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
  // 共用测量画布：文字层按 PDF 实际宽度校准，避免逐 span 读布局造成卡顿
  const measureCtx = document.createElement('canvas').getContext('2d');
  // 矩阵相乘，与 pdf.js Util.transform(viewport.transform, item.transform) 等价
  function transform(m1, m2) {
    return [
      m1[0] * m2[0] + m1[2] * m2[1],
      m1[1] * m2[0] + m1[3] * m2[1],
      m1[0] * m2[2] + m1[2] * m2[3],
      m1[1] * m2[2] + m1[3] * m2[3],
      m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
      m1[1] * m2[4] + m1[3] * m2[5] + m1[5]
    ];
  }

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
    // 「写入字段」下拉：只列深度字段（研究背景/目的/方法/结论…）
    const fs = $('popField');
    fs.innerHTML = '';
    (window.PaperFields ? window.PaperFields.FILL_TARGETS : []).forEach(f => {
      const o = document.createElement('option');
      o.value = f.k; o.textContent = f.label;
      fs.appendChild(o);
    });
    $('popFill').onclick = fillField;
    $('popClaim').onclick = saveAsClaim;
    $('rdShot').onclick = startShot;
    // 选区变化时弹出气泡
    document.addEventListener('selectionchange', onSelChange);
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      if ($('pop').classList.contains('on')) closePop();
      else if ($('reader').classList.contains('rd-shooting')) endShot();
      else if ($('reader').classList.contains('on')) close();
    });
  }

  // ---------- 打开 / 关闭 ----------
  async function open(pid, opts) {
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
      // pdf.js 会转移并清空传入的 ArrayBuffer，必须先复制一份，
      // 否则同一篇 PDF 关掉检阅再点第二次就打不开了（detached ArrayBuffer）
      doc = await lib.getDocument({ data: new Uint8Array(buf.slice(0)) }).promise;
      $('rdTitle').textContent = `${p.title || '（无题目）'}　—　${doc.numPages} 页`;
      await renderAll();
      paint();          // 重新打开时恢复已有批注的高亮与序号徽标
      renderList();
      $('rdLoading').classList.add('hide');
      if (opts && opts.focus) setTimeout(() => focusEvidence(opts.focus, opts.quote), 120);
    } catch (e) {
      // 出错时保留提示。此前无论成功失败都会 hide，用户只能看到空白页
      $('rdLoading').textContent = '无法打开该 PDF：' + (e && e.message ? e.message : e) +
        '。如果是从备份恢复的记录，PDF 原文件未一并保存，需重新上传。';
      $('rdLoading').classList.remove('hide');
    }
  }
  function close() {
    endShot();
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

    // 文字层：必须把「页面 viewport 变换」与「文本片段 transform」相乘。
    // 之前直接用 item.transform，既没有乘 1.4 缩放，也没有做 PDF 的 Y 轴翻转，
    // 还把字号当成 scaleX，导致一段 5 个字被拉成 500 多像素，划词位置完全对不上。
    const tc = await page.getTextContent();
    tc.items.forEach((it, idx) => {
      if (!it.str || !it.str.trim()) return;
      const tx = transform(viewport.transform, it.transform);
      const fontH = Math.hypot(tx[2], tx[3]) || 10;
      const angle = Math.atan2(tx[1], tx[0]);
      const span = document.createElement('span');
      span.textContent = it.str;
      span.dataset.idx = String(idx);
      span.style.left = tx[4] + 'px';
      span.style.top = (tx[5] - fontH) + 'px';
      span.style.fontSize = fontH + 'px';
      span.style.fontFamily = 'sans-serif';
      span.style.transformOrigin = '0 0';
      // PDF 的 advance width 才是这段文字在页面上的真实宽度；
      // 浏览器字体与 PDF 字体不同，需要单独校准横向比例。
      const targetW = Math.max(0, (it.width || 0) * viewport.scale);
      measureCtx.font = fontH + 'px sans-serif';
      const actualW = measureCtx.measureText(it.str).width;
      const sx = targetW > 0 && actualW > 0 ? targetW / actualW : 1;
      span.style.transform = (Math.abs(angle) > 0.001 ? `rotate(${angle}rad) ` : '') + `scaleX(${sx})`;
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
      // 选区两端都必须落在 PDF 文字层内。
      // 跨页选择时 commonAncestorContainer 是页面容器，用「两端节点」判断才不会被误杀。
      const range = sel.getRangeAt(0);
      const inLayer = node => !!(node && (node.nodeType === 1
        ? node.closest('.txt-layer')
        : node.parentElement && node.parentElement.closest('.txt-layer')));
      if (!inLayer(range.startContainer) || !inLayer(range.endContainer)) {
        if (!editingId) closePop(); return;
      }
      const rect = range.getBoundingClientRect();
      if (!rect || (!rect.width && !rect.height)) return;
      const spans = collectSpans(range);
      if (!spans.length) return;
      pending = buildAnchor(spans, sel.toString(), range);
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

  // 选区在某一段文字里的字符偏移量（跨 <mark> 也能算对）
  function offsetIn(spanEl, container, offset) {
    try {
      const r = document.createRange();
      r.selectNodeContents(spanEl);
      r.setEnd(container, offset);
      return r.toString().length;
    } catch (e) { return null; }
  }
  // 生成锚点：除了「第几个片段」，还要记片段内的起止字符。
  // 否则选中一个词，整段都会被标记。
  function buildAnchor(spans, text, range) {
    const first = spans[0], last = spans[spans.length - 1];
    let startOff = 0;
    let endOff = (last.sp.item.str || '').length;
    if (range) {
      const so = offsetIn(first.sp.el, range.startContainer, range.startOffset);
      const eo = offsetIn(last.sp.el, range.endContainer, range.endOffset);
      if (so != null && so >= 0) startOff = so;
      if (eo != null && eo >= 0) endOff = eo;
    }
    const full = (first.sp.item.str || '').length;
    if (startOff > full) startOff = 0;
    if (endOff <= startOff && spans.length === 1) endOff = full;
    return {
      page: first.rec.n,
      startIdx: first.sp.idx, startOff,
      // 跨页选择时记下结束页，重绘时按页分段高亮
      endPage: last.rec.n,
      endIdx: last.sp.idx, endOff,
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
    const wasEdit = !!editingId;
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
    api.toast(wasEdit ? '批注已更新' : '批注已添加');
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
      try { paintAcross(a, activeId); } catch (e) { console.warn('高亮绘制失败', e); }
      const rec = pages[(a.page || 1) - 1];
      if (!rec) return;

      // 序号徽标只挂在起始页
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

  // 一条批注可能跨页：从起始页画到结束页，首尾页按记录的字符偏移截取，
  // 中间页整页都算命中
  function paintAcross(a, activeId) {
    const an = a.anchor || {};
    const sp = Math.max(1, +(an.page || a.page || 1));
    const ep = Math.max(sp, +(an.endPage || an.page || a.page || 1));
    for (let pn = sp; pn <= ep; pn++) {
      const rec = pages[pn - 1];
      if (!rec || !rec.spans.length) continue;
      const idxs = rec.spans.map(s => +String(s.idx));
      const lo = Math.min.apply(null, idxs);
      const hi = Math.max.apply(null, idxs);
      const isStart = pn === sp;
      const isEnd = pn === ep;
      const localAnchor = {
        startIdx: isStart ? an.startIdx : String(lo),
        startOff: isStart ? (an.startOff || 0) : 0,
        endIdx: isEnd ? an.endIdx : String(hi),
        endOff: isEnd ? an.endOff : null
      };
      paintAnn(rec, Object.assign({}, a, { anchor: localAnchor }), activeId);
    }
  }

  // 锚点 -> Range
  // span 内可能已经包着别的 <mark>，所以必须按「文本节点 + 累计偏移」定位，
  // 不能用 span 元素本身加字符偏移
  function textLenOf(root) {
    let n = 0;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let t;
    while ((t = w.nextNode())) n += (t.nodeValue || '').length;
    return n;
  }
  function nodeAtOffset(root, off) {
    let remain = Math.max(0, off || 0);
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n, last = null;
    while ((n = w.nextNode())) {
      last = n;
      const len = (n.nodeValue || '').length;
      if (remain <= len) return { node: n, offset: remain };
      remain -= len;
    }
    return last ? { node: last, offset: (last.nodeValue || '').length } : null;
  }
  function anchorToRange(anchor, rec) {
    if (!anchor) return null;
    const s = rec.spans.find(x => String(x.idx) === String(anchor.startIdx));
    const e = rec.spans.find(x => String(x.idx) === String(anchor.endIdx)) || s;
    if (!s) return null;
    try {
      const sLen = textLenOf(s.el);
      const eLen = textLenOf(e.el);
      const st = nodeAtOffset(s.el, Math.min(anchor.startOff || 0, sLen));
      const en = nodeAtOffset(e.el, Math.min(anchor.endOff != null ? anchor.endOff : eLen, eLen));
      if (!st || !en) return null;
      const r = document.createRange();
      r.setStart(st.node, st.offset);
      r.setEnd(en.node, en.offset);
      return r;
    } catch (err) { return null; }
  }

  // 只给选区覆盖到的字符加高亮：先把每段文字拆成「命中区间」，
  // 再用 Range.surroundContents 分段包 mark，这样同段里的多条批注不会嵌套整段
  function paintAnn(rec, a, activeId) {
    const an = a.anchor || {};
    const s = rec.spans.find(x => String(x.idx) === String(an.startIdx));
    const e = rec.spans.find(x => String(x.idx) === String(an.endIdx)) || s;
    if (!s) return;
    const i0 = +String(s.idx), i1 = +String(e.idx);
    const lo = Math.min(i0, i1), hi = Math.max(i0, i1);
    rec.spans.forEach(sp => {
      const idx = +String(sp.idx);
      if (idx < lo || idx > hi) return;
      const total = textLenOf(sp.el);
      let ls = String(sp.idx) === String(an.startIdx) ? (an.startOff || 0) : 0;
      let le = String(sp.idx) === String(an.endIdx) ? (an.endOff != null ? an.endOff : total) : total;
      if (String(sp.idx) !== String(an.startIdx)) ls = 0;
      if (String(sp.idx) !== String(an.endIdx)) le = total;
      ls = Math.max(0, Math.min(ls, total));
      le = Math.max(0, Math.min(le, total));
      if (le <= ls) return;

      const segs = [];
      let cursor = 0;
      const w = document.createTreeWalker(sp.el, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = w.nextNode())) {
        const len = (n.nodeValue || '').length;
        const a0 = Math.max(ls, cursor);
        const a1 = Math.min(le, cursor + len);
        if (a1 > a0) segs.push({ node: n, from: a0 - cursor, to: a1 - cursor });
        cursor += len;
      }
      segs.forEach(seg => {
        const m = document.createElement('mark');
        m.className = 'ann t-' + (a.type || 'important') + (a.id === activeId ? ' active' : '');
        m.dataset.aid = a.id;
        m.title = a.text || a.quote || '';
        m.onclick = ev => { ev.stopPropagation(); focusAnn(a.id); };
        try {
          const r = document.createRange();
          r.setStart(seg.node, seg.from);
          r.setEnd(seg.node, seg.to);
          r.surroundContents(m);
        } catch (err) {
          // 极端情况（节点已被别的批注拆开）退化成整段包裹
          const parent = seg.node.parentNode;
          if (!parent) return;
          parent.insertBefore(m, seg.node);
          m.appendChild(seg.node);
        }
      });
    });
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

  // ---------- 把选中原文写入指定字段 ----------
  function fillField() {
    if (!pending || !pending.text) { api.toast('请先在正文里选中一段文字'); return; }
    const key = $('popField').value;
    if (!key) return;
    const f = (window.PaperFields.BY_KEY || {})[key];
    const label = f ? f.label : key;
    const cur2 = cur;
    const text = pending.text.trim();
    // 追加而非覆盖：避免把已整理好的内容冲掉
    const old = cur2[key] || '';
    if (old.includes(text.slice(0, 40))) { api.toast('该字段已包含这段内容'); return; }
    cur2[key] = old ? old + '\n' + text : text;
    api.save();
    closePop();
    window.getSelection().removeAllRanges();
    api.toast('已追加到「' + label + '」');
  }

  // ---------- 选中原文存为观点 ----------
  function saveAsClaim() {
    if (!pending || !pending.text) { api.toast('请先在正文里选中一段文字'); return; }
    if (!api.addClaimFromSelection) { api.toast('当前版本未启用观点功能'); return; }
    const note = $('popText').value.trim();
    const p = pending;
    closePop();
    window.getSelection().removeAllRanges();
    api.addClaimFromSelection(cur.id, p, note);
  }

  // ---------- 证据回跳：精确定位或退化为跳页 ----------
  function clearEvidenceMarks() {
    document.querySelectorAll('mark.ann.t-evidence').forEach(m => {
      const host = m.parentNode;
      if (!host) return;
      while (m.firstChild) host.insertBefore(m.firstChild, m);
      m.remove();
    });
  }
  function focusEvidence(anchor, quote) {
    if (!anchor) return;
    const pageNo = Math.max(1, +(anchor.page || 1));
    const rec = pages[pageNo - 1];
    if (!rec) { api.toast('原文页码超出范围'); return; }
    rec.wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
    curPage = pageNo; updatePageLabel();
    clearEvidenceMarks();
    setTimeout(() => {
      const range = anchorToRange(anchor, rec);
      if (!range) {
        api.toast('该证据无法精确锚定，已跳到第 ' + pageNo + ' 页，请按摘录核对原文');
        return;
      }
      try {
        paintAnn(rec, { id: '__evidence__', type: 'evidence', anchor, quote: quote || '' }, null);
        api.toast('已定位到第 ' + pageNo + ' 页的证据');
      } catch (e) {
        api.toast('已跳到第 ' + pageNo + ' 页，但高亮失败，请按摘录核对');
      }
    }, 320);
  }

  // ---------- 框选截图收藏 ----------
  let shotState = null;
  function startShot() {
    if (!pages.length) { api.toast('PDF 尚未渲染完成'); return; }
    api.toast('在页面上拖出矩形框，即可收藏该区域为「图示」');
    document.getElementById('reader').classList.add('rd-shooting');
    // 给每一页盖一层透明蒙版用于框选
    pages.forEach(rec => {
      if (!rec || rec.shotMask) return;
      const mask = el('div', 'shotmask');
      mask.dataset.page = rec.n;
      rec.wrap.appendChild(mask);
      rec.shotMask = mask;
      mask.addEventListener('mousedown', e => beginDrag(e, rec, mask));
    });
  }
  function endShot() {
    document.getElementById('reader').classList.remove('rd-shooting');
    pages.forEach(rec => {
      if (rec && rec.shotMask) { rec.shotMask.remove(); rec.shotMask = null; }
    });
  }
  function beginDrag(e, rec, mask) {
    e.preventDefault();
    const wr = mask.getBoundingClientRect();
    const x0 = e.clientX - wr.left, y0 = e.clientY - wr.top;
    const rect = el('div', 'shotrect');
    mask.appendChild(rect);
    shotState = { rec, mask, rect, x0, y0, wr };

    const move = ev => {
      const x1 = ev.clientX - wr.left, y1 = ev.clientY - wr.top;
      const l = Math.min(x0, x1), t = Math.min(y0, y1);
      const w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
      rect.style.left = l + 'px'; rect.style.top = t + 'px';
      rect.style.width = w + 'px'; rect.style.height = h + 'px';
    };
    const up = ev => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      const x1 = ev.clientX - wr.left, y1 = ev.clientY - wr.top;
      const l = Math.min(x0, x1), t = Math.min(y0, y1);
      const w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
      rect.remove();
      endShot();
      if (w < 12 || h < 12) return;   // 误点，不收藏
      captureFigure(rec, l, t, w, h);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }

  function captureFigure(rec, l, t, w, h) {
    const canvas = rec.canvas;
    if (!canvas) return;
    // 蒙版是 CSS 像素，canvas 可能是设备像素，需要换算
    const sx = canvas.width / rec.wrap.clientWidth;
    const sy = canvas.height / rec.wrap.clientHeight;
    const out = document.createElement('canvas');
    out.width = Math.round(w * sx); out.height = Math.round(h * sy);
    const ctx = out.getContext('2d');
    ctx.drawImage(canvas, l * sx, t * sy, w * sx, h * sy, 0, 0, out.width, out.height);
    const data = out.toDataURL('image/png');
    const cap = prompt('给这张图起个名字（如「图4-1 WBS工作分解结构图」）', '第' + rec.n + '页 图示');
    if (cap === null) return;
    if (!Array.isArray(cur.figures)) cur.figures = [];
    cur.figures.push({ data, page: rec.n, caption: cap || ('第' + rec.n + '页'), at: new Date().toISOString() });
    api.save();
    api.toast('已收藏到「图示」字段，共 ' + cur.figures.length + ' 张');
  }

  window.ReaderMode = { init, open, close, repaint: paint };
})();

/* ================= 一键填充与截图收藏 =================
 * 挂在 ReaderMode 之外需要访问其闭包状态，因此通过 init 时注册。
 */
