/* 站点适配器：仅支持 Bilibili。提取 tid、vid、标题、字幕轨道、章节、视频元素。
 * 全局 VC.adapters。*/
(function (root) {
  const VC = root.VC || (root.VC = {});
  const href = location.href;

  function param(name) {
    try { return new URLSearchParams(location.search).get(name); } catch (e) { return null; }
  }

  const bilibili = {
    id: 'bilibili',
    match: () => /bilibili\.com/i.test(href) || /b23\.tv/i.test(href),
    tid: () => {
      const aid = param('aid') || param('av') || (location.pathname.match(/\/av(\d+)/) || [])[1];
      const bv = (location.pathname.match(/(BV[0-9A-Za-z]{10})/) || [])[1];
      return bv || aid || 'bilibili';
    },
    vid: () => param('p') || '1',
    title: () => {
      const el = document.querySelector('h1.video-title, .video-title, h1[title], meta[property="og:title"]');
      return el ? (el.getAttribute('content') || el.textContent || '').trim() : (document.title || 'B站视频');
    },
    // 内容脚本在 isolated world 读不到页面 window.__INITIAL_STATE__，
    // 因此用 bvid 调公共 view 接口拿 aid/cid（无需登录、无跨域问题）。
    aidCid: async () => {
      let aid = param('aid') || (location.pathname.match(/\/av(\d+)/) || [])[1];
      let cid = param('cid');
      try {
        const st = root.__INITIAL_STATE__ || {};
        const vd = st.videoData || {};
        if (!aid) aid = vd.aid;
        if (!cid) cid = vd.cid;
      } catch (e) {}
      if (!aid || !cid) {
        const bv = (location.pathname.match(/(BV[0-9A-Za-z]{10})/) || [])[1];
        if (bv) {
          try {
            const res = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bv}`, { credentials: 'include' })
              .then(r => r.json());
            if (res && res.code === 0 && res.data) {
              aid = aid || res.data.aid;
              cid = cid || res.data.cid;
            }
          } catch (e) { console.warn('[vc] view api failed', e); }
        }
      }
      console.log('[vc] aidCid =>', aid, cid);
      return { aid, cid };
    },
    subtitleSources: async () => {
      const sources = [];
      const { aid, cid } = await bilibili.aidCid();
      console.log('[vc] bili subtitleSources aid/cid', aid, cid);
      // 1) 主动调用播放器 API（带页面 cookies，登录后可拿字幕列表）
      if (aid && cid) {
        try {
          const res = await fetch(`https://api.bilibili.com/x/player/wbi/v2?aid=${aid}&cid=${cid}`, { credentials: 'include' })
            .then(r => r.json());
          console.log('[vc] wbi/v2 code', res && res.code, 'subs', ((res.data||{}).subtitle||{}).subtitles?.length);
          if (res.data) VC.store.set({ needLoginSubtitle: !!res.data.need_login_subtitle });
          const subs = (res.data && res.data.subtitle && res.data.subtitle.subtitles) || [];
          subs.forEach(s => {
            const url = (s.subtitle_url || '').startsWith('//') ? 'https:' + s.subtitle_url : s.subtitle_url;
            let lang = s.lan || '';
            if (lang.startsWith('ai-')) lang = lang.slice(3); // B站 AI 字幕前缀
            if (url) sources.push({ url, lang, name: s.lan_doc || lang });
          });
        } catch (e) { console.warn('[vc] bili player api failed', e); }
      }
      // 2) 页面初始状态（部分页面把字幕列表内嵌于此）
      try {
        const st = root.__INITIAL_STATE__ || {};
        const list = (st.videoData && st.videoData.subtitle && st.videoData.subtitle.list)
          || (st.videoData && st.videoData.subtitle && st.videoData.subtitle.subtitles) || [];
        list.forEach(s => {
          const url = (s.subtitle_url || '').startsWith('//') ? 'https:' + s.subtitle_url : s.subtitle_url;
          if (url && !sources.some(x => x.url === url)) sources.push({ url, lang: s.lan, name: s.lan_doc || s.lan });
        });
      } catch (e) {}
      // 3) 被动捕获的 JSON 字幕
      try {
        const cap = await VC.store.get('capturedSubtitles', []);
        cap.forEach(c => { if (!sources.some(x => x.url === c.url)) sources.push({ url: c.url, lang: c.lang || '', name: c.lang || '捕获字幕', content: c.content }); });
      } catch (e) {}
      return sources;
    },
    chapters: async () => {
      try {
        const { aid, cid } = await bilibili.aidCid();
        if (aid && cid) {
          const res = await fetch(`https://api.bilibili.com/x/player/wbi/v2?aid=${aid}&cid=${cid}`, { credentials: 'include' })
            .then(r => r.json());
          const vp = ((res.data && res.data.view_points) || []).filter(v => v.type === 2);
          if (vp.length) return vp.map(v => ({
            title: v.title || '章节',
            description: '',
            startMs: Math.round((v.from || 0) * 1000)
          })).sort((a, b) => a.startMs - b.startMs);
        }
        const cap = await VC.store.get('capturedChapters', null);
        return cap && cap.bilibili ? cap.bilibili : [];
      } catch (e) { return []; }
    }
  };

  const fallback = {
    id: 'fallback', match: () => true,
    tid: () => 'local', vid: () => 'video',
    title: () => document.title || '视频',
    subtitleSources: async () => [],
    chapters: async () => []
  };

  function detect() {
    return bilibili.match() ? bilibili : fallback;
  }

  VC.adapters = { detect, bilibili, fallback };
})(typeof window !== 'undefined' ? window : globalThis);
