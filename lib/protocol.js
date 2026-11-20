/* 分层通信协议：content script <-> panel（两种传输：iframe 用 postMessage，sidepanel 用 chrome 消息）。
 * 全局 VC.proto。用法：
 *   VC.proto.init({ role:'panel', token });                       // iframe 模式
 *   VC.proto.init({ role:'panel', transport:'chrome' });           // sidepanel 模式
 *   VC.proto.init({ role:'content', target: iframe.contentWindow, token }); // content 侧
 *   VC.proto.on('GET_STATE', handler);
 *   VC.proto.send('JUMP_TO', {idx}) -> Promise<响应>
 */
(function (root) {
  const VC = root.VC || (root.VC = {});
  const NS = 'vcap-clone';
  const handlers = {};
  const pending = {};
  let seq = 0;
  let ctx = { role: '', target: null, token: '', transport: 'postmsg' };
  let listening = false;
  let chromeListening = false;

  function init(opts) {
    ctx = Object.assign(ctx, opts);
    if (ctx.transport === 'chrome') {
      // sidepanel：经 chrome.runtime 接收 content 推来的事件
      if (!chromeListening && root.chrome && chrome.runtime && chrome.runtime.onMessage) {
        chrome.runtime.onMessage.addListener(onChromeMessage);
        chromeListening = true;
      }
      VC.proto.__ready = true;
      return;
    }
    if (ctx.token && ctx.token !== '__PENDING__') VC.proto.__ready = true;
    if (!listening) { root.addEventListener('message', onMessage); listening = true; }
  }

  function dispatch(type, action, payload, extra) {
    const h = handlers[action] || handlers['event:' + action];
    if (h) h(payload || {}, extra);
  }

  function onMessage(e) {
    if (e.source === root) return;
    const d = e.data;
    if (!d || d.ns !== NS || d.token !== ctx.token) return;
    if (d.type === 'req') {
      const h = handlers[d.action];
      Promise.resolve(h ? h(d.payload || {}, e.source) : { ok: false, error: 'no handler: ' + d.action })
        .then(result => ctx.target && ctx.target.postMessage({
          ns: NS, token: ctx.token, type: 'res', id: d.id, result
        }, '*'))
        .catch(err => ctx.target && ctx.target.postMessage({
          ns: NS, token: ctx.token, type: 'res', id: d.id,
          result: { ok: false, error: String(err && err.message || err) }
        }, '*'));
    } else if (d.type === 'res') {
      const p = pending[d.id];
      if (p) { delete pending[d.id]; p(d.result); }
    } else if (d.type === 'evt') {
      dispatch('evt', d.action, d.payload, e.source);
    }
  }

  function onChromeMessage(msg) {
    if (!msg || msg.__vcProto !== true) return;
    if (msg.type === 'evt') dispatch('evt', msg.action, msg.payload);
    else if (msg.type === 'res') {
      const p = pending[msg.id];
      if (p) { delete pending[msg.id]; p(msg.result); }
    }
  }

  function send(action, payload) {
    if (ctx.transport === 'chrome') {
      // sidepanel -> content（发给当前活动标签页）
      return new Promise(resolve => {
        if (!chrome || !chrome.tabs) return resolve({ ok: false, error: 'no tabs api' });
        chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
          if (!tabs || !tabs[0]) return resolve({ ok: false, error: 'no active tab' });
          chrome.tabs.sendMessage(tabs[0].id, {
            __vcProto: true, type: 'req', action, payload
          }, r => resolve(r || { ok: false, error: 'no response' }));
        });
      });
    }
    return new Promise(resolve => {
      const id = ++seq;
      pending[id] = resolve;
      ctx.target && ctx.target.postMessage({ ns: NS, token: ctx.token, type: 'req', id, action, payload }, '*');
      setTimeout(() => { if (pending[id]) { delete pending[id]; resolve({ ok: false, error: 'timeout' }); } }, 8000);
    });
  }

  function emit(action, payload) {
    if (ctx.transport === 'chrome') return; // sidepanel 无需主动 emit
    ctx.target && ctx.target.postMessage({ ns: NS, token: ctx.token, type: 'evt', action, payload }, '*');
  }

  // content 侧：让 chrome 消息也能命中已注册 handlers（供 sidepanel 调用）
  function listenChromeForHandlers() {
    if (chromeListening || !root.chrome || !chrome.runtime || !chrome.runtime.onMessage) return;
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || msg.__vcProto !== true || msg.type !== 'req') return false;
      const h = handlers[msg.action];
      Promise.resolve(h ? h(msg.payload || {}, sender) : { ok: false, error: 'no handler: ' + msg.action })
        .then(sendResponse)
        .catch(err => sendResponse({ ok: false, error: String(err && err.message || err) }));
      return true; // 异步响应
    });
    chromeListening = true;
  }

  function on(action, handler) { handlers[action] = handler; }
  function makeToken() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }

  VC.proto = { init, send, emit, on, makeToken, listenChromeForHandlers, pushEvent };
  // content 主动把事件推给 sidepanel（chrome.runtime 广播）
  function pushEvent(action, payload) {
    try {
      if (root.chrome && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({ __vcProto: true, type: 'evt', action, payload }, () => {
          // 忽略 "receiving end does not exist"（sidepanel 未打开时正常）
          if (chrome.runtime.lastError) void chrome.runtime.lastError;
        });
      }
    } catch (e) {}
  }
})(typeof window !== 'undefined' ? window : globalThis);
