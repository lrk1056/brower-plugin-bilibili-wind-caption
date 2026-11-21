/* 面板逻辑：渲染列表/全文、5 个 Tab、交互，通过 VC.proto 与内容脚本通信。*/
(function () {
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const U = VC.util;
  const params = new URLSearchParams(location.search);
  const isSidepanel = params.get('sidepanel') === '1';
  const token = params.get('token') || document.getElementById('vc-panel-frame')?.dataset.token || '';
  // iframe 模式用 postMessage；sidepanel 模式用 chrome 消息通道
  if (isSidepanel) VC.proto.init({ role: 'panel', transport: 'chrome' });
  else VC.proto.init({ role: 'panel', target: parent, token: token || '__PENDING__' });

  let S = { sentences: [], chapters: [], sources: [], activeSource: 0, secondSource: -1, second: {},
    currentIdx: 0, settings: {}, site: '', title: '' };
  let view = 'list', multi = false, selected = new Set(), query = '';

  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('on');
    clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('on'), 1800);
  }
  function call(action, payload) { return VC.proto.send(action, payload); }

  /* ---------- 握手：获取 token ---------- */
  window.addEventListener('message', function handshake(e) {
    if (e.data && e.data.ns === 'vcap-clone' && e.data.type === 'evt' && e.data.action === 'STATE') {
      VC.proto.init({ role: 'panel', target: parent, token: e.data.token });
      window.removeEventListener('message', handshake);
    }
  });

  VC.proto.on('STATE', s => { S = Object.assign(S, s); renderAll(); });
  VC.proto.on('event:SHORTCUT_EXPORT', p => {
    if (p.kind === 'copy-subtitles') copyAll(); else quickDownload();
  });

  function mark(t) {
    if (!query) return t;
    const q = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return String(t).replace(new RegExp(q, 'gi'), m => `<mark>${m}</mark>`);
  }
  function titleAt(ms) { return U.chapterTitleAt(S.chapters, ms) || '字幕'; }

  /* ---------- 外观设置（主题 / 字号 / 行高） ---------- */
  const APPEARANCE = { theme: 'gray', fontSize: 13, lineHeight: 1.55 };
  function applyAppearance() {
    const root = document.documentElement;
    root.setAttribute('data-theme', APPEARANCE.theme);
    root.style.setProperty('--sub-font', APPEARANCE.fontSize + 'px');
    root.style.setProperty('--sub-line', APPEARANCE.lineHeight);
    // 预览区同步
    if ($('#font-val')) $('#font-val').textContent = APPEARANCE.fontSize + 'px';
    if ($('#line-val')) $('#line-val').textContent = APPEARANCE.lineHeight.toFixed(2).replace(/0$/, '');
    if ($('#font-range')) $('#font-range').value = APPEARANCE.fontSize;
    if ($('#line-range')) $('#line-range').value = APPEARANCE.lineHeight;
    $$('#theme-seg button').forEach(b => b.classList.toggle('active', b.dataset.theme === APPEARANCE.theme));
  }
  function saveAppearance() {
    if (!S.settings || !Object.keys(S.settings).length) return;
    S.settings.theme = APPEARANCE.theme;
    S.settings.fontSize = APPEARANCE.fontSize;
    S.settings.subLineHeight = APPEARANCE.lineHeight;
    call('SAVE_SETTINGS', { settings: S.settings });
  }
  // 从 STATE 的设置初始化（仅首次或设置变化时）
  let appearanceLoaded = false;
  function loadAppearanceFromSettings() {
    if (appearanceLoaded || !S.settings || !Object.keys(S.settings).length) return;
    appearanceLoaded = true;
    let t = S.settings.theme || 'gray';
    if (t === 'system') t = 'auto';
    if (!['light','dark','gray','auto'].includes(t)) t = 'gray';
    // 旧默认 auto 且用户未显式选过主题 → 迁移到新默认 gray；显式选择 auto 的行为保留
    if (t === 'auto' && !S.settings.themePinned) t = 'gray';
    APPEARANCE.theme = t;
    let fs = Number(S.settings.fontSize);
    if (!fs || fs < 12 || fs > 20) fs = 13;
    APPEARANCE.fontSize = fs;
    let lh = Number(S.settings.subLineHeight);
    if (!lh || lh < 1.2 || lh > 2) lh = 1.55;
    APPEARANCE.lineHeight = lh;
    applyAppearance();
  }
  $$('#theme-seg button').forEach(b => b.addEventListener('click', () => {
    APPEARANCE.theme = b.dataset.theme;
    if (S.settings) S.settings.themePinned = true;
    applyAppearance(); saveAppearance();
  }));
  $('#font-range').addEventListener('input', e => {
    APPEARANCE.fontSize = Math.min(20, Math.max(12, +e.target.value));
    applyAppearance();
  });
  $('#font-range').addEventListener('change', () => saveAppearance());
  $('#line-range').addEventListener('input', e => {
    APPEARANCE.lineHeight = Math.min(2, Math.max(1.2, +e.target.value));
    applyAppearance();
  });
  $('#line-range').addEventListener('change', () => saveAppearance());
  $('#btn-reset-appearance').addEventListener('click', () => {
    APPEARANCE.theme = 'gray'; APPEARANCE.fontSize = 13; APPEARANCE.lineHeight = 1.55;
    if (S.settings) S.settings.themePinned = false;
    applyAppearance(); saveAppearance(); toast('已恢复默认外观');
  });

  /* ---------- 渲染 ---------- */
  function renderAll() {
    loadAppearanceFromSettings();
    $('#site-tag').textContent = ({ bilibili: 'Bilibili', youtube: 'YouTube' })[S.site] || S.site || '—';
    $('#chip-source').textContent = '字幕：' + ((S.sources[S.activeSource] || {}).name || '—');
    $('#chip-second').textContent = '第二字幕：' + (S.secondSource >= 0 || Object.keys(S.second).length ? '开' : '关闭');
    $('#chip-count').textContent = view === 'article'
      ? `${S.sentences.length} 条 · ${U.buildParagraphs(S.sentences).length} 段`
      : `共 ${S.sentences.length} 条`;
    // tabs 显隐
    const tabs = (S.settings.tabs) || {};
    $$('.tab').forEach(t => t.classList.toggle('hidden', t.dataset.tab !== 'subtitle' && tabs[t.dataset.tab] === false));
    renderChapters(); renderList(); renderChapterStrip();
    $('#mode-label').textContent = ({ embed: '嵌入', float: '悬浮', side: '侧边栏' })[S.panelMode] || '';
    $('#tr-second').checked = S.secondSource >= 0 || Object.keys(S.second).length > 0;
    // 折叠状态 → 图标旋转由 CSS 依据 aria-expanded 驱动（展开朝上 / 折叠朝下）
    const folded = !!S.folded;
    $('#root').classList.toggle('folded', folded);
    $('#btn-fold').setAttribute('aria-expanded', folded ? 'false' : 'true');
    $('#btn-fold').title = folded ? '展开面板' : '折叠面板';
    $('#btn-fold').setAttribute('aria-label', folded ? '展开面板' : '折叠面板');
    // 拖拽手柄只在 B站嵌入模式显示（其他模式高度由 CSS/悬浮窗设置控制）
    $('#resize-grip').classList.toggle('show', !folded && S.panelMode === 'embed' && S.site === 'bilibili');
  }

  function renderChapters() {
    const box = $('#chapter-list');
    if (!S.chapters.length) { box.innerHTML = '<div class="empty">暂无章节</div>'; $('#ch-status').textContent = '暂无章节 · 可点击“生成章节”'; return; }
    $('#ch-status').textContent = `已加载 ${S.chapters.length} 个章节`;
    box.innerHTML = S.chapters.map((c, i) => {
      const on = S.currentIdx >= (c.startIdx || 0) && (i === S.chapters.length - 1 || S.currentIdx < (S.chapters[i + 1].startIdx || Infinity));
      return `<div class="ch ${on ? 'on' : ''}" data-i="${i}" data-ms="${c.startMs}"><span class="n">${String(i + 1).padStart(2, '0')}</span><div><b>${c.title || `第 ${i + 1} 章`}</b><small>${U.fmtClock(c.startMs / 1000)}${c.description ? ' · ' + c.description : ''}</small></div></div>`;
    }).join('');
    $$('.ch', box).forEach(el => el.addEventListener('click', () => {
      call('JUMP_CHAPTER', { ms: +el.dataset.ms });
    }));
  }

  function renderChapterStrip() {
    const strip = $('#chapter-track');
    const cs = S.chapters;
    $('#chapter-curr').textContent = cs.length ? titleAt((S.sentences[S.currentIdx] || {}).fromMs || 0) : '—';
    if (!cs.length) { strip.innerHTML = '<i class="on"></i>'; return; }
    strip.innerHTML = cs.map((c, i) => {
      const next = cs[i + 1] ? cs[i + 1].startMs : Infinity;
      const ms = (S.sentences[S.currentIdx] || {}).fromMs || 0;
      return `<i class="${ms >= c.startMs && ms < next ? 'on' : ''}"></i>`;
    }).join('');
  }

  function renderList() {
    const box = $('#list');
    box.innerHTML = '';
    if (!S.sentences.length) {
      const hint = S.needLoginSubtitle && S.site === 'bilibili'
        ? '该视频字幕需要登录 B站 才能获取，请登录后再刷新页面'
        : 'B站/YouTube 打开带字幕的视频即可自动获取';
      box.innerHTML = `<div class="empty">暂无字幕<br><span class="muted small">${hint}</span></div>`;
      return;
    }
    if (view === 'article') { renderArticle(box); scrollCurrent(); return; }
    // 搜索时只显示匹配项（保留原始索引用于跳转）
    const indices = S.sentences.map((_, i) => i).filter(i => {
      if (!query) return true;
      const s = S.sentences[i];
      return s.content.includes(query) || (S.second[i] && S.second[i].content.includes(query));
    });
    if (query && !indices.length) {
      box.innerHTML = '<div class="empty">未找到匹配的字幕</div>';
      return;
    }
    indices.forEach(i => {
      const s = S.sentences[i];
      const el = document.createElement('div');
      el.className = 'sub' + (i === S.currentIdx ? ' cur' : '') + (selected.has(i) ? ' sel' : '');
      el.dataset.i = i;
      const sec = S.second[i] ? `<div class="sec">${S.second[i].content}</div>` : '';
      el.innerHTML = `${multi ? `<input type="checkbox" class="ck" ${selected.has(i) ? 'checked' : ''}>` : ''}
        <span class="t">${U.fmtClock(s.fromMs / 1000, true)}</span>
        <div class="b">${mark(s.content)}${sec}</div>`;
      el.addEventListener('click', e => {
        if (multi && e.target.classList.contains('ck')) {
          e.target.checked ? selected.add(i) : selected.delete(i);
          el.classList.toggle('sel', selected.has(i)); updateSel(); return;
        }
        call('JUMP_TO', { idx: i });
      });
      box.appendChild(el);
    });
    updateSel();
    if (!multi) scrollCurrent();
  }

  // 全文段落：{sentences:[带标点的句子文本], second:[译文或null]}，渲染与导出共用
  function getArticleParas() {
    const paras = U.buildParagraphs(S.sentences);
    const lang = (S.sources[S.activeSource] || {}).lang || S.settings.lang || 'zh';
    const punc = U.punct(lang);
    return paras.map(p => {
      const i = paras.indexOf(p);
      const nextIdx = paras[i + 1] ? paras[i + 1].startIdx : S.sentences.length;
      const segs = S.sentences.slice(p.startIdx, nextIdx);
      const texts = segs.map(s => {
        let t = (s.content || '').trim();
        if (t && !U.endsPunctuation(t)) t += punc.period;
        return t;
      });
      const seconds = segs.map(s => {
        const sec = S.second[s.idx];
        return sec ? (sec.content || '').trim() : '';
      });
      return { startIdx: p.startIdx, endIdx: nextIdx, startMs: p.startMs, texts, seconds, hasSecond: seconds.some(Boolean) };
    });
  }

  // 全文纯文本：段落之间空行分隔，句子连排（带标点），无标题/时间戳/水印
  function buildArticleText() {
    return getArticleParas().map(p => {
      let para = p.texts.join('');
      if (p.hasSecond) para += '\n' + p.seconds.filter(Boolean).join(' ');
      return para;
    }).join('\n\n');
  }

  function renderArticle(box) {
    let paras = getArticleParas();
    const total = S.sentences.length;
    // 搜索时只显示含关键词的段落（段落内所有句子保留，关键词由 mark 高亮）
    if (query) {
      paras = paras.filter(p =>
        p.texts.some(t => t.includes(query)) || p.seconds.some(t => t && t.includes(query)));
      if (!paras.length) { box.innerHTML = '<div class="empty">未找到匹配的字幕</div>'; return; }
    }
    paras.forEach((p, i) => {
      const active = S.currentIdx >= p.startIdx && S.currentIdx < p.endIdx;
      const el = document.createElement('div');
      el.className = 'para' + (active ? ' on' : '');
      const bodyHtml = p.texts.map((t, k) => {
        const idx = p.startIdx + k;
        const cur = idx === S.currentIdx ? ' cur' : '';
        return `<span class="para-sent${cur}" data-idx="${idx}" title="跳转到 ${U.fmtClock(S.sentences[idx].fromMs / 1000)}">${mark(t)}</span>`;
      }).join('');
      const secsHtml = p.hasSecond
        ? `<p class="p2">${p.seconds.map((sec, k) => sec ? `<span class="para-sent para-sec" data-idx="${p.startIdx + k}">${mark(sec)}</span>` : '').filter(Boolean).join(' ')}</p>`
        : '';
      el.innerHTML = `<p class="para-body">${bodyHtml}</p>${secsHtml}`;
      // 点句子 -> 跳到该句；点段落空白处 -> 跳到段落开头
      el.addEventListener('click', e => {
        const sent = e.target.closest('.para-sent');
        call('JUMP_TO', { idx: sent ? +sent.dataset.idx : p.startIdx });
      });
      box.appendChild(el);
    });
  }
  // 跟随播放滚动：把当前句定位到距容器底部约 3 行的位置，提前露出后续内容
  // force=true 时（点"回到当前"）即使已在舒适区也强制归位
  function scrollCurrent(force) {
    setTimeout(() => {
      const box = $('#list');
      if (!box) return;
      // 全文用当前句 span，列表用当前条；找不到则不滚动（避免误跳）
      const sel = view === 'article' ? $('.para-sent.cur') || $('.para.on') : $('.sub.cur');
      if (!sel) return;
      const reserve = view === 'article' ? 90 : 100; // 底部预留像素（约3行）
      const selTop = sel.offsetTop - box.offsetTop;
      const target = selTop - box.clientHeight + reserve + sel.offsetHeight;
      // 若当前句已在舒适区且不强制，不重复滚动，避免频繁抖动
      if (!force) {
        const top = box.scrollTop;
        const bottomLine = top + box.clientHeight - reserve;
        if (selTop >= top && selTop + sel.offsetHeight <= bottomLine) return;
      }
      box.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
    }, 30);
  }
  function updateSel() { $('#sel-count').textContent = `已选 ${selected.size} / ${S.sentences.length}`; }

  /* ---------- 视图切换 ---------- */
  function setView(v) {
    view = v;
    $('#view-seg').querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.view === v));
    const article = v === 'article';
    $('#btn-multi').classList.toggle('hidden', article);
    if (article && multi) $('#btn-multi').click();
    $('#hint').textContent = article
      ? 'ⓘ 全文视图：句子按语义合并为段落，点击任意句子跳转到对应播放位置'
      : 'ⓘ 每条带时间戳，点击跳转、支持多选';
    renderAll(); scrollCurrent();
  }
  $('#view-seg').querySelectorAll('button').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
  $('#btn-fold').addEventListener('click', async () => {
    const res = await call('TOGGLE_FOLD');
    // 立即同步图标，不等 STATE 往返（内容脚本也会广播 STATE 做兜底对齐）
    if (res && typeof res.folded === 'boolean') {
      S.folded = res.folded;
      const folded = res.folded;
      $('#root').classList.toggle('folded', folded);
      $('#btn-fold').setAttribute('aria-expanded', folded ? 'false' : 'true');
      $('#btn-fold').title = folded ? '展开面板' : '折叠面板';
      $('#btn-fold').setAttribute('aria-label', folded ? '展开面板' : '折叠面板');
    }
  });
  $('#btn-options').addEventListener('click', () => call('OPEN_OPTIONS'));

  /* ---------- 底部拖拽手柄：调整嵌入高度 ---------- */
  (function initResizeGrip() {
    const grip = $('#resize-grip');
    let dragging = false, startY = 0, startH = 0, lastSent = 0, raf = 0, submitted = true;
    const bounds = () => (S.embedRange && S.embedRange.min != null)
      ? S.embedRange
      : { min: 240, max: 820 };
    const currentH = () => (S.embedHeight && S.embedHeight > 0) ? S.embedHeight : bounds().min;

    grip.addEventListener('pointerdown', e => {
      if (!grip.classList.contains('show')) return;
      dragging = true; submitted = false; startY = e.clientY; startH = currentH(); lastSent = startH;
      grip.classList.add('dragging');
      try { grip.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
    });
    grip.addEventListener('pointermove', e => {
      if (!dragging) return;
      const b = bounds();
      const delta = e.clientY - startY;          // 下拖为正 → 增高，上拖为负 → 降低
      const h = Math.round(Math.min(b.max, Math.max(b.min, startH + delta)));
      if (h === lastSent) return;
      lastSent = h;
      S.embedHeight = h;                          // 本地即时反馈
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => { raf = 0; call('PREVIEW_EMBED_HEIGHT', { height: h }); });
      e.preventDefault();
    });
    const finish = e => {
      if (!dragging) return;
      dragging = false;
      grip.classList.remove('dragging');
      try { grip.releasePointerCapture(e.pointerId); } catch (_) {}
      // 松手时提交并存盘（pointerup/pointercancel 幂等，只提交一次）
      if (!submitted) { submitted = true; call('SET_EMBED_HEIGHT', { height: lastSent }); }
    };
    grip.addEventListener('pointerup', finish);
    grip.addEventListener('pointercancel', finish);
  })();

  /* ---------- 字幕栏操作 ---------- */
  $('#btn-multi').addEventListener('click', e => {
    multi = !multi; if (!multi) selected.clear();
    $('#multi-bar').classList.toggle('hidden', !multi);
    e.target.textContent = multi ? '退出多选' : '多选';
    renderList();
  });
  $('#btn-resume').addEventListener('click', () => scrollCurrent(true));
  $('#sel-all').addEventListener('click', () => { selected = new Set(S.sentences.map((_, i) => i)); renderList(); });
  $('#sel-none').addEventListener('click', () => { selected.clear(); renderList(); });
  $('#sel-invert').addEventListener('click', () => { selected = new Set(S.sentences.map((_, i) => i).filter(i => !selected.has(i))); renderList(); });
  $('#sel-copy').addEventListener('click', () => {
    const text = [...selected].sort((a, b) => a - b).map(i => `${U.fmtClock(S.sentences[i].fromMs / 1000)}  ${S.sentences[i].content}`).join('\n');
    copyText(text); toast(`已复制 ${selected.size} 条字幕`);
  });
  $('#sel-translate').addEventListener('click', () => {
    if (!selected.size) return toast('请先选择字幕');
    toast(`已选中 ${selected.size} 条，请在“翻译”Tab 发起任务`);
    switchTab('translate');
  });
  $('#btn-refresh').addEventListener('click', async () => {
    toast('正在重新获取字幕...');
    const r = await call('REFRESH_SUBTITLES', {});
    toast(r && r.ok ? `已获取 ${r.count} 个字幕源` : '刷新失败');
  });

  /* ---------- 搜索（内嵌在字幕面板，实时过滤列表） ---------- */
  let searchOpen = false;
  function toggleSearch(open) {
    searchOpen = open;
    $('#search-inline').classList.toggle('hidden', !open);
    if (open) $('#search').focus();
    else { $('#search').value = ''; query = ''; renderAll(); }
  }
  $('#btn-search-toggle').addEventListener('click', () => toggleSearch(!searchOpen));
  $('#btn-clear-search').addEventListener('click', () => { $('#search').value = ''; query = ''; $('#search-count').textContent = ''; renderAll(); $('#search').focus(); });
  function doSearch(q) {
    query = q.trim();
    if (!query) {
      $('#search-count').textContent = '';
      renderAll();
      return;
    }
    const hits = S.sentences.map((s, i) => ({ s, i })).filter(x =>
      x.s.content.includes(query) || (S.second[x.i] && S.second[x.i].content.includes(query)));
    $('#search-count').textContent = `${hits.length} 条匹配`;
    renderAll(); // 两个视图都按 query 过滤 + 高亮
  }
  $('#search').addEventListener('input', e => doSearch(e.target.value));

  /* ---------- 章节 Tab ---------- */
  $('#btn-gen-chapter').addEventListener('click', async () => {
    toast('章节生成任务已创建...');
    const res = await call('GEN_CHAPTERS', { opts: {
      lang: $('#ch-lang').value, includeDescription: $('#ch-desc').checked, includeParagraphs: $('#ch-para').checked
    }});
    toast(res.ok ? '章节生成完成' : ('生成失败：' + (res.error || '')));
  });
  $('#ch-prev').addEventListener('click', () => {
    const ms = (S.sentences[S.currentIdx] || {}).fromMs || 0;
    const prev = [...S.chapters].reverse().find(c => c.startMs < ms - 100);
    if (prev) call('JUMP_CHAPTER', { ms: prev.startMs }); else toast('已是第一章');
  });
  $('#ch-next').addEventListener('click', () => {
    const ms = (S.sentences[S.currentIdx] || {}).fromMs || 0;
    const next = S.chapters.find(c => c.startMs > ms + 100);
    if (next) call('JUMP_CHAPTER', { ms: next.startMs }); else toast('已是最后一章');
  });

  /* ---------- 翻译 Tab ---------- */
  $('#btn-translate').addEventListener('click', async () => {
    if (!S.sentences.length) return toast('暂无字幕');
    $('#progress-box').classList.remove('hidden');
    $('#progress-pct').textContent = '处理中...';
    $('#progress-fill').style.width = '30%';
    $('#tr-status').textContent = '翻译中';
    const res = await call('TRANSLATE', { lang: $('#tr-lang').value });
    if (res.ok) {
      $('#progress-fill').style.width = '100%'; $('#progress-pct').textContent = '完成';
      $('#tr-status').textContent = '已完成'; toast('翻译完成');
      if ($('#tr-second').checked) call('SET_SECOND', { idx: S.activeSource });
    } else {
      $('#tr-status').textContent = '失败'; toast('翻译失败：' + (res.error || ''));
    }
  });
  $('#tr-second').addEventListener('change', e => call('SET_SECOND', { idx: e.target.checked ? S.activeSource : -1 }));

  /* ---------- 导出（字幕面板内弹层：选格式即下载） ---------- */
  let exportOpen = false;
  function toggleExport(open) {
    exportOpen = open;
    $('#export-pop').classList.toggle('hidden', !open);
  }
  $('#btn-export-toggle').addEventListener('click', () => toggleExport(!exportOpen));
  $('#export-pop-close').addEventListener('click', () => toggleExport(false));

  // 默认导出选项：文稿/全文固定 TXT（无文件格式切换）
  function exportOpts(type) {
    return {
      format: 'txt', type: type || 'textWithTime',
      includeTime: true, includeSecond: false,
      withoutWatermark: false, withStructure: true
    };
  }
  async function getExport(opts) {
    // 全文（紧凑）用渲染全文文本，保证与屏幕一致
    if (opts && opts.type === 'article') return buildArticleText();
    const r = await call('EXPORT', opts || exportOpts());
    return r.ok ? r.text : '';
  }
  // 统一下载执行
  async function doDownload(type) {
    const opts = exportOpts(type);
    const text = await getExport(opts);
    if (!text) { toast('没有可下载的内容'); return; }
    const ext = ['srt','vtt','lrc'].includes(type) ? type : 'txt';
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${(S.title || '字幕').replace(/[\\/:*?"<>|]/g, '_')}.${ext}`;
    a.click(); URL.revokeObjectURL(url);
    toggleExport(false);
    toast('已下载 ' + ext.toUpperCase());
  }
  // 点选导出类型 -> 立即下载
  $$('.export-item').forEach(it => it.addEventListener('click', () => doDownload(it.dataset.type)));
  function copyText(text) {
    // iframe 中 Clipboard API 可能被 permissions policy 拦截，优先用 execCommand
    let ok = false;
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.focus(); ta.select();
      ok = document.execCommand('copy');
      ta.remove();
    } catch (e) { ok = false; }
    if (!ok) {
      // 兜底：交给内容脚本在父页面复制
      call('COPY_TEXT', { text }).then(r => { if (r && !r.ok) toast('复制失败，请手动选择文本'); });
    }
  }
  async function copyAll() {
    // 全文视图下复制 = 与屏幕一致的全文文本；列表视图 = 当前导出设置
    const text = view === 'article' ? await getExport({ type: 'article' }) : await getExport(exportOpts());
    if (text) { copyText(text); toast('已复制全部字幕'); }
  }
  async function quickDownload() {
    // 快捷下载：使用默认格式（列表=文稿TXT，全文=纯全文TXT）
    const opts = view === 'article' ? { type: 'article', format: 'txt' } : exportOpts();
    const text = await getExport(opts);
    if (!text) return toast('没有可下载的内容');
    const ext = opts.type === 'srt' || opts.type === 'vtt' || opts.type === 'lrc' ? opts.type : 'txt';
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${(S.title || '字幕').replace(/[\\/:*?"<>|]/g, '_')}.${ext}`;
    a.click(); URL.revokeObjectURL(url);
    toast('快捷下载成功');
  }
  $('#btn-copy-all').addEventListener('click', copyAll);
  $('#btn-quick-dl').addEventListener('click', quickDownload);

  /* ---------- Tabs ---------- */
  function switchTab(name) {
    $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    $$('.tabpane').forEach(p => {
      const on = p.dataset.pane === name;
      p.classList.toggle('active', on);
      p.classList.toggle('hidden', !on); // 必须同步移除 hidden，否则 display:none!important 导致空白
    });
  }
  $$('.tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  /* ---------- 键盘快捷键（聚焦面板时） ---------- */
  document.addEventListener('keydown', async e => {
    const sc = S.settings.shortcut || {};
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const map = {
      [sc.prevSentence]: 'prev', [sc.nextSentence]: 'next', [sc.prevPage]: 'prevpage', [sc.nextPage]: 'nextpage',
      [sc.togglePlayPause]: 'play', [sc.volumeUp]: 'volup', [sc.volumeDown]: 'voldown',
      [sc.copyCurrent]: 'copycur', [sc.downloadSubtitle]: 'download', [sc.toggleFold]: 'fold',
      [sc.toggleView]: 'view', [sc.resumeScrolling]: 'resume'
    };
    const act = map[key];
    if (!act) return;
    e.preventDefault();
    if (act === 'prev') call('JUMP_TO', { idx: Math.max(0, S.currentIdx - 1) });
    if (act === 'next') call('JUMP_TO', { idx: Math.min(S.sentences.length - 1, S.currentIdx + 1) });
    if (act === 'prevpage' || act === 'nextpage') {
      const by = act === 'prevpage' ? -10 : 10;
      call('JUMP_TO', { idx: Math.max(0, Math.min(S.sentences.length - 1, S.currentIdx + by)) });
    }
    if (act === 'play') call('CONTROL', { op: 'playpause' });
    if (act === 'volup') call('CONTROL', { op: 'volume', value: 0.1 });
    if (act === 'voldown') call('CONTROL', { op: 'volume', value: -0.1 });
    if (act === 'copycur') { const s = S.sentences[S.currentIdx]; if (s) { copyText(s.content); toast('已复制当前句'); } }
    if (act === 'download') quickDownload();
    if (act === 'fold') $('#btn-fold').click();
    if (act === 'view') setView(view === 'list' ? 'article' : 'list');
    if (act === 'resume') scrollCurrent(true);
  });

  // 初始拉取状态：等握手拿到 token 后再发
  const waitHandshake = setInterval(() => {
    if (VC.proto.__ready) { clearInterval(waitHandshake); call('GET_STATE'); }
  }, 50);
})();
