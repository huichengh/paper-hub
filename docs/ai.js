/* AI 抽取（OpenAI 兼容接口）
 *
 * 把 PDF 的摘要与正文片段发给大模型，按固定模板抽取深度字段。
 * 默认关闭：需要用户自己填 API Key 才启用，且明确提示内容会发到第三方服务。
 *
 * 注意：
 *  - 只抽取 fields.js 里 AI_FIELDS 声明的深度字段，不覆盖人工填写的内容
 *  - 返回要求纯 JSON，逐项校验后再写入，避免模型编造污染数据
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PaperAI = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {

  const CFG_KEY = 'paperhub.ai.v1';
  // 只保存在当前页面内存里：刷新即失效，不落 localStorage，避免密钥随备份/浏览器数据泄露
  let memoryKey = '';

  function getCfg() {
    try {
      const c = JSON.parse(localStorage.getItem(CFG_KEY) || '{}');
      // 兼容旧版本：如果 localStorage 里还残留 key，直接忽略，不再使用
      delete c.key;
      return Object.assign(c, { key: memoryKey });
    } catch (e) { return { key: memoryKey }; }
  }
  function setCfg(c) {
    const cfg = c || {};
    memoryKey = String(cfg.key || '');
    // 持久化只保留 base/model，不写 key
    try { localStorage.setItem(CFG_KEY, JSON.stringify({ base: cfg.base || '', model: cfg.model || '' })); }
    catch (e) { }
  }
  function isReady() {
    const c = getCfg();
    return !!(c.key && c.model);
  }

  // 按模型实际情况给出可用的默认 base
  const PRESETS = [
    { name: 'DeepSeek', base: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    { name: '通义千问', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
    { name: 'Kimi', base: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
    { name: '智谱 GLM', base: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
    { name: '自定义', base: '', model: '' }
  ];

  function buildPrompt(paper, text) {
    const fields = window.PaperFields.AI_FIELDS;
    const spec = fields.map(f => `  "${f.k}": ${f.ask}`).join(',\n');
    return `你是一位学术文献分析助手。请根据下面的论文内容，抽取指定字段。

要求：
1. 只依据给出的原文，不要编造。原文没有的信息填空字符串 ""。
2. 每个字段用中文，简洁概括，80~200 字，不要整段照抄。
3. 严格输出 JSON 对象，不要 markdown 代码块，不要任何解释。
4. JSON 的键只能是下面列出的这些。

需要抽取的字段：
${spec}

论文题目：${paper.title || '未知'}

论文内容（摘要与正文节选）：
${text.slice(0, 14000)}

请输出 JSON：`;
  }

  function parseJsonLoose(s) {
    if (!s) return null;
    // 去掉可能的 markdown 包裹
    let t = s.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a < 0 || b < 0) return null;
    try { return JSON.parse(t.slice(a, b + 1)); }
    catch (e) { return null; }
  }

  /**
   * 抽取一篇论文的深度字段
   * @returns {Promise<{ok:boolean, fields?:object, error?:string, raw?:string}>}
   */
  async function extract(paper, text, onLog) {
    const cfg = getCfg();
    if (!isReady()) return { ok: false, error: '未配置 API' };
    const base = (cfg.base || PRESETS[0].base).replace(/\/+$/, '');
    const prompt = buildPrompt(paper, text);
    try {
      const resp = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + cfg.key
        },
        body: JSON.stringify({
          model: cfg.model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.2,
          max_tokens: 2200
        })
      });
      if (!resp.ok) {
        const t = await resp.text().catch(() => '');
        return { ok: false, error: 'HTTP ' + resp.status + '：' + t.slice(0, 160) };
      }
      const data = await resp.json();
      const content = data.choices && data.choices[0] &&
        data.choices[0].message && data.choices[0].message.content;
      const obj = parseJsonLoose(content);
      if (!obj) return { ok: false, error: '返回不是合法 JSON', raw: (content || '').slice(0, 300) };
      // 只保留声明过的字段，且必须是字符串
      const out = {};
      window.PaperFields.AI_FIELDS.forEach(f => {
        const v = obj[f.k];
        if (typeof v === 'string' && v.trim()) out[f.k] = v.trim();
      });
      return { ok: true, fields: out };
    } catch (e) {
      return { ok: false, error: '网络错误：' + e.message };
    }
  }

  /** 测试连通性：发一个最小请求 */
  async function ping() {
    const cfg = getCfg();
    if (!isReady()) return { ok: false, error: '请先填写 API Key 和模型名' };
    const base = (cfg.base || PRESETS[0].base).replace(/\/+$/, '');
    try {
      const r = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.key },
        body: JSON.stringify({
          model: cfg.model,
          messages: [{ role: 'user', content: '回复"ok"两个字即可' }],
          max_tokens: 10
        })
      });
      if (!r.ok) return { ok: false, error: 'HTTP ' + r.status };
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  return { getCfg, setCfg, isReady, extract, ping, PRESETS };
});
