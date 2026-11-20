/* 设置页逻辑 */
(function () {
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const store = VC.store;
  let settings;

  function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('on'), 1600); }
  function uid() { return 'svc_' + Math.random().toString(36).slice(2, 8); }
  // 应用设置页主题（与面板一致：light/dark/auto）
  function applyPageTheme(theme) {
    let t = theme || 'auto';
    if (t === 'system') t = 'auto';
    if (!['light','dark','auto'].includes(t)) t = 'auto';
    document.documentElement.setAttribute('data-theme', t);
  }

  async function init() {
    settings = await store.getSettings();
    fill();
  }
  function fill() {
    const s = settings;
    $('#g-autoInsert').checked = !!s.autoInsert;
    $('#g-autoExpand').checked = !!s.autoExpand;
    $('#g-autoFold').checked = !!s.autoFold;
    $('#g-smartPunctuation').checked = !!s.smartPunctuation;
    $('#g-lang').value = s.lang || 'zh';
    $('#g-theme').value = s.theme || 'system';
    applyPageTheme(s.theme);
    $('#g-subtitleBar').checked = !!(s.subtitleBar && s.subtitleBar.enabled);

    $('#d-position').value = s.display.position || 'embed';
    $('#d-side').value = s.display.panelSide || 'right';
    $('#d-w').value = s.display.width || 420; $('#d-h').value = s.display.height || 520;
    $('#d-density').value = s.density || 'standard';
    $('#d-font').value = s.fontSize || 15;
    $('#d-striped').checked = !!s.striped;
    $('#b-chProgress').checked = s.subtitleBar.showChapterProgress !== false;
    $('#b-chDetail').checked = !!s.subtitleBar.showChapterDetail;
    $('#b-subtitle').checked = s.subtitleBar.showSubtitle !== false;

    $('#tab-toggles').innerHTML = Object.keys(SHORTCUT_TABS).map(k =>
      `<label><input type="checkbox" data-tab="${k}" ${s.tabs[k] !== false ? 'checked' : ''}> ${SHORTCUT_TABS[k]}</label>`).join('');
    renderServices();
  }
  const SHORTCUT_TABS = { chapter: '章节', translate: '翻译', subtitle: '字幕' };

  /* ---------- 服务 ---------- */
  function renderServices() {
    const box = $('#service-list');
    box.innerHTML = '';
    (settings.services || []).forEach(svc => {
      const card = document.createElement('div');
      card.className = 'service-card';
      card.innerHTML = `
        <div class="sh"><b>${svc.name || '未命名服务'}</b><span class="pill">${svc.enabled ? '已启用' : '已禁用'}</span></div>
        <input type="hidden" data-id="${svc.id}">
        <div class="row"><label>名称</label><input data-f="name" value="${esc(svc.name || '')}"></div>
        <div class="row"><label>类别</label><select data-f="category">
          <option value="translate" ${svc.category === 'translate' ? 'selected' : ''}>翻译服务</option>
          <option value="ai" ${svc.category === 'ai' ? 'selected' : ''}>AI 服务（章节用）</option>
        </select></div>
        <div class="row"><label>协议类型</label><select data-f="type">
          <option value="openai" ${svc.type === 'openai' ? 'selected' : ''}>OpenAI 兼容</option>
          <option value="gemini" ${svc.type === 'gemini' ? 'selected' : ''}>Gemini</option>
          <option value="google" ${svc.type === 'google' ? 'selected' : ''}>Google 翻译</option>
          <option value="niutrans" ${svc.type === 'niutrans' ? 'selected' : ''}>小牛翻译</option>
          <option value="deepl" ${svc.type === 'deepl' ? 'selected' : ''}>DeepL</option>
        </select></div>
        <div class="row"><label>API 地址</label><input data-f="baseUrl" value="${esc(svc.baseUrl || '')}" placeholder="https://api.openai.com/v1"></div>
        <div class="row"><label>API Key</label><input data-f="apiKey" type="password" value="${esc(svc.apiKey || '')}"></div>
        <div class="row"><label>模型</label><input data-f="model" value="${esc(svc.model || '')}" placeholder="gpt-4o-mini / deepseek-chat"></div>
        <div class="row"><label>extra_body</label><input data-f="extraBody" value="${esc(svc.extraBody || '')}" placeholder='{"key":"value"}'></div>
        <div class="ops"><button data-op="toggle">${svc.enabled ? '禁用' : '启用'}</button><button data-op="test">测试连通性</button><button class="del" data-op="del">删除</button></div>`;
      box.appendChild(card);
      card.querySelectorAll('[data-f]').forEach(el => el.addEventListener('change', () => {
        svc[el.dataset.f] = el.value.trim();
        if (el.dataset.f === 'name') card.querySelector('.sh b').textContent = svc.name || '未命名服务';
      }));
      card.querySelector('[data-op=toggle]').addEventListener('click', () => { svc.enabled = !svc.enabled; renderServices(); });
      card.querySelector('[data-op=del]').addEventListener('click', () => {
        settings.services = settings.services.filter(x => x.id !== svc.id); renderServices(); buildDefaultSelects();
      });
      card.querySelector('[data-op=test]').addEventListener('click', async () => {
        const res = await chrome.runtime.sendMessage({ action: 'TEST_AI', service: svc });
        toast(res && res.ok ? '连接成功' : ('连接失败：' + ((res && res.error) || '')));
      });
    });
    buildDefaultSelects();
  }
  function buildDefaultSelects() {
    const opts = (settings.services || []).filter(s => s.enabled).map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
    $('#default-ai').innerHTML = `<option value="">（自动）</option>` + opts;
    $('#default-translate').innerHTML = `<option value="">（自动）</option>` + opts;
    $('#default-ai').value = settings.defaultAiService || '';
    $('#default-translate').value = settings.defaultTranslateService || '';
  }
  function esc(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

  // 主题下拉实时预览
  $('#g-theme').addEventListener('change', e => applyPageTheme(e.target.value));

  $('#btn-add-service').addEventListener('click', () => {
    settings.services = settings.services || [];
    settings.services.push({ id: uid(), name: '新服务', category: 'ai', type: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: '', model: '', enabled: true });
    renderServices();
  });

  /* ---------- 导航 / 保存 ---------- */
  $$('.side a').forEach(a => a.addEventListener('click', () => {
    $$('.side a').forEach(x => x.classList.toggle('active', x === a));
    $$('.main section').forEach(s => s.classList.toggle('hidden', s.dataset.panel !== a.dataset.sec));
  }));
  $('#btn-save').addEventListener('click', async () => {
    settings.autoInsert = $('#g-autoInsert').checked;
    settings.autoExpand = $('#g-autoExpand').checked;
    settings.autoFold = $('#g-autoFold').checked;
    settings.smartPunctuation = $('#g-smartPunctuation').checked;
    settings.lang = $('#g-lang').value;
    settings.theme = $('#g-theme').value;
    settings.subtitleBar.enabled = $('#g-subtitleBar').checked;
    settings.subtitleBar.showChapterProgress = $('#b-chProgress').checked;
    settings.subtitleBar.showChapterDetail = $('#b-chDetail').checked;
    settings.subtitleBar.showSubtitle = $('#b-subtitle').checked;
    settings.display.position = $('#d-position').value;
    settings.display.panelSide = $('#d-side').value;
    settings.display.width = Math.max(300, Math.min(800, +$('#d-w').value || 420));
    settings.display.height = Math.max(300, Math.min(1200, +$('#d-h').value || 520));
    settings.density = $('#d-density').value;
    settings.fontSize = +$('#d-font').value || 15;
    settings.striped = $('#d-striped').checked;
    $$('#tab-toggles input').forEach(i => settings.tabs[i.dataset.tab] = i.checked);
    settings.defaultAiService = $('#default-ai').value;
    settings.defaultTranslateService = $('#default-translate').value;
    await store.saveSettings(settings);
    $('#save-status').textContent = '✓ 已保存 ' + new Date().toLocaleTimeString();
    toast('设置已保存');
  });
  $('#btn-reset-all').addEventListener('click', async () => {
    if (!confirm('确定恢复默认设置？')) return;
    await store.set({ settings: JSON.parse(JSON.stringify(store.DEFAULTS.settings)) });
    settings = await store.getSettings(); fill(); toast('已恢复默认');
  });

  /* 网站配置（展示当前标签页 URL） */
  if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.query) {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      $('#cur-url').textContent = tabs[0] ? tabs[0].url : '—';
    });
  }
  $('#btn-save-site').addEventListener('click', async () => {
    const url = $('#cur-url').textContent;
    if (!url || url === '—') return toast('无法获取当前页面');
    const u = new URL(url);
    const key = u.host + u.pathname;
    settings.websiteConfigs = settings.websiteConfigs || {};
    settings.websiteConfigs[key] = { position: $('#s-position').value };
    await store.saveSettings(settings);
    toast('已保存，刷新网页后生效');
  });

  init();
})();
