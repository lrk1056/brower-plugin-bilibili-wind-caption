/* MAIN world：拦截 fetch/XHR 响应，识别字幕资源并通过 DOM CustomEvent 转发给内容脚本。
 * 只观察，不修改原请求。 */
(function () {
  const EVENT = '__vc_capture_subtitle__';
  const isSubtitleUrl = url => {
    if (!url) return null;
    // B站 JSON 字幕 / 字幕列表
    if (/bilibili/i.test(location.hostname)) {
      // 语言包 i18n/*.json 不是字幕，不再捕获
      if (/i18n\//i.test(url)) return null;
      if (/subtitle|\.vtt/i.test(url)) return 'bilibili';
    }
    // YouTube timedtext
    if (/youtube/i.test(location.hostname) || /youtube/i.test(url)) {
      if (/timedtext|api\/timedtext|caption/i.test(url)) return 'youtube';
    }
    return null;
  };
  // 只放行“确实像字幕”的响应，避免把语言包 / 接口配置 JSON 当字幕转发，
  // 否则内容脚本解析出 0 句会不断产生警告噪音。
  function looksLikeSubtitle(text) {
    if (/WEBVTT|-->|^\[\d+:\d+/m.test(text.slice(0, 400))) return true; // VTT / SRT / LRC
    if (!/^\s*[{[]/.test(text)) return false;
    try {
      const j = JSON.parse(text);
      const arr = Array.isArray(j) ? j : (j.body || j.subtitles || j.events);
      return Array.isArray(arr) && arr.length > 0 &&
        arr.some(x => x && (x.content != null || x.text != null || Array.isArray(x.segs)));
    } catch (e) { return false; }
  }
  function emit(url, body, site) {
    let text = body;
    const isYtXml = /timedtext/i.test(url) && /<transcript>/.test(text);
    if (isYtXml) {
      // XML 字幕 -> 提取文本行
      const lines = [...text.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)].map(m =>
        (m[1] || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/<[^>]+>/g, '').trim()
      ).filter(Boolean);
      text = lines.join('\n');
    }
    if (!text || text.length < 2 || text.length > 2_000_000) return;
    if (!isYtXml && !looksLikeSubtitle(text)) return;
    document.dispatchEvent(new CustomEvent(EVENT, { detail: { url, site, text } }));
  }

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const site = isSubtitleUrl(url);
    return origFetch.apply(this, arguments).then(async res => {
      if (site) {
        try { const clone = res.clone(); emit(url, await clone.text(), site); } catch (e) {}
      }
      return res;
    });
  };

  // ★ 不能替换全局 XMLHttpRequest 构造函数：B站用 instanceof 等检测 XHR 实例，
  //   替换后 UP 主按钮接口失败，按钮永久停在灰色骨架态（充电/关注消失）。
  //   只在原生 prototype 上挂只读 hook，保留原生 instanceof 与构造行为。
  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;
    XHR.prototype.open = function (method, u) {
      try { this.__vcUrl = String(u || ''); } catch (e) {}
      return origOpen.apply(this, arguments);
    };
    XHR.prototype.send = function () {
      try {
        if (!this.__vcHookAdded) {
          this.__vcHookAdded = true;
          this.addEventListener('load', function () {
            const url = this.__vcUrl || '';
            const site = isSubtitleUrl(url);
            if (!site) return;
            // responseText 仅在 responseType 为 ''/'text' 时可读，否则会抛 InvalidStateError
            if (this.responseType && this.responseType !== 'text') return;
            try { const text = this.responseText; if (text) emit(url, text, site); } catch (e) {}
          });
        }
      } catch (e) { /* 忽略：hook 失败不影响原请求 */ }
      return origSend.apply(this, arguments);
    };
  }
})();
