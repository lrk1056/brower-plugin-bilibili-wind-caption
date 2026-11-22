/* vCaptions 复刻 · 页面原型交互脚本 */
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove('show'), 1800);
  }

  /* ---------- demo data ---------- */
  const subtitles = [
    { t: 0,    time: '00:00.000', text: '大家好，今天我们来聊聊推荐系统的整体设计。', en: 'Hi everyone, today we will talk about recommender system design.', sp: 'Speaker 1' },
    { t: 6,    time: '00:06.000', text: '推荐系统本质上是在海量物品中，找到用户最可能感兴趣的那一个。', en: 'A recommender system finds the item a user is most likely interested in.' },
    { t: 14,   time: '00:14.000', text: '我们先从整体架构看起，通常分为召回、粗排、精排和重排四个阶段。', en: 'Let us start with the architecture: recall, pre-ranking, ranking and re-ranking.' },
    { t: 24,   time: '00:24.000', text: '召回阶段负责从全量物品池中快速筛出几百到几千个候选。', en: 'Recall quickly selects hundreds or thousands of candidates.' },
    { t: 204,  time: '03:24.000', text: '这一讲的重点是架构总览，我们先看三层结构是怎么协作的。', en: 'This lecture focuses on the architecture overview and the three-layer structure.', sp: 'Speaker 2' },
    { t: 212,  time: '03:32.000', text: '第一层是召回，它决定了推荐的上限；第二层是排序，决定了精度。', en: 'Recall decides the ceiling; ranking decides the precision.' },
    { t: 224,  time: '03:44.000', text: '第三层是重排，主要处理多样性、新鲜度和业务规则。', en: 'Re-ranking handles diversity, freshness and business rules.' },
    { t: 600,  time: '10:00.000', text: '常用的召回策略有协同过滤、向量召回和热点召回。', en: 'Common recall strategies: collaborative filtering, vector recall, hot recall.' },
    { t: 900,  time: '15:00.000', text: '排序模型方面，我们需要重点考虑特征工程和实时性。', en: 'For ranking models, feature engineering and real-time performance matter.' },
    { t: 1200, time: '20:00.000', text: '最后做一个总结，推荐系统是一个持续迭代的工程体系。', en: 'In summary, recommendation is an iteratively improving engineering system.' }
  ];

  let currentIdx = 4;      // 当前播放句
  let viewMode = 'list';   // list | article
  let multiSelect = false;
  let selected = new Set();
  let secondSub = false;
  let searchQuery = '';

  /* ---------- screen switching ---------- */
  $$('.nav-btn').forEach(btn => btn.addEventListener('click', () => {
    $$('.nav-btn').forEach(b => b.classList.toggle('active', b === btn));
    const screen = btn.dataset.screen;
    $$('.screen').forEach(s => s.classList.toggle('active', s.id === 'screen-' + screen));
  }));

  /* ---------- site select ---------- */
  $('#site-select').addEventListener('change', e => {
    const yt = e.target.value === 'youtube';
    $('#site-logo').textContent = yt ? 'YouTube' : 'bilibili';
    $('#panel-site-tag').textContent = yt ? 'YouTube' : 'Bilibili';
    $('#video-title').textContent = yt
      ? 'System Design Course · Lecture 1 (Example)'
      : '【示例视频】如何系统设计一个推荐系统 · 第 1 讲';
    toast(yt ? 'YouTube 适配器：拦截 CC 字幕' : 'Bilibili 适配器：读取官方字幕列表');
  });

  /* ---------- semantic paragraphs (用于全文视图) ---------- */
  const CHAPTER_TITLES = ['开场与背景', '架构总览', '召回策略', '排序模型', '总结与答疑'];
  function chapterTitleAt(t) {
    if (t < 204) return CHAPTER_TITLES[0];
    if (t < 600) return CHAPTER_TITLES[1];
    if (t < 900) return CHAPTER_TITLES[2];
    if (t < 1200) return CHAPTER_TITLES[3];
    return CHAPTER_TITLES[4];
  }
  // 演示策略：相邻字幕间隔 > 30 秒视为语义停顿，合并成一个段落
  function buildParagraphs() {
    const paras = [];
    let cur = null;
    subtitles.forEach((s, i) => {
      if (!cur || s.t - cur.endT > 30) {
        cur = { startIdx: i, startT: s.t, endT: s.t, items: [] };
        paras.push(cur);
      }
      cur.items.push({ s, i });
      cur.endT = s.t;
    });
    return paras;
  }

  /* ---------- render subtitles ---------- */
  function renderSubtitles() {
    if (viewMode === 'article') { renderArticle(); return; }
    const list = $('#subtitle-list');
    list.innerHTML = '';
    subtitles.forEach((s, i) => {
      const item = document.createElement('div');
      item.className = 'sub-item' + (i === currentIdx ? ' current' : '') + (selected.has(i) ? ' selected' : '');
      item.dataset.idx = i;
      const speaker = s.sp ? `<span class="sub-speaker">${s.sp}</span>` : '';
      const second = secondSub ? `<div class="sub-second">${s.en}</div>` : '';
      const hit = searchQuery && (s.text.includes(searchQuery) || s.en.toLowerCase().includes(searchQuery.toLowerCase()));
      item.innerHTML = `
        ${multiSelect ? `<input type="checkbox" class="sub-check" ${selected.has(i) ? 'checked' : ''}>` : ''}
        <span class="sub-time">${s.time}</span>
        <div class="sub-body">
          <div class="sub-text">${speaker}${hit ? mark(s.text) : s.text}</div>
          ${second}
        </div>`;
      item.addEventListener('click', e => {
        if (multiSelect && e.target.classList.contains('sub-check')) {
          e.target.checked ? selected.add(i) : selected.delete(i);
          updateSelCount();
          item.classList.toggle('selected', selected.has(i));
          return;
        }
        jumpTo(i);
      });
      list.appendChild(item);
    });
    $('#chip-count').textContent = `共 ${subtitles.length} 条`;
    if (multiSelect) updateSelCount();
  }

  /* ---------- render article (语义合并段落) ---------- */
  function renderArticle() {
    const list = $('#subtitle-list');
    list.innerHTML = '';
    const paras = buildParagraphs();
    paras.forEach(p => {
      const lastIdx = p.items[p.items.length - 1].i;
      const active = currentIdx >= p.startIdx && currentIdx <= lastIdx;
      const div = document.createElement('div');
      div.className = 'article-para' + (active ? ' active' : '');
      div.dataset.idx = p.startIdx;
      const body = p.items.map(({ s }) => s.text).join('');
      const enBody = p.items.map(({ s }) => s.en).join(' ');
      div.innerHTML = `
        <div class="para-head">
          <span class="para-title">${chapterTitleAt(p.startT)}</span>
          <span class="para-jump">点击跳转 ▸</span>
        </div>
        <p class="para-text">${searchQuery ? mark(body) : body}</p>
        ${secondSub ? `<p class="para-second">${enBody}</p>` : ''}`;
      div.addEventListener('click', () => jumpTo(p.startIdx));
      list.appendChild(div);
    });
    $('#chip-count').textContent = `${subtitles.length} 条 · ${paras.length} 段`;
  }
  function mark(text) {
    const q = searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return text.replace(new RegExp(q, 'gi'), m => `<mark>${m}</mark>`);
  }
  function jumpTo(i) {
    currentIdx = i;
    const s = subtitles[i];
    $('#fc-time').textContent = `${fmt(s.t)} / 24:36`;
    $('#fc-fill').style.width = (s.t / 1476 * 100).toFixed(1) + '%';
    $('#chapter-curr').textContent = currentChapterText(s.t);
    renderSubtitles();
    const selector = viewMode === 'article'
      ? `.article-para.active`
      : `.sub-item[data-idx="${i}"]`;
    const cur = $(selector);
    if (cur) cur.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    toast(`已跳转到 ${s.time}`);
  }
  function fmt(sec) {
    return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
  }
  function currentChapterText(t) {
    if (t < 204) return '第 1 / 5 章 · 开场与背景';
    if (t < 600) return '第 2 / 5 章 · 架构总览';
    if (t < 900) return '第 3 / 5 章 · 召回策略';
    if (t < 1200) return '第 4 / 5 章 · 排序模型';
    return '第 5 / 5 章 · 总结与答疑';
  }

  /* ---------- tabs ---------- */
  $$('.tab').forEach(tab => tab.addEventListener('click', () => {
    $$('.tab').forEach(t => t.classList.toggle('active', t === tab));
    $$('.tab-content').forEach(c => c.classList.toggle('hidden', c.dataset.content !== tab.dataset.tab));
    if (tab.dataset.tab === 'search') renderSearch();
  }));

  /* ---------- subtitle toolbar / view switch ---------- */
  function setView(mode) {
    viewMode = mode;
    const article = mode === 'article';
    $('#subtitle-list').classList.toggle('article-mode', article);
    $$('.view-seg button').forEach(b => b.classList.toggle('active', b.dataset.view === mode));
    $('#view-label').textContent = article ? '全文视图' : '字幕视图';
    // 全文视图：隐藏多选/展开折叠/搜索/回到当前，退出多选
    ['#btn-multiselect', '#btn-expand', '#btn-scroll', '.search-row'].forEach(sel => $(sel).classList.toggle('hidden', article));
    if (article && multiSelect) $('#btn-multiselect').click();
    $('#view-hint').textContent = article
      ? 'ⓘ 全文视图：句子按语义合并为段落，点击段落跳转；时间戳与多选仅在字幕视图显示'
      : 'ⓘ 字幕视图：每条带时间戳，点击跳转、可多选与展开折叠';
    renderSubtitles();
    toast('切换为' + (article ? '全文文章' : '字幕列表') + '视图');
  }
  $('#btn-view').addEventListener('click', () => setView(viewMode === 'list' ? 'article' : 'list'));
  $$('.view-seg button').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
  $('#btn-fold').addEventListener('click', () => $('#panel').classList.toggle('folded'));
  $('#btn-more').addEventListener('click', () => $('#modal-mask').classList.remove('hidden'));

  $('#btn-expand').addEventListener('click', () => toast('展开/折叠全部'));
  $('#btn-scroll').addEventListener('click', () => jumpTo(currentIdx));

  /* ---------- multiselect ---------- */
  function updateSelCount() { $('#sel-count').textContent = `已选 ${selected.size} / ${subtitles.length}`; }
  $('#btn-multiselect').addEventListener('click', e => {
    multiSelect = !multiSelect;
    if (!multiSelect) selected.clear();
    $('#multiselect-bar').classList.toggle('hidden', !multiSelect);
    e.target.textContent = multiSelect ? '退出多选' : '多选';
    renderSubtitles();
  });
  $('#btn-sel-all').addEventListener('click', () => { selected = new Set(subtitles.map((_, i) => i)); renderSubtitles(); });
  $('#btn-sel-none').addEventListener('click', () => { selected.clear(); renderSubtitles(); });
  $('#btn-sel-invert').addEventListener('click', () => { selected = new Set(subtitles.map((_, i) => i).filter(i => !selected.has(i))); renderSubtitles(); });
  $('#btn-sel-copy').addEventListener('click', () => toast(`已复制 ${selected.size} 条字幕`));
  $('#btn-sel-translate').addEventListener('click', () => toast(`已创建翻译任务，共 ${selected.size} 条字幕`));

  /* ---------- search ---------- */
  function renderSearch() {
    const q = $('#search-tab-input').value.trim();
    const box = $('#search-results');
    if (!q) {
      $('#search-count').textContent = '请输入关键词';
      box.innerHTML = '<div class="empty-state">输入关键词后在此显示匹配的字幕</div>';
      return;
    }
    const hits = subtitles.map((s, i) => ({ s, i })).filter(x => x.s.text.includes(q) || x.s.en.toLowerCase().includes(q.toLowerCase()));
    $('#search-count').textContent = `${hits.length} 条匹配`;
    box.innerHTML = hits.length
      ? hits.map(({ s, i }) => `<div class="search-hit" data-idx="${i}"><span class="t">${s.time}</span><div>${mark(s.text)}</div></div>`).join('')
      : '<div class="empty-state">未找到匹配的字幕</div>';
    $$('.search-hit', box).forEach(el => el.addEventListener('click', () => jumpTo(+el.dataset.idx)));
  }
  $('#btn-search').addEventListener('click', () => { searchQuery = $('#search-input').value.trim(); renderSubtitles(); toast('搜索：' + (searchQuery || '空')); });
  $('#btn-clear-search').addEventListener('click', () => { $('#search-input').value = ''; searchQuery = ''; renderSubtitles(); toast('已清除搜索'); });
  $('#search-tab-input').addEventListener('input', renderSearch);

  /* ---------- chapter ---------- */
  $('#btn-gen-chapter').addEventListener('click', () => toast('章节生成任务已创建（演示）'));
  $$('.chapter-item').forEach(el => el.addEventListener('click', () => {
    $$('.chapter-item').forEach(x => x.classList.toggle('active', x === el));
    jumpTo(+el.dataset.time === 0 ? 0 : subtitles.findIndex(s => s.t >= +el.dataset.time));
  }));
  $('#btn-prev-chapter').addEventListener('click', () => toast('跳转到上一章'));
  $('#btn-next-chapter').addEventListener('click', () => toast('跳转到下一章'));
  $('#btn-float-chapter').addEventListener('click', () => toast('悬浮章节列表：已开启（演示）'));

  /* ---------- translate ---------- */
  $('#chk-second').addEventListener('change', e => { secondSub = e.target.checked; renderSubtitles(); $('#chip-second').textContent = secondSub ? '第二字幕：英语' : '第二字幕：关闭'; });
  $('#btn-translate-now').addEventListener('click', () => {
    const p = $('#translate-progress');
    p.classList.remove('hidden');
    $('#translate-status').textContent = '翻译中';
    let pct = 0;
    clearInterval(window._trTimer);
    window._trTimer = setInterval(() => {
      pct += 10;
      $('#translate-fill').style.width = pct + '%';
      $('#translate-pct').textContent = pct + '%';
      if (pct >= 100) { clearInterval(window._trTimer); $('#translate-status').textContent = '已完成'; toast('翻译任务已完成'); }
    }, 400);
  });
  $('#btn-trans-pause').addEventListener('click', () => { clearInterval(window._trTimer); $('#translate-status').textContent = '已暂停'; toast('翻译已暂停'); });
  $('#btn-trans-retry').addEventListener('click', () => toast('已重试失败任务'));
  $('#btn-trans-delete').addEventListener('click', () => { $('#translate-progress').classList.add('hidden'); $('#translate-status').textContent = '未开始'; toast('译文已删除'); });
  $('#btn-chapter-translate').addEventListener('click', () => toast('章节翻译任务已创建'));

  /* ---------- download ---------- */
  function buildPreview() {
    const type = $('#dl-type').value;
    let out = `# 示例视频标题 · 字幕列表演示\n> https://www.bilibili.com/video/BVxxxx\n\n`;
    subtitles.forEach(s => {
      const line = type.startsWith('SRT') || type.startsWith('VTT') ? `${s.time} --> ${s.time}\n${s.text}` : `${s.time}  ${s.text}`;
      out += line + '\n';
    });
    if (type.startsWith('SRT')) out = subtitles.map((s, i) => `${i + 1}\n${s.time.replace('.', ',')} --> ${s.time.replace('.', ',')}\n${s.text}\n`).join('');
    if (type.startsWith('VTT')) out = 'WEBVTT\n\n' + subtitles.map((s, i) => `${i + 1}\n${s.time} --> ${s.time}\n${s.text}\n`).join('');
    return out.length > 1000 ? out.slice(0, 1000) + '\n…（内容过长，仅显示前 1000 字符）' : out;
  }
  $('#btn-preview').addEventListener('click', () => {
    $('#preview-box').classList.remove('hidden');
    $('#preview-text').textContent = buildPreview();
  });
  $('#btn-download').addEventListener('click', () => toast('下载成功（演示）'));
  $('#btn-copy').addEventListener('click', () => toast('复制成功（演示）'));
  $('#btn-copy-all').addEventListener('click', () => toast('已复制全部字幕'));
  $('#btn-quick-download').addEventListener('click', () => toast('快捷下载成功（演示）'));

  /* ---------- settings nav ---------- */
  $$('.settings-side a').forEach(a => a.addEventListener('click', () => {
    $$('.settings-side a').forEach(x => x.classList.toggle('active', x === a));
    $$('.settings-section').forEach(s => s.classList.toggle('hidden', s.dataset.section !== a.dataset.settings));
  }));

  /* ---------- shortcuts table ---------- */
  const shortcuts = [
    ['上一句 / 下一句', '← / →'], ['上一章 / 下一章', '未设置'],
    ['上/下翻页', '↑ / ↓'], ['播放/暂停', 'Space'],
    ['提高/降低音量', '未设置'], ['循环当前句', 'L'],
    ['复制当前句', 'C'], ['复制字幕', '未设置'],
    ['下载字幕', 'S'], ['折叠/展开', 'F'],
    ['显示/隐藏字幕条', 'B'], ['切换视图', 'V'],
    ['回到当前', 'R'], ['添加评论', '未设置']
  ];
  const table = $('#shortcut-table');
  table.innerHTML = shortcuts.map(([k, v]) => `<tr><td>${k}</td><td><kbd>${v}</kbd></td></tr>`).join('');
  $('#btn-reset-shortcuts').addEventListener('click', () => toast('已恢复默认快捷键'));

  /* ---------- modal ---------- */
  $('#tab-reorder').addEventListener('click', () => { $('#modal-mask').classList.remove('hidden'); });
  $('#modal-close').addEventListener('click', () => $('#modal-mask').classList.add('hidden'));
  $('#modal-mask').addEventListener('click', e => { if (e.target === $('#modal-mask')) $('#modal-mask').classList.add('hidden'); });
  $('#modal-save').addEventListener('click', () => { $('#modal-mask').classList.add('hidden'); toast('Tab 配置已保存'); });

  /* ---------- flow map ---------- */
  const flow = [
    ['1. 字幕获取与站点适配', 'P0', ['Bilibili 适配器：官方字幕列表', 'YouTube 适配器：CC 字幕拦截 / ytInitialData', '字幕刷新：重置缓存、语言偏好排序']],
    ['2. 字幕列表核心展示', 'P0', ['双视图：字幕列表 / 全文', '时间轴联动：点击跳转、高亮、跟随滚动', '搜索与筛选、行操作、智能标点、说话人标识']],
    ['3. 翻译与双语', 'P1', ['翻译服务：AI / Google / 小牛 / DeepL', '全量翻译、进度/暂停/重试/删除', '第二字幕双语对照', '多选批量：复制 / 翻译 / 修正翻译', '章节翻译']],
    ['4. 章节', 'P1', ['AI 生成（含描述 / 段落）与状态机', '章节列表 / 上下章 / 悬浮章节', '章节进度条与详情条', '删除章节']],
    ['5. 复制 / 下载 / 导出', 'P1', ['文稿(TXT/MD) / 全文 / SRT / VTT / LRC', '时间戳 / 结构 / 第二字幕 / 无水印', '下载中心预览、快捷按钮', '浏览器快捷键 Ctrl+Shift+C / D']],
    ['6. 显示形态与布局', 'P2', ['页面内嵌入', '字幕条（B站）', '网站配置、5 个 Tab 排序显隐', '自动插入 / 展开 / 折叠']],
    ['7. 技术架构（参考）', '—', ['Manifest V3：SW + options', 'BG ↔ 多内容脚本分层协议', '跨 iframe / SPA 监听', 'Redux + i18next + daisyUI']]
  ];
  $('#flow-grid').innerHTML = flow.map(([title, tag, items]) => `
    <div class="flow-card"><h3>${title}</h3><span class="tag">优先级 ${tag}</span>
      <ul>${items.map(i => `<li>${i}</li>`).join('')}</ul></div>`).join('');

  /* ---------- init ---------- */
  renderSubtitles();
  $('#fc-play').addEventListener('click', () => toast('播放/暂停（演示）'));
  $('#fc-cc').addEventListener('click', () => toast('CC 字幕开关（演示）'));
})();
