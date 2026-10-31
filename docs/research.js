/* PaperHub Research OS —— P1 争议地图 + 研究机会雷达
 *
 * 设计原则：
 *  - 观点（claim）必须能绑定到某篇文献的页码与原文摘录；没有证据时明确标“待确认/证据不足”。
 *  - 研究机会（opportunity）只说明“当前导入文献库内的观察”，禁止“全领域首创/从未研究”措辞。
 *  - 不依赖 AI：全部功能可手工完成；AI 以后只作为可选抽取器接入。
 */
(function (root) {
  'use strict';

  const $ = id => document.getElementById(id);
  const el = (t, c, x) => { const n = document.createElement(t); if (c) n.className = c; if (x != null) n.textContent = x; return n; };
  const uid = p => (p || 'x') + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const nowIso = () => new Date().toISOString();

  const STANCE = {
    support: { label: '支持', cls: 'support' },
    oppose: { label: '反对', cls: 'oppose' },
    conditional: { label: '条件不同', cls: 'conditional' },
    unknown: { label: '证据不足', cls: 'unknown' }
  };
  const OPTYPE = { theory: '理论', method: '方法', context: '情境', data: '数据', practice: '实践' };
  const CONF = {
    needs_evidence: '证据不足 / 需补充文献',
    weak: '弱：库内少量线索',
    medium: '中：存在多篇相关证据',
    strong: '较强：存在明确对立或条件差异'
  };

  let api = null;
  let editingClaim = null;   // {id, isNew, draft}
  let editingOpp = null;

  function init(hooks) {
    api = hooks;
    bind();
    renderAll();
  }

  function papers() { return (api && api.getPapers()) || []; }
  function claims() { return (api && api.getClaims()) || []; }
  function opps() { return (api && api.getOpps()) || []; }
  function settings() { return (api && api.getSettings()) || {}; }
  function question() { return (settings().researchQuestion || '').trim(); }
  function conditions() { return settings().conditions || {}; }
  function paperById(id) { return papers().find(p => p.id === id) || null; }
  function claimById(id) { return claims().find(c => c.id === id) || null; }
  function shortTitle(p) {
    if (!p) return '未知文献';
    const t = p.title || p.fileName || '未命名文献';
    return t.length > 22 ? t.slice(0, 22) + '…' : t;
  }
  function queryClaims() {
    const q = question();
    const chosen = api && api.getSelected ? api.getSelected() : [];
    return claims().filter(c => {
      if (q && c.question !== q) return false;
      // 文献库有勾选时，争议地图只看这批文献；未绑定文献的观点仍保留
      if (chosen.length && c.paperId && !chosen.includes(c.paperId)) return false;
      return true;
    });
  }

  // ---------- 通用 UI ----------
  function setView(view) {
    if (api && api.setView) api.setView(view);
  }
  function toast(m) { if (api && api.toast) api.toast(m); }
  function save() { if (api && api.save) api.save(); }
  function emptyBox(title, desc) {
    const b = el('div', 'empty-r');
    b.appendChild(el('b', null, title));
    b.appendChild(document.createTextNode(desc));
    return b;
  }
  function pill(text, cls) { return el('span', 'pill ' + (cls || ''), text); }

  // ---------- 研究设定 ----------
  function fillSettings() {
    const q = question(), c = conditions();
    $('rqInput').value = q;
    $('rqObject').value = c.object || '';
    $('rqIndustry').value = c.industry || '';
    $('rqTime').value = c.time || '';
    $('rqContext').value = c.context || '';
    const chosen = api && api.getSelected ? api.getSelected() : [];
    $('rqPapers').textContent = `当前纳入 ${scopePapers().length} 篇` + (chosen.length ? '（勾选）' : '（全部）');
  }
  function saveSettings() {
    const q = $('rqInput').value.trim();
    api.updateSettings({
      researchQuestion: q,
      conditions: {
        object: $('rqObject').value.trim(),
        industry: $('rqIndustry').value.trim(),
        time: $('rqTime').value.trim(),
        context: $('rqContext').value.trim()
      }
    });
    save();
    renderAll();
    toast('研究设定已保存');
  }
  function scopePapers() {
    const sel = api.getSelected ? api.getSelected() : [];
    return sel.length ? papers().filter(p => sel.includes(p.id)) : papers();
  }

  // ---------- 争议地图 ----------
  function renderAll() {
    fillSettings();
    renderClaims();
    renderOpps();
  }

  function renderClaims() {
    if (!$('claimList')) return;
    const all = queryClaims();
    const stanceF = $('claimStance').value;
    const paperF = $('claimPaper').value;
    const shown = all.filter(c => (!stanceF || c.stance === stanceF) && (!paperF || c.paperId === paperF));

    // 统计
    const cnt = { support: 0, oppose: 0, conditional: 0, unknown: 0 };
    all.forEach(c => { if (cnt[c.stance] != null) cnt[c.stance]++; });
    $('claimStats').innerHTML = '';
    [['support', '支持'], ['oppose', '反对'], ['conditional', '条件不同'], ['unknown', '证据不足']].forEach(([k, label]) => {
      const d = el('div', 'rstat ' + k);
      d.appendChild(el('b', null, String(cnt[k])));
      d.appendChild(el('span', null, label));
      $('claimStats').appendChild(d);
    });

    // 文献筛选下拉
    const selBox = $('claimPaper');
    const cur = selBox.value;
    const used = [...new Set(all.map(c => c.paperId).filter(Boolean))].map(paperById).filter(Boolean);
    selBox.innerHTML = '';
    const o0 = document.createElement('option'); o0.value = ''; o0.textContent = '全部文献'; selBox.appendChild(o0);
    used.forEach(p => {
      const o = document.createElement('option'); o.value = p.id; o.textContent = shortTitle(p); selBox.appendChild(o);
    });
    if (used.some(p => p.id === cur)) selBox.value = cur;

    // 列表
    const list = $('claimList');
    list.innerHTML = '';
    if (!all.length) {
      list.appendChild(emptyBox('还没有观点',
        '在「文献库」点某篇「检阅」，选中原文后点「存为观点」；也可以点右上「新建观点」手工录入。'));
      renderMatrix(all);
      return;
    }
    if (!shown.length) {
      list.appendChild(emptyBox('没有符合筛选条件的观点', '换一个立场或文献筛选看看。'));
      renderMatrix(all);
      return;
    }
    shown.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))).forEach(c => {
      list.appendChild(claimCard(c));
    });
    renderMatrix(all);
  }

  function claimCard(c) {
    const p = paperById(c.paperId);
    const st = STANCE[c.stance] || STANCE.unknown;
    const card = el('div', 'claim-card ' + st.cls);
    const head = el('div', 'cc-head');
    head.appendChild(pill(st.label, st.cls));
    head.appendChild(pill(c.confirmed ? '已确认' : '待确认', c.confirmed ? 'confirmed' : 'unconfirmed'));
    if (c.page) head.appendChild(pill('第 ' + c.page + ' 页', 'evidence'));
    // 证据状态必须可见：从 PDF 选区来的有锚点，手工摘录只能算待核对
    if (c.anchor) head.appendChild(pill('原文锚点', 'confirmed'));
    else if (c.quote) head.appendChild(pill('人工摘录 · 待核对', 'unconfirmed'));
    else head.appendChild(pill('无原文证据', 'unknown'));
    card.appendChild(head);
    card.appendChild(el('div', 'cc-text', c.text || '（未填写主张）'));

    const meta = el('div', 'cc-meta');
    [p ? shortTitle(p) : (c.paperTitle || '未绑定文献'),
     c.object ? '对象：' + c.object : '',
     c.scope ? '范围：' + c.scope : '',
     c.method ? '方法：' + c.method : ''].filter(Boolean).forEach(x => meta.appendChild(el('span', null, x)));
    card.appendChild(meta);

    if (c.quote) {
      const q = el('div', 'cc-quote');
      q.appendChild(el('b', null, '原文：'));
      q.appendChild(document.createTextNode(c.quote.length > 220 ? c.quote.slice(0, 220) + '…' : c.quote));
      card.appendChild(q);
    }

    const act = el('div', 'cc-act');
    if (c.paperId) {
      const b = el('button', 'btn', '定位原文');
      b.onclick = () => api.openEvidence(c.paperId, c.anchor || { page: c.page || 1 }, c.quote || '');
      act.appendChild(b);
    }
    const be = el('button', 'btn', '编辑');
    be.onclick = () => openClaim(c);
    act.appendChild(be);
    const bc = el('button', 'btn', c.confirmed ? '取消确认' : '确认观点');
    bc.onclick = () => { c.confirmed = !c.confirmed; c.updatedAt = nowIso(); save(); renderClaims(); };
    act.appendChild(bc);
    const bd = el('button', 'btn danger', '删除');
    bd.onclick = () => {
      if (!confirm('删除这条观点？关联的机会卡片会保留，但会失去这条证据。')) return;
      const i = claims().findIndex(x => x.id === c.id);
      if (i >= 0) claims().splice(i, 1);
      opps().forEach(o => { if (Array.isArray(o.claimIds)) o.claimIds = o.claimIds.filter(x => x !== c.id); });
      save(); renderClaims(); renderOpps();
    };
    act.appendChild(bd);
    card.appendChild(act);
    return card;
  }

  function renderMatrix(all) {
    const box = $('claimMatrix');
    if (!box) return;
    box.innerHTML = '';
    const rows = {};
    all.forEach(c => {
      const k = c.paperId || '__none';
      rows[k] = rows[k] || { support: 0, oppose: 0, conditional: 0, unknown: 0 };
      rows[k][c.stance] = (rows[k][c.stance] || 0) + 1;
    });
    const keys = Object.keys(rows);
    if (!keys.length) {
      box.appendChild(el('div', 'mini', '有观点后，这里会显示每篇文献在四个立场上的分布。'));
      return;
    }
    const t = document.createElement('table');
    const thead = document.createElement('thead');
    const tr = document.createElement('tr');
    ['文献', '支持', '反对', '条件', '不足'].forEach((x, i) => tr.appendChild(el('th', null, x)));
    thead.appendChild(tr); t.appendChild(thead);
    const tb = document.createElement('tbody');
    keys.forEach(k => {
      const p = k === '__none' ? null : paperById(k);
      const r = el('tr');
      r.appendChild(el('td', null, p ? shortTitle(p) : '未绑定文献'));
      ['support', 'oppose', 'conditional', 'unknown'].forEach(s => r.appendChild(el('td', null, String(rows[k][s] || 0))));
      tb.appendChild(r);
    });
    t.appendChild(tb); box.appendChild(t);
  }

  // ---------- 观点编辑 ----------
  function ensureQuestionOrWarn() {
    if (question()) return true;
    toast('请先在上方填写并保存「研究问题」');
    $('rqInput').focus();
    return false;
  }

  function openClaim(c) {
    if (!c && !ensureQuestionOrWarn()) return;
    editingClaim = c ? { id: c.id, isNew: false } : { id: uid('c'), isNew: true };
    const draft = c || {
      id: editingClaim.id, question: question(), text: '', stance: 'unknown',
      object: conditions().object || '', scope: conditions().context || '',
      method: '', paperId: '', page: '', quote: '', note: '',
      anchor: null, confirmed: false
    };
    $('clTitle').textContent = c ? '编辑观点' : '新建观点';
    $('clText').value = draft.text || '';
    $('clStance').value = draft.stance || 'unknown';
    $('clObject').value = draft.object || '';
    $('clScope').value = draft.scope || '';
    $('clMethod').value = draft.method || '';
    $('clPage').value = draft.page || '';
    $('clQuote').value = draft.quote || '';
    $('clNote').value = draft.note || '';
    $('clDelete').style.display = c ? '' : 'none';
    $('clEvidenceHint').textContent = draft.anchor
      ? '这条观点已绑定原文锚点；修改页码或摘录后，若无法精确定位会自动退化为“跳页 + 原文摘录”。'
      : '没有原文证据也可以先保存为“待确认”，但研究机会与写作引用只应使用能回到原文的观点。';

    const ps = $('clPaper');
    ps.innerHTML = '';
    const o0 = document.createElement('option'); o0.value = ''; o0.textContent = '（未绑定文献）'; ps.appendChild(o0);
    papers().forEach(p => {
      const o = document.createElement('option'); o.value = p.id; o.textContent = shortTitle(p); ps.appendChild(o);
    });
    ps.value = draft.paperId || '';

    editingClaim.draft = draft;
    $('claimModal').classList.add('on');
  }

  function saveClaim() {
    if (!editingClaim) return;
    const text = $('clText').value.trim();
    if (!text) { toast('请填写观点主张'); $('clText').focus(); return; }
    const paperId = $('clPaper').value || '';
    const page = parseInt($('clPage').value, 10) || '';
    const quote = $('clQuote').value.trim();
    const old = editingClaim.isNew ? null : claimById(editingClaim.id);
    // 页码和摘录都没改才复用旧锚点；否则自动退化为“跳页 + 摘录”，不假装精确高亮
    const anchor = (old && old.anchor && String(old.page) === String(page) && (old.quote || '') === quote)
      ? old.anchor : null;
    const c = {
      id: editingClaim.id,
      question: old ? (old.question || question()) : question(),
      text,
      stance: $('clStance').value || 'unknown',
      object: $('clObject').value.trim(),
      scope: $('clScope').value.trim(),
      method: $('clMethod').value.trim(),
      paperId, page, quote, anchor,
      evidenceId: (old && old.evidenceId) || (quote ? uid('ev') : ''),
      note: $('clNote').value.trim(),
      confirmed: old ? !!old.confirmed : false,
      createdAt: old ? old.createdAt : nowIso(),
      updatedAt: nowIso()
    };
    if (editingClaim.isNew) claims().push(c);
    else {
      const i = claims().findIndex(x => x.id === c.id);
      if (i < 0) claims().push(c); else claims()[i] = c;
    }
    save(); closeClaim(); renderAll();
    toast('观点已保存');
  }

  function closeClaim() { $('claimModal').classList.remove('on'); editingClaim = null; }
  function deleteClaim() {
    if (!editingClaim || editingClaim.isNew) return;
    if (!confirm('删除这条观点？')) return;
    const i = claims().findIndex(x => x.id === editingClaim.id);
    const cid = editingClaim.id;
    if (i >= 0) claims().splice(i, 1);
    opps().forEach(o => { if (Array.isArray(o.claimIds)) o.claimIds = o.claimIds.filter(x => x !== cid); });
    save(); closeClaim(); renderAll();
    toast('已删除');
  }

  // Reader 调用：把选中原文直接变成一条待确认观点
  function addClaimFromSelection(paperId, pending, note) {
    const p = paperById(paperId);
    if (!p || !pending) return;
    const c = {
      id: uid('c'), question: question(),
      text: (note && note.trim()) || pending.text || '',
      stance: 'unknown',
      object: conditions().object || '',
      scope: conditions().context || '',
      method: '',
      paperId, page: pending.page || 1,
      quote: (pending.text || '').slice(0, 1000),
      anchor: pending,
      evidenceId: uid('ev'),
      note: note && note.trim() && note.trim() !== pending.text ? '' : '',
      confirmed: false, createdAt: nowIso(), updatedAt: nowIso()
    };
    claims().push(c);
    save();
    setView('claims');
    renderAll();
    openClaim(c);
    toast('已生成一条待确认观点，请选择立场并确认');
  }

  // ---------- 机会雷达 ----------
  function renderOpps() {
    if (!$('oppList')) return;
    const list = $('oppList');
    list.innerHTML = '';
    const qf = ($('oppFilterQ').value || '').trim().toLowerCase();
    const tf = $('oppFilterType').value;
    const sf = $('oppFilterStatus').value;
    let arr = opps().slice();
    if (qf) arr = arr.filter(o => ((o.title || '') + ' ' + (o.question || '') + ' ' + (o.researchQuestion || '')).toLowerCase().includes(qf));
    if (tf) arr = arr.filter(o => o.type === tf);
    if (sf) arr = arr.filter(o => (o.status || 'draft') === sf);
    $('oppCount').textContent = arr.length + ' 张卡片';
    if (!arr.length) {
      list.appendChild(emptyBox('还没有研究机会卡片',
        '点「从观点生成候选」，系统只基于当前库内观点给出候选；也可以手工新建卡片。'));
      return;
    }
    arr.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))).forEach(o => list.appendChild(oppCard(o)));
  }

  function oppCard(o) {
    const card = el('div', 'opp-card' + (o.status === 'saved' ? ' saved' : ''));
    const top = el('div', 'opp-top');
    top.appendChild(el('h4', null, o.title || '未命名研究机会'));
    top.appendChild(pill(OPTYPE[o.type] || '机会', o.type === 'method' ? 'evidence' : 'unknown'));
    card.appendChild(top);

    const meta = el('div', 'opp-meta');
    meta.appendChild(pill(o.status === 'saved' ? '已收藏' : '草案', o.status === 'saved' ? 'confirmed' : 'unconfirmed'));
    meta.appendChild(pill(CONF[o.confidence] || CONF.needs_evidence, o.confidence === 'strong' ? 'support' : (o.confidence === 'needs_evidence' ? 'conditional' : 'evidence')));
    card.appendChild(meta);

    if (o.researchQuestion) card.appendChild(el('div', 'opp-rq', o.researchQuestion));

    const linked = (o.claimIds || []).map(claimById).filter(Boolean);
    const papersLinked = [...new Set(linked.map(c => c.paperId).filter(Boolean))];
    const sec = el('div', 'opp-sec');
    sec.appendChild(el('b', null, '证据基础：'));
    sec.appendChild(document.createTextNode(
      linked.length ? `${linked.length} 条观点，来自 ${papersLinked.length} 篇库内文献` : '尚无关联观点'));
    card.appendChild(sec);

    if (linked.length) {
      const ev = el('div', 'opp-ev');
      linked.slice(0, 6).forEach(c => {
        const p = paperById(c.paperId);
        const chip = el('span', 'ev-chip', (p ? shortTitle(p) : '未绑定') + ' · p' + (c.page || '?'));
        chip.title = c.quote || c.text || '';
        chip.onclick = () => { if (c.paperId) api.openEvidence(c.paperId, c.anchor || { page: c.page || 1 }, c.quote || ''); };
        ev.appendChild(chip);
      });
      card.appendChild(ev);
    }

    if (o.limit) {
      const l = el('div', 'opp-sec');
      l.appendChild(el('b', null, '限制 / 反向证据：'));
      l.appendChild(document.createTextNode(o.limit));
      card.appendChild(l);
    }
    if (o.searchTerms && o.searchTerms.length) {
      const s = el('div', 'opp-sec');
      s.appendChild(el('b', null, '待补检索：'));
      s.appendChild(document.createTextNode(o.searchTerms.join('、')));
      card.appendChild(s);
    }
    if (o.note) {
      const n = el('div', 'opp-sec');
      n.appendChild(el('b', null, '备注：'));
      n.appendChild(document.createTextNode(o.note));
      card.appendChild(n);
    }

    const act = el('div', 'opp-act');
    const bdg = el('button', 'btn', '转为研究方案');
    bdg.onclick = () => {
      if (window.PaperDesign) window.PaperDesign.createFromOpportunity(o);
      else toast('研究设计模块未加载');
    };
    act.appendChild(bdg);
    const be = el('button', 'btn', '编辑');
    be.onclick = () => openOpp(o);
    act.appendChild(be);
    const bs = el('button', 'btn', o.status === 'saved' ? '取消收藏' : '收藏');
    bs.onclick = () => { o.status = o.status === 'saved' ? 'draft' : 'saved'; o.updatedAt = nowIso(); save(); renderOpps(); };
    act.appendChild(bs);
    const bm = el('button', 'btn', '导出这张');
    bm.onclick = () => exportOppMd([o], (o.title || '研究机会').slice(0, 24) + '.md');
    act.appendChild(bm);
    const bd = el('button', 'btn danger', '删除');
    bd.onclick = () => {
      if (!confirm('删除这张研究机会卡片？')) return;
      const i = opps().findIndex(x => x.id === o.id);
      if (i >= 0) opps().splice(i, 1);
      save(); renderOpps();
    };
    act.appendChild(bd);
    card.appendChild(act);
    return card;
  }

  function currentClaimsForOpp() {
    const all = queryClaims();
    return all.length ? all : claims();
  }

  function openOpp(o) {
    editingOpp = o ? { id: o.id, isNew: false } : { id: uid('o'), isNew: true };
    const d = o || {
      id: editingOpp.id, question: question(), title: '', researchQuestion: '',
      type: 'theory', confidence: 'needs_evidence', status: 'draft',
      claimIds: [], limit: '', searchTerms: [], note: '', paperIds: []
    };
    $('opTitle').textContent = o ? '编辑研究机会' : '新建研究机会';
    $('opTitleInput').value = d.title || '';
    $('opRQ').value = d.researchQuestion || '';
    $('opType').value = d.type || 'theory';
    $('opConfidence').value = d.confidence || 'needs_evidence';
    $('opStatus').value = d.status || 'draft';
    $('opLimit').value = d.limit || '';
    $('opSearch').value = (d.searchTerms || []).join(', ');
    $('opNote').value = d.note || '';
    $('opDelete').style.display = o ? '' : 'none';

    const box = $('opClaims'); box.innerHTML = '';
    const list = currentClaimsForOpp();
    if (!list.length) box.appendChild(el('div', 'mini', '暂无观点。可以先到「争议地图」创建观点，再回来关联。'));
    list.forEach(c => {
      const lab = el('label', 'ck');
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = c.id;
      cb.checked = (d.claimIds || []).includes(c.id);
      lab.appendChild(cb);
      const p = paperById(c.paperId);
      lab.appendChild(document.createTextNode((c.text || '（未填写）').slice(0, 45) + ' · ' + (p ? shortTitle(p) : '未绑定')));
      box.appendChild(lab);
    });

    editingOpp.draft = d;
    $('oppModal').classList.add('on');
  }

  function saveOpp() {
    if (!editingOpp) return;
    const title = $('opTitleInput').value.trim();
    if (!title) { toast('请填写卡片标题'); $('opTitleInput').focus(); return; }
    const claimIds = [...$('opClaims').querySelectorAll('input[type=checkbox]:checked')].map(x => x.value);
    const linked = claimIds.map(claimById).filter(Boolean);
    if (!linked.length) {
      toast('至少关联一条观点作为证据；没有证据的卡片不允许保存');
      return;
    }
    const paperIds = [...new Set(linked.map(c => c.paperId).filter(Boolean))];
    const old = editingOpp.isNew ? null : opps().find(x => x.id === editingOpp.id);
    const searchTerms = $('opSearch').value.split(/[,，、;；]/).map(s => s.trim()).filter(Boolean);
    const o = {
      id: editingOpp.id,
      question: old ? old.question : question(),
      title,
      researchQuestion: $('opRQ').value.trim(),
      type: $('opType').value,
      confidence: $('opConfidence').value,
      status: $('opStatus').value,
      claimIds, paperIds,
      limit: $('opLimit').value.trim(),
      searchTerms,
      note: $('opNote').value.trim(),
      source: old ? old.source : 'manual',
      createdAt: old ? old.createdAt : nowIso(),
      updatedAt: nowIso()
    };
    if (editingOpp.isNew) opps().push(o);
    else {
      const i = opps().findIndex(x => x.id === o.id);
      if (i < 0) opps().push(o); else opps()[i] = o;
    }
    save(); closeOpp(); renderOpps();
    toast('研究机会已保存');
  }
  function closeOpp() { $('oppModal').classList.remove('on'); editingOpp = null; }
  function deleteOpp() {
    if (!editingOpp || editingOpp.isNew) return;
    if (!confirm('删除这张研究机会卡片？')) return;
    const i = opps().findIndex(x => x.id === editingOpp.id);
    if (i >= 0) opps().splice(i, 1);
    save(); closeOpp(); renderOpps();
    toast('已删除');
  }

  // 规则生成：只基于库内已有观点，不调用模型，不编造证据
  function generateOpps() {
    const q = question();
    if (!q) { toast('请先填写并保存研究问题'); $('rqInput').focus(); return; }
    const list = queryClaims();
    if (!list.length) { toast('当前研究问题与勾选文献下还没有观点，先在检阅模式中存观点或手工新建'); return; }
    const by = { support: [], oppose: [], conditional: [], unknown: [] };
    list.forEach(c => { (by[c.stance] || by.unknown).push(c); });
    const created = [];
    const exists = type => opps().some(o => o.question === q && o.type === type && o.source === 'rule');
    const add = (type, title, rq, ids, conf, limit) => {
      if (exists(type)) return;
      const linked = ids.map(claimById).filter(Boolean);
      const unanchored = linked.filter(c => !c.anchor).length;
      const o = {
        id: uid('o'), question: q, title, researchQuestion: rq, type,
        confidence: conf, status: 'draft', source: 'rule',
        claimIds: ids, paperIds: [...new Set(linked.map(c => c.paperId).filter(Boolean))],
        limit, searchTerms: [q, '边界条件', '反向证据', '方法比较'].filter(Boolean),
        note: '由当前库内观点自动汇总，需人工核对样本、情境与证据完整性。' +
          (unanchored ? ` 其中 ${unanchored} 条观点为人工摘录、尚无原文锚点，引用前必须回原文核对。` : ''),
        createdAt: nowIso(), updatedAt: nowIso()
      };
      opps().push(o); created.push(o);
    };

    if (by.support.length && by.oppose.length) {
      add('theory', '「' + q.slice(0, 36) + '」的对立结论与适用条件',
        '在哪些研究对象、行业或情境条件下，' + q + ' 的结论会发生方向性变化？',
        [...by.support, ...by.oppose].map(c => c.id), 'strong',
        '库内同时存在支持与反对观点；差异可能来自样本、时间、方法或情境条件，暂不能判定谁对谁错。');
    }
    if (by.conditional.length) {
      add('context', '「' + q.slice(0, 36) + '」的边界条件',
        '哪些条件组合会加强或削弱该结论？现有研究在哪些情境下可能不适用？',
        by.conditional.map(c => c.id), 'medium',
        '条件差异不是事实冲突，需要把对象、时间、制度环境与方法分别拆开验证。');
    }
    if (by.unknown.length || (!by.support.length || !by.oppose.length)) {
      add('method', '「' + q.slice(0, 36) + '」的证据缺口与方法补充',
        '当前库内证据为何不足以支持稳定结论？需要补充哪些样本、数据或研究方法？',
        (by.unknown.length ? by.unknown : list).map(c => c.id), 'needs_evidence',
        '这是基于当前导入文献库的观察，不代表全领域没有研究；需补充外部检索与样本。');
    }
    if (!created.length) { toast('同类候选已存在，未重复生成'); return; }
    save(); renderOpps();
    toast('已生成 ' + created.length + ' 张候选卡片（草案）');
  }

  function exportOppMd(list, filename) {
    if (!list || !list.length) { toast('没有可导出的卡片'); return; }
    const lines = ['# 研究机会卡片（当前导入文献库内观察）', ''];
    list.forEach((o, i) => {
      const linked = (o.claimIds || []).map(claimById).filter(Boolean);
      lines.push(`## ${i + 1}. ${o.title || '未命名'}`);
      lines.push('');
      lines.push('- 类型：' + (OPTYPE[o.type] || o.type));
      lines.push('- 证据强度：' + (CONF[o.confidence] || o.confidence));
      lines.push('- 状态：' + (o.status === 'saved' ? '已收藏' : '草案'));
      lines.push('');
      if (o.researchQuestion) { lines.push('**候选研究问题**'); lines.push(''); lines.push(o.researchQuestion); lines.push(''); }
      if (linked.length) {
        lines.push('**关联证据**');
        lines.push('');
        linked.forEach(c => {
          const p = paperById(c.paperId);
          lines.push(`- ${p ? p.title : '未绑定文献'}（第 ${c.page || '?'} 页）：${(c.quote || c.text || '').replace(/\n/g, ' ').slice(0, 260)}`);
        });
        lines.push('');
      }
      if (o.limit) { lines.push('**限制 / 反向证据**：' + o.limit); lines.push(''); }
      if (o.searchTerms && o.searchTerms.length) { lines.push('**待补检索词**：' + o.searchTerms.join('、')); lines.push(''); }
      if (o.note) { lines.push('**备注**：' + o.note); lines.push(''); }
      lines.push('> 说明：仅代表当前导入文献库内的观察，不代表全领域检索结论。');
      lines.push('');
    });
    download(lines.join('\n'), filename || '研究机会卡片.md', 'text/markdown');
  }

  function exportOppJson() {
    const arr = opps();
    if (!arr.length) { toast('没有可导出的卡片'); return; }
    download(JSON.stringify({ version: 1, exportedAt: nowIso(), note: '仅代表当前导入文献库内的观察', opportunities: arr }, null, 2),
      '研究机会卡片.json', 'application/json');
  }

  function download(text, name, type) {
    const b = new Blob([text], { type: type + ';charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 400);
  }

  // ---------- 事件 ----------
  function bind() {
    $('rqSave').onclick = saveSettings;
    $('rqScopeAll').onclick = () => {
      if (api && api.clearSelection) api.clearSelection();
      renderAll();
      toast('已改为纳入全部文献');
    };
    $('btnClaimNew').onclick = () => openClaim(null);
    $('btnClaimGuide').onclick = () => {
      const sel = api.getSelected ? api.getSelected() : [];
      if (sel.length) {
        if (api.openReader) api.openReader(sel[0]);
      } else {
        toast('先回「文献库」勾选或点开一篇论文，再选文字');
        setView('library');
      }
    };
    $('claimStance').onchange = renderClaims;
    $('claimPaper').onchange = renderClaims;
    $('clSave').onclick = saveClaim;
    $('clCancel').onclick = closeClaim;
    $('clClose').onclick = closeClaim;
    $('clDelete').onclick = deleteClaim;
    $('claimModal').onclick = e => { if (e.target === $('claimModal')) closeClaim(); };

    $('btnOppGenerate').onclick = generateOpps;
    $('btnOppNew').onclick = () => openOpp(null);
    $('btnOppExport').onclick = exportOppJson;
    $('btnOppMd').onclick = () => exportOppMd(opps());
    $('opSave').onclick = saveOpp;
    $('opCancel').onclick = closeOpp;
    $('opClose').onclick = closeOpp;
    $('opDelete').onclick = deleteOpp;
    $('oppModal').onclick = e => { if (e.target === $('oppModal')) closeOpp(); };
    ['oppFilterQ', 'oppFilterType', 'oppFilterStatus'].forEach(i => {
      const e = $(i); if (e) { e.addEventListener('input', renderOpps); e.addEventListener('change', renderOpps); }
    });
  }

  // 删除论文时联动清理
  function removePaper(paperId) {
    for (let i = claims().length - 1; i >= 0; i--) if (claims()[i].paperId === paperId) claims().splice(i, 1);
    opps().forEach(o => {
      o.claimIds = (o.claimIds || []).filter(id => claimById(id));
      o.paperIds = (o.paperIds || []).filter(id => id !== paperId);
    });
    renderAll();
  }

  root.ResearchOS = {
    init, renderAll, renderClaims, renderOpps, addClaimFromSelection, removePaper,
    openClaim, openOpp, setView
  };
})(typeof self !== 'undefined' ? self : globalThis);
