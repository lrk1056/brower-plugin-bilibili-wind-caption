/* 内容脚本：捕获字幕 -> 解析 -> 管理状态 -> 注入面板 iframe -> 桥接协议 -> 控制页面播放。*/
(function () {
  if (window.__vcContentReady) return;
  window.__vcContentReady = true;
  const U = VC.util, store = VC.store, proto = VC.proto;
  const adapter = VC.adapters.detect();
  const TOKEN = proto.makeToken();
  const CAPTURE_EVENT = '__vc_capture_subtitle__';

  const state = {
    tid: adapter.tid(), vid: adapter.vid(),
    title: adapter.title(), site: adapter.id,
    sources: [],          // [{name,lang,url,content,parsed,sentences}]
    activeSource: 0,
    secondSource: -1,
    second: {},           // idx -> {content}
    chapters: [],
    settings: null,
    currentIdx: 0,
    playing: false,
    frame: null,
    panelMode: 'embed',
    folded: false,
    autoScroll: true
  };
  let pausedScrollUntil = 0;
  let captionBubble = null;

  /* ---------- 持久化与恢复 ---------- */
  async function init() {
    console.log('[vc] init start v2-bgload', location.href);
    state.settings = await store.getSettings();
    state.panelMode = state.settings.display.position || 'embed';

    // ★ 面板必须最先注入：字幕 fetch 可能很慢甚至挂起，绝不能阻塞面板出现
    if (state.settings.autoInsert) injectPanel();
    bindVideoEvents();
    listenCommands();
    if (state.settings.subtitleBar.enabled) ensureCaptionBubble();

    const saved = await store.getVideo(state.tid, state.vid);
    if (saved && saved.sources) {
      state.sources = saved.sources.map(s => ({ ...s, parsed: true, sentences: s.sentences || [] }));
      state.second = saved.second || {};
      state.chapters = saved.chapters || [];
      state.activeSource = saved.activeSource || 0;
      state.secondSource = typeof saved.secondSource === 'number' ? saved.secondSource : -1;
      pushState();
    }
    // 站点原生字幕：B站/YouTube 字幕 API 可能稍后才可用，异步加载 + 重试
    loadNativeSubtitles().catch(e => console.warn('[vc] loadNativeSubtitles error', e));
    if (!state.sources.length) {
      [2000, 5000, 9000].forEach(delay => setTimeout(() => {
        loadNativeSubtitles().catch(e => console.warn('[vc] retry error', e));
      }, delay));
    }
  }

  async function loadNativeSubtitles() {
    const before = state.sources.length;
    let native = [];
    if (state.site === 'bilibili') {
      // B站字幕.download 在后台完成（带 Referer、无 CORS 限制），最可靠
      try {
        const res = await chrome.runtime.sendMessage({ action: 'LOAD_BILI_SUBTITLES', bvid: state.tid });
        console.log('[vc] bg LOAD_BILI_SUBTITLES:', res && res.ok, 'sources:', res && res.sources && res.sources.length, res && res.error || '');
        if (res && res.diagnostics) console.log('[vc] bg diagnostics:', JSON.stringify(res.diagnostics));
        if (res && res.ok && res.sources) native = res.sources;
        if (res && res.needLogin) await VC.store.set({ needLoginSubtitle: true });
      } catch (e) { console.warn('[vc] bg subtitle load failed', e); }
    }
    if (!native.length) native = await adapter.subtitleSources();
    console.log('[vc] native sources:', native.length, native.map(n => n.url));
    for (const n of native) {
      // 后台已解析好 sentences，直接 push
      if (n.sentences && n.sentences.length) {
        if (!state.sources.some(s => s.key === n.key)) {
          state.sources.push({ key: n.key || n.url, name: n.name || n.lang, lang: n.lang || '', url: n.url || '', content: n.content || '', sentences: n.sentences });
        }
      } else {
        await addSource(n, false);
      }
    }
    const chapters = await adapter.chapters();
    if (chapters && chapters.length && !state.chapters.length) state.chapters = U.chaptersFromData(chapters);
    if (!state.chapters.length && state.sources.length) state.chapters = U.autoChapters(state.sources[state.activeSource].sentences, 5);
    if (state.sources.length > before) { await persistData(); pushState(); }
  }

  /* ---------- 添加/解析字幕源 ---------- */
  async function addSource(src, persist = true) {
    if (!src || (!src.content && !src.url && !src.file)) { console.log('[vc] addSource: empty src'); return; }
    let content = src.content;
    if (!content && src.url) {
      try {
        console.log('[vc] fetching subtitle url:', src.url);
        const resp = await fetch(src.url);
        console.log('[vc] subtitle fetch status:', resp.status);
        content = await resp.text();
        console.log('[vc] subtitle content length:', content ? content.length : 0, 'head:', content ? content.slice(0, 80) : '');
      } catch (e) {
        console.warn('[vc] direct fetch failed, try background proxy', src.url, e);
        try {
          const r = await chrome.runtime.sendMessage({ action: 'FETCH_TEXT', url: src.url });
          console.log('[vc] bg fetch result:', r && r.ok, r && r.status);
          if (r && r.ok) content = r.text;
        } catch (e2) { console.warn('[vc] bg fetch also failed', e2); }
      }
    }
    if (!content && src.file) {
      content = await new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsText(src.file); });
    }
    const sentencesRaw = U.parseSubtitle(content, src.file ? src.file.name : (src.url || ''));
    console.log('[vc] parsed raw sentences:', sentencesRaw.length);
    const sentences = state.settings && state.settings.smartPunctuation
      ? U.mergeSentences(sentencesRaw, src.lang || state.settings.lang)
      : sentencesRaw;
    console.log('[vc] merged sentences:', sentences.length);
    if (!sentences.length) { console.warn('[vc] addSource aborted: 0 sentences'); return; }
    const name = src.name || src.lang || `字幕 ${state.sources.length + 1}`;
    const key = src.url || name + ':' + sentences.length;
    if (state.sources.some(s => s.key === key)) return;
    state.sources.push({ key, name, lang: src.lang || '', url: src.url || '', content, sentences });
    if (persist) await persistData();
    pushState();
  }

  function persistData() {
    return store.saveVideo(state.tid, state.vid, {
      title: state.title, site: state.site,
      sources: state.sources.map(s => ({ key: s.key, name: s.name, lang: s.lang, url: s.url, content: s.content, sentences: s.sentences })),
      second: state.second, chapters: state.chapters,
      activeSource: state.activeSource, secondSource: state.secondSource
    });
  }

  /* ---------- 视频控制 ---------- */
  function video() { return document.querySelector('video'); }
  function currentSentences() { return (state.sources[state.activeSource] || {}).sentences || []; }
  function bindVideoEvents() {
    const v = video();
    if (!v) {
      // 视频尚未出现：定时重试绑定 + 校正嵌入位置
      let tries = 0;
      const t = setInterval(() => {
        repositionEmbedHost();
        if (video() || ++tries > 20) { clearInterval(t); if (video()) bindVideoEvents(); }
      }, 1000);
      return;
    }
    v.addEventListener('timeupdate', () => {
      const t = v.currentTime * 1000;
      const list = currentSentences();
      let idx = -1;
      for (let i = 0; i < list.length; i++) { if (list[i].fromMs <= t) idx = i; else break; }
      if (idx !== state.currentIdx) { state.currentIdx = Math.max(0, idx); pushState(); }
      if (Date.now() > pausedScrollUntil) updateBubble();
    });
    v.addEventListener('play', () => { state.playing = true; pushState(); updateBubble(); });
    v.addEventListener('pause', () => { state.playing = false; pushState(); updateBubble(); });
    // 监听 SPA 切换视频
    let last = location.href;
    setInterval(() => {
      if (location.href !== last) { last = location.href; location.reload(); }
    }, 1500);
    v.addEventListener('loadedmetadata', () => { if (!state.sources.length) init(); });
  }
  function jumpTo(idx) {
    const list = currentSentences();
    const s = list[idx];
    if (!s) return;
    const v = video();
    if (v) v.currentTime = s.fromMs / 1000;
    state.currentIdx = idx;
    pushState(); updateBubble();
  }
  function control(op, value) {
    const v = video();
    if (!v) return;
    switch (op) {
      case 'playpause': v.paused ? v.play() : v.pause(); break;
      case 'seek': v.currentTime = value; break;
      case 'volume': v.volume = Math.max(0, Math.min(1, v.volume + value)); break;
    }
  }

  /* ---------- 字幕悬浮条（B站特性，默认关闭，可在设置开启） ---------- */
  function ensureCaptionBubble() {
    if (captionBubble) return;
    captionBubble = document.createElement('div');
    captionBubble.className = 'vc-caption-bubble';
    (video() ? video().parentElement : document.body).appendChild(captionBubble);
  }
  function updateBubble() {
    if (!state.settings.subtitleBar.enabled) {
      if (captionBubble) captionBubble.style.display = 'none';
      return;
    }
    ensureCaptionBubble();
    const s = currentSentences()[state.currentIdx];
    captionBubble.style.display = s ? 'block' : 'none';
    if (!s) return;
    const b = state.settings.subtitleBar;
    captionBubble.innerHTML = `
      ${b.showChapterProgress ? `<div class="vc-cb-chapter">${U.chapterTitleAt(state.chapters, s.fromMs)}</div>` : ''}
      ${b.showSubtitle ? `<div class="vc-cb-text">${s.content}</div>` : ''}`;
  }

  /* ---------- 面板注入（三种显示模式） ---------- */
  // 找到适合"嵌入"的锚点：视频播放器容器之后，让面板进入页面内容流
  function findEmbedAnchor() {
    const sels = [
      '.bpx-player-container', '.bpx-player-wrap', '#playerWrap', '.video-container',
      '.player-wrap', '#bilibili-player', '.html5-player-container'
    ];
    for (const s of sels) {
      const el = document.querySelector(s);
      if (el) return el;
    }
    const v = document.querySelector('video');
    return v ? (v.closest('div') || v.parentElement) : null;
  }

  function ensureEmbedHost() {
    let host = document.getElementById('vc-embed-host');
    if (host) return host;
    host = document.createElement('div');
    host.id = 'vc-embed-host';
    const side = (state.settings.display && state.settings.display.panelSide) || 'right';
    if (side === 'left') host.classList.add('side-left');
    const anchor = findEmbedAnchor();
    if (anchor && anchor.parentElement) anchor.parentElement.insertBefore(host, anchor.nextSibling);
    else document.body.appendChild(host);
    return host;
  }
  // 视频元素可能晚于 content script 出现：定时把嵌入 host 移到正确的播放器容器后
  function repositionEmbedHost() {
    if (state.panelMode !== 'embed' || !state.frame) return;
    const host = document.getElementById('vc-embed-host');
    if (!host) return;
    const anchor = findEmbedAnchor();
    if (!anchor || !anchor.parentElement) return;
    const wantedNext = anchor.nextSibling;
    // 已经在正确位置则跳过
    if (host.previousSibling === anchor) return;
    anchor.parentElement.insertBefore(host, wantedNext);
  }

  function injectPanel() {
    // 只在顶层窗口注入面板，避免注入到 iframe 子帧里而不可见
    if (window !== window.top) { console.log('[vc] skip panel in iframe'); return; }
    if (state.panelMode === 'side') { openSidePanel(); return; } // 侧边栏用原生 sidePanel
    if (state.frame) return;
    const frame = document.createElement('iframe');
    frame.id = 'vc-panel-frame';
    frame.src = chrome.runtime.getURL('panel/panel.html') + '?token=' + encodeURIComponent(TOKEN);
    frame.dataset.token = TOKEN;
    state.frame = frame;
    mountFrame(frame);
    frame.addEventListener('load', () => {
      console.log('[vc] panel iframe loaded, mode=', state.panelMode);
      proto.init({ role: 'content', target: frame.contentWindow, token: TOKEN });
      pushState();
    });
    console.log('[vc] panel injected, mode=', state.panelMode);
  }

  // 把 iframe 挂到对应容器（嵌入进页面流 / 悬浮固定）
  function mountFrame(frame) {
    if (state.panelMode === 'embed') {
      const host = ensureEmbedHost();
      host.appendChild(frame);
    } else {
      document.body.appendChild(frame);
    }
  }
  function unmountFrame(frame) {
    if (frame && frame.parentElement) frame.parentElement.removeChild(frame);
  }
  function removePanel() {
    if (state.frame) { unmountFrame(state.frame); state.frame = null; }
  }
  function applyLayout() {
    const f = state.frame;
    if (!f) return;
    f.className = 'vc-panel mode-' + state.panelMode + (state.folded ? ' folded' : '');
    // 悬浮窗尺寸由设置决定
    const d = (state.settings && state.settings.display) || {};
    if (state.panelMode === 'float') {
      f.style.width = Math.max(300, Math.min(800, d.width || 420)) + 'px';
      if (!state.folded) f.style.height = Math.max(300, Math.min(1200, d.height || 520)) + 'px';
    } else {
      f.style.width = ''; f.style.height = '';
    }
    // 模式切换时重新挂载到正确容器
    const host = document.getElementById('vc-embed-host');
    if (state.panelMode === 'embed') {
      if (!host || !f.parentElement || f.parentElement.id !== 'vc-embed-host') mountFrame(f);
    } else if (f.parentElement && f.parentElement.id === 'vc-embed-host') {
      document.body.appendChild(f);
    }
  }
  applyLayout();

  // 侧边栏：原生 sidePanel（同时移除页面内 iframe）
  async function openSidePanel() {
    try {
      await chrome.runtime.sendMessage({ action: 'OPEN_SIDEPANEL' });
      console.log('[vc] side panel opened');
    } catch (e) { console.warn('[vc] open sidepanel failed', e); }
  }
  function closeSidePanel() {
    try { chrome.runtime.sendMessage({ action: 'CLOSE_SIDEPANEL' }); } catch (e) {}
  }
  // 应用显示模式（含 iframe <-> sidePanel 切换）
  async function setPanelMode(mode) {
    if (!['embed', 'float', 'side'].includes(mode)) return;
    if (state.panelMode === 'side' && mode !== 'side') closeSidePanel();
    state.panelMode = mode;
    if (mode === 'side') {
      removePanel();          // 移除页面内 iframe
      await openSidePanel();
    } else {
      if (!state.frame) injectPanel();
      else applyLayout();
    }
    pushState();
  }

  /* ---------- 协议处理 ---------- */
  async function statePayload() {
    return {
      site: state.site, title: state.title, tid: state.tid, vid: state.vid,
      sources: state.sources.map(s => ({ name: s.name, lang: s.lang })),
      activeSource: state.activeSource, secondSource: state.secondSource,
      second: state.second,
      sentences: currentSentences(),
      chapters: state.chapters,
      currentIdx: state.currentIdx, playing: state.playing,
      settings: state.settings,
      needLoginSubtitle: !!(await store.get('needLoginSubtitle', false)),
      panelMode: state.panelMode, folded: state.folded
    };
  }
  async function pushState() {
    const payload = await statePayload();
    proto.emit('STATE', payload);          // iframe 模式
    proto.pushEvent('STATE', payload);     // 侧边栏模式（chrome 广播）
    applyLayout();
  }
  function registerProtoHandlers() {
    proto.on('GET_STATE', () => statePayload());
    proto.on('JUMP_TO', p => { jumpTo(p.idx); return { ok: true }; });
    proto.on('JUMP_CHAPTER', p => {
      const idx = currentSentences().findIndex(s => s.fromMs >= p.ms);
      jumpTo(Math.max(0, idx)); return { ok: true };
    });
    proto.on('CONTROL', p => { control(p.op, p.value); return { ok: true }; });
    proto.on('SET_VIEW_MODE', async p => {
      await setPanelMode(p.mode);
      // 同步默认值到设置
      if (state.settings && state.settings.display) {
        state.settings.display.position = p.mode;
        await store.saveSettings(state.settings);
      }
      return { ok: true };
    });
    proto.on('TOGGLE_FOLD', () => { state.folded = !state.folded; applyLayout(); return { ok: true, folded: state.folded }; });
    proto.on('PAUSE_SCROLL', p => { pausedScrollUntil = Date.now() + (p.ms || 2000); return { ok: true }; });
    proto.on('SET_SOURCE', async p => {
      state.activeSource = p.idx;
      await persistData(); pushState(); return { ok: true };
    });
    proto.on('SET_SECOND', async p => {
      state.secondSource = p.idx;
      await persistData(); pushState(); return { ok: true };
    });
    proto.on('SET_SECOND_LINES', async p => {
      state.second = p.second || {};
      await persistData(); pushState(); return { ok: true };
    });
    proto.on('ADD_SECOND', async p => {
      let content = p.content;
      if (!content && p.url) content = await fetch(p.url).then(r => r.text());
      const arr = U.parseSubtitle(content, '');
      state.second = {};
      arr.forEach(s => { state.second[s.idx] = { content: s.content }; });
      await persistData(); pushState(); return { ok: true };
    });
    proto.on('TRANSLATE', async p => {
      const sentences = currentSentences();
      const res = await chrome.runtime.sendMessage({ action: 'AI_TRANSLATE', sentences, lang: p.lang });
      if (!res || !res.ok) return { ok: false, error: res && res.error || '翻译失败' };
      state.second = {};
      res.result.forEach((r, i) => { if (r && r.content) state.second[i] = { content: r.content }; });
      await persistData(); pushState(); return { ok: true };
    });
    proto.on('GEN_CHAPTERS', async p => {
      const res = await chrome.runtime.sendMessage({ action: 'GENERATE_CHAPTERS', sentences: currentSentences(), opts: p.opts || {} });
      if (!res || !res.ok) return { ok: false, error: res && res.error || '生成失败' };
      state.chapters = res.chapters;
      await persistData(); pushState(); return { ok: true };
    });
    proto.on('UPDATE_CHAPTERS', async p => { state.chapters = p.chapters; await persistData(); pushState(); return { ok: true }; });
    proto.on('REFRESH_SUBTITLES', async () => {
      console.log('[vc] manual refresh subtitles');
      await loadNativeSubtitles();
      await pushState();
      return { ok: true, count: state.sources.length };
    });
    proto.on('RESET_VIDEO', async () => {
      await store.clearVideo(state.tid, state.vid);
      state.sources = []; state.second = {}; state.chapters = []; state.activeSource = 0; state.secondSource = -1;
      const native = await adapter.subtitleSources();
      for (const n of native) await addSource(n, false);
      await persistData(); pushState(); return { ok: true };
    });
    proto.on('EXPORT', p => {
      const sentences = currentSentences();
      const text = U.exportText(sentences, {
        format: p.format, type: p.type, includeTime: p.includeTime,
        secondSub: p.includeSecond ? state.second : null,
        chapters: state.chapters, title: state.title, url: location.href,
        withoutWatermark: p.withoutWatermark, lang: state.settings.lang
      });
      return { ok: true, text };
    });
    proto.on('COPY_TEXT', async p => {
      const text = p.text || '';
      try {
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.left = '-9999px';
        document.body.appendChild(ta); ta.focus(); ta.select();
        const ok = document.execCommand('copy'); ta.remove();
        return { ok };
      } catch (e) { return { ok: false, error: String(e) }; }
    });
    proto.on('GET_SETTINGS', async () => { state.settings = await store.getSettings(); return { ok: true, settings: state.settings }; });
    proto.on('SAVE_SETTINGS', async p => { await store.saveSettings(p.settings); state.settings = p.settings; pushState(); return { ok: true }; });
    proto.on('TOGGLE_PANEL', () => { state.frame ? removePanel() : injectPanel(); return { ok: true }; });
    proto.on('OPEN_OPTIONS', async () => {
      try { await chrome.runtime.sendMessage({ action: 'OPEN_OPTIONS' }); }
      catch (e) { console.warn('[vc] open options failed', e); }
      return { ok: true };
    });
  }

  /* ---------- 捕获事件 ---------- */
  document.addEventListener(CAPTURE_EVENT, async e => {
    const { url, site, text } = e.detail || {};
    if (!text || !site) return;
    // YouTube：只保留当前视频（URL 中带 videoId 的 timedtext）
    if (site === 'youtube') {
      const vid = adapter.tid();
      if (vid && vid !== 'youtube' && !url.includes(vid)) return;
    }
    const lang = (url.match(/[?&]lang=([^&]+)/) || [])[1] || '';
    await addSource({ url, name: lang || 'CC 字幕', lang: decodeURIComponent(lang), content: text }, true);
    // 注意：字幕 JSON 的 body 是字幕行，不是章节，不要用它覆盖章节。
  });

  /* ---------- 浏览器快捷键 ---------- */
  function listenCommands() {
    chrome.runtime.onMessage.addListener(msg => {
      if (msg.action === 'SHORTCUT_EXPORT') {
        proto.emit('SHORTCUT_EXPORT', { kind: msg.kind });
      } else if (msg.action === 'TOGGLE_PANEL') {
        if (state.frame) removePanel(); else injectPanel();
      } else if (msg.action === 'PANEL_VISIBILITY') {
        // 侧边栏打开/关闭时同步
        if (msg.open) pushState();
      }
    });
  }

  // 注册协议处理器（供 iframe 与 sidepanel 两条通道共用）
  registerProtoHandlers();
  proto.listenChromeForHandlers();

  init();
})();
