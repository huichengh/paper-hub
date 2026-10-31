/* PaperHub Research OS —— IndexedDB 存储适配层
 *
 * 目标：
 *  1) 论文元数据、批注、PDF 原文、逐页全文、观点、机会卡片分别落到独立 store；
 *  2) 旧版本 localStorage 数据一次性迁移，迁移失败不影响旧流程；
 *  3) 所有读写都不把大体积 PDF 放进 localStorage。
 *
 * 浏览器环境使用；不依赖任何第三方库。
 */
(function (root) {
  'use strict';

  const DB_NAME = 'paperhub-os';
  const DB_VER = 2;
  const STORES = {
    papers: { keyPath: 'id', indexes: [['addedAt', 'addedAt']] },
    pdfFiles: { keyPath: 'id' },
    pageTexts: { keyPath: 'id', indexes: [['paperId', 'paperId'], ['paperPage', ['paperId', 'page']]] },
    annotations: { keyPath: 'paperId' },
    claims: { keyPath: 'id', indexes: [['question', 'question'], ['paperId', 'paperId'], ['stance', 'stance']] },
    opportunities: { keyPath: 'id', indexes: [['question', 'question']] },
    settings: { keyPath: 'key' },
    meta: { keyPath: 'key' }
  };

  let db = null;
  let ready = false;
  let opening = null;

  function supported() {
    try { return typeof indexedDB !== 'undefined'; } catch (e) { return false; }
  }

  function open() {
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      if (!supported()) return reject(new Error('当前浏览器不支持 IndexedDB'));
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const d = req.result;
        Object.keys(STORES).forEach(name => {
          const def = STORES[name];
          let os;
          if (!d.objectStoreNames.contains(name)) os = d.createObjectStore(name, { keyPath: def.keyPath });
          else os = req.transaction.objectStore(name);
          (def.indexes || []).forEach(([idxName, keyPath]) => {
            if (!os.indexNames.contains(idxName)) os.createIndex(idxName, keyPath, { unique: false });
          });
        });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB 打开失败'));
      req.onblocked = () => reject(new Error('IndexedDB 被其他页面占用，请关闭重复标签页后重试'));
    });
    return opening;
  }

  async function init() {
    if (ready) return { ok: true };
    try {
      db = await open();
      ready = true;
      return { ok: true };
    } catch (e) {
      ready = false;
      return { ok: false, error: e.message || String(e) };
    }
  }

  function requireDb() {
    if (!db) throw new Error('IndexedDB 尚未初始化');
    return db;
  }

  function reqP(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function txDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('事务被取消'));
    });
  }

  async function get(store, key) {
    const t = requireDb().transaction(store, 'readonly');
    return reqP(t.objectStore(store).get(key));
  }
  async function getAll(store) {
    const t = requireDb().transaction(store, 'readonly');
    return reqP(t.objectStore(store).getAll());
  }
  async function put(store, value) {
    const t = requireDb().transaction(store, 'readwrite');
    t.objectStore(store).put(value);
    await txDone(t);
    return value;
  }
  async function del(store, key) {
    const t = requireDb().transaction(store, 'readwrite');
    t.objectStore(store).delete(key);
    await txDone(t);
  }
  async function clear(store) {
    const t = requireDb().transaction(store, 'readwrite');
    t.objectStore(store).clear();
    await txDone(t);
  }
  async function getAllByIndex(store, index, value) {
    const t = requireDb().transaction(store, 'readonly');
    return reqP(t.objectStore(store).index(index).getAll(value));
  }

  // ---------- meta / settings ----------
  async function getMeta(key, fallback) {
    try { const r = await get('meta', key); return r ? r.value : fallback; }
    catch (e) { return fallback; }
  }
  async function setMeta(key, value) {
    return put('meta', { key, value, at: new Date().toISOString() });
  }
  async function getSetting(key, fallback) {
    try { const r = await get('settings', key); return r ? r.value : fallback; }
    catch (e) { return fallback; }
  }
  async function setSetting(key, value) {
    return put('settings', { key, value, at: new Date().toISOString() });
  }

  // ---------- 整体快照 ----------
  /**
   * 全量保存论文/批注/观点/机会/UI 设置。
   * 采用「同事务 clear + put」，保证删除、清空、导入后的数据一致；
   * 论文规模在几十篇，单次写入量可以接受。
   */
  async function saveSnapshot(snap) {
    const s = snap || {};
    const names = ['papers', 'annotations', 'claims', 'opportunities', 'settings'];
    const t = requireDb().transaction(names, 'readwrite');
    const ps = t.objectStore('papers');
    const as = t.objectStore('annotations');
    const cs = t.objectStore('claims');
    const os = t.objectStore('opportunities');
    const ss = t.objectStore('settings');
    ps.clear(); as.clear(); cs.clear(); os.clear(); ss.clear();
    (s.papers || []).forEach(p => ps.put(p));
    Object.keys(s.annotations || {}).forEach(pid => {
      const items = s.annotations[pid];
      if (Array.isArray(items) && items.length) as.put({ paperId: pid, items });
    });
    (s.claims || []).forEach(c => cs.put(c));
    (s.opportunities || []).forEach(o => os.put(o));
    ss.put({ key: 'ui', value: { sel: s.sel || [], researchQuestion: s.researchQuestion || '', conditions: s.conditions || {}, view: s.view || 'library' } });
    await txDone(t);
  }

  async function loadSnapshot() {
    const [papers, anns, claims, opps, ui] = await Promise.all([
      getAll('papers'), getAll('annotations'), getAll('claims'), getAll('opportunities'),
      getSetting('ui', {})
    ]);
    const annotations = {};
    anns.forEach(r => { if (r && r.paperId) annotations[r.paperId] = r.items || []; });
    return { papers: papers || [], annotations, claims: claims || [], opportunities: opps || [], ui: ui || {} };
  }

  // ---------- 迁移 ----------
  async function migrateLegacy(legacy) {
    const d = legacy || {};
    const papers = Array.isArray(d.papers) ? d.papers : [];
    const annotations = (d.annotations && typeof d.annotations === 'object') ? d.annotations : {};
    const t = requireDb().transaction(['papers', 'annotations', 'claims', 'opportunities', 'settings', 'meta'], 'readwrite');
    const ps = t.objectStore('papers');
    const as = t.objectStore('annotations');
    const cs = t.objectStore('claims');
    const os = t.objectStore('opportunities');
    const ss = t.objectStore('settings');
    const ms = t.objectStore('meta');
    papers.forEach(p => { if (p && p.id) ps.put(p); });
    Object.keys(annotations).forEach(pid => {
      const items = annotations[pid];
      if (Array.isArray(items) && items.length) as.put({ paperId: pid, items });
    });
    (Array.isArray(d.claims) ? d.claims : []).forEach(c => { if (c && c.id) cs.put(c); });
    (Array.isArray(d.opportunities) ? d.opportunities : []).forEach(o => { if (o && o.id) os.put(o); });
    ss.put({ key: 'ui', value: { sel: Array.isArray(d.sel) ? d.sel : [], researchQuestion: (d.research && d.research.question) || '', conditions: (d.research && d.research.conditions) || {}, view: 'library' } });
    ms.put({ key: 'migration', value: { done: true, at: new Date().toISOString(), papers: papers.length, from: 'localStorage:paperhub.v1' } });
    await txDone(t);
    return { papers: papers.length };
  }

  // ---------- PDF 文件 ----------
  async function putPdf(id, buffer, info) {
    if (!buffer) throw new Error('没有可保存的 PDF 数据');
    return put('pdfFiles', {
      id,
      name: (info && info.name) || '',
      size: (info && info.size) || buffer.byteLength || 0,
      type: 'application/pdf',
      data: buffer.slice(0),
      savedAt: new Date().toISOString()
    });
  }
  async function getPdf(id) {
    const r = await get('pdfFiles', id);
    if (!r || !r.data) return null;
    return r.data.slice(0);
  }
  async function deletePdf(id) { return del('pdfFiles', id); }
  async function hasPdf(id) { return !!(await get('pdfFiles', id)); }

  // ---------- 页文本 ----------
  async function putPageText(paperId, page, text) {
    return put('pageTexts', {
      id: paperId + ':' + page,
      paperId, page,
      text: String(text || ''),
      at: new Date().toISOString()
    });
  }
  async function getPageTexts(paperId) {
    const rows = await getAllByIndex('pageTexts', 'paperId', paperId);
    return (rows || []).sort((a, b) => a.page - b.page);
  }
  async function getPageText(paperId, page) {
    return get('pageTexts', paperId + ':' + page);
  }
  async function countPageTexts(paperId) {
    const rows = await getAllByIndex('pageTexts', 'paperId', paperId);
    return (rows || []).length;
  }
  async function clearPageTexts(paperId) {
    const rows = await getAllByIndex('pageTexts', 'paperId', paperId);
    if (!rows.length) return 0;
    const t = requireDb().transaction('pageTexts', 'readwrite');
    const os = t.objectStore('pageTexts');
    rows.forEach(r => os.delete(r.id));
    await txDone(t);
    return rows.length;
  }

  // ---------- 级联删除 ----------
  async function deletePaperCascade(id) {
    const claims = await getAllByIndex('claims', 'paperId', id);
    const t = requireDb().transaction(['papers', 'pdfFiles', 'pageTexts', 'annotations', 'claims'], 'readwrite');
    t.objectStore('papers').delete(id);
    t.objectStore('pdfFiles').delete(id);
    t.objectStore('annotations').delete(id);
    const pageStore = t.objectStore('pageTexts');
    const idx = pageStore.index('paperId');
    const req = idx.openCursor(IDBKeyRange.only(id));
    req.onsuccess = () => {
      const cur = req.result;
      if (cur) { pageStore.delete(cur.primaryKey); cur.continue(); }
    };
    const cs = t.objectStore('claims');
    (claims || []).forEach(c => cs.delete(c.id));
    await txDone(t);
    return { claims: (claims || []).length };
  }

  async function clearAll() {
    const names = Object.keys(STORES);
    const t = requireDb().transaction(names, 'readwrite');
    names.forEach(n => t.objectStore(n).clear());
    await txDone(t);
  }

  // 只清文献相关数据，保留迁移标记、设置与 AI 配置
  async function clearLibrary() {
    const names = ['papers', 'pdfFiles', 'pageTexts', 'annotations', 'claims', 'opportunities'];
    const t = requireDb().transaction(names, 'readwrite');
    names.forEach(n => t.objectStore(n).clear());
    await txDone(t);
  }

  async function stats() {
    const out = {};
    for (const n of Object.keys(STORES)) out[n] = (await getAll(n)).length;
    return out;
  }

  root.PaperDB = {
    init, supported, ready: () => ready,
    get, getAll, put, del, clear, getMeta, setMeta, getSetting, setSetting,
    saveSnapshot, loadSnapshot, migrateLegacy,
    putPdf, getPdf, deletePdf, hasPdf,
    putPageText, getPageTexts, getPageText, countPageTexts, clearPageTexts,
    deletePaperCascade, clearAll, clearLibrary, stats,
    DB_NAME, DB_VER
  };
})(typeof self !== 'undefined' ? self : globalThis);
