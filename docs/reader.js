/* 检阅模式 —— PDF 渲染 + 批注锚定
 *
 * 批注锚定原理：
 *   pdf.js 的 getTextContent() 会返回每个文本片段的坐标(transform)。我们据此在 canvas 上
 *   叠一层"透明但可选中"的文字层，每个片段对应一个 <span>，用 scale/translate 还原位置。
 *   用户选中文字时，通过 window.getSelection() 拿到锚点落在哪几个 span 上，
 *   记录 [page, spanIndexStart, offsetStart, spanIndexEnd, offsetEnd] + 选中文本。
 *   再次打开时按锚点自动重绘高亮 <mark>，因此批注能精确回跳，不受分页影响。
 */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const el = (t, c, x) => { const n = document.createElement(t); if (c) n.className = c; if (x != null) n.textContent = x; return n; };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const TYPES = [
    { k: 'important', n: '重点' }, { k: 'method', n: '方法' },
    { k: 'conclusion', n: '结论' }, { k: 'question', n: '疑问' },
    { k: 'quote', n: '待引用' }
  ];
  const STYPE = {};
  TYPES.forEach(t => STYPE[t.k] = t.n);

  let api = null;        // 由 app.js 注入：{ getPaper, getAnnotations, setAnnotations, save, toast, lib }
  let cur = null;        // 当前检阅的论文
  let doc = null;        // pdf.js 文档
  let pages = [];        // [{wrap, canvas, layer, spans:[{el,item,rect}]}]
  let curPage = 1;
  let pending = null;    // 待保存的选区
  let filterT = '';
  let editingId = null;

  function init(hooks) {
    api = hooks;
    $('rdClose').onclick = close;
    $('rdPrevPage').onclick = () => goto(curPage - 1);
    $('rdNextPage').onclick = () => goto(curPage + 1);
    $('rdFilter').onchange = e => { filterT = e.target.value; renderList(); };
    $('rdSearch').oninput = renderList;
    $('rdToNote').onclick = toNote;
    $('rdExportNote').onclick = exportNotes;
    $('popCancel').onclick = closePop;
    $('popSave').onclick = saveAnnotation;
    document.querySelectorAll('.rd-legend .lg').forEach(b => {
      b.onclick = () => { b.classList.toggle('on'); filterT = b.classList.contains('on') ? b.dataset.t : ''; $('rdFilter').value = filterT; renderList(); };
    });
    // 类型选择按钮
    const box = $('popTypes'); box.innerHTML = '';
    TYPES.forEach(t => {
      const b = el('button', 'lg', t.n);
      b.dataset.t = t.k;
      b.onclick = () => {
        box.querySelectorAll('.lg').forEach(x => x.classList.remove('on'));
        b.classList.add('on');
      };
      box.appendChild(b);
    });
    // 选区变化时弹出气泡
    document.addEventListener('selectionchange', onSelChange);
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') { if ($('pop').classList.contains('on')) closePop(); else if ($('reader').classList.contains('on')) close(); }
    });
  }

  // ---------- 打开 / 关闭 ----------
  async function open(pid) {
    const p = api.getPaper(pid);
    if (!p) return;
    cur = p; curPage = 1; pending = null; editingId = null; filterT = '';
    $('rdFilter').value = ''; $('rdSearch').value = '';
    document.querySelectorAll('.rd-legend .lg').forEach(b => b.classList.remove('on'));
    $('rdTitle').textContent = p.title || '（无题目）';
    $('reader').classList.add('on');
    $('rdLoading').classList.remove('hide');
    $('rdPages').innerHTML = '';
    pages = [];
    try {
      $('rdLoading').textContent = '正在准备 PDF…';
      const lib = await api.getLib();
      const buf = await api.getFileBuffer(p);
      $('rdLoading').textContent = '正在渲染 PDF…';
      doc = await lib.getDocument({ data: new Uint8Array(buf) }).promise;
      $('rdTitle').textContent = `${p.title || '（无题目）'}　—　${doc.numPages} 页`;
      await renderAll();
      renderList();
    } catch (e) {
      $('rdLoading').textContent = '无法打开该 PDF：' + (e && e.message ? e.message : e) +
        '。如果是从备份恢复的记录，PDF 原文件未一并保存，需重新上传。';
    }
    $('rdLoading').classList.add('hide');
  }
  function close() {
    $('reader').classList.remove('on');
    doc = null; pages = []; pending = null; editingId = null;
  }

  // ---------- 渲染全部页面 ----------
  async function renderAll() {
    if (!doc) return;
    const total = doc.numPages;
    for (let n = 1; n <= total; n++) {
      try { await renderPage(n); } catch (e) { console.warn('渲染第' + n+'页失败', e); }
    }
    $('rdPage').textContent = '1 / ' + total;
    updatePageLabel();
  }

  async function renderPage(n) {
    const page = await doc.getPage(n);
    const viewport = page.getViewport({ scale: 1.4 });
    const wrap = el('div', 'rd-pagewrap');
    wrap.dataset.page = n;

    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    wrap.appendChild(canvas);

    const layer = el('div', 'txt-layer');
    layer.style.width = canvas.width + 'px';
    layer.style.height = canvas.height + 'px';
    wrap.appendChild(layer);

    $('rdPages').appendChild(wrap);
    const rec = { wrap, canvas, layer, spans: [], n };
    pages[n - 1] = rec;

    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

    // 文字层：每个片段按其 transform 定位
    const tc = await page.getTextContent();
    tc.items.forEach((it, idx) => {
      if (!it.str || !it.str.trim()) return;
      const tx = pdfjsLib ? null : null; // 占位，避免未使用告警
      const tr = it.transform;
      const fontH = Math.hypot(tr[2], tr[3]) || 10;
      const span = document.createElement('span');
      span.textContent = it.str;
      span.dataset.idx = String(idx);
      const x = tr[4], y = tr[5] - fontH;
      span.style.left = x + 'px';
      span.style.top = y + 'px';
      span.style.fontSize = fontH + 'px';
      span.style.fontFamily = it.fontName || 'sans-serif';
      // pdf.js 的横向缩放矩阵在 transform[0] 里
      const sx = tr[0] || 1;
      span.style.transform = `scale(${sx}, 1)`;
      layer.appendChild(span);
      rec.spans.push({ el: span, item: it, idx });
    });
    // 页面在视口内时更新页码
    if (window.IntersectionObserver) {
      const io = new IntersectionObserver(es => {
        es.forEach(en => { if (en.isIntersecting) { curPage = n; updatePageLabel(); } });
      }, { root: $('rdView'), threshold: 0.4 });
      io.observe(wrap);
    }
  }

  function updatePageLabel() { if (doc) $('rdPage').textContent = curPage + ' / ' + doc.numPages; }
  function goto(n) {
    if (!doc) return;
    const t = Math.min(Math.max(1, n), doc.numPages);
    const rec = pages[t - 1];
    if (rec) rec.wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
    curPage = t; updatePageLabel();
  }

  // ---------- 选区 -> 气泡 ----------
  let selTimer = null;
  let popGuard = 0;   // 气泡自身的输入引起的 selectionchange 需要忽略
  function onSelChange() {
    if (!$('reader').classList.contains('on')) return;
    // 焦点在批注气泡里时产生的 selectionchange 不是正文选区，忽略
    const ae = document.activeElement;
    if (ae && ($('pop').contains(ae) || ae === $('popText'))) return;
    if (Date.now() < popGuard) return;
    clearTimeout(selTimer);
    selTimer = setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) { if (!editingId) closePop(); return; }
      // 选区必须落在 PDF 文字层内
      const range = sel.getRangeAt(0);
      const inLayer = !!(range.commonAncestorContainer &&
        (range.commonAncestorContainer.nodeType === 1
          ? range.commonAncestorContainer.closest('.txt-layer')
          : range.commonAncestorContainer.parentElement &&
            range.commonAncestorContainer.parentElement.closest('.txt-layer')));
      if (!inLayer) { if (!editingId) closePop(); return; }
      const rect = range.getBoundingClientRect();
      if (!rect || (!rect.width && !rect.height)) return;
      const spans = collectSpans(range);
      if (!spans.length) return;
      pending = buildAnchor(spans, sel.toString());
      openPop(rect, sel.toString());
    }, 220);
  }

  // 把 range 覆盖到的文字片段收集出来
  function collectSpans(range) {
    const out = [];
    pages.forEach(rec => {
      if (!rec) return;
      rec.spans.forEach(sp => {
        try {
          if (range.intersectsNode(sp.el)) out.push({ rec, sp });
        } catch (e) { /* 忽略 */ }
      });
    });
    out.sort((a, b) => (a.rec.n - b.rec.n) || (a.sp.idx - b.sp.idx));
    return out;
  }

  // 生成锚点
  function buildAnchor(spans, text) {
    const first = spans[0], last = spans[spans.length - 1];
    return {
      page: first.rec.n,
      startIdx: first.sp.idx, startOff: 0,
      endIdx: last.sp.idx, endOff: (last.sp.item.str || '').length,
      text: text.slice(0, 500)
    };
  }

  function openPop(rect, quote) {
    const pop = $('pop');
    $('popQuote').textContent = quote.length > 140 ? quote.slice(0, 140) + '…' : quote;
    $('popText').value = '';
    $('popTypes').querySelectorAll('.lg').forEach(x => x.classList.remove('on'));
    editingId = null;
    // 定位：优先放在选区下方，超出则放上方
    const vw = window.innerWidth, vh = window.innerHeight;
    pop.classList.add('on');
    const pw = 308, ph = pop.offsetHeight || 210;
    let x = rect.left + rect.width / 2 - pw / 2;
    let y = rect.bottom + 8;
    if (y + ph > vh - 10) y = Math.max(10, rect.top - ph - 8);
    x = Math.min(Math.max(10, x), vw - pw - 10);
    pop.style.left = x + 'px';
    pop.style.top = y + 'px';
    popGuard = Date.now() + 900;
    setTimeout(() => { if ($('pop').classList.contains('on')) $('popText').focus(); }, 30);
  }
  function closePop() {
    $('pop').classList.remove('on');
    $('popText').value = '';
    pending = null; editingId = null;
  }

  // ---------- 保存 / 编辑 / 删除 ----------
  function saveAnnotation() {
    const txt = $('popText').value.trim();
    const typeBtn = $('popTypes').querySelector('.lg.on');
    const type = typeBtn ? typeBtn.dataset.t : 'important';
    const list = api.getAnnotations(cur.id);
    if (editingId) {
      const a = list.find(x => x.id === editingId);
      if (a) { a.text = txt; a.type = type; }
    } else {
      if (!pending) { api.toast('未选中文字'); return; }
      list.push({
        id: 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        pid: cur.id, type, text: txt,
        quote: pending.text, anchor: pending,
        page: pending.page, at: new Date().toISOString()
      });
    }
    api.setAnnotations(cur.id, list);
    closePop();
    window.getSelection().removeAllRanges();
    paint();
    renderList();
    api.toast(editingId ? '批注已更新' : '批注已添加');
  }

  function delAnnotation(id) {
    const list = api.getAnnotations(cur.id).filter(a => a.id !== id);
    api.setAnnotations(cur.id, list);
    paint(); renderList();
    api.toast('批注已删除');
  }

  // ---------- 高亮绘制 ----------
  function paint() {
    if (!pages.length) return;
    const list = api.getAnnotations(cur.id);
    pages.forEach(rec => {
      if (!rec) return;
      rec.layer.querySelectorAll('mark.ann').forEach(m => {
        const host = m.parentNode;      // 即原来的 span
        if (host && host.tagName === 'SPAN') {
          while (m.firstChild) host.insertBefore(m.firstChild, m);
        } else {
          const parent = m.parentNode;
          while (m.firstChild) parent.insertBefore(m.firstChild, m);
        }
        m.remove();
      });
      rec.wrap.querySelectorAll('.rd-badge').forEach(b => b.remove());   // 徽标挂在 wrap 上
    });
    const active = $('rdList').querySelector('.ann-item.active');
    const activeId = active ? active.dataset.id : null;

    list.forEach((a, ai) => {
      const rec = pages[(a.page || 1) - 1];
      if (!rec) return;
      const range = anchorToRange(a.anchor, rec);
      if (!range) return;
      // 用 mark 包裹命中的片段。surroundContents 在片段含多个子节点时会抛错，
      // 因此改为「逐个子节点包裹」，并保持 span 元素本身不被替换（便于重复绘制与还原）。
      try {
        const hits = [];
        rec.spans.forEach(sp => { if (range.intersectsNode(sp.el)) hits.push(sp); });
        hits.forEach(sp => {
          const el0 = sp.el;
          if (!el0.isConnected) return;
          const kids = Array.from(el0.childNodes);
          const wrapAll = () => {
            const m = document.createElement('mark');
            m.className = 'ann t-' + (a.type || 'important') + (a.id === activeId ? ' active' : '');
            m.dataset.aid = a.id;
            m.onclick = ev => { ev.stopPropagation(); focusAnn(a.id); };
            while (el0.firstChild) m.appendChild(el0.firstChild);
            el0.appendChild(m);
          };
          if (kids.length === 1) wrapAll();
          else if (kids.length > 1) {
            // 片段被拆成多段（如换行符分离），整段一起高亮
            wrapAll();
          } else {
            const m = document.createElement('mark');
            m.className = 'ann t-' + (a.type || 'important');
            m.dataset.aid = a.id;
            m.textContent = el0.textContent;
            el0.textContent = '';
            el0.appendChild(m);
          }
        });
      } catch (e) { console.warn('高亮绘制失败', e); }

      // 序号徽标
      try {
        const r2 = anchorToRange(a.anchor, rec);
        if (r2) {
          const rect = r2.getBoundingClientRect();
          const wr = rec.wrap.getBoundingClientRect();
          const b = el('div', 'rd-badge t-' + (a.type || 'important'), String(ai + 1));
          b.style.left = (rect.left - wr.left + rect.width / 2 - 8) + 'px';
          b.style.top = (rect.top - wr.top - 8) + 'px';
          b.title = a.text || a.quote;
          b.onclick = ev => { ev.stopPropagation(); focusAnn(a.id); };
          rec.wrap.appendChild(b);
        }
      } catch (e) { }
    });
  }

  // 锚点 -> Range
  // 注意：span 内可能已包着 <mark>，因此必须用「文本节点」定位，不能用 span 元素 + 字符偏移
  function firstTextNode(node) {
    if (!node) return null;
    if (node.nodeType === 3) return node;
    for (let i = 0; i < node.childNodes.length; i++) {
      const r = firstTextNode(node.childNodes[i]);
      if (r) return r;
    }
    return null;
  }
  function anchorToRange(anchor, rec) {
    if (!anchor) return null;
    const s = rec.spans.find(x => String(x.idx) === String(anchor.startIdx));
    const e = rec.spans.find(x => String(x.idx) === String(anchor.endIdx)) || s;
    if (!s) return null;
    try {
      const st = firstTextNode(s.el);
      const en = firstTextNode(e.el);
      if (!st || !en) return null;
      const sLen = (st.nodeValue || '').length;
      const eLen = (en.nodeValue || '').length;
      const r = document.createRange();
      r.setStart(st, Math.min(anchor.startOff || 0, sLen));
      r.setEnd(en, Math.min(anchor.endOff != null ? anchor.endOff : eLen, eLen));
      return r;
    } catch (err) { return null; }
  }

  // ---------- 批注列表 ----------
  function renderList() {
    const box = $('rdList'); box.innerHTML = '';
    const all = api.getAnnotations(cur ? cur.id : '');
    $('rdCount').textContent = all.length;
    const q = ($('rdSearch').value || '').trim().toLowerCase();
    let list = all.slice().sort((a, b) => (a.page - b.page) || String(a.at).localeCompare(String(b.at)));
    if (filterT) list = list.filter(a => a.type === filterT);
    if (q) list = list.filter(a => ((a.text || '') + (a.quote || '')).toLowerCase().includes(q));

    if (!all.length) {
      box.appendChild(el('div', 'rd-empty', '还没有批注。<br>在左侧选中正文文字即可添加。<br><br>用途：标记可引用段落、记录疑问、<br>沉淀方法与结论，供写作时取用。'));
      return;
    }
    if (!list.length) {
      box.appendChild(el('div', 'rd-empty', '没有符合条件的批注'));
      return;
    }
    list.forEach(a => {
      const it = el('div', 'ann-item');
      it.dataset.id = a.id;
      if (a.quote) it.appendChild(el('div', 'ann-q', a.quote));
      if (a.text) it.appendChild(el('div', 'ann-txt', a.text));
      const meta = el('div', 'ann-meta');
      meta.appendChild(el('span', 'tagpill t-' + (a.type || 'important'), STYPE[a.type] || '批注'));
      meta.appendChild(el('span', null, '第 ' + a.page + ' 页'));
      const ed = el('button', 'del', '编辑');
      ed.onclick = ev => { ev.stopPropagation(); editAnn(a); };
      const dl = el('button', 'del', '删除');
      dl.onclick = ev => { ev.stopPropagation(); if (confirm('删除这条批注？')) delAnnotation(a.id); };
      meta.appendChild(ed, dl);
      it.appendChild(meta);
      it.onclick = () => focusAnn(a.id);
      box.appendChild(it);
    });
  }

  function focusAnn(id) {
    const rec0 = $('rdList').querySelector('.ann-item.active');
    if (rec0) rec0.classList.remove('active');
    const item = $('rdList').querySelector(`.ann-item[data-id="${id}"]`);
    if (item) { item.classList.add('active'); item.scrollIntoView({ block: 'nearest' }); }
    const a = api.getAnnotations(cur.id).find(x => x.id === id);
    if (a) { goto(a.page); setTimeout(paint, 320); }
  }

  function editAnn(a) {
    editingId = a.id;
    const rec = pages[(a.page || 1) - 1];
    if (rec) {
      const r = anchorToRange(a.anchor, rec);
      if (r) {
        const rect = r.getBoundingClientRect();
        $('popQuote').textContent = (a.quote || '').slice(0, 140);
        $('popText').value = a.text || '';
        $('popTypes').querySelectorAll('.lg').forEach(x => x.classList.toggle('on', x.dataset.t === a.type));
        const pop = $('pop');
        pop.classList.add('on');
        const pw = 308, ph = pop.offsetHeight || 210;
        let x = rect.left + rect.width / 2 - pw / 2;
        let y = rect.bottom + 8;
        if (y + ph > window.innerHeight - 10) y = Math.max(10, rect.top - ph - 8);
        pop.style.left = Math.min(Math.max(10, x), window.innerWidth - pw - 10) + 'px';
        pop.style.top = y + 'px';
        popGuard = Date.now() + 900;
        $('popText').focus();
      }
    } else {
      // 页面未渲染，退化为纯文本编辑
      editingId = a.id;
      $('popQuote').textContent = (a.quote || '').slice(0, 140);
      $('popText').value = a.text || '';
      $('popTypes').querySelectorAll('.lg').forEach(x => x.classList.toggle('on', x.dataset.t === a.type));
      const pop = $('pop');
      pop.classList.add('on');
      pop.style.left = '40px'; pop.style.top = '120px';
      popGuard = Date.now() + 900;
      $('popText').focus();
    }
  }

  // ---------- 批注导出 / 写入备注 ----------
  function exportNotes() {
    const list = api.getAnnotations(cur ? cur.id : '');
    if (!list.length) { api.toast('还没有批注'); return; }
    const p = cur;
    const rows = [['类型', '页码', '批注内容', '原文摘录', '时间']];
    list.slice().sort((a, b) => a.page - b.page).forEach(a => {
      rows.push([STYPE[a.type] || '批注', a.page, a.text || '', a.quote || '', (a.at || '').replace('T', ' ').slice(0, 16)]);
    });
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{ wch: 8 }, { wch: 6 }, { wch: 40 }, { wch: 60 }, { wch: 17 }];
    XLSX.utils.book_append_sheet(wb, ws, '批注');
    XLSX.writeFile(wb, (p.title || '论文').slice(0, 30) + '_批注.xlsx');
    api.toast('已导出 ' + list.length + ' 条批注');
  }

  function toNote() {
    const list = api.getAnnotations(cur ? cur.id : '');
    if (!list.length) { api.toast('还没有批注'); return; }
    const text = list.slice().sort((a, b) => a.page - b.page).map(a =>
      `【第${a.page}页·${STYPE[a.type] || '批注'}】${a.text || a.quote}`
    ).join('\n');
    const p = api.getPaper(cur.id);
    if (!p) return;
    const old = p.note || '';
    if (old && !confirm('备注已有内容，追加到末尾？')) return;
    p.note = old ? old + '\n\n' + text : text;
    api.save();
    api.toast('已写入「备注」字段');
  }

  window.ReaderMode = { init, open, close, repaint: paint };
})();
