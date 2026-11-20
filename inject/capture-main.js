/* MAIN world：拦截 fetch/XHR 响应，识别字幕资源并通过 DOM CustomEvent 转发给内容脚本。
 * 只观察，不修改原请求。 */
(function () {
  const EVENT = '__vc_capture_subtitle__';
  const isSubtitleUrl = url => {
    if (!url) return null;
    // B站 JSON 字幕 / 字幕列表
    if (/bilibili/i.test(location.hostname)) {
      if (/subtitle|i18n\/[a-z-]+\.json|vtt/i.test(url) && (/\.json|\.vtt/i.test(url) || /subtitle/i.test(url))) return 'bilibili';
    }
    // YouTube timedtext
    if (/youtube/i.test(location.hostname) || /youtube/i.test(url)) {
      if (/timedtext|api\/timedtext|caption/i.test(url)) return 'youtube';
    }
    return null;
  };
  function emit(url, body, site) {
    let text = body;
    if (/timedtext/i.test(url) && /<transcript>/.test(text)) {
      // XML 字幕 -> 提取文本行
      const lines = [...text.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)].map(m =>
        (m[1] || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/<[^>]+>/g, '').trim()
      ).filter(Boolean);
      text = lines.join('\n');
    }
    if (!text || text.length < 2 || text.length > 2_000_000) return;
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

  const OrigXHR = window.XMLHttpRequest;
  function PatchedXHR() {
    const xhr = new OrigXHR();
    let url = '';
    const origOpen = xhr.open;
    xhr.open = function (method, u) { url = String(u || ''); return origOpen.apply(this, arguments); };
    xhr.addEventListener('load', function () {
      const site = isSubtitleUrl(url);
      if (!site) return;
      // responseText 仅在 responseType 为 ''/'text' 时可读，否则会抛 InvalidStateError
      if (xhr.responseType && xhr.responseType !== 'text') return;
      try {
        const text = xhr.responseText;
        if (text) emit(url, text, site);
      } catch (e) { /* 忽略：非文本响应 */ }
    });
    return xhr;
  }
  PatchedXHR.prototype = OrigXHR.prototype;
  window.XMLHttpRequest = PatchedXHR;
})();
