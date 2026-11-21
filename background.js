/* Background service worker：AI 翻译 / 章节生成 / 导出 / 快捷指令 / 面板开合。
 * 复用 lib 中的工具脚本（通过 importScripts）。 */
importScripts('lib/util.js', 'lib/storage.js');

const U = VC.util;
const store = VC.store;

/* ---------- AI（OpenAI 兼容 Chat Completions）---------- */
function pickService(type) {
  return store.getSettings().then(s => {
    const services = s.services || [];
    let svc;
    if (type === 'translate') svc = services.find(x => x.id === s.defaultTranslateService && x.enabled);
    else svc = services.find(x => x.id === s.defaultAiService && x.enabled);
    if (!svc) svc = services.find(x => x.enabled && (type === 'translate' ? x.category !== 'ai' : true));
    return svc || null;
  });
}
function endpoint(svc) {
  let base = (svc.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  if (svc.type === 'gemini' && !/v1beta/i.test(base)) base += '/v1beta/openai';
  return base + '/chat/completions';
}
async function aiChat(messages, opts = {}) {
  const svc = await pickService(opts.category);
  if (!svc || !svc.apiKey) throw new Error('请先在设置中配置 API Key 与服务');
  const body = {
    model: svc.model || 'gpt-4o-mini',
    messages,
    temperature: svc.temperature != null ? svc.temperature : 0.2
  };
  if (svc.extraBody) { try { Object.assign(body, JSON.parse(svc.extraBody)); } catch (e) {} }
  if (opts.json) body.response_format = { type: 'json_object' };
  const res = await fetch(endpoint(svc), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + svc.apiKey },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`AI 请求失败 ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data.choices && data.choices[0] && data.choices[0].message.content || '';
}

/* ---------- 翻译：分批保持上下文 ---------- */
async function translateSentences(sentences, targetLang, category, onProgress) {
  const total = sentences.length;
  const batchSize = 40;
  const result = new Array(total).fill(null);
  for (let start = 0; start < total; start += batchSize) {
    const batch = sentences.slice(start, start + batchSize);
    const numbered = batch.map((s, i) => `${start + i + 1}. ${s.content}`).join('\n');
    const prompt = `把下面字幕逐条翻译成${targetLang}。保持编号，每条一行，只输出译文，不要解释：\n\n${numbered}`;
    const text = await aiChat([
      { role: 'system', content: '你是字幕翻译助手，输出与输入编号一一对应的译文。' },
      { role: 'user', content: prompt }
    ], { category });
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    batch.forEach((_, i) => {
      let line = lines[i] || '';
      line = line.replace(/^\d+[\.\)、:：]\s*/, '');
      result[start + i] = { content: line };
    });
    if (onProgress) onProgress(Math.min(total, start + batch.length), total);
  }
  return result;
}

/* ---------- 章节生成 ---------- */
async function generateChapters(sentences, opts = {}) {
  const targetLang = opts.lang || '中文';
  const includeDesc = opts.includeDescription !== false;
  const includePara = opts.includeParagraphs !== false;
  const numbered = sentences.map((s, i) => `${i}|${U.fmtClock(s.from / 1000)}|${s.content}`).join('\n');
  const text = await aiChat([
    { role: 'system', content: '你是视频章节划分助手，只输出合法 JSON，不要 Markdown 代码块。' },
    { role: 'user', content: `根据以下带索引和时间的字幕，把视频划分为 4-8 个章节。
输出 JSON：{"chapters":[{"title":"章节标题","description":"一句话描述","startIdx":0}${includePara ? ',"paragraphs":[{"title":"段落标题","startIdx":0}]' : ''}]}
startIdx 必须是字幕中实际存在的索引。语言：${targetLang}。${includeDesc ? '' : 'description 留空。'}
字幕：\n${numbered}` }
  ], { category: 'ai', json: true });
  const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
  const chapters = (parsed.chapters || []).map(c => {
    const idx = Math.max(0, Math.min(sentences.length - 1, +c.startIdx || 0));
    const ch = { title: c.title || '章节', description: c.description || '', startMs: sentences[idx].fromMs, startIdx: idx };
    if (includePara && Array.isArray(c.paragraphs)) {
      ch.paragraphs = c.paragraphs.map(p => {
        const pi = Math.max(0, Math.min(sentences.length - 1, +p.startIdx || idx));
        return { title: p.title || '段落', startMs: sentences[pi].fromMs, startIdx: pi };
      });
    }
    return ch;
  }).sort((a, b) => a.startMs - b.startMs);
  return chapters;
}

/* ---------- 消息处理 ---------- */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const run = async () => {
    switch (msg.action) {
      case 'AI_TRANSLATE': {
        const r = await translateSentences(msg.sentences, msg.lang, 'translate');
        return { ok: true, result: r };
      }
      case 'GENERATE_CHAPTERS': {
        const chapters = await generateChapters(msg.sentences, msg.opts || {});
        return { ok: true, chapters };
      }
      case 'TEST_AI': {
        const svc = msg.service;
        if (!svc || !svc.apiKey) return { ok: false, error: '缺少 API Key' };
        let base = (svc.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
        if (svc.type === 'gemini' && !/v1beta/i.test(base)) base += '/v1beta/openai';
        const res = await fetch(base + '/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + svc.apiKey },
          body: JSON.stringify({ model: svc.model || 'gpt-4o-mini', messages: [{ role: 'user', content: 'ping' }], max_tokens: 5 })
        });
        return res.ok ? { ok: true } : { ok: false, error: `HTTP ${res.status}` };
      }
      case 'OPEN_OPTIONS': {
        // 用官方 API 打开选项页，避免 window.open 被 Chrome 弹窗拦截
        await chrome.runtime.openOptionsPage();
        return { ok: true };
      }
      case 'OPEN_PANEL':
      case 'OPEN_SIDEPANEL': {
        try {
          const tabId = msg.tabId || (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
          if (tabId) await chrome.sidePanel.open({ tabId });
        } catch (e) { console.warn('[vc-bg] open sidepanel failed', e); }
        return { ok: true };
      }
      case 'CLOSE_SIDEPANEL': {
        // Chrome 无主动关闭 sidePanel 的 API（用户点浏览器侧边栏按钮关闭）；
        // 通知 content 切回即可。保留占位以兼容未来。
        return { ok: true };
      }
      case 'FETCH_TEXT': {
        // 内容脚本跨域 fetch 受 CORS 限制时，用后台代理（有 host_permissions，不受 CORS 约束）
        try {
          const headers = { 'Referer': 'https://www.bilibili.com/', 'User-Agent': 'Mozilla/5.0' };
          const resp = await fetch(msg.url, { credentials: 'omit', headers });
          const text = await resp.text();
          return { ok: resp.ok, status: resp.status, text };
        } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
      }
      case 'LOAD_BILI_SUBTITLES': {
        // 完整链路放在后台：bvid -> aid/cid -> 字幕列表 -> 下载 JSON -> 解析
        // 后台有 host_permissions 且不受 CORS 限制，带 B站 Referer 避免 403。
        try {
          const bv = msg.bvid;
          const H = { 'Referer': 'https://www.bilibili.com/', 'User-Agent': 'Mozilla/5.0' };
          const view = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bv}`, { headers: H }).then(r => r.json());
          if (!view || view.code !== 0 || !view.data) return { ok: false, error: 'view api failed' };
          const aid = view.data.aid, cid = view.data.cid;
          const wbi = await fetch(`https://api.bilibili.com/x/player/wbi/v2?aid=${aid}&cid=${cid}`, {
            headers: H, credentials: 'include'
          }).then(r => r.json());
          const subs = (wbi.data && wbi.data.subtitle && wbi.data.subtitle.subtitles) || [];
          const results = [];
          const diagnostics = [];
          const nameCount = {}; // 用于同名轨道加序号
          for (const s of subs) {
            if (!s.subtitle_url) continue;
            const url = s.subtitle_url.startsWith('//') ? 'https:' + s.subtitle_url : s.subtitle_url;
            try {
              const resp = await fetch(url, { headers: {
                'Referer': `https://www.bilibili.com/video/${bv}`,
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36'
              }});
              const txt = await resp.text();
              let sentences = VC.util.parseSubtitle(txt, '');
              // AI 字幕可能是 {"body":[...]} 但 time 字段为毫秒整数，parseBiliJSON 已兼容
              const rawLan = s.lan || '';
              const isAI = rawLan.startsWith('ai-');
              let lang = rawLan.replace(/^ai-/, '');
              // 构造可区分的名字：来源(AI/投稿) + 语言文档名
              const langDoc = s.lan_doc || lang || '中文';
              let name = (isAI ? 'AI字幕' : '投稿字幕') + ' · ' + langDoc;
              nameCount[name] = (nameCount[name] || 0) + 1;
              if (nameCount[name] > 1) name += ` (${nameCount[name]})`;
              const diag = { status: resp.status, len: txt ? txt.length : 0,
                head: txt ? txt.slice(0, 120) : '', parsed: sentences.length, url: url.slice(0, 90) };
              diagnostics.push(diag);
              console.log('[vc-bg] subtitle fetch', JSON.stringify(diag));
              results.push({ key: url, url, name, lang, content: txt, sentences });
            } catch (e) {
              diagnostics.push({ error: String(e && e.message || e), url: url.slice(0, 90) });
              console.log('[vc-bg] subtitle fetch ERROR', String(e && e.message || e));
            }
          }
          console.log('[vc-bg] LOAD_BILI_SUBTITLES bvid', bv, '-> sources', results.length,
            results.map(r => r.sentences.length));
          return { ok: true, sources: results, diagnostics,
            needLogin: !!(wbi.data && wbi.data.need_login_subtitle) };
        } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
      }
      case 'GET_SETTINGS': return { ok: true, settings: await store.getSettings() };
      default: return { ok: false, error: 'unknown action: ' + msg.action };
    }
  };
  run().then(sendResponse).catch(e => sendResponse({ ok: false, error: String(e && e.message || e) }));
  return true;
});

/* 浏览器级快捷键 */
/* 在页面主世界注入 fetch/XHR 拦截器，捕获字幕网络响应 */
async function registerCapture() {
  try {
    await chrome.scripting.registerContentScripts([{
      id: 'vc-capture',
      matches: ['https://*.bilibili.com/*', 'https://*.youtube.com/*'],
      js: ['inject/capture-main.js'],
      runAt: 'document_start',
      world: 'MAIN',
      allFrames: true
    }]);
  } catch (e) { /* 已注册 */ }
}
chrome.runtime.onInstalled.addListener(registerCapture);
chrome.runtime.onStartup && chrome.runtime.onStartup.addListener(registerCapture);
registerCapture();

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  if (command === 'copy-subtitles' || command === 'download-subtitles') {
    chrome.tabs.sendMessage(tab.id, { action: 'SHORTCUT_EXPORT', kind: command });
  }
});

/* 点击浏览器工具栏上固定的扩展图标 → 打开设置页。
 * manifest 的 action 未设置 default_popup，故点击会触发 onClicked；
 * 用官方 openOptionsPage 而非 window.open，避免被 Chrome 弹窗拦截。 */
chrome.action.onClicked.addListener(async () => {
  try { await chrome.runtime.openOptionsPage(); }
  catch (e) { console.warn('[vc-bg] open options from toolbar icon failed', e); }
});
