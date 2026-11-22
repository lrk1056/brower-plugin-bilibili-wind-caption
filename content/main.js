/* 内容脚本：捕获字幕 -> 解析 -> 管理状态 -> 注入面板 iframe -> 桥接协议 -> 控制页面播放。*/
(function () {
  if (window.__vcContentReady) return;
  window.__vcContentReady = true;
  const U = VC.util, store = VC.store, proto = VC.proto;
  const adapter = VC.adapters.detect();
  const TOKEN = proto.makeToken();
  const CAPTURE_EVENT = '__vc_capture_subtitle__';
  // 扩展被重载后，旧标签页里残留的内容脚本上下文已失效；所有定时行为立即停摆。
  function extAlive() {
    try { return !!(window.chrome && chrome.runtime && chrome.runtime.id); }
    catch (e) { return false; }
  }

  const state = {
    tid: adapter.tid(), vid: adapter.vid(),
    title: adapter.title(), site: adapter.id,
    sources: [],          // [{name,lang,url,content,parsed,sentences}]
    activeSource: 0,
    secondSource: -1,
    second: {},           // idx -> {content}
    chapters: [],
    danmaku: [],          // [{timeMs, sendTs, content}]
    settings: null,
    currentIdx: 0,
    playing: false,
    frame: null,
    panelMode: 'embed',
    folded: false,
    embedHeight: 0,       // 用户拖拽设定的嵌入高度；0 = 用默认高度
    autoScroll: true,
    lastHasSubtitle: null // 自动展开/折叠用的上一次"是否有字幕句"状态
  };
  // 嵌入高度范围：以字幕行数为准——默认最低显示 10 行、最高 15 行。
  // 单行高度 = 字号 × 行高 + .sub 上下 padding(14px)；chrome 为面板固定区域高度。
  // 同时不超过视口，避免面板溢出屏幕。
  function embedHeightRange() {
    const fs = Number((state.settings && state.settings.fontSize) || 13);
    const lh = Number((state.settings && state.settings.subLineHeight) || 1.55);
    const row = fs * lh + 14;
    const chrome = 250; // head/meta/章节条/tabs/工具栏/提示/底栏之和（约值）
    const MIN_ROWS = 10, MAX_ROWS = 15;
    const hardMax = Math.max(200, window.innerHeight - 24);
    let min = Math.round(chrome + row * MIN_ROWS);
    let max = Math.round(chrome + row * MAX_ROWS);
    max = Math.min(max, hardMax);
    if (min > max) min = max;
    return { min, max, rows: { min: MIN_ROWS, max: MAX_ROWS } };
  }
  let pausedScrollUntil = 0;
  let captionBubble = null;
  let initStarted = false;

  /* ---------- 持久化与恢复 ---------- */
  async function init() {
    if (initStarted) return;   // loadedmetadata 等事件会重复触发，必须只初始化一次
    initStarted = true;
    console.log('[vc] init start v2-bgload', location.href);
    state.settings = await store.getSettings();
    // 显示模式固定为嵌入（悬浮窗/侧边栏均已移除）：历史配置里的 float/side 一律回退为 embed。
    state.panelMode = 'embed';
    // 面板初始折叠态由"自动展开"开关决定：不勾选 → 默认折叠；勾选 → 默认展开。
    // 默认 autoExpand=true，故默认行为仍是展开，不影响既有体验。
    state.folded = !state.settings.autoExpand;
    // 恢复用户拖拽保存的嵌入高度（由 SET_EMBED_HEIGHT 写入 display.embedHeight）
    const savedH = Number((state.settings.display || {}).embedHeight);
    if (savedH > 0) state.embedHeight = savedH;

    // ★ 面板必须最先注入：字幕 fetch 可能很慢甚至挂起，绝不能阻塞面板出现
    if (state.settings.autoInsert) injectPanel();
    ensureLauncher(); // 面板关闭后仍可重新打开；autoInsert=false 时也有入口
    bindVideoEvents();
    listenCommands();
    watchSettingsChanges();
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
    // B站字幕 API 可能稍后才可用，异步加载 + 重试
    loadNativeSubtitles().catch(e => console.debug('[vc] loadNativeSubtitles error', e));
    if (!state.sources.length) {
      [2000, 5000, 9000].forEach(delay => setTimeout(() => {
        loadNativeSubtitles().catch(e => console.debug('[vc] retry error', e));
      }, delay));
    }
    // 弹幕异步加载（登录态下接口返回更全）
    loadDanmaku().catch(e => console.debug('[vc] loadDanmaku error', e));
    // 应用"隐藏官方弹幕"设置（默认关闭）
    applyOfficialDanmakuVisibility();
  }

  // 加载 B站弹幕（XML）
  async function loadDanmaku() {
    if (state.site !== 'bilibili') return;
    try {
      const { cid } = await adapter.aidCid();
      if (!cid) return;
      const res = await bgSend({ action: 'LOAD_BILI_DANMAKU', cid, bvid: state.tid });
      console.log('[vc] LOAD_BILI_DANMAKU:', res && res.ok, 'count:', res && res.list && res.list.length);
      if (res && res.ok && res.list) {
        state.danmaku = res.list;
        pushState();
      }
    } catch (e) { console.debug('[vc] loadDanmaku error', e); }
  }

  // 隐藏/显示 B站官方弹幕栏（默认关闭=显示官方弹幕）
  function applyOfficialDanmakuVisibility() {
    try {
      const hide = !!(state.settings && state.settings.hideOfficialDanmaku);
      let style = document.getElementById('vc-hide-danmaku-style');
      if (hide && !style) {
        style = document.createElement('style');
        style.id = 'vc-hide-danmaku-style';
        style.textContent = `
          .bpx-player-dm-wrap,.bpx-player-dm,.bpx-player-dm-view,.bpx-player-dm-surface,
          #danmukuBox,.bili-dm-wrap{display:none !important}
        `;
        (document.head || document.documentElement).appendChild(style);
      } else if (!hide && style) {
        style.remove();
      }
    } catch (e) {}
  }

  async function loadNativeSubtitles() {
    const before = state.sources.length;
    let native = [];
    if (state.site === 'bilibili') {
      // B站字幕.download 在后台完成（带 Referer、无 CORS 限制），最可靠
      try {
        const res = await bgSend({ action: 'LOAD_BILI_SUBTITLES', bvid: state.tid });
        console.log('[vc] bg LOAD_BILI_SUBTITLES:', res && res.ok, 'sources:', res && res.sources && res.sources.length, res && res.error || '');
        if (res && res.diagnostics) console.log('[vc] bg diagnostics:', JSON.stringify(res.diagnostics));
        if (res && res.ok && res.sources) native = res.sources;
        if (res && res.needLogin) await VC.store.set({ needLoginSubtitle: true });
      } catch (e) { console.debug('[vc] bg subtitle load failed', e); }
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
    if (state.sources.length > before) await persistData();
    // 无论是否拿到字幕都要推一次状态：无字幕时也必须让 syncAutoFold 执行折叠判断
    pushState();
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
        console.debug('[vc] direct fetch failed, try background proxy', src.url, e);
        try {
          const r = await bgSend({ action: 'FETCH_TEXT', url: src.url });
          console.log('[vc] bg fetch result:', r && r.ok, r && r.status);
          if (r && r.ok) content = r.text;
        } catch (e2) { console.debug('[vc] bg fetch also failed', e2); }
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
    if (!sentences.length) { console.debug('[vc] addSource: no sentences in payload'); return; }
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
  let hrefWatchStarted = false;
  // 只按“视频身份”判断：BV/av 号 + 分 P。忽略 spm_id_from / vd_source 等追踪参数，
  // 否则 B站切集或追加埋点参数会被误判为换片，触发整页 reload 让面板反复消失重建。
  function videoIdentity() {
    const bv = (location.pathname.match(/(BV[0-9A-Za-z]{10}|\/av\d+)/) || [])[1] || location.pathname;
    let p = '1';
    try { p = new URLSearchParams(location.search).get('p') || '1'; } catch (e) {}
    return bv + '|p=' + p;
  }
  function watchVideoSwitch() {
    if (hrefWatchStarted) return;
    // 只在顶层页面判断换片：iframe 里也执行会导致 iframe 被 reload（页面闪烁/二次刷新观感）
    if (window !== window.top) return;
    hrefWatchStarted = true;
    let last = videoIdentity();
    setInterval(() => {
      if (!extAlive()) return;
      const now = videoIdentity();
      if (now === last) return;
      last = now;
      // 仅当与当前状态记录的视频身份不同才重建，避免 URL 抖动引发无谓重建/闪烁
      if (now === stateIdentity()) return;
      // 仅处理视频页身份（含 BV/av），SPA 跳到首页等非视频页不做重建
      if (!/(BV[0-9A-Za-z]{10}|\/av\d+)/.test(now)) return;
      handleVideoSwitch();
    }, 1500);
  }
  function stateIdentity() {
    return `${state.tid}|p=${state.vid || '1'}`;
  }

  // 站内切换视频/分P：原地重置状态并重新拉取，绝不 location.reload()（避免整页二次刷新）
  let switchingVideo = false;
  async function handleVideoSwitch() {
    if (switchingVideo) return;
    switchingVideo = true;
    try {
      await new Promise(r => setTimeout(r, 350)); // 等 B站 SPA 更新标题/URL
      // 二次确认：延迟后仍未回到当前身份，才认定为真正换片
      if (videoIdentity() === stateIdentity()) return;
      state.tid = adapter.tid();
      state.vid = adapter.vid();
      state.title = adapter.title();
      state.sources = [];
      state.chapters = [];
      state.danmaku = [];
      state.second = {};
      state.secondSource = -1;
      state.activeSource = 0;
      state.currentIdx = 0;
      state.lastHasSubtitle = null; // 重新判定自动展开/折叠
      const saved = await store.getVideo(state.tid, state.vid);
      if (saved && saved.sources) {
        state.sources = saved.sources.map(s => ({ ...s, parsed: true, sentences: s.sentences || [] }));
        state.second = saved.second || {};
        state.chapters = saved.chapters || [];
        state.activeSource = saved.activeSource || 0;
        state.secondSource = typeof saved.secondSource === 'number' ? saved.secondSource : -1;
      }
      bindVideoEvents();      // 换片后 video 元素可能被替换，重新绑定
      pushState();
      loadNativeSubtitles().catch(e => console.debug('[vc] switch subtitles error', e));
      loadDanmaku().catch(e => console.debug('[vc] switch danmaku error', e));
      console.log('[vc] video switched in place ->', state.tid, state.vid);
    } finally {
      switchingVideo = false;
    }
  }
  // 监听设置页跨标签改动，实时同步字幕条开关/自动折叠等，无需刷新视频页
  function watchSettingsChanges() {
    if (!extAlive() || !chrome.storage || !chrome.storage.onChanged) return;
    try {
      chrome.storage.onChanged.addListener(changes => {
        if (!extAlive() || !changes.settings || !changes.settings.newValue) return;
        const prevBar = !!(state.settings && state.settings.subtitleBar && state.settings.subtitleBar.enabled);
        state.settings = changes.settings.newValue;
        const nowBar = !!(state.settings.subtitleBar && state.settings.subtitleBar.enabled);
        if (nowBar) { ensureCaptionBubble(); updateBubble(); }
        else if (prevBar && captionBubble) captionBubble.style.display = 'none';
        applyOfficialDanmakuVisibility(); // 显示配置里勾选/取消隐藏官方弹幕即时生效
        pushState();
      });
    } catch (e) { console.debug('[vc] watchSettingsChanges skipped', e); }
  }

  let boundVideoEl = null;
  function bindVideoEvents() {
    watchVideoSwitch();
    const v = video();
    if (!v) {
      // 视频晚于 content script 出现：等待后再绑定（嵌入位置由全局定时校正负责）
      const t = setInterval(() => {
        if (video()) { clearInterval(t); bindVideoEvents(); }
      }, 500);
      return;
    }
    if (v === boundVideoEl) return; // 同一 video 元素只绑定一次，避免重复监听
    boundVideoEl = v;
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
    const parent = (video() && video().parentElement) || document.body;
    if (!parent) return; // document_start 早期 body 尚未就绪
    captionBubble = document.createElement('div');
    captionBubble.className = 'vc-caption-bubble';
    try { parent.appendChild(captionBubble); }
    catch (e) { captionBubble = null; }
  }
  function updateBubble() {
    if (!state.settings.subtitleBar.enabled) {
      if (captionBubble) captionBubble.style.display = 'none';
      return;
    }
    ensureCaptionBubble();
    if (!captionBubble) return; // body 尚未就绪，下次 timeupdate 再试
    const s = currentSentences()[state.currentIdx];
    captionBubble.style.display = s ? 'block' : 'none';
    if (!s) return;
    const b = state.settings.subtitleBar;
    captionBubble.innerHTML = `
      ${b.showChapterProgress ? `<div class="vc-cb-chapter">${U.chapterTitleAt(state.chapters, s.fromMs)}</div>` : ''}
      ${b.showSubtitle ? `<div class="vc-cb-text">${s.content}</div>` : ''}`;
  }

  /* ---------- 面板注入（三种显示模式） ---------- */
  // B站视频页：host 必须挂在 body（Vue 根节点 #app 之外），不能插进
  // .right-container-inner。后者是 B站 Vue 组件管理的子节点序列，插入外来节点
  // 会让 Vue 异步 patch 抛 HierarchyRequestError，中断推荐列表初始化（封面灰块）。
  // 视觉位置由 positionSideColumnHost() 用文档坐标 + CSS 预留空白实现。
  function findEmbedAnchor() {
    if (state.site === 'bilibili') {
      const right = document.querySelector('.right-container-inner');
      // 右栏尚未渲染：等下一轮，不退化到视频窗口
      if (!right || !right.isConnected) return null;
      return { container: document.body, before: null, sideColumn: true, right };
    }
    // 其他站点：覆盖视频区域（保持原行为）
    const v = document.querySelector('video');
    if (v) {
      let el = v.parentElement;
      for (let i = 0; el && i < 4; i++, el = el.parentElement) {
        const r = el.getBoundingClientRect();
        if (r.width >= 240 && r.height >= 120) return { container: el, before: null, sideColumn: false };
      }
      if (v.parentElement) return { container: v.parentElement, before: null, sideColumn: false };
    }
    const dm = document.querySelector('.bpx-player-dm-wrap, .bpx-player-video-dm, #danmukuBox');
    if (dm) return { container: dm.parentElement || dm, before: null, sideColumn: false };
    const wrap = document.querySelector('.video-container, .player-wrap, #playerWrap');
    return wrap ? { container: wrap, before: null, sideColumn: false } : null;
  }

  // 让锚点成为定位上下文，并避免 overflow:hidden 裁掉面板
  function prepareEmbedAnchor(anchor, host) {
    const cs = getComputedStyle(anchor);
    if (cs.position === 'static') { host.dataset.anchorWasStatic = '1'; anchor.style.position = 'relative'; }
    if (cs.overflow === 'hidden' || cs.overflowX === 'hidden') { host.dataset.anchorOverflow = anchor.style.overflow; anchor.style.overflow = 'visible'; }
  }
  function restoreAnchor(anchor, host) {
    if (host.dataset.anchorWasStatic === '1') { anchor.style.position = ''; delete host.dataset.anchorWasStatic; }
    if (host.dataset.anchorOverflow !== undefined) { anchor.style.overflow = host.dataset.anchorOverflow; delete host.dataset.anchorOverflow; }
  }

  // 判断 host 是否还在正确的父容器。
  // B站 now 挂 body（Vue 根之外），只需确认父子关系；具体视口位置由
  // positionSideColumnHost() 负责，不再用 .rcmd-tab 子节点顺序判断，
  // 避免读取 Vue 正在 patch 的子节点序列。
  function isHostWellPlaced(host, container) {
    if (container === document.body) return true;
    const kids = Array.prototype.slice.call(container.children);
    const idx = kids.indexOf(host);
    if (idx < 0) return false;
    // 唯一必须修正的错位：被 B站重渲染挤到"推荐列表之后"（面板滑出可视区=消失）。
    // 刻意容忍 idx=0 与 idx=1 的差异（UP主卡片之前/之后都可见、都在弹幕列表上方），
    // 也不比较 before 节点身份——B站会频繁替换弹幕列表节点，严格比较会引发反复移动/iframe 重载/频闪。
    let rcmd = -1;
    for (let i = 0; i < kids.length; i++) {
      if (kids[i].classList && kids[i].classList.contains('rcmd-tab')) { rcmd = i; break; }
    }
    if (rcmd >= 0) return idx < rcmd;
    if (kids.length <= 1) return true;
    return idx < kids.length - 1;
  }

  // 检测布局形态：返回 'wide'（宽屏/网页全屏，栏目移到视频下方）或 'normal'（右栏在视频右侧）。
  // 用 video 与右栏的几何关系判断，比 class/宽度更可靠。
  function detectLayoutKind(right) {
    const video = document.querySelector('video');
    if (!video) return 'normal';
    const vr = video.getBoundingClientRect();
    const vw = window.innerWidth;
    // 1) 右栏与视频的几何关系（最可靠）
    if (right && right.isConnected) {
      const rr = right.getBoundingClientRect();
      // 右栏在视频右侧（常规布局）
      if (rr.left >= vr.right - 40 && rr.width < vw * 0.55) return 'normal';
      // 右栏在视频下方（宽屏重排）
      if (rr.top >= vr.bottom - 40) return 'wide';
      // 右栏与视频水平重叠 / 被视频容器包住 → 宽屏
      return 'wide';
    }
    // 2) 视频铺满视口宽度 → 宽屏
    if (vr.width >= vw * 0.82) return 'wide';
    // 3) B站宽屏类名
    const cls = ((document.body && document.body.className) || '') + ' ' +
      ((document.documentElement && document.documentElement.className) || '');
    if (/(^|\s)(widescreen|web-fullscreen|bpx-player-fullscreen|player-fullscreen)(\s|$)/i.test(cls)) return 'wide';
    return 'normal';
  }
  function isWideScreenMode(right) { return detectLayoutKind(right) === 'wide'; }

  // B站：把 body 上的 host 摆到"UP主卡片下方、弹幕列表上方"的预留空白里。
  // 只改 body/host 的样式和 CSS 变量，不增删 B站 Vue 容器内的任何节点。
  function positionSideColumnHost(target) {
    if (state.site !== 'bilibili' || state.panelMode !== 'embed' || !state.host) return;
    const doc = document.documentElement;
    if (!doc || !document.body) return;
    const right = (target && target.right && target.right.isConnected ? target.right : document.querySelector('.right-container-inner'));
    const wide = isWideScreenMode(right);
    document.body.classList.toggle('vc-bili-wide', wide); // 宽屏用不同的 CSS 预留策略
    const range = embedHeightRange();
    const height = state.folded ? 44 : Math.min(range.max, Math.max(range.min, state.embedHeight || range.min));
    doc.style.setProperty('--vc-embed-panel-height', height + 'px');
    doc.style.setProperty('--vc-embed-panel-space', (height + 12) + 'px');
    document.body.classList.add('vc-bili-embed-active');

    if (!right || !right.isConnected) {
      document.body.classList.add('vc-bili-embed-no-danmaku');
      return;
    }
    // 只在直接子节点里找弹幕模块，和 CSS margin 规则的选择器保持一致。
    let anchor = null;
    const kids = Array.prototype.slice.call(right.children);
    for (let i = 0; i < kids.length; i++) {
      const el = kids[i];
      if ((el.classList && (el.classList.contains('video-pod-above-modules') || el.classList.contains('danmaku-box'))) || el.id === 'danmukuBox') {
        anchor = el; break;
      }
    }
    const isDanmakuAnchor = !!anchor;
    if (!anchor) {
      for (let i = 0; i < kids.length; i++) {
        if (kids[i].classList && kids[i].classList.contains('rcmd-tab')) { anchor = kids[i]; break; }
      }
    }
    document.body.classList.toggle('vc-bili-embed-no-danmaku', !isDanmakuAnchor);

    const r = right.getBoundingClientRect();
    const up = right.querySelector('.up-panel-container');
    const vEl = document.querySelector('video');
    const vRect = vEl ? vEl.getBoundingClientRect() : null;
    let top;
    if (wide) {
      // 宽屏：右栏栏目已移到视频下方。面板放在"视频底部之后"，
      // 且与右栏第一个子栏目的预留 margin 对齐（该 margin 由 CSS 注入）。
      const firstChild = right.firstElementChild;
      const afterVideo = vRect ? vRect.bottom + window.scrollY + 12 : r.top + window.scrollY;
      top = Math.max(r.top + window.scrollY, afterVideo);
      if (firstChild) {
        const fcTop = firstChild.getBoundingClientRect().top + window.scrollY;
        // 第一个子栏目已带 --vc-embed-panel-space 的 margin，减回去就是空白起点
        const fcMarginTop = parseFloat(getComputedStyle(firstChild).marginTop) || 0;
        const contentStart = fcTop - fcMarginTop;
        top = Math.max(top, contentStart);
      }
    } else if (anchor) {
      // 常规：anchor 已含我们预留的 margin-top，减回去就是空白起点（UP主卡片下方）。
      top = anchor.getBoundingClientRect().top + window.scrollY - height - 12;
    } else if (up && up.parentElement === right) {
      top = up.getBoundingClientRect().bottom + window.scrollY + 12;
    } else {
      top = r.top + window.scrollY + 12;
    }
    // 宽度对齐右栏内容：宽屏/网页全屏时右栏会变宽甚至铺满，
    // 面板不应跟着变成整行，取一个与右栏栏目一致的合理宽度并靠右对齐。
    const NORMAL_W = 350;                 // 常规右栏宽度
    const MAX_W = 420;                    // 宽屏下面板最大宽度
    const colW = Math.max(1, r.width);
    // 以 UP主卡片（右栏内容实际左边界）为参考，确定内容区左缘
    let contentLeft = r.left;
    if (up && up.isConnected) contentLeft = up.getBoundingClientRect().left;
    const panelW = Math.min(MAX_W, Math.max(NORMAL_W, colW));
    let left;
    if (wide) {
      // 宽屏：右栏栏目在视频下方，面板与视频右缘对齐（栏目右边界），不覆盖视频
      left = vRect ? vRect.right - panelW : r.right - panelW;
    } else if (colW > NORMAL_W + 40) {
      // 常规但右栏偏宽：靠右栏右缘对齐
      left = r.right - panelW;
    } else {
      // 常规：与右栏内容左缘对齐
      left = contentLeft;
    }
    // 视口内夹紧，避免溢出屏幕
    left = Math.max(8, Math.min(left, window.innerWidth - panelW - 8));

    // ★ 兜底保护：绝不覆盖视频画面。若面板矩形与视频区域相交，强制移到视频底部之下。
    // 注意：left/top 此处仍是「文档坐标分量」（left 视口x + scrollX 后才写入样式），
    // 因此比较时统一换算成视口坐标（减去 scroll）避免混用。
    if (vRect && vRect.height > 0) {
      const panelLeftVp = left - window.scrollX;
      const panelTopVp = top - window.scrollY;
      const panelBottomVp = panelTopVp + height;
      const overlapsX = panelLeftVp < vRect.right - 20 && (panelLeftVp + panelW) > vRect.left + 20;
      const overlapsY = panelTopVp < vRect.bottom - 20 && panelBottomVp > vRect.top + 20;
      if (overlapsX && overlapsY) {
        top = vRect.bottom + window.scrollY + 12; // 移到视频下方（转回文档坐标）
        document.body.classList.add('vc-bili-wide'); // 按宽屏预留策略处理
      }
    }

    state.host.style.left = Math.round(left + window.scrollX) + 'px';
    state.host.style.top = Math.round(top) + 'px';
    state.host.style.width = Math.round(panelW) + 'px';
  }

  // 保证 host 在正确锚点、iframe 挂在其内。可被反复调用（幂等）。
  // 已就位时只刷新 B站定位样式，绝不移动 host（移动 iframe 会重载、频闪）。
  function ensureEmbedPlacement() {
    if (!extAlive()) return; // 上下文失效后停止一切 DOM 操作
    try { doEnsureEmbedPlacement(); }
    catch (e) { console.debug('[vc] embed placement skipped', e); }
  }
  function doEnsureEmbedPlacement() {
    if (state.panelMode !== 'embed' || !state.frame) return;
    const f = state.frame;
    const target = findEmbedAnchor();
    if (!target || !target.container || !target.container.isConnected) return;
    const { container } = target;
    let before = target.before;
    const wantSideClass = !!target.sideColumn;
    if (f === container || f.contains(container)) return;
    if (before && (before === f || f.contains(before))) before = null;

    let host = (state.host && state.host.isConnected) ? state.host : document.getElementById('vc-embed-host');
    // 防御：host 被塞进 iframe 内 / 与容器互为祖先，先摘除再重建
    if (host && (host === container || host.contains(container))) { host.remove(); host = null; }

    // 是否已就位：连接 + 父容器 + 模式类 + 位置（B站文档流模式才校验位置）
    const structurallyOK = host && host.isConnected && host.parentElement === container &&
      host.classList.contains('vc-side-column') === wantSideClass;
    const inPlace = structurallyOK && (!wantSideClass || isHostWellPlaced(host, container));
    if (inPlace) {
      // 只保证 iframe 在 host 内；绝不移动 host（移动会重载 iframe）。
      if (f.parentElement !== host && !f.contains(host)) {
        try { host.appendChild(f); } catch (e) { console.debug('[vc] reattach skipped', e); }
      }
      if (wantSideClass) positionSideColumnHost(target);
      return;
    }

    // before 兜底：目标弹幕列表缺失时，尽量插到 UP主卡片之后，避免落到右栏最顶部。
    if (!before || before.parentElement !== container) {
      const up = container.querySelector('.up-panel-container');
      before = (up && up.parentElement === container && up.nextElementSibling) || null;
    }

    // host 结构正确但位置被 B站挤歪：复用 host 原位移动，不重建、不摘 iframe（尽量少重载）。
    if (structurallyOK) {
      try {
        if (before && before.parentElement === container && before !== host) container.insertBefore(host, before);
        else if (!before && container.lastElementChild !== host) container.appendChild(host);
        if (f.parentElement !== host && !f.contains(host)) host.appendChild(f);
        state.host = host;
        if (wantSideClass) positionSideColumnHost(target);
      } catch (e) { console.debug('[vc] reposition skipped', e); }
      return;
    }

    // 需要搬迁/重建：先把 iframe 摘下，移动 host 时才不会出现层级环
    try { if (f.parentElement) f.parentElement.removeChild(f); }
    catch (e) { console.debug('[vc] detach frame failed', e); return; }
    if (host && host.isConnected) {
      const old = host.parentElement;
      if (old && old !== document.body) restoreAnchor(old, host);
      host.remove();
    }

    host = document.createElement('div');
    host.id = 'vc-embed-host';
    if (wantSideClass) {
      host.classList.add('vc-side-column');
    } else {
      prepareEmbedAnchor(container, host);
    }
    try {
      if (before && before.parentElement === container) container.insertBefore(host, before);
      else container.appendChild(host);
      host.appendChild(f); // appendChild 会自动把 f 从旧父节点移过来，无需预先 removeChild
    } catch (e) {
      console.debug('[vc] embed mount failed', e);
      return;
    }
    state.host = host;
    if (wantSideClass) positionSideColumnHost(target);
  }

  function injectPanel() {
    // 只在顶层窗口注入面板，避免注入到 iframe 子帧里而不可见
    if (window !== window.top) { console.log('[vc] skip panel in iframe'); return; }
    if (state.frame) return;
    let panelUrl;
    try { panelUrl = chrome.runtime.getURL('panel/panel.html'); }
    catch (e) { console.debug('[vc] extension context invalid', e); return; }
    const frame = document.createElement('iframe');
    frame.id = 'vc-panel-frame';
    frame.src = panelUrl + '?token=' + encodeURIComponent(TOKEN);
    frame.dataset.token = TOKEN;
    state.frame = frame;
    mountFrame(frame);
    applyLayout(); // 挂载后立即套用模式样式，不等 iframe load（load 晚到或被阻塞时也能显示）
    frame.addEventListener('load', () => {
      console.log('[vc] panel iframe loaded, mode=', state.panelMode);
      proto.init({ role: 'content', target: frame.contentWindow, token: TOKEN });
      pushState();
    });
    console.log('[vc] panel injected, mode=', state.panelMode);
    syncLauncher();
  }

  // 把 iframe 挂到对应容器（页面内嵌入面板）
  function mountFrame(frame) {
    if (state.panelMode === 'embed') {
      ensureEmbedPlacement();
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

  /* ---------- 面板关闭 / 重开：页面右下角常驻 launcher ----------
     面板内「×」关闭后，或 autoInsert=false 时，用户仍能重新打开。 */
  let launcher = null;
  function ensureLauncher() {
    if (launcher) return;
    if (!document.body) { // document_start 注入时 body 可能还不存在，稍后重试
      if (extAlive()) setTimeout(ensureLauncher, 200);
      return;
    }
    launcher = document.createElement('button');
    launcher.id = 'vc-launcher';
    launcher.type = 'button';
    launcher.textContent = '字';
    launcher.title = '打开 WindCaption 字幕面板';
    launcher.setAttribute('aria-label', '打开 WindCaption 字幕面板');
    launcher.addEventListener('click', () => { openPanel(); });
    try { document.body.appendChild(launcher); }
    catch (e) { launcher = null; return; }
    syncLauncher();
  }
  function syncLauncher() {
    if (launcher) launcher.classList.toggle('show', !state.frame);
  }
  function openPanel() {
    injectPanel();
    syncLauncher();
    pushState();
    return { ok: true, open: true };
  }
  function closePanel() {
    if (state.frame) removePanel();
    syncLauncher();
    pushState();
    return { ok: true, open: false };
  }
  function togglePanel() {
    return state.frame ? closePanel() : openPanel();
  }
  function applyLayout() {
    const f = state.frame;
    // B站预留空白只在面板真实存在时启用；关闭面板后立即撤销。
    if (document.body) {
      document.body.classList.toggle('vc-bili-embed-active', state.site === 'bilibili' && !!f);
      if (!(state.site === 'bilibili' && !!f)) {
        document.body.classList.remove('vc-bili-embed-no-danmaku');
      }
    }
    if (!f) return;
    f.className = 'vc-panel mode-embed' + (state.folded ? ' folded' : '');
    // 尺寸与定位完全交给 CSS，清掉历史 float 残留的内联样式。
    f.style.width = ''; f.style.height = '';
    f.style.left = ''; f.style.top = ''; f.style.right = '';
    ensureEmbedPlacement();
  }
  applyLayout();

  // B站播放器异步渲染、切片时会替换 DOM 节点；持续校正嵌入位置。
  // 仅 embed 模式且有 frame 时生效，其他页面/模式零副作用。
  setInterval(ensureEmbedPlacement, 1000);
  window.addEventListener('pageshow', e => { if (e.persisted) ensureEmbedPlacement(); });
  window.addEventListener('resize', () => {
    if (state.site === 'bilibili') ensureEmbedPlacement();
  });

  /* ---------- 协议处理 ---------- */
  async function statePayload() {
    return {
      site: state.site, title: state.title, tid: state.tid, vid: state.vid,
      sources: state.sources.map(s => ({ name: s.name, lang: s.lang })),
      activeSource: state.activeSource, secondSource: state.secondSource,
      second: state.second,
      sentences: currentSentences(),
      chapters: state.chapters,
      danmaku: state.danmaku,
      currentIdx: state.currentIdx, playing: state.playing,
      settings: state.settings,
      needLoginSubtitle: !!(await store.get('needLoginSubtitle', false)),
      panelMode: state.panelMode, folded: state.folded,
      embedHeight: state.embedHeight, embedRange: embedHeightRange()
    };
  }
  // 自动展开/折叠：依据"是否有可显示字幕句"切换折叠态，受通用配置管控：
  //   autoExpand=true  → 有字幕时自动展开
  //   autoFold=true    → 无字幕 / 字幕消失时自动折叠
  // 边界变化或首次判定都会执行；字幕持续存在期间不反复覆盖用户手动折叠。
  function syncAutoFold() {
    const s = state.settings || {};
    const has = currentSentences().length > 0;
    const prev = state.lastHasSubtitle;
    const firstCheck = prev === null;
    if (firstCheck || prev !== has) {
      if (!has) {
        // 无字幕 / 字幕消失 → 折叠
        if (s.autoFold) state.folded = true;
      } else if (s.autoExpand) {
        // 有字幕 → 展开
        state.folded = false;
      }
      state.lastHasSubtitle = has;
    }
  }
  async function pushState() {
    syncAutoFold();
    const payload = await statePayload();
    proto.emit('STATE', payload);
    applyLayout();
    syncLauncher();                        // mode 切换/关闭后 launcher 显隐始终与面板一致
  }
  // 统一的后台消息封装：扩展被重载后 chrome.runtime 上下文失效，避免未捕获 Promise 异常
  async function bgSend(msg) {
    try { return await chrome.runtime.sendMessage(msg); }
    catch (e) { console.debug('[vc] bg message skipped', e); return null; }
  }
  function registerProtoHandlers() {
    proto.on('GET_STATE', () => statePayload());
    proto.on('JUMP_TO', p => { jumpTo(p.idx); return { ok: true }; });
    proto.on('JUMP_CHAPTER', p => {
      const idx = currentSentences().findIndex(s => s.fromMs >= p.ms);
      jumpTo(Math.max(0, idx)); return { ok: true };
    });
    proto.on('CONTROL', p => { control(p.op, p.value); return { ok: true }; });
    proto.on('SEEK_MS', p => {
      const v = video();
      if (v) v.currentTime = Math.max(0, (p.ms || 0) / 1000);
      return { ok: true };
    });
    proto.on('LOAD_DANMAKU', async () => { await loadDanmaku(); return { ok: true, count: state.danmaku.length }; });
    proto.on('TOGGLE_FOLD', async () => {
      state.folded = !state.folded;
      applyLayout();
      await pushState();   // 把最新 folded 广播给面板，折叠图标才能同步切换
      return { ok: true, folded: state.folded };
    });
    // 拖拽过程中的实时预览：只改 CSS 变量与定位，不写盘、不广播 STATE，避免列表重渲染/频闪。
    proto.on('PREVIEW_EMBED_HEIGHT', p => {
      const r = embedHeightRange();
      let h = Number(p && p.height);
      if (!isFinite(h) || h <= 0) h = r.min;
      h = Math.round(Math.min(r.max, Math.max(r.min, h)));
      state.embedHeight = h;
      applyLayout();
      return { ok: true, height: h };
    });
    proto.on('SET_EMBED_HEIGHT', async p => {
      const r = embedHeightRange();
      let h = Number(p && p.height);
      if (!isFinite(h) || h <= 0) h = r.min;
      h = Math.round(Math.min(r.max, Math.max(r.min, h)));
      state.embedHeight = h;
      // 持久化到 display.embedHeight
      try {
        state.settings = state.settings || (await store.getSettings());
        state.settings.display = state.settings.display || {};
        state.settings.display.embedHeight = h;
        await store.saveSettings(state.settings);
      } catch (e) { console.debug('[vc] save embed height skipped', e); }
      applyLayout();
      await pushState();
      return { ok: true, height: h, range: r };
    });
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
      const res = await bgSend({ action: 'AI_TRANSLATE', sentences, lang: p.lang });
      if (!res || !res.ok) return { ok: false, error: res && res.error || '翻译失败' };
      state.second = {};
      res.result.forEach((r, i) => { if (r && r.content) state.second[i] = { content: r.content }; });
      await persistData(); pushState(); return { ok: true };
    });
    proto.on('GEN_CHAPTERS', async p => {
      const res = await bgSend({ action: 'GENERATE_CHAPTERS', sentences: currentSentences(), opts: p.opts || {} });
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
    proto.on('CLOSE_PANEL', () => closePanel());
    proto.on('TOGGLE_PANEL', () => togglePanel());
    proto.on('OPEN_OPTIONS', async () => {
      try { await bgSend({ action: 'OPEN_OPTIONS' }); }
      catch (e) { console.debug('[vc] open options failed', e); }
      return { ok: true };
    });
  }

  /* ---------- 捕获事件 ---------- */
  document.addEventListener(CAPTURE_EVENT, async e => {
    const { url, site, text } = e.detail || {};
    if (!text || !site) return;
    const lang = (url.match(/[?&]lang=([^&]+)/) || [])[1] || '';
    await addSource({ url, name: lang || '字幕', lang: decodeURIComponent(lang), content: text }, true);
    // 注意：字幕 JSON 的 body 是字幕行，不是章节，不要用它覆盖章节。
  });

  /* ---------- 浏览器快捷键 ---------- */
  function listenCommands() {
    try { chrome.runtime.onMessage.addListener(msg => {
      if (msg.action === 'SHORTCUT_EXPORT') {
        proto.emit('SHORTCUT_EXPORT', { kind: msg.kind });
      } else if (msg.action === 'TOGGLE_PANEL') {
        togglePanel();
      }
    }); } catch (e) { console.debug('[vc] listenCommands failed', e); }
  }

  registerProtoHandlers();

  init().catch(e => console.debug('[vc] init failed', e));
})();
