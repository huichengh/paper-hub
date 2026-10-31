/* PaperHub Research OS —— P2 研究方案生成器 + 论文证据链审计
 *
 * 研究方案：从研究机会/手工创建研究蓝图，字段级来源标记（文献/推断/用户），
 *          至少两种候选方法的结构化比较，版本快照，Markdown/JSON 导出。
 * 证据审计：把用户文本按句拆分，与库内 claim/原文摘录做本地 n-gram 匹配，
 *          给出“支持/部分支持/冲突/未找到证据”的机器初判，必须人工复核。
 *
 * 不调用模型，不伪造专家评分、用户调研或引文。AI 可选能力留给后续接入。
 */
(function (root) {
  'use strict';

  const $ = id => document.getElementById(id);
  const el = (t, c, x) => { const n = document.createElement(t); if (c) n.className = c; if (x != null) n.textContent = x; return n; };
  const uid = p => (p || 'x') + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const nowIso = () => new Date().toISOString();

  const SOURCE = { literature: '来自文献', inference: '基于文献的推断', user: '我手工填写' };
  const VERDICT = {
    support: '支持', partial: '部分支持', conflict: '冲突', none: '目前未找到证据'
  };
  const TYPE_LABEL = { theory: '理论', method: '方法', context: '情境', data: '数据', practice: '实践' };

  let api = null;
  let currentProject = null;
  let currentAudit = null;
  let auditDirty = false;

  function init(hooks) {
    api = hooks;
    bind();
    renderAll();
  }

  function papers() { return (api && api.getPapers()) || []; }
  function claims() { return (api && api.getClaims()) || []; }
  function opportunities() { return (api && api.getOpps()) || []; }
  function projects() { return (api && api.getProjects()) || []; }
  function audits() { return (api && api.getAudits()) || []; }
  function settings() { return (api && api.getSettings()) || {}; }
  function question() { return (settings().researchQuestion || '').trim(); }
  function selected() { return (api && api.getSelected) ? api.getSelected() : []; }
  function paperById(id) { return papers().find(p => p.id === id) || null; }
  function claimById(id) { return claims().find(c => c.id === id) || null; }
  function toast(m) { if (api && api.toast) api.toast(m); }
  function save() { if (api && api.save) api.save(); }
  function short(s, n) { s = String(s || ''); return s.length > (n || 24) ? s.slice(0, n || 24) + '…' : s; }
  function download(text, name, type) {
    const blob = new Blob([text], { type: (type || 'text/plain') + ';charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 400);
  }

  // ============================================================
  // 研究方案
  // ============================================================
  function blankProject() {
    return {
      id: uid('pr'), title: '未命名研究方案', question: question(),
      opportunityId: '', paperIds: [], claimIds: [],
      objective: '', researchQuestions: '',
      scope: {
        object: (settings().conditions || {}).object || '',
        industry: (settings().conditions || {}).industry || '',
        time: (settings().conditions || {}).time || '',
        context: (settings().conditions || {}).context || ''
      },
      framework: '',
      methods: [blankMethod(), blankMethod()],
      variables: [],
      dataNeeds: '', steps: '', contribution: '', risks: '', missingEvidence: '',
      sourceMap: { objective: 'inference', questions: 'inference', scope: 'user', framework: 'inference', methods: 'inference', variables: 'inference', data: 'inference', steps: 'user', contribution: 'inference', risks: 'literature' },
      status: 'draft', versions: [],
      createdAt: nowIso(), updatedAt: nowIso()
    };
  }
  function blankMethod() {
    return { id: uid('m'), name: '', applicability: '', limitation: '', data: '', cost: '', source: 'inference' };
  }
  function blankVariable() {
    return { id: uid('v'), name: '', type: '', measure: '', source: 'inference' };
  }

  function renderAll() {
    renderDesignList();
    renderEditor();
    renderAuditHistory();
    if (!auditDirty && currentAudit) $('auditText').value = currentAudit.text || '';
    renderAuditResults();
  }

  function renderDesignList() {
    if (!$('designList')) return;
    const box = $('designList'); box.innerHTML = '';
    const arr = projects().slice().sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    $('designCount').textContent = arr.length + ' 份';
    if (!arr.length) {
      box.appendChild(el('div', 'empty-r', '还没有研究方案。从「研究机会」卡片点「转为研究方案」，或新建一份。'));
      currentProject = null;
      return;
    }
    if (!currentProject || !arr.some(p => p.id === currentProject.id)) currentProject = arr[0];
    arr.forEach(p => {
      const it = el('div', 'design-item' + (currentProject && currentProject.id === p.id ? ' on' : ''));
      it.appendChild(el('b', null, p.title || '未命名研究方案'));
      it.appendChild(el('span', null, (p.status === 'confirmed' ? '已确认' : '草案') + ' · ' + (p.methods || []).filter(m => m.name).length + ' 种方法 · ' + String(p.updatedAt || '').slice(0, 10)));
      it.onclick = () => { currentProject = p; renderDesignList(); renderEditor(); };
      box.appendChild(it);
    });
  }

  function srcSelect(key, value) {
    const s = document.createElement('select');
    s.className = 'src'; s.dataset.src = key;
    Object.keys(SOURCE).forEach(k => {
      const o = document.createElement('option'); o.value = k; o.textContent = SOURCE[k]; s.appendChild(o);
    });
    s.value = value || 'inference';
    return s;
  }
  function dsec(title, key, hint, body) {
    const sec = el('div', 'dsec');
    const h = el('div', 'dsec-h');
    h.appendChild(el('b', null, title));
    if (key) h.appendChild(srcSelect(key, (currentProject.sourceMap || {})[key]));
    sec.appendChild(h);
    sec.appendChild(body);
    if (hint) sec.appendChild(el('div', 'hint', hint));
    return sec;
  }
  function ta(field, value, rows, ph) {
    const t = document.createElement('textarea');
    t.dataset.f = field; t.rows = rows || 3; t.placeholder = ph || ''; t.value = value || '';
    return t;
  }
  function inp(field, value, ph, type) {
    const i = document.createElement('input');
    i.type = type || 'text'; i.dataset.f = field; i.placeholder = ph || ''; i.value = value || '';
    return i;
  }

  function renderEditor() {
    const box = $('designEditor'); if (!box) return;
    box.innerHTML = '';
    if (!currentProject) {
      const d = el('div', 'design-empty');
      d.appendChild(el('b', null, '选择或新建一份研究方案'));
      d.appendChild(document.createElement('br'));
      d.appendChild(document.createTextNode('研究方案不是自动生成的论文，而是一张可核对的研究蓝图：目标、问题、范围、方法、变量、数据、步骤、贡献与风险。'));
      box.appendChild(d);
      return;
    }
    const p = currentProject;
    const head = el('div', 'design-head');
    const ht = document.createElement('div'); ht.style.flex = '1';
    const title = inp('title', p.title, '方案标题');
    title.style.fontSize = '15px'; title.style.fontWeight = '700';
    ht.appendChild(title);
    ht.appendChild(el('div', 'meta', `状态：${p.status === 'confirmed' ? '已确认' : '草案'} · 更新于 ${String(p.updatedAt || '').slice(0, 16).replace('T', ' ')} · 历史版本 ${(p.versions || []).length} 个`));
    head.appendChild(ht);
    box.appendChild(head);

    const hasInference = Object.keys(p.sourceMap || {}).some(k => p.sourceMap[k] === 'inference');
    box.appendChild(el('div', 'design-draft',
      p.status === 'confirmed'
        ? '这份方案已由你确认。确认仅代表方案内容被人工看过，不代表方法适用于所有情境。'
        : '建议草案：含“基于文献的推断”的部分尚未经你确认。请逐项检查来源，再标记为已确认。'));

    box.appendChild(dsec('研究目标', 'objective',
      '写清楚“要解决什么、在什么范围内解决”，不要写成研究结论。',
      ta('objective', p.objective, 3, '例如：识别实物补偿模式下变电站迁改项目前期阶段的关键进度风险，并提出可操作的应对顺序。')));

    box.appendChild(dsec('研究问题', 'questions',
      '一个主问题 + 2–4 个子问题；每个子问题都应能被数据回答。',
      ta('researchQuestions', p.researchQuestions, 3, '主问题：……\n子问题 1：……\n子问题 2：……')));

    const scope = el('div', 'dgrid');
    [['object', '研究对象 / 样本'], ['industry', '行业 / 场景'], ['time', '时间范围'], ['context', '情境条件']].forEach(([k, label]) => {
      const d = el('div', 'dfield');
      d.appendChild(el('label', null, label));
      d.appendChild(inp(k, p.scope && p.scope[k], ''));
      scope.appendChild(d);
    });
    box.appendChild(dsec('研究对象与范围', 'scope', '范围决定结论能推广到哪里；写清“不研究什么”同样重要。', scope));

    box.appendChild(dsec('理论框架', 'framework',
      '只写真正使用的理论，并注明它来自哪篇文献；不要堆砌理论名词。',
      ta('framework', p.framework, 3, '例如：全寿命周期管理 + 风险矩阵；理论来源见关联文献……')));

    // 方法比较
    const mwrap = el('div', 'table-scroll');
    const mt = document.createElement('table'); mt.className = 'methods-table';
    mt.innerHTML = '<thead><tr><th style="width:18%">候选方法</th><th style="width:22%">适用前提</th><th style="width:22%">局限</th><th style="width:20%">数据需求</th><th style="width:18%">成本 / 可行性</th><th style="width:40px"></th></tr></thead>';
    const mtb = document.createElement('tbody');
    (p.methods || []).forEach(m => {
      const tr = el('tr'); tr.dataset.methodRow = m.id || uid('m');
      const fields = ['name', 'applicability', 'limitation', 'data', 'cost'];
      fields.forEach(f => {
        const td = document.createElement('td');
        const t = ta('m_' + f, m[f], 2, f === 'name' ? '如：案例研究' : '');
        t.dataset.m = f; td.appendChild(t); tr.appendChild(td);
      });
      const td = document.createElement('td');
      const b = el('button', 'btn sm', '×'); b.title = '删除该方法';
      b.onclick = () => { tr.remove(); };
      td.appendChild(b); tr.appendChild(td);
      mtb.appendChild(tr);
    });
    mt.appendChild(mtb); mwrap.appendChild(mt);
    const addM = el('button', 'btn sm method-add', '添加候选方法');
    addM.onclick = () => {
      const tr = el('tr'); tr.dataset.methodRow = uid('m');
      ['name', 'applicability', 'limitation', 'data', 'cost'].forEach(f => {
        const td = document.createElement('td');
        const t = ta('m_' + f, '', 2, f === 'name' ? '如：问卷 + 半结构访谈' : '');
        t.dataset.m = f; td.appendChild(t); tr.appendChild(td);
      });
      const td = document.createElement('td'); const b = el('button', 'btn sm', '×');
      b.onclick = () => tr.remove(); td.appendChild(b); tr.appendChild(td);
      mtb.appendChild(tr);
    };
    mwrap.appendChild(addM);
    mwrap.appendChild(el('div', 'hint', '至少填写两种方法。平台不提供专家评分或伪造的可行性分数，只并列适用前提、局限、数据与成本。'));
    box.appendChild(dsec('候选方法与结构化比较', 'methods', '', mwrap));

    // 变量
    const vwrap = el('div', 'table-scroll');
    const vt = document.createElement('table'); vt.className = 'methods-table';
    vt.innerHTML = '<thead><tr><th style="width:28%">变量 / 指标</th><th style="width:18%">类型</th><th style="width:38%">测量方式 / 数据字段</th><th style="width:16%">来源</th><th style="width:40px"></th></tr></thead>';
    const vtb = document.createElement('tbody');
    (p.variables || []).forEach(v => {
      const tr = el('tr');
      [['name', '名称'], ['type', '类型'], ['measure', '测量方式']].forEach(([f, ph]) => {
        const td = document.createElement('td'); const t = ta('v_' + f, v[f], 2, ph); t.dataset.v = f; td.appendChild(t); tr.appendChild(td);
      });
      const td = document.createElement('td');
      const s = document.createElement('select'); s.className = 'verdict-select';
      Object.keys(SOURCE).forEach(k => { const o = document.createElement('option'); o.value = k; o.textContent = SOURCE[k]; s.appendChild(o); });
      s.value = v.source || 'inference'; s.dataset.vsrc = '1'; td.appendChild(s); tr.appendChild(td);
      const td2 = document.createElement('td'); const b = el('button', 'btn sm', '×'); b.onclick = () => tr.remove(); td2.appendChild(b); tr.appendChild(td2);
      vtb.appendChild(tr);
    });
    vt.appendChild(vtb); vwrap.appendChild(vt);
    const addV = el('button', 'btn sm method-add', '添加变量 / 指标');
    addV.onclick = () => {
      const tr = el('tr');
      [['name', '名称'], ['type', '类型'], ['measure', '测量方式']].forEach(([f, ph]) => {
        const td = document.createElement('td'); const t = ta('v_' + f, '', 2, ph); t.dataset.v = f; td.appendChild(t); tr.appendChild(td);
      });
      const td = document.createElement('td'); const s = document.createElement('select'); s.className = 'verdict-select';
      Object.keys(SOURCE).forEach(k => { const o = document.createElement('option'); o.value = k; o.textContent = SOURCE[k]; s.appendChild(o); });
      s.value = 'inference'; s.dataset.vsrc = '1'; td.appendChild(s); tr.appendChild(td);
      const td2 = document.createElement('td'); const b = el('button', 'btn sm', '×'); b.onclick = () => tr.remove(); td2.appendChild(b); tr.appendChild(td2);
      vtb.appendChild(tr);
    };
    vwrap.appendChild(addV); vwrap.appendChild(el('div', 'hint', '变量要能落到可获得的数据上；没有数据来源的指标只能算待验证设想。'));
    box.appendChild(dsec('变量与测量', 'variables', '', vwrap));

    box.appendChild(dsec('数据需求与可获得性', 'data',
      '写清数据来源、样本量、时间窗口、谁有权提供；不要假设数据一定拿得到。',
      ta('dataNeeds', p.dataNeeds, 3, '如：项目合同、会议纪要、进度月报、访谈录音；预计样本 3 个项目 / 12 人。')));

    box.appendChild(dsec('实施步骤', 'steps',
      '按阶段写，能落到时间与产出物。',
      ta('steps', p.steps, 3, '1. 文献与理论框架梳理；2. 访谈与文件收集；3. 编码与风险矩阵；4. 案例验证；5. 论文写作。')));

    box.appendChild(dsec('预期贡献', 'contribution',
      '区分理论贡献、方法贡献、实践贡献；不要写“填补空白”这类无法证明的话。',
      ta('contribution', p.contribution, 2, '')));

    box.appendChild(dsec('风险、限制与缺失证据', 'risks',
      '把数据拿不到、样本偏差、方法不适用、结论推广边界写在这里。',
      ta('risks', p.risks, 2, '')));

    box.appendChild(dsec('待补证据', 'missingEvidence',
      '列出还需要补充的文献、数据或访谈；没有证据支持的部分不要写成既定事实。',
      ta('missingEvidence', p.missingEvidence, 2, '')));

    if (p.claimIds && p.claimIds.length) {
      const ev = el('div', 'dsec');
      ev.appendChild(el('b', null, '关联证据'));
      const list = el('div', 'audit-evs');
      p.claimIds.map(claimById).filter(Boolean).forEach(c => {
        const d = el('div', 'audit-ev');
        const pp = paperById(c.paperId);
        d.appendChild(el('b', null, (pp ? short(pp.title, 20) : '未绑定文献') + ' · 第 ' + (c.page || '?') + ' 页：'));
        d.appendChild(document.createTextNode((c.quote || c.text || '').slice(0, 220)));
        if (c.paperId) {
          const l = el('span', 'ev-link', '定位原文');
          l.onclick = () => api.openEvidence(c.paperId, c.anchor || { page: c.page || 1 }, c.quote || '');
          d.appendChild(l);
        }
        list.appendChild(d);
      });
      ev.appendChild(list); box.appendChild(ev);
    }

    const act = el('div', 'design-actions');
    const bsave = el('button', 'btn primary', '保存');
    bsave.onclick = () => saveProject(false);
    act.appendChild(bsave);
    const bver = el('button', 'btn', '保存新版本');
    bver.onclick = () => saveProject(true);
    act.appendChild(bver);
    const bconf = el('button', 'btn', p.status === 'confirmed' ? '转回草案' : '标记为已确认');
    bconf.onclick = () => toggleConfirmed();
    act.appendChild(bconf);
    act.appendChild(el('span', 'spacer'));
    const bmd = el('button', 'btn', '导出 Markdown'); bmd.onclick = () => exportProject('md'); act.appendChild(bmd);
    const bjson = el('button', 'btn', '导出 JSON'); bjson.onclick = () => exportProject('json'); act.appendChild(bjson);
    const bdel = el('button', 'btn danger', '删除方案'); bdel.onclick = deleteProject; act.appendChild(bdel);
    box.appendChild(act);
  }

  function readEditor() {
    const box = $('designEditor');
    const val = f => { const e = box.querySelector('[data-f="' + f + '"]'); return e ? e.value.trim() : ''; };
    const src = k => { const e = box.querySelector('[data-src="' + k + '"]'); return e ? e.value : 'inference'; };
    const methods = [...box.querySelectorAll('tr[data-method-row]')].map(tr => {
      const get = f => { const e = tr.querySelector('[data-m="' + f + '"]'); return e ? e.value.trim() : ''; };
      return { id: tr.dataset.methodRow, name: get('name'), applicability: get('applicability'), limitation: get('limitation'), data: get('data'), cost: get('cost'), source: 'inference' };
    }).filter(m => m.name || m.applicability || m.limitation);
    const variables = [...box.querySelectorAll('tbody tr')].filter(tr => tr.querySelector('[data-v="name"]')).map(tr => {
      const get = f => { const e = tr.querySelector('[data-v="' + f + '"]'); return e ? e.value.trim() : ''; };
      const s = tr.querySelector('[data-vsrc]');
      return { id: uid('v'), name: get('name'), type: get('type'), measure: get('measure'), source: s ? s.value : 'inference' };
    }).filter(v => v.name || v.measure);
    return Object.assign({}, currentProject, {
      title: val('title') || '未命名研究方案',
      objective: val('objective'),
      researchQuestions: val('researchQuestions'),
      scope: { object: val('object'), industry: val('industry'), time: val('time'), context: val('context') },
      framework: val('framework'),
      methods,
      variables,
      dataNeeds: val('dataNeeds'),
      steps: val('steps'),
      contribution: val('contribution'),
      risks: val('risks'),
      missingEvidence: val('missingEvidence'),
      sourceMap: {
        objective: src('objective'), questions: src('questions'), scope: src('scope'), framework: src('framework'),
        methods: src('methods'), variables: src('variables'), data: src('data'), steps: src('steps'),
        contribution: src('contribution'), risks: src('risks')
      }
    });
  }

  function saveProject(asVersion) {
    if (!currentProject) return;
    const d = readEditor();
    if (!d.title) { toast('请填写方案标题'); return; }
    const methods = d.methods.filter(m => m.name);
    if (methods.length < 2) { toast('至少填写两种候选方法，才能形成方法比较'); return; }
    d.methods = methods;
    d.variables = (d.variables || []).filter(v => v.name || v.measure);
    if (asVersion) {
      const snap = Object.assign({}, currentProject);
      snap.versions = undefined;
      d.versions = (currentProject.versions || []).concat([{ at: nowIso(), snapshot: snap }]).slice(-10);
    } else {
      d.versions = currentProject.versions || [];
    }
    d.updatedAt = nowIso();
    const i = projects().findIndex(x => x.id === d.id);
    if (i >= 0) projects()[i] = d; else projects().push(d);
    currentProject = d;
    save(); renderDesignList(); renderEditor();
    toast(asVersion ? '已保存新版本' : '方案已保存');
  }

  function toggleConfirmed() {
    if (!currentProject) return;
    const d = readEditor();
    d.status = currentProject.status === 'confirmed' ? 'draft' : 'confirmed';
    d.updatedAt = nowIso();
    const i = projects().findIndex(x => x.id === d.id);
    if (i >= 0) projects()[i] = d;
    currentProject = d;
    save(); renderDesignList(); renderEditor();
    toast(d.status === 'confirmed' ? '已标记为人工确认' : '已转回草案');
  }

  function deleteProject() {
    if (!currentProject) return;
    if (!confirm('删除研究方案《' + (currentProject.title || '未命名') + '》？')) return;
    const i = projects().findIndex(x => x.id === currentProject.id);
    if (i >= 0) projects().splice(i, 1);
    currentProject = null;
    save(); renderDesignList(); renderEditor();
    toast('方案已删除');
  }

  function newProject() {
    const p = blankProject();
    projects().push(p); currentProject = p;
    save(); api.setView('design'); renderAll();
    toast('已新建研究方案草案');
  }

  function createFromOpportunity(o) {
    if (!o) { toast('请先选择一张研究机会卡片'); return; }
    const p = blankProject();
    p.title = (o.title || '研究方案').slice(0, 60);
    p.question = o.question || question();
    p.opportunityId = o.id;
    p.claimIds = (o.claimIds || []).slice();
    p.paperIds = (o.paperIds || []).slice();
    p.researchQuestions = o.researchQuestion || '';
    p.objective = o.researchQuestion
      ? '围绕“' + o.researchQuestion + '”，明确研究对象、数据与可验证的分析步骤。'
      : '';
    p.risks = o.limit || '';
    p.missingEvidence = o.note || '';
    projects().push(p); currentProject = p;
    save(); api.setView('design'); renderAll();
    toast('已生成研究方案草案，请补全方法与数据');
  }

  async function aiDraft() {
    const p = currentProject;
    if (!p) { toast('先选择一份研究方案'); return; }
    if (!window.PaperAI || !window.PaperAI.isReady()) {
      toast('先配置 DeepSeek R1（顶栏 AI 设置）');
      if (api.openAiSettings) api.openAiSettings();
      return;
    }
    const cfg = window.PaperAI.getCfg();
    const linked = (p.claimIds || []).map(claimById).filter(Boolean);
    const ctx = {
      题目: p.title, 研究问题: p.question, 研究对象: p.scope,
      已有目标: p.objective, 已有方法: (p.methods || []).filter(m => m.name),
      库内观点: linked.slice(0, 8).map(c => ({ 主张: c.text, 立场: c.stance, 页码: c.page, 原文: (c.quote || '').slice(0, 180) }))
    };
    const ctxText = JSON.stringify(ctx);
    if (!confirm(
      `将把研究方案与 ${linked.length} 条库内观点发送到：\n${cfg.base || 'OpenAI 兼容接口'} / ${cfg.model}\n\n` +
      `预览：${ctxText.slice(0, 520)}…\n\nAI 只会补空字段，不会覆盖你已写的内容；是否继续？`
    )) return;
    const prompt = `你是应用研究型硕士的研究设计导师。只能使用给出的方案与库内观点，不得编造文献、作者、页码、引文或调研数据。请补全一份可执行的研究蓝图草案。

严格输出 JSON：
{"objective":"研究目标","researchQuestions":["主问题","子问题1","子问题2"],"framework":"理论框架及使用方式","methods":[{"name":"方法","applicability":"适用前提","limitation":"局限","data":"数据需求","cost":"成本/可行性"}],"variables":[{"name":"变量","type":"类型","measure":"测量方式"}],"dataNeeds":"数据来源与样本","steps":"实施步骤","contribution":"预期贡献（理论/实践）","risks":"风险、限制与推广边界","missingEvidence":"待补证据"}

规则：
1. 只做研究设计建议，不写研究结论，不声称“填补空白”。
2. 至少两种候选方法，不伪造专家评分或调研数据。
3. 变量必须能落到可获得的数据；无法确定的写“待验证”。
4. 如果材料不足，在 missingEvidence 中说明，不要编造。
5. 只输出 JSON，不要解释。

材料：
${ctxText.slice(0, 12000)}

请输出 JSON：`;
    const r = await window.PaperAI.chatJSON(prompt, { max_tokens: 2600, temperature: 0.3, timeout: 300000, json: true, system: '你是应用研究型硕士的研究设计导师。只输出严格 JSON 对象，不要 markdown，不要解释；所有内容用中文。' });
    if (!r.ok) { toast('AI 补全失败：' + r.error); return; }
    const d = r.data || {};
    const str = v => typeof v === 'string' ? v.trim() : '';
    const arr = v => Array.isArray(v) ? v : [];
    const methods = arr(d.methods).map(m => ({
      id: uid('m'), name: str(m && m.name), applicability: str(m && m.applicability),
      limitation: str(m && m.limitation), data: str(m && m.data), cost: str(m && m.cost), source: 'inference'
    })).filter(m => m.name).slice(0, 4);
    const variables = arr(d.variables).map(v => ({
      id: uid('v'), name: str(v && v.name), type: str(v && v.type), measure: str(v && v.measure), source: 'inference'
    })).filter(v => v.name || v.measure).slice(0, 10);
    // 只补空字段；已有内容保留
    if (!p.objective && str(d.objective)) p.objective = str(d.objective);
    if (!p.researchQuestions && arr(d.researchQuestions).length) p.researchQuestions = arr(d.researchQuestions).map(str).filter(Boolean).map((x, i) => (i ? '子问题' + i + '：' : '主问题：') + x).join('\n');
    if (!p.framework && str(d.framework)) p.framework = str(d.framework);
    const existingMethods = (p.methods || []).filter(m => m.name);
    if (existingMethods.length < 2 && methods.length) {
      p.methods = existingMethods.concat(methods.slice(0, 2 - existingMethods.length));
    }
    if (!(p.variables || []).length && variables.length) p.variables = variables;
    if (!p.dataNeeds && str(d.dataNeeds)) p.dataNeeds = str(d.dataNeeds);
    if (!p.steps && str(d.steps)) p.steps = str(d.steps);
    if (!p.contribution && str(d.contribution)) p.contribution = str(d.contribution);
    if (!p.risks && str(d.risks)) p.risks = str(d.risks);
    if (!p.missingEvidence && str(d.missingEvidence)) p.missingEvidence = str(d.missingEvidence);
    p.sourceMap = p.sourceMap || {};
    ['objective', 'questions', 'framework', 'methods', 'variables', 'data', 'steps', 'contribution', 'risks'].forEach(k => {
      if (!p.sourceMap[k]) p.sourceMap[k] = 'inference';
    });
    p.aiDraft = { model: r.model || cfg.model, at: nowIso(), note: 'AI 补全草案；未覆盖已有字段，需人工核对' };
    p.updatedAt = nowIso();
    const i = projects().findIndex(x => x.id === p.id);
    if (i >= 0) projects()[i] = p;
    save(); renderDesignList(); renderEditor();
    toast('AI 草案已补入空字段，请核对来源与方法');
  }

  function exportProject(kind) {
    if (!currentProject) return;
    const p = readEditor();
    if (kind === 'json') {
      download(JSON.stringify({ kind: 'research-design', platform: 'PaperHub Research OS', exportedAt: nowIso(), project: p }, null, 2),
        (p.title || '研究方案').slice(0, 30) + '.json', 'application/json');
      return;
    }
    const lines = [];
    lines.push('# 研究方案：' + (p.title || '未命名'));
    lines.push('');
    lines.push('- 状态：' + (p.status === 'confirmed' ? '已人工确认' : '建议草案'));
    lines.push('- 研究问题：' + (p.question || '未填写'));
    lines.push('');
    const sec = (t, v, k) => { if (v || k) { lines.push('## ' + t); lines.push(''); lines.push(v || '（未填写）'); lines.push(''); lines.push('> 来源：' + (SOURCE[(p.sourceMap || {})[k]] || '未标注')); lines.push(''); } };
    sec('研究目标', p.objective, 'objective');
    sec('研究问题', p.researchQuestions, 'questions');
    lines.push('## 对象与范围');
    lines.push('');
    lines.push('- 研究对象：' + (p.scope.object || '未填写'));
    lines.push('- 行业/场景：' + (p.scope.industry || '未填写'));
    lines.push('- 时间范围：' + (p.scope.time || '未填写'));
    lines.push('- 情境条件：' + (p.scope.context || '未填写'));
    lines.push('');
    sec('理论框架', p.framework, 'framework');
    lines.push('## 候选方法比较');
    lines.push('');
    lines.push('| 方法 | 适用前提 | 局限 | 数据需求 | 成本/可行性 |');
    lines.push('|---|---|---|---|---|');
    (p.methods || []).forEach(m => lines.push('| ' + [m.name, m.applicability, m.limitation, m.data, m.cost].map(x => String(x || '').replace(/\n/g, ' ')).join(' | ') + ' |'));
    lines.push('');
    lines.push('> 方法比较只列适用前提与成本，不包含伪造的专家评分。');
    lines.push('');
    lines.push('## 变量与测量');
    lines.push('');
    lines.push('| 变量 | 类型 | 测量方式 | 来源 |');
    lines.push('|---|---|---|---|');
    (p.variables || []).forEach(v => lines.push('| ' + [v.name, v.type, v.measure, SOURCE[v.source] || ''].join(' | ') + ' |'));
    lines.push('');
    sec('数据需求与可获得性', p.dataNeeds, 'data');
    sec('实施步骤', p.steps, 'steps');
    sec('预期贡献', p.contribution, 'contribution');
    sec('风险、限制与缺失证据', p.risks, 'risks');
    sec('待补证据', p.missingEvidence, 'risks');
    lines.push('---');
    lines.push('');
    lines.push('说明：本方案中的“基于文献的推断”与“我手工填写”部分需作者自行核对；平台不生成专家评价、调研数据或引文。');
    download(lines.join('\n'), (p.title || '研究方案').slice(0, 30) + '.md', 'text/markdown');
    toast('已导出 Markdown');
  }

  // ============================================================
  // 证据审计
  // ============================================================
  function splitSentences(text) {
    const out = [];
    const parts = String(text || '').split(/(?<=[。！？；\n])/);
    parts.forEach(s => {
      const t = s.replace(/\s+/g, ' ').trim();
      if (t.length >= 8) out.push(t);
    });
    return out.slice(0, 30);
  }
  function normText(s) {
    return String(s || '').replace(/[\s\u3000\p{P}\p{S}]/gu, '').toLowerCase();
  }
  const STOP = new Set(['研究', '本文', '进行', '通过', '以及', '一个', '我们', '可以', '不同', '相关', '主要', '问题', '分析', '影响', '因此', '但是', '同时']);
  function bigrams(s) {
    const t = normText(s);
    const set = new Set();
    for (let i = 0; i < t.length - 1; i++) {
      const g = t.slice(i, i + 2);
      if (!STOP.has(g)) set.add(g);
    }
    if (!set.size && t) set.add(t);
    return set;
  }
  function similarity(a, b) {
    const A = bigrams(a), B = bigrams(b);
    if (!A.size || !B.size) return 0;
    let inter = 0;
    A.forEach(x => { if (B.has(x)) inter++; });
    return inter / Math.min(A.size, B.size);
  }

  function auditClaimsPool() {
    const q = question();
    const chosen = selected();
    return claims().filter(c => {
      if (q && c.question !== q) return false;
      if (chosen.length && c.paperId && !chosen.includes(c.paperId)) return false;
      return true;
    });
  }

  function runAudit() {
    const text = ($('auditText').value || '').trim();
    if (!text) { toast('请先粘贴要审计的文本'); $('auditText').focus(); return; }
    const sentences = splitSentences(text);
    if (!sentences.length) { toast('没有识别到可核验的完整句子'); return; }
    const pool = auditClaimsPool();
    const items = sentences.map(s => {
      const scored = pool.map(c => {
        const source = (c.text || '') + ' ' + (c.quote || '');
        return { claim: c, score: similarity(s, source) };
      }).sort((a, b) => b.score - a.score);
      const top = scored.filter(x => x.score >= 0.12).slice(0, 3);
      const best = top[0];
      let verdict = 'none';
      let note = '';
      if (best && best.score >= 0.18) {
        const st = best.claim.stance;
        if (st === 'oppose') verdict = 'conflict';
        else if (st === 'conditional') verdict = 'partial';
        else if (st === 'unknown') { verdict = 'partial'; note = '库内证据本身不足，不能当作支持。'; }
        else verdict = 'support';
        const opposing = scored.find(x => x.claim.stance === 'oppose' && x.score >= 0.18);
        if (verdict === 'support' && opposing) { verdict = 'partial'; note = '库内同时存在相反观点，指向性不唯一。'; }
      }
      const papers = [...new Set(top.map(x => x.claim.paperId).filter(Boolean))];
      let suggestion = '';
      if (verdict === 'none') suggestion = '当前导入库内未找到可对应证据。建议改为“在本次检索到的文献中……”，或补充检索后再下结论；未找到证据不等于结论错误。';
      else if (verdict === 'conflict') suggestion = '库内存在相反或不同条件的观点。建议写明对象、情境与方法差异，不要把单篇结论写成普遍结论。';
      else if (verdict === 'partial') suggestion = '证据只覆盖部分条件。建议补上样本、行业、时间或方法限定，并标明待验证部分。';
      else suggestion = '库内存在支持性观点。仍需回原文核对页码、样本与语境，再决定是否引用。';
      return {
        id: uid('ai'), text: s,
        verdict, reviewed: false, note,
        evidence: top.map(x => ({
          claimId: x.claim.id, paperId: x.claim.paperId, page: x.claim.page,
          quote: x.claim.quote || x.claim.text || '', anchor: x.claim.anchor || null,
          claimText: x.claim.text || '', stance: x.claim.stance, score: Number(x.score.toFixed(3))
        })),
        coverage: `命中 ${top.length} 条观点，涉及 ${papers.length} 篇库内文献`,
        suggestion
      };
    });
    const uniquePapers = [...new Set(items.flatMap(it => it.evidence.map(e => e.paperId)).filter(Boolean))];
    const fulltextPapers = papers().filter(p => p.fulltext && p.fulltext.status === 'done').length;
    const audit = {
      id: uid('au'), question: question(), text,
      items, createdAt: nowIso(), updatedAt: nowIso(),
      coverage: { claims: pool.length, papers: papers().length, matchedPapers: uniquePapers.length, fulltextPapers },
      modelStatus: 'rule-based-local'
    };
    audits().unshift(audit);
    currentAudit = audit; auditDirty = false;
    save(); renderAuditHistory(); renderAuditResults();
    $('auditText').value = text;
    toast('审计完成，请逐条人工复核');
  }

  function renderAuditHistory() {
    const sel = $('auditHistory'); if (!sel) return;
    sel.innerHTML = '<option value="">历史审计…</option>';
    audits().slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).forEach(a => {
      const o = document.createElement('option'); o.value = a.id;
      o.textContent = String(a.createdAt || '').slice(0, 16).replace('T', ' ') + ' · ' + short(a.text, 24);
      sel.appendChild(o);
    });
    if (currentAudit) sel.value = currentAudit.id;
    if (!currentAudit) currentAudit = audits()[0] || null;
    if (currentAudit && !auditDirty) $('auditText').value = currentAudit.text || '';
  }

  function renderAuditResults() {
    const box = $('auditList'); if (!box) return;
    box.innerHTML = '';
    if (!currentAudit) {
      box.appendChild(el('div', 'audit-empty', '粘贴一段文字后点「开始审计」。系统按句拆分，用库内观点和原文摘录做本地匹配；所有结果都需要人工复核。'));
      $('auditMeta').textContent = '当前证据基础：尚未审计';
      return;
    }
    const a = currentAudit;
    $('auditMeta').textContent = `本地规则匹配 · 当前研究问题：${a.question || '未设置'} · 库内观点 ${a.coverage.claims} 条 · 文献 ${a.coverage.papers} 篇（其中全文已抽取 ${a.coverage.fulltextPapers} 篇） · 结果需人工复核`;
    a.items.forEach(it => {
      const card = el('div', 'audit-item ' + it.verdict);
      const head = el('div', 'audit-head');
      head.appendChild(el('div', 'txt', it.text));
      const sel = document.createElement('select'); sel.className = 'verdict-select';
      Object.keys(VERDICT).forEach(k => { const o = document.createElement('option'); o.value = k; o.textContent = VERDICT[k]; sel.appendChild(o); });
      sel.value = it.verdict;
      sel.onchange = () => { it.verdict = sel.value; it.reviewed = true; it.updatedAt = nowIso(); save(); renderAuditResults(); };
      head.appendChild(sel);
      card.appendChild(head);
      if (it.note) card.appendChild(el('div', 'audit-cov', it.note));
      const evs = el('div', 'audit-evs');
      if (!it.evidence.length) evs.appendChild(el('div', 'mini', '当前库内没有匹配到原文证据。'));
      it.evidence.forEach(ev => {
        const d = el('div', 'audit-ev');
        const p = paperById(ev.paperId);
        d.appendChild(el('b', null, (p ? short(p.title, 18) : '未绑定文献') + ' · 第 ' + (ev.page || '?') + ' 页：'));
        d.appendChild(document.createTextNode(' ' + String(ev.quote || '').slice(0, 180)));
        if (ev.paperId) {
          const l = el('span', 'ev-link', '定位原文');
          l.onclick = () => api.openEvidence(ev.paperId, ev.anchor || { page: ev.page || 1 }, ev.quote || '');
          d.appendChild(l);
        }
        evs.appendChild(d);
      });
      card.appendChild(evs);
      card.appendChild(el('div', 'audit-sug', '修改建议：' + it.suggestion));
      const act = el('div', 'cc-act');
      const copy = el('button', 'btn', '复制审阅意见');
      copy.onclick = () => {
        const t = '原文：' + it.text + '\n初判：' + VERDICT[it.verdict] + '\n建议：' + it.suggestion;
        if (navigator.clipboard) navigator.clipboard.writeText(t).then(() => toast('已复制审阅意见')).catch(() => toast('复制失败'));
        else toast('当前浏览器不支持剪贴板');
      };
      act.appendChild(copy);
      card.appendChild(act);
      card.appendChild(el('div', 'audit-cov', it.coverage + ' · 人工复核：' + (it.reviewed ? '已复核' : '未复核')));
      box.appendChild(card);
    });
  }

  function loadAudit(id) {
    const a = audits().find(x => x.id === id);
    if (!a) return;
    currentAudit = a; auditDirty = false;
    $('auditText').value = a.text || '';
    renderAuditHistory(); renderAuditResults();
  }

  function exportAudit(kind) {
    if (!currentAudit) { toast('没有可导出的审计结果'); return; }
    const a = currentAudit;
    if (kind === 'json') {
      download(JSON.stringify({ kind: 'evidence-audit', exportedAt: nowIso(), audit: a }, null, 2), '证据审计_' + a.id + '.json', 'application/json');
      return;
    }
    const lines = ['# 论文证据链审计', '', '- 时间：' + String(a.createdAt).slice(0, 16).replace('T', ' '), '- 研究问题：' + (a.question || '未设置'), '- 证据基础：库内观点 ' + a.coverage.claims + ' 条，文献 ' + a.coverage.papers + ' 篇，全文已抽取 ' + a.coverage.fulltextPapers + ' 篇', '- 判断方式：本地规则匹配（非大模型）', '', '## 待审文本', '', a.text, '', '## 逐句结果', ''];
    a.items.forEach((it, i) => {
      lines.push(`### ${i + 1}. ${it.text}`);
      lines.push('');
      lines.push('- 初判：' + VERDICT[it.verdict] + (it.reviewed ? '（已人工复核）' : '（未人工复核）'));
      lines.push('- 覆盖：' + it.coverage);
      if (it.note) lines.push('- 说明：' + it.note);
      lines.push('');
      if (it.evidence.length) {
        lines.push('**证据**');
        lines.push('');
        it.evidence.forEach(ev => {
          const p = paperById(ev.paperId);
          lines.push(`- ${p ? p.title : '未绑定文献'}（第 ${ev.page || '?'} 页，${ev.stance || '未判断'}）：${String(ev.quote || '').slice(0, 260)}`);
        });
        lines.push('');
      }
      lines.push('**修改建议**：' + it.suggestion);
      lines.push('');
    });
    lines.push('> 说明：机器初判只基于当前导入文献库的观点与原文摘录，不代表全领域检索结论；未找到证据不等于结论错误。');
    download(lines.join('\n'), '证据审计_' + a.id + '.md', 'text/markdown');
    toast('已导出 Markdown');
  }

  // ============================================================
  // 事件
  // ============================================================
  function bind() {
    $('btnDesignNew').onclick = newProject;
    $('btnDesignFromOpp').onclick = () => {
      const arr = opportunities().slice().sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
      if (!arr.length) { toast('还没有研究机会卡片，先到「研究机会」生成'); api.setView('opportunities'); return; }
      createFromOpportunity(arr[0]);
    };
    $('btnDesignAi').onclick = aiDraft;
    $('btnDesignExport').onclick = () => exportProject('md');

    $('btnAuditRun').onclick = runAudit;
    $('btnAuditExport').onclick = () => exportAudit('md');
    $('btnAuditJson').onclick = () => exportAudit('json');
    $('auditHistory').onchange = e => { if (e.target.value) loadAudit(e.target.value); };
    $('auditText').addEventListener('input', () => { auditDirty = true; });
  }

  root.PaperDesign = {
    init, renderAll, renderDesign: renderDesignList, createFromOpportunity
  };
  root.PaperAudit = {
    renderAll, runAudit
  };
})(typeof self !== 'undefined' ? self : globalThis);
