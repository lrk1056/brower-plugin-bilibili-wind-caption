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
      lang: 'zh',
      theme: 'auto',
      subLineHeight: 1.55,
      display: { position: 'embed', width: 420, height: 520, panelSide: 'right' },
      density: 'standard',
      fontSize: 15,
      striped: true,
      subtitleBar: { enabled: false, position: 'bottom', showChapterProgress: true, showChapterDetail: true, showSubtitle: true },
      tabs: { chapter: true, translate: true, subtitle: true },
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

  function get(key, fallback) {
    return new Promise(resolve => {
      if (!area) return resolve(fallback !== undefined ? fallback : null);
      area.get(key, data => resolve(data[key] !== undefined ? data[key] : fallback));
    });
  }
  function set(obj) {
    return new Promise(resolve => { if (area) area.set(obj, resolve); else resolve(); });
  }
  async function getSettings() {
    const saved = await get('settings', null);
    if (!saved) return JSON.parse(JSON.stringify(DEFAULTS.settings));
    // 浅合并 + 关键子项深合并
    const s = Object.assign({}, DEFAULTS.settings, saved);
    s.display = Object.assign({}, DEFAULTS.settings.display, saved.display || {});
    s.subtitleBar = Object.assign({}, DEFAULTS.settings.subtitleBar, saved.subtitleBar || {});
    s.shortcut = Object.assign({}, DEFAULTS.settings.shortcut, saved.shortcut || {});
    s.tabs = Object.assign({}, DEFAULTS.settings.tabs, saved.tabs || {});
    return s;
  }
  function saveSettings(settings) { return set({ settings }); }

  function videoKey(tid, vid) { return `v:${tid}:${vid}`; }
  function getVideo(tid, vid) { return get(videoKey(tid, vid), null); }
  function saveVideo(tid, vid, data) { return set({ [videoKey(tid, vid)]: data }); }
  function clearVideo(tid, vid) {
    return new Promise(resolve => { if (area) area.remove(videoKey(tid, vid), resolve); else resolve(); });
  }

  VC.store = { DEFAULTS, get, set, getSettings, saveSettings, videoKey, getVideo, saveVideo, clearVideo };
})(typeof window !== 'undefined' ? window : globalThis);
