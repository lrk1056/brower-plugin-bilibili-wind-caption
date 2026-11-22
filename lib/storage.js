/* 本地存储封装：配置 + 按视频缓存。全局 window.VC.store。*/
(function (root) {
  const VC = root.VC || (root.VC = {});
  const area = (root.chrome && chrome.storage) ? chrome.storage.local : null;

  const DEFAULTS = {
    settings: {
      autoInsert: true,
      autoExpand: true,
      autoFold: true,
      smartPunctuation: true,
      hideOfficialDanmaku: false,
      lang: 'zh',
      theme: 'gray',
      themePinned: false,
      subLineHeight: 1.55,
      display: {},
      density: 'standard',
      fontSize: 15,
      subtitleBar: { enabled: false, position: 'bottom', showChapterProgress: true, showChapterDetail: true, showSubtitle: true },
      shortcut: {
        prevSentence: 'ArrowLeft', nextSentence: 'ArrowRight', prevChapter: '', nextChapter: '',
        prevPage: 'ArrowUp', nextPage: 'ArrowDown', togglePlayPause: ' ', volumeUp: '', volumeDown: '',
        loopSentence: 'l', copyCurrent: 'c', copySubtitle: '', downloadSubtitle: 's',
        toggleFold: 'f', toggleSubtitleBar: 'b', toggleView: 'v', resumeScrolling: 'r', addComment: ''
      },
      services: [],
      defaultAiService: '',
      defaultTranslateService: '',
      websiteConfigs: {},
      analytics: false
    }
  };

  function alive() {
    try { return !!(root.chrome && chrome.runtime && chrome.runtime.id && area); }
    catch (e) { return false; }
  }
  function get(key, fallback) {
    return new Promise(resolve => {
      if (!alive()) return resolve(fallback !== undefined ? fallback : null);
      try { area.get(key, data => resolve(data && data[key] !== undefined ? data[key] : fallback)); }
      catch (e) { resolve(fallback !== undefined ? fallback : null); }
    });
  }
  function set(obj) {
    return new Promise(resolve => {
      if (!alive()) return resolve();
      try { area.set(obj, resolve); } catch (e) { resolve(); }
    });
  }
  async function getSettings() {
    const saved = await get('settings', null);
    if (!saved) return JSON.parse(JSON.stringify(DEFAULTS.settings));
    // 浅合并 + 关键子项深合并
    const s = Object.assign({}, DEFAULTS.settings, saved);
    s.display = Object.assign({}, DEFAULTS.settings.display, saved.display || {});
    // 显示模式已固定嵌入：清理历史遗留的 position/panelSide/悬浮窗字段。
    delete s.display.position;
    delete s.display.panelSide;
    delete s.display.floatPos;
    delete s.display.width;
    delete s.display.height;
    s.subtitleBar = Object.assign({}, DEFAULTS.settings.subtitleBar, saved.subtitleBar || {});
    s.shortcut = Object.assign({}, DEFAULTS.settings.shortcut, saved.shortcut || {});
    // 界面语言固定中文：忽略历史保存值，始终使用默认 zh（智能标点 fallback 也用它）
    s.lang = 'zh';
    return s;
  }
  function saveSettings(settings) { return set({ settings }); }

  function videoKey(tid, vid) { return `v:${tid}:${vid}`; }
  function getVideo(tid, vid) { return get(videoKey(tid, vid), null); }
  function saveVideo(tid, vid, data) { return set({ [videoKey(tid, vid)]: data }); }
  function clearVideo(tid, vid) {
    return new Promise(resolve => {
      if (!alive()) return resolve();
      try { area.remove(videoKey(tid, vid), resolve); } catch (e) { resolve(); }
    });
  }

  VC.store = { DEFAULTS, get, set, getSettings, saveSettings, videoKey, getVideo, saveVideo, clearVideo };
})(typeof window !== 'undefined' ? window : globalThis);
