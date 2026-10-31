/* AI 能力（OpenAI 兼容接口）
 *
 * 支持：
 *  - DeepSeek R1 官方 API：deepseek-reasoner
 *  - DeepSeek R1 本地 Ollama / vLLM：http://localhost:11434/v1，模型 deepseek-r1:7b 等
 *  - 其他 OpenAI 兼容服务
 *
 * 约束：
 *  - Key 只保存在当前页面内存，不写 localStorage；
 *  - 只接受声明过的字段/结构化 JSON，逐项校验；
 *  - 调用前由界面展示服务商、模型与待发送片段；
 *  - R1 的  think 段会被剥离，避免污染 JSON。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PaperAI = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const CFG_KEY = 'paperhub.ai.v1';
  let memoryKey = '';

  function getCfg() {
    try {
      const c = JSON.parse(localStorage.getItem(CFG_KEY) || '{}');
      delete c.key;   // 兼容旧版本：旧 localStorage 里的 key 不再使用
      return Object.assign(c, { key: memoryKey });
    } catch (e) { return { key: memoryKey }; }
  }
  function setCfg(c) {
    const cfg = c || {};
    memoryKey = String(cfg.key || '');
    try {
      localStorage.setItem(CFG_KEY, JSON.stringify({
        base: cfg.base || '', model: cfg.model || '',
        keyless: !!cfg.keyless, preset: cfg.preset || ''
      }));
    } catch (e) { }
  }
  function isReady() {
    const c = getCfg();
    return !!(c.model && (c.key || c.keyless));
  }

  const PRESETS = [
    {
      name: 'DeepSeek R1 · 官方 API',
      base: 'https://api.deepseek.com/v1', model: 'deepseek-reasoner',
      keyless: false, note: '官方 R1 推理模型，需要 API Key'
    },
    {
      name: 'DeepSeek R1 · 本地 Ollama',
      base: 'http://localhost:11434/v1', model: 'deepseek-r1:7b',
      keyless: true, note: '本地开源权重；无需 Key，需先启动 Ollama 并允许跨域'
    },
    {
      name: 'DeepSeek R1 · 自托管 vLLM',
      base: 'http://localhost:8000/v1', model: 'deepseek-r1',
      keyless: true, note: 'vLLM / SGLang 等 OpenAI 兼容服务；无鉴权时可留空 Key'
    },
    { name: 'DeepSeek Chat', base: 'https://api.deepseek.com/v1', model: 'deepseek-chat', keyless: false },
    { name: '通义千问', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', keyless: false },
    { name: 'Kimi', base: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', keyless: false },
    { name: '智谱 GLM', base: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', keyless: false },
    { name: '自定义 OpenAI 兼容', base: '', model: '', keyless: false }
  ];

  function stripThink(s) {
    let t = String(s || '');
    // DeepSeek R1 / 本地蒸馏模型常见的思考段
    t = t.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');
    t = t.replace(/<\|begin_of_thought\|>[\s\S]*?<\|end_of_thought\|>/gi, '');
    return t.trim();
  }

  function pickContent(data) {
    const m = data && data.choices && data.choices[0] && data.choices[0].message;
    if (!m) return '';
    // 优先最终回答；只有 reasoning_content 时作为兜底（仍会剥离 think）
    return stripThink(m.content || m.reasoning_content || '');
  }

  function parseJsonLoose(s) {
    if (!s) return null;
    let t = stripThink(s).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a < 0 || b < 0) return null;
    try { return JSON.parse(t.slice(a, b + 1)); }
    catch (e) { return null; }
  }

  async function chat(messages, opts) {
    const cfg = getCfg();
    if (!isReady()) return { ok: false, error: '未配置 AI：请先填写模型；云端服务还需要 API Key' };
    const base = (cfg.base || PRESETS[0].base).replace(/\/+$/, '');
    const headers = { 'Content-Type': 'application/json' };
    if (cfg.key) headers.Authorization = 'Bearer ' + cfg.key;
    const ctrl = new AbortController();
    // R1 推理慢，给 180 秒；超时明确报错，不静默挂起
    const timer = setTimeout(() => ctrl.abort(), (opts && opts.timeout) || 180000);
    try {
      const body = {
        model: cfg.model,
        messages,
        max_tokens: (opts && opts.max_tokens) || 2400,
        stream: false
      };
      // DeepSeek 官方 deepseek-reasoner 不接受 temperature 等采样参数
      if (!/reasoner|deepseek-r1/i.test(cfg.model)) {
        body.temperature = opts && opts.temperature != null ? opts.temperature : 0.2;
      }
      const resp = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers,
        signal: ctrl.signal,
        body: JSON.stringify(body)
      });
      if (!resp.ok) {
        const txt = await resp.text().catch(() => '');
        return { ok: false, error: 'HTTP ' + resp.status + '：' + txt.slice(0, 240) };
      }
      const data = await resp.json();
      const content = pickContent(data);
      if (!content) return { ok: false, error: '模型返回为空（可能是 R1 只返回了思考段或触发了长度上限）' };
      return {
        ok: true, content,
        usage: data.usage || null,
        model: data.model || cfg.model
      };
    } catch (e) {
      if (e && e.name === 'AbortError') return { ok: false, error: '请求超时（180 秒），可改用更小的本地模型或缩短输入' };
      return { ok: false, error: '网络/CORS 错误：' + (e.message || e) };
    } finally {
      clearTimeout(timer);
    }
  }

  async function chatJSON(prompt, opts) {
    const r = await chat([{ role: 'user', content: prompt }], opts);
    if (!r.ok) return r;
    const obj = parseJsonLoose(r.content);
    if (!obj) return { ok: false, error: '返回不是合法 JSON', raw: r.content.slice(0, 500) };
    return { ok: true, data: obj, raw: r.content, usage: r.usage, model: r.model };
  }

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

  async function extract(paper, text) {
    const r = await chat([{ role: 'user', content: buildPrompt(paper, text) }], { max_tokens: 2600, temperature: 0.2 });
    if (!r.ok) return r;
    const obj = parseJsonLoose(r.content);
    if (!obj) return { ok: false, error: '返回不是合法 JSON', raw: r.content.slice(0, 300) };
    const out = {};
    window.PaperFields.AI_FIELDS.forEach(f => {
      const v = obj[f.k];
      if (typeof v === 'string' && v.trim()) out[f.k] = v.trim();
    });
    return { ok: true, fields: out };
  }

  async function ping() {
    const cfg = getCfg();
    if (!isReady()) return { ok: false, error: '请先填写模型；云端服务还需要 API Key' };
    const r = await chat([{ role: 'user', content: '只回复 ok 两个字母，不要解释。' }], { max_tokens: 16, temperature: 0, timeout: 60000 });
    if (!r.ok) return r;
    return { ok: true, model: r.model };
  }

  return { getCfg, setCfg, isReady, extract, ping, chat, chatJSON, parseJsonLoose, stripThink, PRESETS };
});
