/* PaperHub Research OS —— P3 本地研究助手
 *
 * 只做可验证的本地工作：
 *  - 从研究方案字段与库内观点生成答辩追问（模板 + 证据条件，不调用模型）
 *  - 把未回答的问题、方案缺口、审计未决项转成待办
 *  - 从方案/观点的方法记录提取迁移候选，由用户判断可迁移性
 *  - 文献可信度统一显示“未核验”，只提供 Crossref 搜索入口，不伪造核验结果
 */
(function (root) {
  'use strict';

  const $ = id => document.getElementById(id);
  const el = (t, c, x) => { const n = document.createElement(t); if (c) n.className = c; if (x != null) n.textContent = x; return n; };
  const uid = p => (p || 'x') + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const nowIso = () => new Date().toISOString();
  const hash = s => { let h = 0; for (let i = 0; i < String(s).length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0; return Math.abs(h).toString(36); };
  const short = (s, n) => { s = String(s || ''); return s.length > (n || 24) ? s.slice(0, n || 24) + '…' : s; };

  let api = null;
  let currentId = null;

  function init(hooks) { api = hooks; bind(); renderAll(); }
  function projects() { return (api && api.getProjects()) || []; }
  function papers() { return (api && api.getPapers()) || []; }
  function claims() { return (api && api.getClaims()) || []; }
  function audits() { return (api && api.getAudits()) || []; }
  function current() { return projects().find(p => p.id === currentId) || null; }
  function toast(m) { if (api && api.toast) api.toast(m); }
  function save() { if (api && api.save) api.save(); }
  function paperById(id) { return papers().find(p => p.id === id) || null; }
  function claimById(id) { return claims().find(c => c.id === id) || null; }

  function patchCurrent(patch) {
    const p = current(); if (!p) return;
    Object.assign(p, patch, { updatedAt: nowIso() });
    save();
  }

  function renderAll() {
    const sel = $('asProject'); if (!sel) return;
    const arr = projects().slice().sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    sel.innerHTML = '';
    if (!arr.length) {
      const o = document.createElement('option'); o.textContent = '还没有研究方案'; o.value = ''; sel.appendChild(o);
      currentId = null;
      ['asQuestions', 'asTodos', 'asTransfers', 'asCredibility'].forEach(id => { const b = $(id); if (b) b.innerHTML = ''; });
      $('asQuestions').appendChild(el('div', 'empty-r', '先在「研究设计」创建一份研究方案，研究助手才有可分析的蓝本。'));
      $('asQCount').textContent = '0 个问题'; $('asTodoCount').textContent = '0 项';
      return;
    }
    if (!currentId || !arr.some(p => p.id === currentId)) currentId = arr[0].id;
    arr.forEach(p => {
      const o = document.createElement('option'); o.value = p.id;
      o.textContent = short(p.title || '未命名方案', 28); sel.appendChild(o);
    });
    sel.value = currentId;
    renderQuestions();
    renderTodos();
    renderTransfers();
    renderCredibility();
  }

  // ---------- 答辩追问 ----------
  function generateQuestions() {
    const p = current(); if (!p) { toast('先创建研究方案'); return; }
    const qs = [];
    const add = (cat, text) => {
      const t = String(text || '').trim();
      if (!t || qs.some(x => x.text === t)) return;
      qs.push({ id: 'q' + hash(t), cat, text: t, source: 'local' });
    };
    add('研究定位', p.question
      ? `你的研究问题“${short(p.question, 60)}”是否具体到可以被数据回答？如果只能回答“有关系”，它还算研究问题吗？`
      : '你的核心研究问题是什么？它和“研究对象”之间是什么关系？');
    if (!p.objective) add('研究目标', '研究目标与研究方法之间是否对应？你希望最终回答的是描述、解释还是对策问题？');
    if (!p.researchQuestions) add('问题拆解', '主问题能否拆成 2–4 个可分别取证的子问题？每个子问题需要什么数据？');
    const methods = (p.methods || []).filter(m => m.name);
    if (methods.length < 2) add('方法适配', '为什么只选择一种方法？如果这种方法失败，你有没有备选方案？');
    methods.forEach(m => {
      add('方法适配', `若采用“${m.name}”，它的适用前提是“${short(m.applicability || '未填写', 40)}”，这些前提在你的样本中成立吗？`);
      if (m.limitation) add('方法局限', `“${m.name}”的局限是“${short(m.limitation, 40)}”，它会不会正好影响你的核心结论？`);
    });
    if (!p.dataNeeds) add('数据可得性', '你的数据具体从哪里来？谁有权提供？如果拿不到，研究问题是否需要缩小？');
    if (!p.framework) add('理论框架', '你使用的理论框架能解释哪些机制？它和变量选择之间是什么关系？');
    if (!p.risks) add('推广边界', '你的结论在哪些对象、行业、时间或制度条件下可能不成立？');
    if (p.missingEvidence) add('证据补齐', `你列出的待补证据是“${short(p.missingEvidence, 60)}”，在答辩前准备如何补齐？`);
    // 库内相反/条件不同观点 → 证据边界追问
    const linked = (p.claimIds || []).map(claimById).filter(Boolean);
    linked.forEach(c => {
      if (c.stance === 'oppose' || c.stance === 'conditional') {
        const pp = paperById(c.paperId);
        add('证据边界', `库内存在一条${c.stance === 'oppose' ? '相反' : '条件不同'}观点：“${short(c.text, 50)}”（${pp ? short(pp.title, 18) : '未绑定文献'}，第 ${c.page || '?'} 页）。你的方案如何处理这个差异？`);
      }
    });
    add('创新性', '与当前库内已有观点相比，你的研究新增了什么？如果只是换一个样本，贡献如何成立？');
    add('变量与因果', '你的变量关系是否可能是反向因果或共同原因造成的？你准备如何排除替代解释？');
    add('实践价值', '如果你的结论成立，哪一类项目或角色会改变什么决策？这个价值有没有证据支持？');

    p.advisor = p.advisor || { answers: {} };
    p.advisor.questions = qs.slice(0, 14);
    p.advisor.generatedAt = nowIso();
    p.advisor.answers = p.advisor.answers || {};
    patchCurrent({ advisor: p.advisor });
    renderQuestions();
    toast(qs.length ? `已生成 ${Math.min(qs.length, 14)} 个追问` : '缺少可生成问题的方案内容');
  }

  async function aiQuestions() {
    const p = current(); if (!p) { toast('先创建研究方案'); return; }
    if (!window.PaperAI || !window.PaperAI.isReady()) {
      toast('先配置 DeepSeek R1（顶栏 AI 设置）');
      if (api.openAiSettings) api.openAiSettings();
      return;
    }
    const cfg = window.PaperAI.getCfg();
    const linked = (p.claimIds || []).map(claimById).filter(Boolean);
    const context = {
      研究方案: {
        题目: p.title, 研究问题: p.question, 目标: p.objective,
        子问题: p.researchQuestions, 对象: p.scope,
        理论框架: p.framework,
        方法: (p.methods || []).filter(m => m.name).map(m => ({ 名称: m.name, 适用前提: m.applicability, 局限: m.limitation, 数据: m.data })),
        数据需求: p.dataNeeds, 风险: p.risks, 待补证据: p.missingEvidence
      },
      库内观点: linked.slice(0, 8).map(c => ({
        主张: c.text, 立场: c.stance, 页码: c.page, 原文: (c.quote || '').slice(0, 220)
      }))
    };
    const ctxText = JSON.stringify(context);
    const preview = ctxText.slice(0, 520);
    if (!confirm(
      `将把研究方案与 ${linked.length} 条库内观点发送到：\n` +
      `${cfg.base || 'OpenAI 兼容接口'} / ${cfg.model}\n\n` +
      `发送内容预览：\n${preview}…\n\n是否继续？`
    )) return;

    const prompt = `你是应用研究型硕士的答辩导师。只能使用下面给出的“研究方案”和“库内观点”，不得新增文献、作者、页码、引文或研究结论。请围绕创新性、研究问题与目标的一致性、方法适配、变量与因果、数据可得性、结论推广边界，提出 8–12 个具体、尖锐但有建设性的追问。

要求：
1. 每个问题必须能由研究者用其方案或数据回答，不要泛泛而谈。
2. 如果库内存在相反/条件不同观点，至少提出一个关于条件差异的问题。
3. 不要复述方案原文作为问题，不要编造“已有研究表明”。
4. 严格输出 JSON：{"questions":[{"category":"方法/数据/创新性/证据边界/推广","text":"问题"}]}

材料：
${ctxText.slice(0, 12000)}

请输出 JSON：`;

    const r = await window.PaperAI.chatJSON(prompt, { max_tokens: 2200, temperature: 0.3 });
    if (!r.ok) { toast('AI 生成失败：' + r.error); return; }
    const arr = r.data && Array.isArray(r.data.questions) ? r.data.questions : null;
    if (!arr || !arr.length) { toast('AI 没有返回可用问题，已保留本地追问'); return; }
    p.advisor = p.advisor || { answers: {} };
    const existing = p.advisor.questions || [];
    const merged = existing.slice();
    arr.forEach(q => {
      const text = String(q && q.text || '').trim();
      if (text.length < 8 || text.length > 240) return;
      if (merged.some(x => x.text === text)) return;
      merged.push({ id: 'q' + hash(text), cat: String(q.category || 'AI 追问'), text, source: 'ai' });
    });
    p.advisor.questions = merged.slice(0, 18);
    p.advisor.generatedAt = nowIso();
    p.advisor.model = r.model || cfg.model;
    patchCurrent({ advisor: p.advisor });
    renderQuestions();
    toast('已加入 AI 追问，仍需你逐条核对是否适用于本方案');
  }

  function renderQuestions() {
    const p = current(); const box = $('asQuestions');
    if (!box) return;
    box.innerHTML = '';
    const qs = (p.advisor && p.advisor.questions) || [];
    $('asQCount').textContent = qs.length + ' 个问题';
    if (!qs.length) {
      box.appendChild(el('div', 'empty-r', '点右上「生成答辩问题」，系统会根据方案字段与库内相反观点给出追问。'));
      return;
    }
    const answers = (p.advisor && p.advisor.answers) || {};
    qs.forEach(q => {
      const d = el('div', 'as-q');
      d.appendChild(el('div', 'qt', q.text));
      d.appendChild(el('div', 'qc', (q.source === 'ai' ? 'AI 建议 · ' : '本地模板 · ') + (q.cat || '追问')));
      const ta = document.createElement('textarea');
      ta.placeholder = '写下你的回答；没有答案就直接加入待办。';
      ta.value = answers[q.id] || '';
      ta.oninput = () => {
        p.advisor.answers = p.advisor.answers || {};
        p.advisor.answers[q.id] = ta.value;
        save();
      };
      d.appendChild(ta);
      const act = el('div', 'as-a-act');
      const b = el('button', 'btn', '加入待办');
      b.onclick = () => { addTodo(ta.value.trim() ? '补强回答：' + q.text : '回答：' + q.text, '答辩问题'); toast('已加入待办'); };
      act.appendChild(b);
      d.appendChild(act);
      box.appendChild(d);
    });
  }

  // ---------- 待办 ----------
  function addTodo(text, source) {
    const p = current(); if (!p || !text) return;
    p.todos = p.todos || [];
    if (p.todos.some(t => t.text === text && !t.done)) { toast('待办已存在'); return; }
    p.todos.unshift({ id: uid('t'), text, source: source || '手动', done: false, createdAt: nowIso() });
    patchCurrent({ todos: p.todos });
    renderTodos();
  }
  function renderTodos() {
    const p = current(); const box = $('asTodos');
    if (!box) return;
    box.innerHTML = '';
    const arr = (p && p.todos) || [];
    $('asTodoCount').textContent = arr.filter(t => !t.done).length + ' 项未完成 / ' + arr.length + ' 项';
    if (!arr.length) { box.appendChild(el('div', 'mini', '还没有待办。可以从答辩问题、方案缺口或审计未决项生成。')); return; }
    arr.forEach(t => {
      const d = el('div', 'todo' + (t.done ? ' done' : ''));
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!t.done;
      cb.onchange = () => { t.done = cb.checked; save(); renderTodos(); };
      d.appendChild(cb);
      const sp = document.createElement('span'); sp.textContent = t.text;
      d.appendChild(sp);
      if (t.source) d.appendChild(el('span', 'src', '· ' + t.source));
      const del = el('button', 'del', '×'); del.title = '删除待办';
      del.onclick = () => { p.todos = (p.todos || []).filter(x => x.id !== t.id); patchCurrent({ todos: p.todos }); renderTodos(); };
      d.appendChild(del);
      box.appendChild(d);
    });
  }
  function todosFromGaps() {
    const p = current(); if (!p) return;
    const add = (text) => { p.todos = p.todos || []; if (!p.todos.some(t => t.text === text)) p.todos.push({ id: uid('t'), text, source: '方案缺口', done: false, createdAt: nowIso() }); };
    if (!p.objective) add('补写研究目标');
    if (!p.researchQuestions) add('拆解研究问题与子问题');
    if ((p.methods || []).filter(m => m.name).length < 2) add('补充第二种候选方法并比较适用前提');
    if (!p.dataNeeds) add('明确数据来源、样本与可获得性');
    if (!p.risks) add('补写风险、限制与结论推广边界');
    if (!p.missingEvidence) add('列出待补检索/访谈/数据');
    patchCurrent({ todos: p.todos || [] });
    renderTodos();
    toast('已根据方案缺口生成待办');
  }
  function todosFromAudit() {
    const p = current(); if (!p) return;
    const a = audits().filter(x => !p.question || x.question === p.question).sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt)))[0];
    if (!a) { toast('还没有可用的审计结果，先到「证据审计」运行一次'); return; }
    p.todos = p.todos || [];
    let n = 0;
    a.items.forEach(it => {
      if (it.verdict === 'none' || it.verdict === 'conflict' || !it.reviewed) {
        const text = (it.verdict === 'none' ? '补证：' : (it.verdict === 'conflict' ? '核对冲突：' : '复核：')) + short(it.text, 50);
        if (!p.todos.some(t => t.text === text)) { p.todos.push({ id: uid('t'), text, source: '证据审计', done: false, createdAt: nowIso() }); n++; }
      }
    });
    patchCurrent({ todos: p.todos });
    renderTodos();
    toast(n ? `已从审计生成 ${n} 项待办` : '审计中没有新的未决项');
  }

  // ---------- 方法迁移 ----------
  function renderTransfers() {
    const p = current(); const box = $('asTransfers');
    if (!box) return;
    box.innerHTML = '';
    const candidates = [];
    (p.methods || []).filter(m => m.name).forEach(m => candidates.push({ method: m.name, source: '方案方法', claimId: '' }));
    (p.claimIds || []).map(claimById).filter(Boolean).forEach(c => {
      if (c.method) candidates.push({ method: c.method, source: '观点方法 · ' + (paperById(c.paperId) ? short(paperById(c.paperId).title, 16) : '未绑定'), claimId: c.id });
    });
    const uniq = [];
    candidates.forEach(c => { if (!uniq.some(x => x.method === c.method)) uniq.push(c); });
    if (!uniq.length) { box.appendChild(el('div', 'mini', '方案还没有方法，关联观点也没有记录方法。')); return; }
    p.transfers = p.transfers || [];
    uniq.forEach(c => {
      const cur = p.transfers.find(t => t.method === c.method) || { method: c.method, source: c.source, status: 'pending', note: '' };
      const d = el('div', 'transfer');
      d.appendChild(el('div', 'name', c.method));
      d.appendChild(el('div', 'src', c.source));
      const sel = document.createElement('select');
      [['pending', '待验证'], ['possible', '可能可迁移'], ['impossible', '不可迁移']].forEach(([v, t]) => { const o = document.createElement('option'); o.value = v; o.textContent = t; sel.appendChild(o); });
      sel.value = cur.status || 'pending';
      const note = document.createElement('input'); note.placeholder = '迁移边界 / 适用前提'; note.value = cur.note || '';
      const sync = () => {
        let rec = p.transfers.find(t => t.method === c.method);
        if (!rec) { rec = { method: c.method, source: c.source, status: 'pending', note: '' }; p.transfers.push(rec); }
        rec.status = sel.value; rec.note = note.value;
        patchCurrent({ transfers: p.transfers });
      };
      sel.onchange = sync; note.oninput = sync;
      d.appendChild(sel); d.appendChild(note);
      box.appendChild(d);
    });
  }

  // ---------- 可信度 ----------
  function renderCredibility() {
    const p = current(); const box = $('asCredibility');
    if (!box) return;
    box.innerHTML = '';
    const ids = [...new Set([...(p.paperIds || []), ...(p.claimIds || []).map(id => (claimById(id) || {}).paperId)].filter(Boolean))];
    const list = ids.map(paperById).filter(Boolean);
    if (!list.length) { box.appendChild(el('div', 'mini', '方案还没有关联文献，无法列出可信度状态。')); return; }
    list.forEach(pp => {
      const d = el('div', 'cred');
      const c = el('div', 'ct');
      c.appendChild(el('b', null, pp.title || pp.fileName || '未命名'));
      c.appendChild(el('span', null, (pp.authors || '') + ' · ' + (pp.year || '') + ' · ' + (pp.source || pp.school || '来源未识别')));
      d.appendChild(c);
      d.appendChild(el('span', 'unv', '未核验'));
      const a = document.createElement('a');
      a.href = 'https://search.crossref.org/?q=' + encodeURIComponent((pp.title || '') + ' ' + (pp.authors || ''));
      a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = 'Crossref 检索';
      d.appendChild(a);
      box.appendChild(d);
    });
  }

  function exportAssistant() {
    const p = current(); if (!p) { toast('没有可导出的方案'); return; }
    const lines = ['# 研究助手纪要：' + (p.title || '未命名'), '', '导出时间：' + new Date().toISOString().slice(0, 16).replace('T', ' '), ''];
    lines.push('## 答辩追问与回答', '');
    const qs = (p.advisor && p.advisor.questions) || [];
    const ans = (p.advisor && p.advisor.answers) || {};
    if (!qs.length) lines.push('（尚未生成）');
    qs.forEach((q, i) => {
      lines.push(`### ${i + 1}. ${q.text}`);
      lines.push('');
      lines.push('- 类别：' + q.cat);
      lines.push('- 回答：' + (ans[q.id] || '（未回答）'));
      lines.push('');
    });
    lines.push('## 待办', '');
    (p.todos || []).forEach(t => lines.push(`- [${t.done ? 'x' : ' '}] ${t.text}${t.source ? '（' + t.source + '）' : ''}`));
    lines.push('');
    lines.push('## 方法迁移候选', '');
    (p.transfers || []).forEach(t => lines.push(`- ${t.method}：${({ pending: '待验证', possible: '可能可迁移', impossible: '不可迁移' })[t.status] || t.status}${t.note ? '；' + t.note : ''}`));
    lines.push('');
    lines.push('## 文献可信度', '');
    const ids = [...new Set([...(p.paperIds || []), ...(p.claimIds || []).map(id => (claimById(id) || {}).paperId)].filter(Boolean))];
    ids.map(paperById).filter(Boolean).forEach(pp => lines.push(`- ${pp.title}：未核验（平台未接 DOI/撤稿数据库，需人工检索）`));
    lines.push('');
    lines.push('> 本纪要由本地规则生成；没有调用模型，也没有产生外部核验结论。');
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = '研究助手纪要.md';
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 400);
    toast('已导出纪要');
  }

  function bind() {
    $('asProject').onchange = e => { currentId = e.target.value; renderAll(); };
    $('btnAsQuestions').onclick = generateQuestions;
    $('btnAsAiQuestions').onclick = aiQuestions;
    $('btnAsExport').onclick = exportAssistant;
    $('btnAsTodoAdd').onclick = () => { const v = $('asTodoInput').value.trim(); if (!v) return toast('先写待办内容'); addTodo(v, '手动'); $('asTodoInput').value = ''; };
    $('asTodoInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('btnAsTodoAdd').click(); } });
    $('btnAsTodoGap').onclick = todosFromGaps;
    $('btnAsTodoAudit').onclick = todosFromAudit;
  }

  root.PaperAdvisor = { init, renderAll, generateQuestions };
})(typeof self !== 'undefined' ? self : globalThis);
