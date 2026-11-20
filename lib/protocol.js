/* 分层通信协议：content script <-> panel iframe（postMessage + 请求/响应 Promise）。
 * 全局 VC.proto。用法：
 *   VC.proto.init({ role:'panel'|'content', target: iframe.contentWindow|window, token });
 *   VC.proto.on('GET_STATE', handler);
 *   VC.proto.send('JUMP_TO', {idx}) -> Promise<响应>
 */
(function (root) {
  const VC = root.VC || (root.VC = {});
  const NS = 'vcap-clone';
  const handlers = {};
  const pending = {};
  let seq = 0;
  let ctx = { role: '', target: null, token: '' };
  let listening = false;

  function init(opts) {
    ctx = Object.assign(ctx, opts);
    if (ctx.token && ctx.token !== '__PENDING__') VC.proto.__ready = true;
    if (!listening) { root.addEventListener('message', onMessage); listening = true; }
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
      // 兼容 on('X') 与 on('event:X') 两种注册方式
      const h = handlers[d.action] || handlers['event:' + d.action];
      if (h) h(d.payload || {});
    }
  }
  function send(action, payload) {
    return new Promise(resolve => {
      const id = ++seq;
      pending[id] = resolve;
      ctx.target && ctx.target.postMessage({ ns: NS, token: ctx.token, type: 'req', id, action, payload }, '*');
      setTimeout(() => { if (pending[id]) { delete pending[id]; resolve({ ok: false, error: 'timeout' }); } }, 8000);
    });
  }
  function emit(action, payload) {
    ctx.target && ctx.target.postMessage({ ns: NS, token: ctx.token, type: 'evt', action, payload }, '*');
  }
  function on(action, handler) { handlers[action] = handler; }
  function makeToken() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }

  VC.proto = { init, send, emit, on, makeToken };
})(typeof window !== 'undefined' ? window : globalThis);
