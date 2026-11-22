/* 公共工具：解析 srt/vtt/lrc、智能分句、语义分段、导出格式、时间格式化。
 * 通过全局 window.VC 暴露，供 content script / panel / background 复用。 */
(function (root) {
  const VC = root.VC || (root.VC = {});

  function pad(n, len = 2) { return String(n).padStart(len, '0'); }
  function fmtClock(sec, withMs = false) {
    sec = Math.max(0, sec || 0);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    const ms = Math.floor((sec % 1) * 1000);
    return (h ? pad(h) + ':' : '') + pad(m) + ':' + pad(s) + (withMs ? '.' + pad(ms, 3) : '');
  }
  function parseClock(str) {
    if (!str) return 0;
    str = str.trim().replace(',', '.');
    const parts = str.split(':').map(Number);
    if (parts.some(isNaN)) return 0;
    let sec = 0;
    parts.forEach(p => { sec = sec * 60 + p; });
    return sec;
  }

  /* -------- 字幕解析 -------- */
  function parseSRT(text) {
    const out = [];
    const blocks = text.replace(/\r/g, '').split(/\n{2,}/);
    blocks.forEach(b => {
      const lines = b.split('\n').filter(l => l.trim() !== '');
      if (lines.length < 2) return;
      const ti = lines.findIndex(l => l.includes('-->'));
      if (ti < 0) return;
      const [a, bb] = lines[ti].split('-->');
      const fromMs = Math.round(parseClock(a) * 1000);
      const toMs = Math.round(parseClock(bb.replace(/[^\d:.,]/g, '')) * 1000);
      const content = lines.slice(ti + 1).join('\n').trim();
      if (content) out.push({ fromMs, toMs, content });
    });
    return finalize(out);
  }
  function parseVTT(text) {
    const out = [];
    const body = text.replace(/\r/g, '').replace(/^WEBVTT.*\n/, '');
    const blocks = body.split(/\n{2,}/);
    blocks.forEach(b => {
      const lines = b.split('\n').filter(l => l.trim() !== '' && !/^(NOTE|STYLE|REGION)/.test(l));
      const ti = lines.findIndex(l => l.includes('-->'));
      if (ti < 0) return;
      const [a, bb] = lines[ti].split('-->');
      const fromMs = Math.round(parseClock(a) * 1000);
      const toMs = Math.round(parseClock(bb.replace(/[^\d:.,]/g, '')) * 1000);
      const content = lines.slice(ti + 1).join('\n').trim();
      if (content) out.push({ fromMs, toMs, content });
    });
    return finalize(out);
  }
  function parseLRC(text) {
    const out = [];
    text.replace(/\r/g, '').split('\n').forEach(line => {
      const m = line.match(/\[(\d+):(\d+(?:\.\d+)?)\](.*)/);
      if (!m) return;
      const t = (+m[1]) * 60 + parseFloat(m[2]);
      out.push({ fromMs: Math.round(t * 1000), content: m[3].trim() });
    });
    return finalize(out);
  }
  function finalize(list) {
    list.sort((a, b) => a.fromMs - b.fromMs);
    list.forEach((l, i) => {
      l.idx = i;
      if (!l.toMs) l.toMs = (list[i + 1] ? list[i + 1].fromMs : l.fromMs + 3000);
      l.from = l.fromMs / 1000;
      l.to = l.toMs / 1000;
    });
    return list;
  }
  /* B站字幕 JSON：{"body":[{from,to,location,content}], "lan":...} */
  function parseBiliJSON(text) {
    try {
      const j = JSON.parse(text);
      const body = Array.isArray(j) ? j : (j.body || j.subtitles || j.events);
      if (!Array.isArray(body)) return null;
      const out = body.map((it, i) => {
        const from = it.fromMs != null ? it.fromMs
          : it.from != null ? Math.round(it.from * 1000)
            : it.startTime != null ? Math.round(it.startTime * 1000) : 0;
        let to = it.toMs != null ? it.toMs
          : it.to != null ? Math.round(it.to * 1000)
            : it.endTime != null ? Math.round(it.endTime * 1000) : 0;
        let content = it.content != null ? it.content : (it.text || '');
        if (Array.isArray(content)) content = content.map(x => x.content || x).join('');
        return { fromMs: from, toMs: to, content: String(content).replace(/<[^>]+>/g, '') };
      }).filter(x => x.content);
      return finalize(out);
    } catch (e) { return null; }
  }
  function parseSubtitle(text, filename = '') {
    if (/^\s*\{/.test(text.trim())) {
      const bili = parseBiliJSON(text);
      if (bili && bili.length) return bili;
    }
    if (/^\s*WEBVTT/i.test(text) || /\.vtt$/i.test(filename)) return parseVTT(text);
    if (/\[\d+:\d+[\.:]\d+\]/.test(text) || /\.lrc$/i.test(filename)) return parseLRC(text);
    return parseSRT(text);
  }

  /* -------- 智能分句：把逐词/短句字幕合并为可读句子 -------- */
  function punct(lang) {
    return (lang || 'zh').toLowerCase().startsWith('zh') ? { comma: '，', period: '。' }
      : (lang || '').toLowerCase().startsWith('ja') ? { comma: '、', period: '。' }
        : { comma: ', ', period: '.' };
  }
  function endsPunctuation(s) { return /[。！？.!?…]$/.test((s || '').trim()); }
  function mergeSentences(items, lang) {
    // items: [{fromMs,toMs,content}] -> 按标点合并成句子
    const { comma, period } = punct(lang);
    const out = [];
    let buf = null;
    items.forEach(it => {
      const c = (it.content || '').trim();
      if (!c) return;
      if (!buf) buf = { fromMs: it.fromMs, toMs: it.toMs, parts: [] };
      buf.parts.push(c);
      buf.toMs = it.toMs;
      if (endsPunctuation(c)) {
        let text = buf.parts.join(buf.parts.length > 1 ? comma : '');
        if (!endsPunctuation(text)) text += period;
        out.push({ fromMs: buf.fromMs, toMs: buf.toMs, content: text });
        buf = null;
      }
    });
    if (buf) {
      let text = buf.parts.join(buf.parts.length > 1 ? comma : '');
      if (!endsPunctuation(text)) text += period;
      out.push({ fromMs: buf.fromMs, toMs: buf.toMs, content: text });
    }
    return finalize(out);
  }

  /* -------- 语义分段：把句子合并为文章段落 -------- */
  function buildParagraphs(sentences, opts = {}) {
    const gapMs = (opts.gapMs || 30) * 1000; // 停顿阈值
    const minChars = opts.minChars || 60;    // 段落最短字数
    const paras = [];
    let cur = null;
    sentences.forEach((s, i) => {
      const gap = cur ? s.fromMs - cur.endMs : 0;
      const curLen = cur ? cur.texts.join('').length : 0;
      if (!cur || gap > gapMs || (curLen >= minChars && gap > 5000)) {
        cur = { startIdx: i, startMs: s.fromMs, endMs: s.toMs, texts: [] };
        paras.push(cur);
      }
      cur.texts.push(s.content);
      cur.endMs = s.toMs;
    });
    return paras.map(p => ({
      startIdx: p.startIdx,
      startMs: p.startMs,
      endMs: p.endMs,
      text: p.texts.join('')
    }));
  }

  /* -------- 章节：从已有 chapter 数据或按时间均分 -------- */
  function chaptersFromData(data) {
    if (!data) return [];
    const arr = Array.isArray(data) ? data : (data.chapters || []);
    return arr.map((c, i) => ({
      title: c.content || c.title || c.chapterTitle || `第 ${i + 1} 章`,
      description: c.description || c.chapterDescription || '',
      startMs: c.startMs ?? (c.fromMs != null ? c.fromMs : c.startTime != null ? c.startTime * 1000 : (c.from != null ? c.from * 1000 : 0))
    })).sort((a, b) => a.startMs - b.startMs);
  }
  function autoChapters(sentences, count = 5) {
    if (!sentences.length) return [];
    const span = sentences[sentences.length - 1].toMs - sentences[0].fromMs;
    const step = span / count;
    const out = [];
    for (let i = 0; i < count; i++) {
      const startMs = sentences[0].fromMs + step * i;
      const first = sentences.find(s => s.fromMs >= startMs) || sentences[sentences.length - 1];
      out.push({ title: `第 ${i + 1} 部分`, description: '', startMs: first.fromMs });
    }
    return out;
  }
  function chapterTitleAt(chapters, ms) {
    let title = chapters[0] ? chapters[0].title : '';
    for (const c of chapters) if (ms >= c.startMs) title = c.title; else break;
    return title;
  }

  /* -------- 导出 -------- */
  function exportText(sentences, opts = {}) {
    const { format = 'txt', type = 'textWithTime', includeTime = true, second = null,
      chapters = [], withStructure = true, secondSub = null, notes = [], title = '字幕文稿', url = '' } = opts;
    const p = punct(opts.lang);
    if (type === 'srt' || type === 'vtt') {
      let head = type === 'vtt' ? 'WEBVTT\n\n' : '';
      const lines = sentences.map((s, i) => {
        const a = fmtClock(s.from / 1000, true).replace('.', ',');
        const b = fmtClock(s.to / 1000, true).replace('.', ',');
        let content = s.content.trim();
        if (secondSub && secondSub[s.idx]) content += '\n' + secondSub[s.idx].content;
        return `${i + 1}\n${a} --> ${b}\n${content}\n`;
      });
      return head + lines.join('\n');
    }
    if (type === 'lrc') {
      return sentences.map(s => `[${fmtClock(s.from / 1000)}.${pad(s.from % 1000, 3)}]${s.content}`).join('\n');
    }
    // textWithTime / article
    const md = format === 'md';
    const compact = type === 'article';
    let out = '';
    if (md) out += `# ${title}\n\n> ${url}\n\n`;
    else out += `${title}\n${url}\n\n`;
    const addTime = s => (includeTime && !compact ? fmtClock(s.from / 1000) + '  ' : '');
    if (withStructure && chapters.length) {
      chapters.forEach((ch, ci) => {
        const next = chapters[ci + 1] ? chapters[ci + 1].startMs : Infinity;
        const seg = sentences.filter(s => s.fromMs >= ch.startMs && s.fromMs < next);
        if (!seg.length) return;
        out += (md ? `## ${ch.title}\n\n` : `[章节] ${ch.title}\n`);
        if (ch.description) out += (md ? `${ch.description}\n\n` : `${ch.description}\n`);
        seg.forEach(s => {
          let line = addTime(s) + s.content;
          if (secondSub && secondSub[s.idx]) line += (compact ? ` (${secondSub[s.idx].content})` : `\n${secondSub[s.idx].content}`);
          out += line + '\n';
        });
        out += '\n';
      });
    } else {
      sentences.forEach(s => {
        let line = addTime(s) + s.content;
        if (secondSub && secondSub[s.idx]) line += (compact ? ` (${secondSub[s.idx].content})` : `\n${secondSub[s.idx].content}`);
        out += line + '\n';
      });
    }
    if (notes && notes.length) {
      out += (md ? '\n## 笔记\n\n' : '\n[笔记]\n');
      notes.forEach((n, i) => { out += (md ? `### 笔记 ${i + 1}\n\n` : `[笔记 ${i + 1}]\n`) + n.text + '\n' + (n.comment ? (md ? `**评论**: ${n.comment}\n` : `[评论]: ${n.comment}\n`) : '') + '\n'; });
    }
    if (!opts.withoutWatermark) out += '\n--- 由 WindCaption 生成 ---';
    return out;
  }

  VC.util = {
    pad, fmtClock, parseClock, parseSRT, parseVTT, parseLRC, parseBiliJSON, parseSubtitle,
    punct, endsPunctuation, mergeSentences, buildParagraphs, chaptersFromData,
    autoChapters, chapterTitleAt, exportText
  };
})(typeof window !== 'undefined' ? window : globalThis);
