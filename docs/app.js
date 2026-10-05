/* 论文汇总与对比平台 —— 主逻辑 */
(function () {
  'use strict';

  const KEY = 'paperhub.v1';
  const PAGE_FIELDS = [
    ['title', '题目'], ['authors', '作者'], ['year', '年代'], ['type', '期刊/论文类型'],
    ['source', '期刊/学校'], ['school', '学位授予单位'], ['major', '学科专业'],
    ['supervisor', '导师'], ['keywords', '关键词'], ['abstract', '摘要'],
    ['pages', '页数'], ['relevance', '与自己论文的相关性'], ['tags', '标签'],
    ['note', '备注'], ['fileName', '源文件名']
  ];
  // 表格默认列（较窄的一组）
  const COLS = [
    { k: '_cb', t: '', w: 34, fixed: true },
    { k: 'title', t: '题目', w: 300 },
    { k: 'authors', t: '作者', w: 100 },
    { k: 'year', t: '年代', w: 66 },
    { k: 'type', t: '期刊/论文类型', w: 150 },
    { k: 'source', t: '期刊/学校', w: 140 },
    { k: 'major', t: '学科专业', w: 100 },
    { k: 'keywords', t: '关键词', w: 190 },
    { k: 'pages', t: '页数', w: 56 },
    { k: 'relevance', t: '相关性', w: 66 },
    { k: 'tags', t: '标签', w: 110 },
    { k: '_act', t: '操作', w: 108, fixed: true }
  ];
  const CAT_CLASS = {
    '期刊论文': 'c-journal', '硕士学位论文': 'c-master', '博士学位论文': 'c-doctor',
    '会议论文': 'c-conf', '研究报告': 'c-report'
  };

  let papers = [];        // 全部文献
  let sel = new Set();    // 勾选的 id
  let cat = '';           // 当前分类
  let sortKey = 'addedAt', sortDir = -1;
  let editId = null;

  // ---------- 工具 ----------
  const $ = id => document.getElementById(id);
  const el = (t, c, x) => { const n = document.createElement(t); if (c) n.className = c; if (x != null) n.textContent = x; return n; };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let toastTimer;
  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.classList.add('on');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), 2600);
  }
  function setStatus(msg, cls) {
    const s = $('status'); s.textContent = msg || ''; s.className = 'status' + (cls ? ' ' + cls : '');
    if (!msg) setTimeout(() => { if (s.textContent === msg) { s.textContent = ''; s.className = 'status'; } }, 100);
  }
  const uid = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const sizeText = b => b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.round(b / 1024) + ' KB';

  // ---------- 存储 ----------
  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify({ papers, sel: [...sel] }));
    } catch (e) {
      // 摘要是长文本，撑爆配额时先丢摘要再试
      try {
        const lite = papers.map(p => Object.assign({}, p, { abstract: (p.abstract || '').slice(0, 200) }));
        localStorage.setItem(KEY, JSON.stringify({ papers: lite, sel: [...sel] }));
        toast('存储空间不足，已精简摘要后保存');
      } catch (e2) { toast('保存失败：浏览器存储空间不足'); }
    }
  }
  function load() {
    try {
      const d = JSON.parse(localStorage.getItem(KEY) || '{}');
      papers = Array.isArray(d.papers) ? d.papers : [];
      sel = new Set(d.sel || []);
    } catch (e) { papers = []; sel = new Set(); }
  }

  // ---------- PDF 解析 ----------
  let pdfjsP = null;
  function pdfjs() {
    if (!pdfjsP) {
      pdfjsP = import('./vendor/pdf.min.mjs').then(m => {
        m.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.mjs';
        return m;
      });
    }
    return pdfjsP;
  }

  async function handleFiles(files) {
    const list = [...files].filter(f => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
    if (!list.length) { toast('未发现 PDF 文件'); return; }
    const prog = $('prog'), bar = prog.querySelector('i');
    prog.style.display = 'block';
    const existing = new Set(papers.map(p => p.fileName + '|' + (p.fileSize || 0)));
    let ok = 0, skip = 0, fail = 0;
    const lib = await pdfjs();

    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      bar.style.width = Math.round((i) / list.length * 100) + '%';
      setStatus(`解析中 ${i + 1}/${list.length}`, 'busy');
      if (existing.has(f.name + '|' + f.size)) { skip++; continue; }
      try {
        const buf = await f.arrayBuffer();
        const doc = await lib.getDocument({ data: new Uint8Array(buf) }).promise;
        // 前 8 页足够拿到封面、版权页、摘要
        const n = Math.min(doc.numPages, 8);
        let txt = '';
        for (let p = 1; p <= n; p++) {
          const pg = await doc.getPage(p);
          const tc = await pg.getTextContent();
          txt += tc.items.map(x => x.str).join('\n') + '\n===PAGE===\n';
        }
        let meta = {};
        try { meta = (await doc.getMetadata()).info || {}; } catch (e) { }
        const r = window.PaperParser.parse(
          { title: meta.Title, author: meta.Author, size: f.size }, txt, doc.numPages, f.name);
        r.id = uid();
        r.fileSize = f.size;
        r.addedAt = new Date().toISOString();
        r.relevance = '';
        r.tags = '';
        papers.unshift(r);
        existing.add(f.name + '|' + f.size);
        ok++;
      } catch (e) {
        console.warn('解析失败', f.name, e);
        fail++;
      }
    }
    bar.style.width = '100%';
    setTimeout(() => { prog.style.display = 'none'; bar.style.width = '0'; }, 400);
    setStatus('');
    save(); render();
    const msg = [];
    if (ok) msg.push(`成功导入 ${ok} 篇`);
    if (skip) msg.push(`跳过重复 ${skip} 篇`);
    if (fail) msg.push(`失败 ${fail} 篇（可能是扫描件，需手动录入）`);
    toast(msg.join('，') || '没有新增文献');
  }

  // ---------- 筛选 ----------
  function activeFilters() {
    const out = [];
    const push = (k, label, v) => { if (v !== '' && v != null) out.push({ k, label, v: String(v) }); };
    push('q', '关键词', $('q').value.trim());
    push('author', '作者', $('fAuthor').value.trim());
    push('source', '期刊/学校', $('fSource').value.trim());
    push('major', '专业', $('fMajor').value.trim());
    push('sup', '导师', $('fSup').value.trim());
    push('tag', '标签', $('fTag').value.trim());
    push('rel', '相关度', $('fRel').value);
    push('ymin', '年份≥', $('fYearMin').value);
    push('ymax', '年份≤', $('fYearMax').value);
    push('pmin', '页数≥', $('fPagesMin').value);
    push('pmax', '页数≤', $('fPagesMax').value);
    if (cat) out.push({ k: 'cat', label: '分类', v: cat });
    return out;
  }
  function match(p, f) {
    for (const x of f) {
      const v = x.v;
      switch (x.k) {
        case 'q': {
          const hay = [p.title, p.authors, p.keywords, p.abstract, p.source, p.major, p.tags, p.note, p.supervisor, p.type]
            .join(' ').toLowerCase();
          if (!hay.includes(v.toLowerCase())) return false;
          break;
        }
        case 'author': if (!String(p.authors || '').toLowerCase().includes(v.toLowerCase())) return false; break;
        case 'source': if (!String(p.source || '').toLowerCase().includes(v.toLowerCase())) return false; break;
        case 'major': if (!String(p.major || '').toLowerCase().includes(v.toLowerCase())) return false; break;
        case 'sup': if (!String(p.supervisor || '').toLowerCase().includes(v.toLowerCase())) return false; break;
        case 'tag': if (!String(p.tags || '').toLowerCase().includes(v.toLowerCase())) return false; break;
        case 'rel': if ((p.relevance || '') !== v) return false; break;
        case 'ymin': if (!(+p.year >= +v)) return false; break;
        case 'ymax': if (!(+p.year <= +v)) return false; break;
        case 'pmin': if (!(+p.pages >= +v)) return false; break;
        case 'pmax': if (!(+p.pages <= +v)) return false; break;
        case 'cat': if (p.category !== v) return false; break;
      }
    }
    return true;
  }
  function filtered() {
    const f = activeFilters();
    let arr = papers.filter(p => match(p, f));
    const k = sortKey, dir = sortDir;
    arr.sort((a, b) => {
      let x = a[k], y = b[k];
      if (k === 'year' || k === 'pages') { x = +x || 0; y = +y || 0; }
      else { x = String(x || ''); y = String(y || ''); }
      if (x === y) return 0;
      return (x > y ? 1 : -1) * dir;
    });
    return arr;
  }

  // ---------- 渲染 ----------
  function renderChips() {
    const box = $('chips'); box.innerHTML = '';
    activeFilters().forEach(f => {
      const c = el('span', 'chip');
      const shown = f.v.length > 18 ? f.v.slice(0, 18) + '…' : f.v;
      c.appendChild(el('b', null, f.label + '：' + shown));
      const b = el('button', null, '×');
      b.title = '移除该筛选';
      b.onclick = () => {
        const map = { q: 'q', author: 'fAuthor', source: 'fSource', major: 'fMajor', sup: 'fSup', tag: 'fTag', rel: 'fRel', ymin: 'fYearMin', ymax: 'fYearMax', pmin: 'fPagesMin', pmax: 'fPagesMax' };
        if (f.k === 'cat') cat = '';
        else { const e = $(map[f.k]); if (e) e.value = ''; }
        render();
      };
      c.appendChild(b); box.appendChild(c);
    });
  }

  function renderCats() {
    const box = $('cats'); box.innerHTML = '';
    const cnt = {};
    papers.forEach(p => { cnt[p.category || '其他'] = (cnt[p.category || '其他'] || 0) + 1; });
    const all = el('div', 'cat-item' + (cat === '' ? ' on' : ''));
    all.append(el('span', null, '全部文献'), el('span', 'n', papers.length));
    all.onclick = () => { cat = ''; render(); };
    box.appendChild(all);
    Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a]).forEach(k => {
      const it = el('div', 'cat-item' + (cat === k ? ' on' : ''));
      it.append(el('span', null, k), el('span', 'n', cnt[k]));
      it.onclick = () => { cat = cat === k ? '' : k; render(); };
      box.appendChild(it);
    });
    $('catTotal').textContent = papers.length ? papers.length + ' 篇' : '';
  }

  function renderRel() {
    const box = $('relStats'); box.innerHTML = '';
    const r = { '高': 0, '中': 0, '低': 0 };
    papers.forEach(p => { if (r[p.relevance] != null) r[p.relevance]++; });
    Object.keys(r).forEach(k => {
      const it = el('div', 'cat-item');
      it.append(el('span', 'badge r-' + k, k), el('span', 'n', r[k]));
      it.onclick = () => { $('fRel').value = $('fRel').value === k ? '' : k; render(); };
      box.appendChild(it);
    });
  }

  function renderDatalists() {
    const fill = (id, vals) => {
      const d = $(id); d.innerHTML = '';
      [...new Set(vals.filter(Boolean))].sort().forEach(v => {
        const o = document.createElement('option'); o.value = v; d.appendChild(o);
      });
    };
    fill('dlAuthor', papers.map(p => p.authors));
    fill('dlSource', papers.map(p => p.source));
    fill('dlMajor', papers.map(p => p.major));
    fill('dlSup', papers.map(p => p.supervisor));
    fill('dlTag', papers.flatMap(p => String(p.tags || '').split(/[,，;；\s]+/)));
  }

  function renderHead() {
    const tr = $('thr'); tr.innerHTML = '';
    COLS.forEach(c => {
      const th = el('th', (c.fixed ? 'cb' : 'sortable'));
      if (c.k === '_act') th.className = '';
      if (c.t) th.appendChild(document.createTextNode(c.t));
      if (c.k === sortKey) th.appendChild(el('span', 'ar', sortDir > 0 ? '▲' : '▼'));
      if (!c.fixed && c.k !== '_act') {
        th.onclick = () => {
          if (sortKey === c.k) sortDir = -sortDir; else { sortKey = c.k; sortDir = 1; }
          render();
        };
      }
      tr.appendChild(th);
    });
  }

  function renderRows() {
    const tb = $('tbody'); tb.innerHTML = '';
    const arr = filtered();
    $('cAll').textContent = papers.length;
    $('cShow').textContent = arr.length;
    $('cSel').textContent = sel.size;
    $('btnCompare').textContent = '对比 (' + sel.size + ')';
    $('empty').style.display = papers.length ? 'none' : 'block';
    $('tbl').style.display = papers.length ? 'table' : 'none';

    arr.forEach(p => {
      const tr = el('tr', sel.has(p.id) ? 'sel' : '');
      // 勾选
      const tdCb = el('td', 'cb');
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = sel.has(p.id);
      cb.onclick = e => {
        e.stopPropagation();
        if (cb.checked) sel.add(p.id); else sel.delete(p.id);
        save(); render();
      };
      tdCb.appendChild(cb); tr.appendChild(tdCb);

      // 题目
      const tdT = el('td', 't-title');
      const w = el('div', 't-wrap');
      w.appendChild(el('div', null, p.title || '（无题目）'));
      const sub = [p.authors, p.year].filter(Boolean).join(' · ');
      if (sub) w.appendChild(el('div', 't-sub', sub));
      tdT.appendChild(w); tr.appendChild(tdT);

      // 作者
      tr.appendChild(el('td', null, p.authors || '—'));
      // 年代
      tr.appendChild(el('td', null, p.year || '—'));
      // 类型（带色标签）
      const tdType = el('td');
      if (p.type) {
        const b = el('span', 'badge ' + (CAT_CLASS[p.type] || ''), p.type);
        tdType.appendChild(b);
      } else tdType.textContent = '—';
      tr.appendChild(tdType);
      tr.appendChild(el('td', null, p.source || '—'));
      tr.appendChild(el('td', null, p.major || '—'));
      const tdK = el('td');
      if (p.keywords) {
        const w2 = el('div', 't-wrap');
        w2.appendChild(el('div', null, p.keywords));
        tdK.appendChild(w2);
      } else tdK.textContent = '—';
      tr.appendChild(tdK);
      tr.appendChild(el('td', null, p.pages || '—'));
      const tdR = el('td');
      if (p.relevance) tdR.appendChild(el('span', 'badge r-' + p.relevance, p.relevance));
      else tdR.textContent = '—';
      tr.appendChild(tdR);
      const tdTag = el('td');
      if (p.tags) {
        const w3 = el('div', 't-wrap');
        w3.appendChild(el('div', null, p.tags));
        tdTag.appendChild(w3);
      } else tdTag.textContent = '—';
      tr.appendChild(tdTag);

      // 操作
      const tdA = el('td');
      const be = el('button', 'rowbtn', '编辑');
      be.onclick = () => openEdit(p.id);
      const bd = el('button', 'rowbtn', '删除');
      bd.onclick = () => {
        if (!confirm('删除《' + (p.title || '无题') + '》？此操作不可撤销。')) return;
        papers = papers.filter(x => x.id !== p.id);
        sel.delete(p.id); save(); render();
      };
      tdA.append(be, bd); tr.appendChild(tdA);
      tb.appendChild(tr);
    });
  }

  function render() {
    renderCats(); renderRel(); renderDatalists(); renderChips(); renderHead(); renderRows();
  }

  // ---------- 编辑弹窗 ----------
  const FIELDS = [
    ['title', '题目', 'text', 1], ['authors', '作者', 'text', 0],
    ['year', '年代', 'text', 0], ['type', '期刊/论文类型', 'text', 0],
    ['category', '所属分类', 'select', 0], ['source', '期刊名称 / 学校', 'text', 0],
    ['school', '学位授予单位', 'text', 0], ['major', '学科专业', 'text', 0],
    ['supervisor', '导师', 'text', 0], ['pages', '页数', 'number', 0],
    ['relevance', '与自己论文的相关性', 'select', 0], ['tags', '标签（逗号分隔）', 'text', 1],
    ['keywords', '关键词', 'text', 1], ['abstract', '摘要', 'textarea', 1],
    ['note', '备注 / 笔记', 'textarea', 1], ['fileName', '源文件名', 'text', 1]
  ];
  function openEdit(id) {
    const p = papers.find(x => x.id === id); if (!p) return;
    editId = id;
    $('mTitle').textContent = '编辑文献';
    const g = $('mGrid'); g.innerHTML = '';
    const cats = window.PaperParser.CATEGORIES.slice();
    if (p.category && !cats.includes(p.category)) cats.unshift(p.category);
    FIELDS.forEach(([k, label, kind, full]) => {
      const f = el('div', 'fld' + (full ? ' full' : ''));
      f.appendChild(el('label', null, label));
      let input;
      if (kind === 'textarea') { input = document.createElement('textarea'); input.value = p[k] || ''; }
      else if (kind === 'select') {
        input = document.createElement('select');
        const opts = k === 'relevance' ? ['', '高', '中', '低'] : cats;
        opts.forEach(o => { const op = document.createElement('option'); op.value = o; op.textContent = o || '（未分类）'; input.appendChild(op); });
        input.value = p[k] || '';
      } else { input = document.createElement('input'); input.type = kind; input.value = p[k] == null ? '' : p[k]; }
      input.dataset.k = k;
      f.appendChild(input);
      if (k === 'fileName') f.appendChild(el('div', 'hint', '仅记录来源，不会保存 PDF 文件本身'));
      g.appendChild(f);
    });
    $('modal').classList.add('on');
  }
  function closeEdit() { $('modal').classList.remove('on'); editId = null; }
  function saveEdit() {
    const p = papers.find(x => x.id === editId); if (!p) return;
    $('mGrid').querySelectorAll('[data-k]').forEach(inp => {
      const k = inp.dataset.k;
      p[k] = inp.type === 'number' ? (inp.value === '' ? '' : +inp.value) : inp.value.trim();
    });
    save(); closeEdit(); render(); toast('已保存');
  }

  // ---------- 对比 ----------
  const CMP_ROWS = [
    ['title', '题目'], ['authors', '作者'], ['year', '年代'], ['type', '文献类型'],
    ['category', '所属分类'], ['source', '期刊/学校'], ['school', '学位授予单位'],
    ['major', '学科专业'], ['supervisor', '导师'], ['pages', '页数'],
    ['relevance', '相关度'], ['tags', '标签'], ['keywords', '关键词'],
    ['abstract', '摘要'], ['note', '备注']
  ];
  function openCompare() {
    const list = papers.filter(p => sel.has(p.id));
    if (list.length < 2) { toast('至少勾选 2 篇论文才能对比'); return; }
    $('cmpCount').textContent = list.length + ' 篇';
    const wrap = $('cmpWrap'); wrap.innerHTML = '';
    const t = el('table', 'cmp');
    // 表头
    const thead = el('thead'), htr = el('tr');
    htr.appendChild(el('th', null, '对比项'));
    list.forEach(p => {
      const th = el('th');
      th.appendChild(el('div', 'dtitle', p.title || '（无题目）'));
      th.appendChild(el('div', 'dmeta', [p.authors, p.year, p.type].filter(Boolean).join(' · ')));
      htr.appendChild(th);
    });
    thead.appendChild(htr); t.appendChild(thead);
    // 表体
    const tb = el('tbody');
    CMP_ROWS.forEach(([k, label]) => {
      const tr = el('tr');
      tr.appendChild(el('th', null, label));
      const vals = list.map(p => String(p[k] == null ? '' : p[k]).trim());
      const norm = vals.map(v => v.replace(/\s+/g, ''));
      const allSame = norm.every(v => v === norm[0] && v !== '');
      list.forEach((p, i) => {
        const td = el('td', allSame ? 'same' : (norm[i] ? 'diff' : ''));
        td.textContent = vals[i] || '—';
        tr.appendChild(td);
      });
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    wrap.appendChild(t);

    const lg = el('div', 'tip');
    lg.style.margin = '10px 0 4px';
    lg.innerHTML = '<span class="badge same" style="background:#e8f5ec;color:#15803d">一致</span> 各篇内容相同　<span class="badge diff" style="background:#fffaf0;color:#b45309">差异</span> 该行存在不同（有内容）';
    wrap.appendChild(lg);

    $('mask').classList.add('on'); $('drawer').classList.add('on');
  }
  function closeCompare() { $('mask').classList.remove('on'); $('drawer').classList.remove('on'); }

  function cmpMatrix() {
    const list = papers.filter(p => sel.has(p.id));
    return { list, rows: CMP_ROWS.map(([k, label]) => ({ k, label, vals: list.map(p => String(p[k] == null ? '' : p[k])) })) };
  }
  function exportCompare(kind) {
    const { list, rows } = cmpMatrix();
    if (!list.length) { toast('请先勾选论文'); return; }
    const aoa = [['对比项'].concat(list.map(p => (p.title || '（无题目）') + (p.authors ? '（' + p.authors + '）' : '')))];
    rows.forEach(r => aoa.push([r.label].concat(r.vals.map(v => v || ''))));
    if (kind === 'csv') {
      const csv = aoa.map(row => row.map(c => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\r\n');
      dl(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }), '论文对比表.csv');
    } else {
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), '对比表');
      XLSX.writeFile(wb, '论文对比表.xlsx');
    }
    toast('已导出对比表');
  }

  // ---------- 导出 / 导入 ----------
  function dl(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function exportXlsx() {
    if (!papers.length) { toast('文献库为空'); return; }
    const aoa = [PAGE_FIELDS.map(f => f[1])];
    papers.forEach(p => aoa.push(PAGE_FIELDS.map(f => {
      let v = p[f[0]];
      if (f[0] === 'fileSize') v = sizeText(v);
      return v == null ? '' : v;
    })));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), '论文汇总');
    XLSX.writeFile(wb, '论文汇总.xlsx');
    toast('已导出 ' + papers.length + ' 篇');
  }
  function exportBackup() {
    const data = JSON.stringify({ v: 1, papers, sel: [...sel], at: new Date().toISOString() }, null, 1);
    dl(new Blob([data], { type: 'application/json' }), '论文库备份_' + new Date().toISOString().slice(0, 10) + '.json');
    toast('备份已导出');
  }
  function importBackup(file) {
    const fr = new FileReader();
    fr.onload = () => {
      try {
        const d = JSON.parse(fr.result);
        const inc = Array.isArray(d.papers) ? d.papers : [];
        if (!inc.length) { toast('备份里没有文献'); return; }
        let n = 0;
        inc.forEach(p => { p.id = uid(); papers.push(p); n++; });
        save(); render();
        toast('已导入 ' + n + ' 篇');
      } catch (e) { toast('备份文件解析失败'); }
    };
    fr.readAsText(file);
  }

  // ---------- 事件 ----------
  function bind() {
    $('drop').onclick = () => $('file').click();
    $('btnDir').onclick = () => $('dir').click();
    $('file').onchange = e => { if (e.target.files.length) handleFiles(e.target.files); e.target.value = ''; };
    $('dir').onchange = e => { if (e.target.files.length) handleFiles(e.target.files); e.target.value = ''; };
    ['dragenter', 'dragover'].forEach(ev => $('drop').addEventListener(ev, e => { e.preventDefault(); $('drop').classList.add('over'); }));
    ['dragleave', 'drop'].forEach(ev => $('drop').addEventListener(ev, e => { e.preventDefault(); $('drop').classList.remove('over'); }));
    $('drop').addEventListener('drop', e => { if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files); });
    // 整页拖放
    ['dragover', 'drop'].forEach(ev => document.addEventListener(ev, e => {
      if (e.target.closest('#drop')) return;
      e.preventDefault();
      if (ev === 'drop' && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
    }));

    $('btnClear').onclick = () => {
      if (!papers.length) return;
      if (!confirm('确定清空全部 ' + papers.length + ' 篇文献？建议先「导出备份」。')) return;
      papers = []; sel.clear(); cat = ''; save(); render(); toast('已清空');
    };
    $('btnExport').onclick = exportXlsx;

    $('btnCompare').onclick = openCompare;
    $('btnCloseDrawer').onclick = closeCompare;
    $('mask').onclick = closeCompare;
    $('btnCmpXlsx').onclick = () => exportCompare('xlsx');
    $('btnCmpCsv').onclick = () => exportCompare('csv');
    $('btnSelAll').onclick = () => { filtered().forEach(p => sel.add(p.id)); save(); render(); };
    $('btnSelNone').onclick = () => { sel.clear(); save(); render(); };
    $('btnReset').onclick = () => {
      ['q', 'fAuthor', 'fSource', 'fMajor', 'fSup', 'fTag', 'fYearMin', 'fYearMax', 'fPagesMin', 'fPagesMax'].forEach(i => $(i).value = '');
      $('fRel').value = ''; cat = ''; render();
    };
    ['q', 'fAuthor', 'fSource', 'fMajor', 'fSup', 'fTag', 'fRel', 'fYearMin', 'fYearMax', 'fPagesMin', 'fPagesMax']
      .forEach(i => { const e = $(i); e.addEventListener('input', render); e.addEventListener('change', render); });

    $('btnMX').onclick = closeEdit;
    $('btnMCancel').onclick = closeEdit;
    $('btnMSave').onclick = saveEdit;
    $('modal').onclick = e => { if (e.target === $('modal')) closeEdit(); };
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') { closeEdit(); closeCompare(); }
    });
  }

  // 备份入口：顶栏只负责下载，侧栏负责恢复
  function initImportFlow() {
    $('btnImport').textContent = '下载备份';
    $('btnImport').onclick = exportBackup;
    $('bakFile').onchange = e => { if (e.target.files.length) importBackup(e.target.files[0]); e.target.value = ''; };
    const b = el('button', 'btn sm', '恢复备份');
    b.style.marginTop = '6px'; b.style.width = '100%';
    b.onclick = () => $('bakFile').click();
    $('btnDir').parentNode.appendChild(b);
  }

  load(); bind(); initImportFlow(); render();
  window.__papers = () => papers;
})();
