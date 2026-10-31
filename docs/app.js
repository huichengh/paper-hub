/* 论文汇总与对比平台 —— 主逻辑 */
(function () {
  'use strict';

  const KEY = 'paperhub.v1';
  // 解析规则版本：规则一改就更新，用来提醒「旧条目还是旧规则的结果」
  const RULES_VER = '2026-10-29b';
  const VER_KEY = 'paperhub.rules';
  // 字段统一定义在 fields.js，这里只做引用
  const PF = window.PaperFields;
  const PAGE_FIELDS = PF.ALL.filter(f => f.kind !== 'figures').map(f => [f.k, f.label]);
  // 表格列：操作列固定，其余按 fields.js 的 TABLE_COLS 顺序渲染
  const COLS = [{ k: '_cb', t: '', w: 34, fixed: true }]
    .concat(PF.TABLE_COLS.map(k => ({ k, t: PF.LABELS[k], w: PF.BY_KEY[k].w || 110 })))
    .concat([{ k: '_act', t: '操作', w: 140, fixed: true }]);
  const CAT_CLASS = {
    '期刊论文': 'c-journal', '硕士学位论文': 'c-master', '博士学位论文': 'c-doctor',
    '会议论文': 'c-conf', '研究报告': 'c-report'
  };

  let papers = [];        // 全部文献
  let sel = new Set();    // 勾选的 id
  let cat = '';           // 当前分类
  let sortKey = 'addedAt', sortDir = -1;
  let editId = null;
  // 批注：{ [paperId]: [ {id,pid,type,text,quote,anchor,page,at} ] }
  let annotations = {};
  // P1：观点与研究机会
  let claims = [];
  let opportunities = [];
  let projects = [];
  let audits = [];
  let settings = { researchQuestion: '', conditions: {}, view: 'library' };
  let currentView = 'library';
  // 存储状态
  let dbReady = false;
  let useLegacy = false;
  let saveTimer = null;
  // PDF 原文件缓存（仅内存）：优先从 IndexedDB 读取，刷新后仍可恢复
  const fileCache = new Map();
  const openReader = id => window.ReaderMode && window.ReaderMode.open(id);

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
  const uid = (prefix) => (prefix || 'p') + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const sizeText = b => b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.round(b / 1024) + ' KB';

  // ---------- 存储 ----------
  function normalizePaper(p) {
    if (!p || typeof p !== 'object') return;
    if (typeof p.fileSize !== 'number') p.fileSize = 0;
    if (typeof p.pages !== 'number') p.pages = 0;
    if (typeof p.relevance !== 'string') p.relevance = '';
    if (typeof p.tags !== 'string') p.tags = '';
    if (typeof p.note !== 'string') p.note = '';
    if (typeof p.keywords !== 'string') p.keywords = '';
    if (typeof p.abstract !== 'string') p.abstract = '';
    ['background', 'purpose', 'method', 'framework', 'innovation',
     'conclusion', 'dimensions', 'criteria', 'topics'].forEach(k => {
      if (typeof p[k] !== 'string') p[k] = '';
    });
    if (!Array.isArray(p.figures)) p.figures = [];
    if (!Array.isArray(p.needCheck)) p.needCheck = [];
    if (!p.fulltext || typeof p.fulltext !== 'object') p.fulltext = { status: 'none' };
  }

  function snapshot() {
    return {
      papers, annotations, claims, opportunities, projects, audits, sel: [...sel],
      researchQuestion: settings.researchQuestion || '',
      conditions: settings.conditions || {},
      view: currentView
    };
  }

  // localStorage 仅作为迁移来源与 IndexedDB 不可用时的兜底
  function saveLegacy() {
    try {
      localStorage.setItem(KEY, JSON.stringify({
        papers, sel: [...sel], annotations, claims, opportunities, projects, audits,
        research: { question: settings.researchQuestion || '', conditions: settings.conditions || {} }
      }));
    } catch (e) {
      try {
        const lite = papers.map(p => Object.assign({}, p, { abstract: (p.abstract || '').slice(0, 200) }));
        localStorage.setItem(KEY, JSON.stringify({
          papers: lite, sel: [...sel], annotations, claims, opportunities, projects, audits,
          research: { question: settings.researchQuestion || '', conditions: settings.conditions || {} }
        }));
        toast('存储空间不足，已精简摘要后保存');
      } catch (e2) { toast('保存失败：浏览器存储空间不足'); }
    }
  }

  function save() {
    if (dbReady && !useLegacy && window.PaperDB) {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        window.PaperDB.saveSnapshot(snapshot()).catch(e => {
          console.warn('IndexedDB 保存失败', e);
          toast('保存到本地数据库失败：' + (e.message || e));
        });
      }, 140);
      return;
    }
    saveLegacy();
  }

  async function saveNow() {
    clearTimeout(saveTimer);
    if (dbReady && !useLegacy && window.PaperDB) {
      await window.PaperDB.saveSnapshot(snapshot());
    } else saveLegacy();
  }

  function readLegacy() {
    try {
      const d = JSON.parse(localStorage.getItem(KEY) || '{}');
      return {
        papers: Array.isArray(d.papers) ? d.papers : [],
        sel: Array.isArray(d.sel) ? d.sel : [],
        annotations: (d.annotations && typeof d.annotations === 'object') ? d.annotations : {},
        claims: Array.isArray(d.claims) ? d.claims : [],
        opportunities: Array.isArray(d.opportunities) ? d.opportunities : [],
        projects: Array.isArray(d.projects) ? d.projects : [],
        audits: Array.isArray(d.audits) ? d.audits : [],
        research: d.research || {}
      };
    } catch (e) { return { papers: [], sel: [], annotations: {}, claims: [], opportunities: [], projects: [], audits: [], research: {} }; }
  }

  function loadLegacy() {
    const d = readLegacy();
    papers = d.papers; sel = new Set(d.sel); annotations = d.annotations;
    claims = d.claims || []; opportunities = d.opportunities || [];
    projects = d.projects || []; audits = d.audits || [];
    settings = {
      researchQuestion: (d.research && d.research.question) || '',
      conditions: (d.research && d.research.conditions) || {},
      view: 'library'
    };
    papers.forEach(normalizePaper);
  }

  async function loadFromDB() {
    const snap = await window.PaperDB.loadSnapshot();
    papers = snap.papers || [];
    papers.forEach(normalizePaper);
    annotations = snap.annotations || {};
    claims = snap.claims || [];
    opportunities = snap.opportunities || [];
    projects = snap.projects || [];
    audits = snap.audits || [];
    const ui = snap.ui || {};
    sel = new Set(Array.isArray(ui.sel) ? ui.sel : []);
    settings = {
      researchQuestion: ui.researchQuestion || '',
      conditions: ui.conditions || {},
      view: ui.view || 'library'
    };
  }

  // ---------- PDF 解析 ----------
  function checkRulesVer() {
    if (!papers.length) { localStorage.setItem(VER_KEY, RULES_VER); return; }
    const old = localStorage.getItem(VER_KEY);
    if (old === RULES_VER) return;
    $('verOld').textContent = old || '更早';
    $('verNew').textContent = RULES_VER;
    $('verbar').style.display = 'flex';
  }

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

  // 统一获取 PDF 二进制：内存缓存 → IndexedDB → 用户重新指认
  async function getBuffer(p, allowPrompt) {
    if (!p) return null;
    if (fileCache.has(p.id)) return fileCache.get(p.id).slice(0);
    if (dbReady && window.PaperDB) {
      try {
        const buf = await window.PaperDB.getPdf(p.id);
        if (buf) { fileCache.set(p.id, buf); return buf.slice(0); }
      } catch (e) { console.warn('读取本地 PDF 失败', e); }
    }
    if (allowPrompt === false) return null;
    toast('请重新选择《' + (p.title || p.fileName || '这篇 PDF') + '》的原文件');
    return new Promise((resolve, reject) => {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = 'application/pdf,.pdf';
      inp.onchange = async () => {
        const f = inp.files && inp.files[0];
        if (!f) return reject(new Error('未选择文件'));
        const buf = await f.arrayBuffer();
        const keep = buf.slice(0);
        fileCache.set(p.id, keep);
        if (dbReady && window.PaperDB) {
          window.PaperDB.putPdf(p.id, keep, { name: f.name, size: f.size }).catch(() => { });
        }
        resolve(keep.slice(0));
      };
      inp.addEventListener('cancel', () => reject(new Error('已取消选择文件')));
      inp.click();
    });
  }

  /**
   * 重新解析：对库中文献用「当前版本的解析规则」重跑一遍。
   * 解决一个真实使用痛点——解析规则更新后，存进 localStorage 的旧记录不会自动刷新，
   * 用户会误以为"改了还是不对"。此函数保留人工改过的字段（相关度/标签/备注/批注），
   * 只刷新自动提取的字段，避免覆盖用户手工整理的内容。
   *
   * 页面刷新后原文件的内存缓存会丢，因此缺缓存时先引导用户重新指认 PDF 所在文件夹，
   * 再按「文件名 + 大小」把文件与库中记录配对，一次性完成重解析。
   */
  async function reparseAll() {
    if (!papers.length) { toast('文献库为空，先上传 PDF'); return; }
    const lib = await pdfjs();
    const AUTO = ['title', 'authors', 'year', 'type', 'category', 'source', 'school',
      'major', 'supervisor', 'coSupervisor', 'keywords', 'abstract', 'pages'];

    // 缺原文件的篇目：先看内存缓存，再看 IndexedDB
    const missing = [];
    for (const p of papers) {
      if (fileCache.has(p.id)) continue;
      let has = false;
      if (dbReady && window.PaperDB) {
        try { has = await window.PaperDB.hasPdf(p.id); } catch (e) { has = false; }
      }
      if (!has) missing.push(p);
    }
    if (missing.length) {
      const picked = await askForFolder(
        `库中有 ${missing.length} 篇缺 PDF 原文件。\n` +
        '请选择存放这些 PDF 的文件夹，平台会自动按文件名配对并重新解析。');
      if (!picked) { toast('已取消'); return; }
      const byName = new Map();
      for (const f of picked) byName.set(f.name, f);
      for (const p of missing) {
        const f = byName.get(p.fileName);
        if (f) {
          const buf = await f.arrayBuffer();
          const keep = buf.slice(0);
          fileCache.set(p.id, keep);
          if (dbReady && window.PaperDB) {
            try { await window.PaperDB.putPdf(p.id, keep, { name: f.name, size: f.size }); } catch (e) { }
          }
        }
      }
    }

    let ok = 0, need = 0, fail = 0;
    setStatus('重新解析中…', 'busy');
    for (const p of papers) {
      const buf = await getBuffer(p, false);
      if (!buf) { need++; continue; }
      try {
        const doc = await lib.getDocument({ data: new Uint8Array(buf.slice(0)) }).promise;
        let txt = '';
        const n = Math.min(doc.numPages, 8);
        for (let i = 1; i <= n; i++) {
          const pg = await doc.getPage(i);
          const tc = await pg.getTextContent();
          txt += tc.items.map(x => x.str).join('\n') + '\n===PAGE===\n';
        }
        let meta = {};
        try { meta = (await doc.getMetadata()).info || {}; } catch (e) { }
        const r = window.PaperParser.parse(
          { title: meta.Title, author: meta.Author, size: p.fileSize }, txt, doc.numPages, p.fileName);
        AUTO.forEach(k => { p[k] = r[k]; });
        p.needCheck = Array.isArray(r.needCheck) ? r.needCheck : [];
        ok++;
      } catch (e) { fail++; }
    }
    setStatus('');
    await saveNow();
    render();
    if (ok) { localStorage.setItem(VER_KEY, RULES_VER); $('verbar').style.display = 'none'; }
    const msg = [`已重新解析 ${ok} 篇`];
    if (need) msg.push(`${need} 篇未找到对应 PDF（文件名需与库中一致）`);
    if (fail) msg.push(`${fail} 篇解析失败`);
    toast(msg.join('，'));
  }

  /** 弹出目录选择器，返回 FileList；用户取消则返回 null */
  function askForFolder(hint) {
    return new Promise(resolve => {
      if (hint) toast(hint);
      const inp = document.createElement('input');
      inp.type = 'file';
      // 优先目录选择；不支持的浏览器退回多选文件
      if ('webkitdirectory' in document.createElement('input')) inp.webkitdirectory = true;
      inp.multiple = true;
      inp.accept = 'application/pdf,.pdf';
      inp.onchange = () => resolve(inp.files && inp.files.length ? inp.files : null);
      // 取消选择时不触发 change，用 focus 兜底
      inp.addEventListener('cancel', () => resolve(null));
      inp.click();
    });
  }

  // ---------- AI 设置与抽取 ----------
  function aiKeyless() { return $('aiKey').dataset.keyless === '1'; }
  function setAiPreset(pr) {
    if (!pr) return;
    if (pr.base) $('aiBase').value = pr.base;
    if (pr.model) $('aiModel').value = pr.model;
    $('aiKey').dataset.keyless = pr.keyless ? '1' : '';
    $('aiKeyHint').textContent = pr.keyless
      ? '本地开源模型可留空 Key。Ollama 需允许跨域（OLLAMA_ORIGINS=*）；GitHub Pages 的 HTTPS 页面访问 http://localhost 可能被浏览器拦截，建议本地打开页面使用。'
      : '只保存在当前页面内存，刷新后需重新填写；不会写入代码、备份或服务器。';
  }
  function openAiCfg() {
    const c = window.PaperAI.getCfg();
    const sel = $('aiPreset');
    if (!sel.options.length) {
      window.PaperAI.PRESETS.forEach((p, i) => {
        const o = document.createElement('option');
        o.value = String(i); o.textContent = p.name;
        sel.appendChild(o);
      });
      sel.onchange = () => setAiPreset(window.PaperAI.PRESETS[+sel.value]);
    }
    $('aiBase').value = c.base || window.PaperAI.PRESETS[0].base;
    $('aiKey').value = c.key || '';
    $('aiModel').value = c.model || window.PaperAI.PRESETS[0].model;
    const match = window.PaperAI.PRESETS.findIndex(p => p.base === c.base && p.model === c.model);
    if (match >= 0) sel.value = String(match);
    $('aiKey').dataset.keyless = (c.keyless || (match >= 0 && window.PaperAI.PRESETS[match].keyless)) ? '1' : '';
    if (match >= 0) setAiPreset(window.PaperAI.PRESETS[match]);
    $('aiStatus').textContent = c.keyless ? '当前为本地/免 Key 模式' : '';
    $('aiModal').classList.add('on');
  }
  function saveAiCfg() {
    window.PaperAI.setCfg({
      base: $('aiBase').value.trim(), key: $('aiKey').value.trim(),
      model: $('aiModel').value.trim(), keyless: aiKeyless()
    });
    $('aiModal').classList.remove('on');
    toast('AI 设置已保存');
  }
  async function testAi() {
    saveAiCfgQuiet();
    $('aiStatus').textContent = '正在测试…（R1 推理模型可能需要几十秒）';
    const r = await window.PaperAI.ping();
    $('aiStatus').textContent = r.ok ? '✓ 连接成功：' + (r.model || $('aiModel').value) : '✗ ' + r.error;
  }
  function saveAiCfgQuiet() {
    window.PaperAI.setCfg({
      base: $('aiBase').value.trim(), key: $('aiKey').value.trim(),
      model: $('aiModel').value.trim(), keyless: aiKeyless()
    });
  }

  // 取一篇论文的正文文本（用于 AI 抽取）
  async function paperText(p, lib) {
    const buf = await getBuffer(p, false);
    if (!buf) return null;
    const doc = await lib.getDocument({ data: new Uint8Array(buf.slice(0)) }).promise;
    let txt = '';
    // 前 12 页通常已含摘要、绪论与研究方法，足够抽取深度字段
    const n = Math.min(doc.numPages, 12);
    for (let i = 1; i <= n; i++) {
      const pg = await doc.getPage(i);
      const tc = await pg.getTextContent();
      txt += tc.items.map(x => x.str).join('\n') + '\n';
    }
    return window.PaperParser.flatten(txt);
  }

  async function aiExtractSelected() {
    const list = papers.filter(p => sel.has(p.id));
    if (!list.length) { toast('请先勾选要抽取的论文'); return; }
    if (!window.PaperAI.isReady()) {
      toast('请先配置 AI（点顶栏「AI 设置」）');
      openAiCfg();
      return;
    }
    const cfg = window.PaperAI.getCfg();
    const lib = await pdfjs();
    // 发送前让用户看到服务商和一段真实待发送文本，而不是只给一句抽象提示
    const sample = await paperText(list[0], lib).catch(() => null);
    if (!sample) { toast('第一篇论文缺少 PDF 原文件，无法预览发送内容'); return; }
    const preview = sample.replace(/\s+/g, ' ').slice(0, 360);
    const okSend = confirm(
      `即将把 ${list.length} 篇论文的摘要与正文片段发送到：\n` +
      `${cfg.base || 'OpenAI 兼容接口'} / ${cfg.model || '未填写模型'}\n\n` +
      `示例片段（《${list[0].title || '未命名'}》）：\n${preview}…\n\n` +
      '内容会离开本机，是否继续？'
    );
    if (!okSend) return;
    let ok = 0, skip = 0, fail = 0;
    const errs = [];
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      setStatus(`AI 抽取 ${i + 1}/${list.length}`, 'busy');
      const text = await paperText(p, lib).catch(() => null);
      if (!text) { skip++; continue; }
      const r = await window.PaperAI.extract(p, text);
      if (r.ok) {
        // 只写入当前为空的字段，不覆盖已有内容（无论是人工还是上次抽取的）
        Object.keys(r.fields).forEach(k => { if (!p[k]) p[k] = r.fields[k]; });
        ok++;
      } else { fail++; errs.push(p.title.slice(0, 12) + '：' + r.error); }
    }
    setStatus('');
    save(); render();
    let msg = `AI 抽取完成 ${ok} 篇`;
    if (skip) msg += `，${skip} 篇缺原文件`;
    if (fail) msg += `，${fail} 篇失败`;
    toast(msg);
    if (errs.length) console.warn('AI 抽取失败明细', errs);
  }

  async function handleFiles(files, srcLabel) {
    const all = [...files];
    const list = all.filter(f => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
    const src = srcLabel ? srcLabel + '：' : '';
    if (!list.length) {
      toast(src + (all.length
        ? `这${all.length} 个文件里没有 PDF`
        : '没有读到任何文件，请重新选择'));
      return;
    }
    const prog = $('prog'), bar = prog.querySelector('i');
    prog.style.display = 'block';
    // 判重指纹：文件名+大小 最强；标题+作者 作为备份导入（可能缺 fileSize）时的兜底
    const fp = new Set(), fp2 = new Set();
    papers.forEach(p => {
      fp.add(p.fileName + '|' + (p.fileSize || 0));
      fp2.add(((p.title || '') + '|' + (p.authors || '')).trim());
    });
    let ok = 0, skip = 0, fail = 0, failNames = [];
    const lib = await pdfjs();

    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      bar.style.width = Math.round((i) / list.length * 100) + '%';
      setStatus(`解析中 ${i + 1}/${list.length}`, 'busy');
      if (fp.has(f.name + '|' + f.size)) { skip++; continue; }
      try {
        const buf = await f.arrayBuffer();
        // 关键：pdf.js 会「转移」并 detach 传入的 ArrayBuffer，
        // 因此必须在传给它之前先复制一份，供检阅模式重新打开同一文件时使用。
        const keep = buf.slice(0);
        const doc = await lib.getDocument({ data: new Uint8Array(buf) }).promise;
        // 前 8 页足够拿到封面、版权页、摘要
        const n = Math.min(doc.numPages, 8);
        let txt = '';
        for (let p = 1; p <= n; p++) {
          const pg = await doc.getPage(p);
          const tc = await pg.getTextContent();
          txt += tc.items.map(x => x.str).join('\n') + '\n===PAGE===\n';
        }
        // 文字层为空的扫描件：能打开但抽不出内容，明确告知而不是当作成功
        if (txt.replace(/\s|===PAGE===/g, '').length < 50) {
          failNames.push(f.name + '（无文字层，疑似扫描件）');
          fail++;
          continue;
        }
        let meta = {};
        try { meta = (await doc.getMetadata()).info || {}; } catch (e) { }
        const r = window.PaperParser.parse(
          { title: meta.Title, author: meta.Author, size: f.size }, txt, doc.numPages, f.name);
        // 标题+作者重复（多见于备份导入后 fileSize 缺失的情况）也算重复。
        // 但「未识别题目」或没有作者的记录不能参与这种判重，
        // 否则两篇都没识别出标题的 PDF 会被误判成同一篇而悄悄跳过。
        const k2 = ((r.title || '') + '|' + (r.authors || '')).trim();
        const metaOk = !!r.title && r.title !== '未识别题目' && !!(r.authors || '').trim();
        if (metaOk && fp2.has(k2)) { skip++; continue; }
        r.id = uid();
        r.fileSize = f.size;
        fileCache.set(r.id, keep);
        r.fulltext = { status: 'none' };
        r.addedAt = new Date().toISOString();
        r.relevance = '';
        r.tags = '';
        if (dbReady && window.PaperDB) {
          try { await window.PaperDB.putPdf(r.id, keep, { name: f.name, size: f.size }); }
          catch (e) { console.warn('PDF 写入 IndexedDB 失败', e); toast('PDF 原文未能写入本地数据库，刷新后需重新选择'); }
        }
        papers.unshift(r);
        fp.add(f.name + '|' + f.size);
        if (metaOk) fp2.add(k2);
        ok++;
      } catch (e) {
        console.warn('解析失败', f.name, e);
        failNames.push(f.name);
        fail++;
      }
    }
    bar.style.width = '100%';
    setTimeout(() => { prog.style.display = 'none'; bar.style.width = '0'; }, 400);
    setStatus('');
    // 导入是重操作，立即落库，避免用户马上刷新导致丢最后几篇
    await saveNow();
    render();
    // 新导入的内容已经是当前规则解析的，不必再提示重解析
    if (ok) { localStorage.setItem(VER_KEY, RULES_VER); $('verbar').style.display = 'none'; }
    const msg = [];
    if (ok) msg.push(`成功导入 ${ok} 篇`);
    if (skip) msg.push(`${skip} 篇已在库中（重复文件已自动跳过）`);
    if (fail) msg.push(`${fail} 篇无法解析`);
    let text = msg.join('，') || '没有新增文献';
    if (skip && !ok) text += '。如需重新导入这些文件，请先在列表中删除旧记录';
    if (failNames.length) text += '：' + failNames.slice(0, 2).join('、') + (failNames.length > 2 ? ' 等' : '');
    toast(text);
  }

  // ---------- 全文抽取（按页写入 IndexedDB） ----------
  let ftRunning = false, ftCancel = false;
  function ftShow(text, pct) {
    $('ftbar').style.display = 'flex';
    if (text != null) $('ftLabel').textContent = text;
    if (pct != null) {
      const v = Math.max(0, Math.min(100, Math.round(pct)));
      $('ftFill').style.width = v + '%';
      $('ftPct').textContent = v + '%';
    }
  }
  function ftHide() { $('ftbar').style.display = 'none'; $('ftFill').style.width = '0'; }
  function ftChip(p) {
    const f = (p && p.fulltext) || {};
    if (!f.status || f.status === 'none') return null;
    const s = el('span', 'ft-chip' + (f.status === 'done' ? '' : (f.status === 'error' ? ' err' : ' part')));
    if (f.status === 'done') s.textContent = '全文 ' + (f.extractedPages || f.pages || 0) + ' 页';
    else if (f.status === 'partial' || f.status === 'cancelled') s.textContent = '全文 ' + (f.extractedPages || 0) + '/' + (f.pages || 0) + ' 页 · 未完成';
    else if (f.status === 'running') s.textContent = '全文抽取中…';
    else s.textContent = '全文抽取失败';
    s.title = f.error || ('状态：' + f.status);
    return s;
  }

  async function extractFulltext(list) {
    if (ftRunning) { toast('已有全文抽取任务在运行'); return; }
    if (!dbReady || !window.PaperDB) { toast('当前浏览器不支持 IndexedDB，无法持久化全文'); return; }
    if (!list.length) return;
    ftRunning = true; ftCancel = false;
    const lib = await pdfjs();
    let totalPages = 0, donePages = 0, okPapers = 0, failPapers = 0;
    const counts = list.map(p => Math.max(1, +p.pages || 1));
    const grand = counts.reduce((a, b) => a + b, 0);
    ftShow('准备抽取全文…', 0);
    try {
      for (let i = 0; i < list.length; i++) {
        if (ftCancel) break;
        const p = list[i];
        let doc = null;
        try {
          const buf = await getBuffer(p, false);
          if (!buf) throw new Error('缺少 PDF 原文件');
          doc = await lib.getDocument({ data: new Uint8Array(buf.slice(0)) }).promise;
          const total = doc.numPages;
          totalPages += total;
          let chars = 0, failed = [], doneForPaper = 0;
          for (let n = 1; n <= total; n++) {
            if (ftCancel) break;
            ftShow(`正在抽取 ${i + 1}/${list.length} · ${(p.title || p.fileName || '').slice(0, 22)} · 第 ${n}/${total} 页`,
              (donePages + (n - 1)) / Math.max(grand, 1) * 100);
            try {
              const pg = await doc.getPage(n);
              const tc = await pg.getTextContent();
              const text = tc.items.map(x => x.str).join(' ').replace(/\s+/g, ' ').trim();
              await window.PaperDB.putPageText(p.id, n, text);
              chars += text.length;
              doneForPaper++;
              donePages++;
            } catch (err) {
              failed.push(n);
              donePages++;
            }
            // 不逐页 render，避免抽全文时卡住表格；保存交给 debounce
            save();
          }
          p.fulltext = {
            status: ftCancel ? 'cancelled' : (failed.length ? 'partial' : 'done'),
            pages: total, extractedPages: doneForPaper, failedPages: failed,
            chars, at: new Date().toISOString(),
            error: failed.length ? ('部分页抽取失败：' + failed.slice(0, 8).join(',')) : ''
          };
          if (p.fulltext.status === 'error') failPapers++; else okPapers++;
          if (ftCancel) {
            for (let j = i + 1; j < list.length; j++) {
              list[j].fulltext = Object.assign({}, list[j].fulltext || {}, { status: 'cancelled' });
            }
            break;
          }
        } catch (e) {
          p.fulltext = { status: 'error', pages: +p.pages || 0, extractedPages: 0, error: e.message || String(e), at: new Date().toISOString() };
          failPapers++;
        }
        save();
      }
      await saveNow();
      render();
      if (ftCancel) toast('已取消，已抽取的页面已保存');
      else if (failPapers) toast(`全文抽取结束：${okPapers} 篇完成，${failPapers} 篇失败，可重新点「全文抽取」重试`);
      else toast(`全文抽取完成 ${okPapers} 篇`);
    } finally {
      ftRunning = false;
      setTimeout(ftHide, 700);
    }
  }

  function runFulltext() {
    if (!papers.length) { toast('文献库为空'); return; }
    let list = papers.filter(p => sel.has(p.id));
    if (!list.length) {
      if (!confirm(`未勾选文献，是否对全部 ${papers.length} 篇抽取全文？`)) return;
      list = papers.slice();
    }
    extractFulltext(list);
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
      const remove = () => {
        const map = { q: 'q', author: 'fAuthor', source: 'fSource', major: 'fMajor', sup: 'fSup', tag: 'fTag', rel: 'fRel', ymin: 'fYearMin', ymax: 'fYearMax', pmin: 'fPagesMin', pmax: 'fPagesMax' };
        if (f.k === 'cat') cat = '';
        else { const e = $(map[f.k]); if (e) e.value = ''; }
        render();
      };
      // 筛选输入框还有焦点时，按下鼠标会让它先失焦并触发一次 render，
      // 原来的按钮被替换掉，click 就丢了。放到 mousedown 阶段执行才稳。
      b.onmousedown = ev => { ev.preventDefault(); ev.stopPropagation(); remove(); };
      b.onclick = ev => { ev.preventDefault(); ev.stopPropagation(); if (!ev.detail) remove(); };
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
    // 库里有文献但筛完为空时，也给一句话，别只剩一个空表头
    const noMatch = papers.length > 0 && arr.length === 0;
    $('empty').innerHTML = noMatch
      ? '<b>没有符合条件的文献</b>试试移除上面的筛选条件'
      : '<b>还没有文献</b>左侧上传 PDF 开始，或点「导入备份」恢复已有数据';
    $('empty').style.display = papers.length && !noMatch ? 'none' : 'block';
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
      const chip = ftChip(p);
      if (chip) w.appendChild(chip);
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
      [['source', p.source], ['major', p.major]].forEach(([k, v]) => {
        const td = el('td');
        const miss = (p.needCheck || []).indexOf(k) >= 0;
        if (v) td.textContent = v;
        else if (miss) {
          const s = el('span', 'miss', '未识别');
          s.title = 'PDF 里没找到这一项，点右侧「编辑」补录';
          td.appendChild(s);
        } else td.textContent = '—';
        tr.appendChild(td);
      });
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
      const br = el('button', 'rowbtn', '检阅');
      br.onclick = () => openReader(p.id);
      const be = el('button', 'rowbtn', '编辑');
      be.onclick = () => openEdit(p.id);
      const bd = el('button', 'rowbtn', '删除');
      bd.onclick = async () => {
        if (!confirm('删除《' + (p.title || '无题') + '》？此操作不可撤销。')) return;
        if (dbReady && window.PaperDB) {
          try { await window.PaperDB.deletePaperCascade(p.id); } catch (e) { console.warn('级联删除失败', e); }
        }
        papers = papers.filter(x => x.id !== p.id);
        delete annotations[p.id];
        fileCache.delete(p.id);
        sel.delete(p.id);
        if (window.ResearchOS) window.ResearchOS.removePaper(p.id);
        save(); render();
      };
      tdA.append(br, be, bd); tr.appendChild(tdA);
      tb.appendChild(tr);
    });
  }

  function render() {
    renderCats(); renderRel(); renderDatalists(); renderChips(); renderHead(); renderRows();
  }

  // ---------- 编辑弹窗 ----------
  // 编辑弹窗字段：text/textarea 占满一行，其余半行
  const FIELDS = PF.ALL.map(f => [f.k, f.label, f.kind, (f.kind === 'textarea' || f.kind === 'figures' || f.k === 'title' || f.k === 'keywords' || f.k === 'tags' || f.k === 'topics') ? 1 : 0]);
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
      if (kind === 'figures') {
        // 图示：只读缩略图列表 + 删除，新增走检阅模式的「截图收藏」
        const figs = Array.isArray(p.figures) ? p.figures : [];
        const box = el('div', 'figbox');
        if (!figs.length) box.appendChild(el('div', 'hint', '暂无。到检阅模式里框选 PDF 上的图即可收藏。'));
        figs.forEach((fg, i) => {
          const card = el('div', 'figcard');
          const im = document.createElement('img');
          im.src = fg.data; im.alt = fg.caption || ('图' + (i + 1));
          im.title = (fg.caption || '') + '（第' + fg.page + '页）';
          card.appendChild(im);
          const cap = el('div', 'figcap', (fg.caption || '图' + (i + 1)) + ' · 第' + fg.page + '页');
          card.appendChild(cap);
          const del = el('button', 'rowbtn', '删除');
          del.onclick = () => {
            if (!confirm('删除这张图？')) return;
            p.figures.splice(i, 1); save(); openEdit(id); render();
          };
          card.appendChild(del);
          box.appendChild(card);
        });
        f.appendChild(box);
        if (PF.BY_KEY[k].hint) f.appendChild(el('div', 'hint', PF.BY_KEY[k].hint));
        g.appendChild(f);
        return;   // figures 不参与 input 绑定
      }
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
      if (PF.BY_KEY[k] && PF.BY_KEY[k].hint) f.appendChild(el('div', 'hint', PF.BY_KEY[k].hint));
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
    save(); closeEdit(); render();
    // 对比抽屉开着的话，改完要同步刷新，否则还显示「未识别」
    if ($('drawer').classList.contains('on')) openCompare();
    toast('已保存');
  }

  // ---------- 对比 ----------
  const CMP_ROWS = PF.COMPARE_ROWS.map(k => [k, PF.LABELS[k]]);
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
        if (k === 'figures') {
          // 图示列：并排缩略图，点击看大图
          const figs = Array.isArray(p.figures) ? p.figures : [];
          if (!figs.length) td.textContent = '—';
          figs.forEach(fg => {
            const im = document.createElement('img');
            im.src = fg.data; im.className = 'cmpfig';
            im.title = (fg.caption || '') + '（第' + fg.page + '页）';
            im.onclick = () => window.open(fg.data, '_blank');
            td.appendChild(im);
          });
          // 数量不同即视为差异
          td.className = figs.length ? 'diff' : '';
        } else {
          const v = vals[i];
          if (v) td.textContent = v;
          else {
            const def = PF.BY_KEY[k] || {};
            const miss = (p.needCheck || []).indexOf(k) >= 0;
            // 自动字段没抓到，明确写「未识别」，别用「—」让人误以为这篇本来就没有
            if (def.auto && miss) {
              td.classList.add('na');
              td.textContent = '未识别';
              td.title = '解析时没从 PDF 里找到这一项，双击可手动补录';
              td.ondblclick = () => openEdit(p.id);
            } else td.textContent = '—';
          }
        }
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
    return {
      list,
      rows: CMP_ROWS.map(([k, label]) => ({
        k, label,
        vals: list.map(p => {
          if (k === 'figures') {
            // 导出的是表格，不能把图片对象直接 String() 成 [object Object]
            const figs = Array.isArray(p.figures) ? p.figures : [];
            return figs.map((fg, i) =>
              (fg.caption || ('图' + (i + 1))) + '（第' + (fg.page || '?') + '页）'
            ).join('；');
          }
          return String(p[k] == null ? '' : p[k]);
        })
      }))
    };
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
    const data = JSON.stringify({
      v: 4,
      app: 'PaperHub Research OS',
      papers, sel: [...sel], annotations, claims, opportunities, projects, audits,
      research: { question: settings.researchQuestion || '', conditions: settings.conditions || {} },
      note: '备份包含文献字段、批注、观点、研究机会、研究方案与审计结果；不包含 PDF 原文与逐页全文缓存。',
      at: new Date().toISOString()
    }, null, 1);
    dl(new Blob([data], { type: 'application/json' }), '论文库备份_' + new Date().toISOString().slice(0, 10) + '.json');
    toast('备份已导出');
  }
  function importBackup(file) {
    const fr = new FileReader();
    fr.onload = () => {
      try {
        const d = JSON.parse(fr.result);
        if (d && d.v && +d.v > 4) {
          toast('这份备份来自更高版本（v' + d.v + '），将尝试导入，未知字段会被忽略');
        }
        const inc = Array.isArray(d.papers) ? d.papers : [];
        if (!inc.length) { toast('备份里没有文献'); return; }
        const incAnns = (d.annotations && typeof d.annotations === 'object') ? d.annotations : {};
        let n = 0, dup = 0, annN = 0;
        // oldId -> 恢复后的 id。重复论文也要记录映射，否则它的批注同样恢复不了
        const idMap = {};
        const byKey = new Map();
        papers.forEach(p => byKey.set(((p.title || '') + '|' + (p.authors || '')).trim(), p));
        inc.forEach(p => {
          if (!p || typeof p !== 'object') return;
          const oldId = p.id;
          const key = ((p.title || '') + '|' + (p.authors || '')).trim();
          const exist = key !== '|' ? byKey.get(key) : null;
          if (exist) { dup++; if (oldId) idMap[oldId] = exist.id; return; }
          p.id = uid();
          if (oldId) idMap[oldId] = p.id;
          // 补齐可能缺失的字段，保证后续判重与导出正常
          p.fileSize = p.fileSize || 0;
          p.pages = p.pages || 0;
          p.tags = p.tags || '';
          p.relevance = p.relevance || '';
          p.note = p.note || '';
          p.addedAt = p.addedAt || new Date().toISOString();
          if (!Array.isArray(p.figures)) p.figures = [];
          if (!Array.isArray(p.needCheck)) p.needCheck = [];
          // 备份不含 PDF 与逐页全文，恢复后标记为待重新抽取
          p.fulltext = { status: 'none' };
          byKey.set(key, p);
          papers.push(p);
          n++;
        });
        // 备份里论文会换新 id，批注必须同步改 pid 并挂到新 id 下
        Object.keys(incAnns).forEach(oldId => {
          const nid = idMap[oldId];
          const list = Array.isArray(incAnns[oldId]) ? incAnns[oldId] : [];
          if (!nid || !list.length) return;
          const target = Array.isArray(annotations[nid]) ? annotations[nid] : [];
          const seenAnn = new Set(target.map(a => a.id + '|' + (a.quote || '') + '|' + (a.text || '')));
          list.forEach(a => {
            if (!a || typeof a !== 'object') return;
            const copy = Object.assign({}, a, { pid: nid });
            const sig = copy.id + '|' + (copy.quote || '') + '|' + (copy.text || '');
            if (seenAnn.has(sig)) return;
            if (target.some(x => x.id === copy.id)) copy.id = 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
            target.push(copy); seenAnn.add(sig); annN++;
          });
          annotations[nid] = target;
        });
        // P1：观点与研究机会随备份迁移；paperId / claimId 需要重新映射
        const incClaims = Array.isArray(d.claims) ? d.claims : ((d.research && Array.isArray(d.research.claims)) ? d.research.claims : []);
        const incOpps = Array.isArray(d.opportunities) ? d.opportunities : ((d.research && Array.isArray(d.research.opportunities)) ? d.research.opportunities : []);
        const claimMap = {}, oppMap = {};
        let claimN = 0, oppN = 0;
        incClaims.forEach(c => {
          if (!c || typeof c !== 'object') return;
          const npid = c.paperId ? idMap[c.paperId] : '';
          if (c.paperId && !npid) return;   // 原论文已不在库中，观点没有可追溯证据，跳过
          const exist = claims.some(x => x.text === c.text && x.paperId === npid && String(x.page) === String(c.page));
          if (exist) return;
          const copy = Object.assign({}, c);
          copy.id = uid('c'); copy.paperId = npid || '';
          copy.question = copy.question || (d.research && d.research.question) || '';
          copy.createdAt = copy.createdAt || new Date().toISOString();
          copy.updatedAt = new Date().toISOString();
          claims.push(copy);
          if (c.id) claimMap[c.id] = copy.id;
          claimN++;
        });
        incOpps.forEach(o => {
          if (!o || typeof o !== 'object') return;
          const copy = Object.assign({}, o);
          copy.id = uid('o');
          copy.claimIds = (o.claimIds || []).map(id => claimMap[id]).filter(Boolean);
          copy.paperIds = [...new Set(copy.claimIds.map(id => (claims.find(c => c.id === id) || {}).paperId).filter(Boolean))];
          copy.updatedAt = new Date().toISOString();
          opportunities.push(copy);
          if (o.id) oppMap[o.id] = copy.id;
          oppN++;
        });
        // P2：研究方案与审计结果随备份迁移，证据/论文/观点 id 一并重映射
        const incProjects = Array.isArray(d.projects) ? d.projects : [];
        const incAudits = Array.isArray(d.audits) ? d.audits : [];
        let projectN = 0, auditN = 0;
        incProjects.forEach(pj => {
          if (!pj || typeof pj !== 'object') return;
          const copy = Object.assign({}, pj);
          copy.id = uid('pr');
          copy.opportunityId = pj.opportunityId ? (oppMap[pj.opportunityId] || '') : '';
          copy.claimIds = (pj.claimIds || []).map(id => claimMap[id]).filter(Boolean);
          copy.paperIds = (pj.paperIds || []).map(id => idMap[id]).filter(Boolean);
          copy.updatedAt = new Date().toISOString();
          projects.push(copy); projectN++;
        });
        incAudits.forEach(au => {
          if (!au || typeof au !== 'object') return;
          const copy = Object.assign({}, au);
          copy.id = uid('au');
          copy.items = (au.items || []).map(it => Object.assign({}, it, {
            evidence: (it.evidence || []).map(ev => Object.assign({}, ev, {
              paperId: ev.paperId ? (idMap[ev.paperId] || '') : '',
              claimId: ev.claimId ? (claimMap[ev.claimId] || '') : ''
            })).filter(ev => ev.paperId || ev.quote)
          }));
          copy.createdAt = copy.createdAt || new Date().toISOString();
          audits.push(copy); auditN++;
        });
        // 原备份里勾选的论文，恢复后尽量保持勾选状态
        if (Array.isArray(d.sel)) d.sel.forEach(oldId => { if (idMap[oldId]) sel.add(idMap[oldId]); });
        if (!settings.researchQuestion && d.research && d.research.question) settings.researchQuestion = d.research.question;
        if (!Object.keys(settings.conditions || {}).length && d.research && d.research.conditions) settings.conditions = d.research.conditions;
        save(); render();
        if (window.ResearchOS) window.ResearchOS.renderAll();
        const parts = [];
        if (n) parts.push(`已导入 ${n} 篇`);
        if (dup) parts.push(`跳过重复 ${dup} 篇`);
        if (annN) parts.push(`恢复批注 ${annN} 条`);
        if (claimN) parts.push(`恢复观点 ${claimN} 条`);
        if (oppN) parts.push(`恢复机会 ${oppN} 张`);
        if (projectN) parts.push(`恢复研究方案 ${projectN} 份`);
        if (auditN) parts.push(`恢复审计 ${auditN} 份`);
        toast(parts.join('，') || '没有可导入的内容');
      } catch (e) { toast('备份文件解析失败'); }
    };
    fr.readAsText(file);
  }

  // ---------- 视图切换 ----------
  function switchView(view, silent) {
    const v = ['library', 'claims', 'opportunities', 'design', 'audit', 'assistant'].includes(view) ? view : 'library';
    currentView = v;
    document.querySelectorAll('#appnav button[data-view]').forEach(b => b.classList.toggle('on', b.dataset.view === v));
    $('viewLibrary').classList.toggle('hide', v !== 'library');
    $('viewClaims').classList.toggle('on', v === 'claims');
    $('viewOpportunities').classList.toggle('on', v === 'opportunities');
    $('viewDesign').classList.toggle('on', v === 'design');
    $('viewAudit').classList.toggle('on', v === 'audit');
    $('viewAssistant').classList.toggle('on', v === 'assistant');
    if ((v === 'claims' || v === 'opportunities') && window.ResearchOS) window.ResearchOS.renderAll();
    if (v === 'design' && window.PaperDesign) window.PaperDesign.renderAll();
    if (v === 'audit' && window.PaperAudit) window.PaperAudit.renderAll();
    if (v === 'assistant' && window.PaperAdvisor) window.PaperAdvisor.renderAll();
    if (!silent) {
      save();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  // ---------- 旧数据迁移 ----------
  async function doMigrate() {
    if (!dbReady || !window.PaperDB) { toast('当前浏览器不支持 IndexedDB，继续使用旧存储'); return; }
    try {
      await window.PaperDB.migrateLegacy({
        papers, annotations, claims, opportunities, projects, audits, sel: [...sel],
        research: { question: settings.researchQuestion || '', conditions: settings.conditions || {} }
      });
      useLegacy = false;
      await loadFromDB();
      $('migrateModal').classList.remove('on');
      if (window.ResearchOS) window.ResearchOS.renderAll();
      if (window.PaperDesign) window.PaperDesign.renderAll();
      switchView(settings.view || 'library', true);
      render();
      toast('数据已迁移到 IndexedDB，旧数据仍保留在 localStorage 作为回退');
    } catch (e) {
      useLegacy = true;
      toast('迁移失败，继续使用旧存储：' + (e.message || e));
    }
  }

  // ---------- 事件 ----------
  function bind() {
    $('drop').onclick = () => $('file').click();
    $('file').onchange = e => { if (e.target.files.length) handleFiles(e.target.files); e.target.value = ''; };
    $('dir').onchange = e => { handleFiles(e.target.files, '文件夹'); e.target.value = ''; };
    // 目录选择：webkitdirectory 在部分浏览器不支持，用能力检测决定走哪条路
    $('btnDir').onclick = () => {
      if ('webkitdirectory' in document.createElement('input')) {
        $('dir').click();
      } else {
        toast('当前浏览器不支持选择文件夹，请改用「点击或拖入 PDF」批量选择');
      }
    };
    ['dragenter', 'dragover'].forEach(ev => $('drop').addEventListener(ev, e => { e.preventDefault(); $('drop').classList.add('over'); }));
    ['dragleave', 'drop'].forEach(ev => $('drop').addEventListener(ev, e => { e.preventDefault(); $('drop').classList.remove('over'); }));
    $('drop').addEventListener('drop', e => { if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files); });
    // 整页拖放
    ['dragover', 'drop'].forEach(ev => document.addEventListener(ev, e => {
      if (e.target.closest('#drop')) return;
      e.preventDefault();
      if (ev === 'drop' && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
    }));

    $('btnClear').onclick = async () => {
      if (!papers.length) return;
      if (!confirm('确定清空全部 ' + papers.length + ' 篇文献？建议先「导出备份」。')) return;
      papers = []; sel.clear(); cat = '';
      // 批注、观点、PDF 内存缓存都一起清，避免留下孤儿数据
      annotations = {}; claims = []; opportunities = []; projects = []; audits = []; fileCache.clear();
      if (dbReady && window.PaperDB) {
        try { await window.PaperDB.clearLibrary(); } catch (e) { console.warn('清空本地库失败', e); }
      }
      if (window.ResearchOS) window.ResearchOS.renderAll();
      if (window.PaperDesign) window.PaperDesign.renderAll();
      if (window.PaperAdvisor) window.PaperAdvisor.renderAll();
      save(); render(); toast('已清空');
    };
    $('btnExport').onclick = exportXlsx;
    $('btnReparse').onclick = reparseAll;
    $('verGo').onclick = reparseAll;
    $('verHide').onclick = () => { $('verbar').style.display = 'none'; localStorage.setItem(VER_KEY, RULES_VER); };
    checkRulesVer();
    $('btnAiCfg').onclick = openAiCfg;
    $('aiMX').onclick = () => $('aiModal').classList.remove('on');
    $('aiCancel').onclick = () => $('aiModal').classList.remove('on');
    $('aiSave').onclick = saveAiCfg;
    $('aiTest').onclick = testAi;
    $('btnAiExtract').onclick = aiExtractSelected;
    $('btnFulltext').onclick = runFulltext;
    $('ftCancel').onclick = () => {
      ftCancel = true;
      $('ftLabel').textContent = '正在取消，已完成页面会保留…';
    };
    document.querySelectorAll('#appnav button[data-view]').forEach(b => {
      b.onclick = () => switchView(b.dataset.view);
    });
    $('migrateNow').onclick = doMigrate;
    $('migrateBackup').onclick = () => {
      exportBackup();
      setTimeout(doMigrate, 400);
    };

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

  // ---------- 检阅模式依赖注入 ----------
  function initReader() {
    window.ReaderMode.init({
      getPaper: id => papers.find(x => x.id === id),
      getAnnotations: id => (annotations[id] || []).slice(),
      setAnnotations: (id, list) => { annotations[id] = list; save(); },
      save,
      toast,
      getLib: pdfjs,
      getFileBuffer: async p => {
        const buf = await getBuffer(p, true);
        if (!buf) throw new Error('未取得 PDF 文件');
        return buf;
      },
      addClaimFromSelection: (pid, pending, note) => {
        window.ReaderMode.close();
        switchView('claims');
        window.ResearchOS.addClaimFromSelection(pid, pending, note);
      }
    });
  }

  // ---------- 启动 ----------
  async function boot() {
    let info = { ok: false };
    try {
      if (window.PaperDB) info = await window.PaperDB.init();
    } catch (e) { info = { ok: false, error: e.message || String(e) }; }
    dbReady = !!info.ok;
    if (!dbReady) {
      useLegacy = true;
      loadLegacy();
      bind(); initImportFlow(); initReader();
      window.ResearchOS.init(researchHooks());
      window.PaperDesign.init(designHooks());
    window.PaperAdvisor.init(assistantHooks());
      switchView('library', true);
      render();
      toast('IndexedDB 不可用，已退回旧存储；全文与证据持久化将不可用');
      return;
    }

    let migrated = null;
    try { migrated = await window.PaperDB.getMeta('migration', null); } catch (e) { migrated = null; }
    const legacy = readLegacy();
    if (!migrated && legacy.papers.length) {
      // 先按旧数据渲染，等用户在弹窗里选择备份/迁移
      loadLegacy();
      useLegacy = true;
      bind(); initImportFlow(); initReader();
      window.ResearchOS.init(researchHooks());
      window.PaperDesign.init(designHooks());
    window.PaperAdvisor.init(assistantHooks());
      switchView('library', true);
      render();
      $('migrateModal').classList.add('on');
      return;
    }

    try {
      await loadFromDB();
      useLegacy = false;
    } catch (e) {
      console.warn('读取 IndexedDB 失败', e);
      useLegacy = true;
      loadLegacy();
      toast('本地数据库读取失败，已回退到旧存储');
    }
    bind(); initImportFlow(); initReader();
    window.ResearchOS.init(researchHooks());
    window.PaperDesign.init(designHooks());
    window.PaperAdvisor.init(assistantHooks());
    switchView(settings.view || 'library', true);
    render();
  }

  function researchHooks() {
    return {
      getPapers: () => papers,
      getClaims: () => claims,
      getOpps: () => opportunities,
      getSettings: () => settings,
      updateSettings: patch => { Object.assign(settings, patch || {}); },
      getSelected: () => [...sel],
      clearSelection: () => { sel.clear(); save(); },
      save,
      toast,
      setView: v => switchView(v),
      openAiSettings: () => openAiCfg(),
      openReader: id => window.ReaderMode.open(id),
      openEvidence: (id, anchor, quote) => window.ReaderMode.open(id, { focus: anchor, quote }),
      exportBackup
    };
  }

  function designHooks() {
    return {
      getPapers: () => papers,
      getClaims: () => claims,
      getOpps: () => opportunities,
      getProjects: () => projects,
      getAudits: () => audits,
      getSettings: () => settings,
      getSelected: () => [...sel],
      setView: v => switchView(v),
      save, toast,
      openEvidence: (id, anchor, quote) => window.ReaderMode.open(id, { focus: anchor, quote })
    };
  }

  function assistantHooks() {
    return {
      getPapers: () => papers,
      getClaims: () => claims,
      getProjects: () => projects,
      getAudits: () => audits,
      getSettings: () => settings,
      getSelected: () => [...sel],
      setView: v => switchView(v),
      save, toast,
      openAiSettings: () => openAiCfg(),
      openEvidence: (id, anchor, quote) => window.ReaderMode.open(id, { focus: anchor, quote })
    };
  }

  window.__papers = () => papers;
  window.__state = () => ({
    papers, annotations, claims, opportunities, projects, audits, settings,
    dbReady, useLegacy, currentView, selected: [...sel]
  });
  boot();
})();
