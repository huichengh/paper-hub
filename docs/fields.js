/* 字段定义（单一数据源）
 *
 * 表格列、编辑弹窗、对比视图、导出、AI 抽取，全部从这里读字段，
 * 避免一处改了字段名/标签，别处对不上。
 *
 * 字段分三组：
 *   base  —— 封面元数据，PDF 能自动提取
 *   deep  —— 需要通读归纳，靠「检阅模式一键填充」或「AI 抽取」
 *   own   —— 只跟你的研究有关，必须人工判断
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PaperFields = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {

  // kind: text | textarea | select | number | figures
  // auto: true 表示解析器/AI 可写入；false 表示只保留人工内容，重解析不覆盖
  const ALL = [
    // ---- 基本信息 ----
    { k: 'title', label: '题目', group: 'base', kind: 'text', auto: true, w: 300 },
    { k: 'authors', label: '作者', group: 'base', kind: 'text', auto: true, w: 100 },
    { k: 'year', label: '年代', group: 'base', kind: 'text', auto: true, w: 66 },
    { k: 'type', label: '期刊/论文类型', group: 'base', kind: 'text', auto: true, w: 150 },
    { k: 'category', label: '所属分类', group: 'base', kind: 'select', auto: true },
    { k: 'source', label: '期刊/学校', group: 'base', kind: 'text', auto: true, w: 140 },
    { k: 'school', label: '学位授予单位', group: 'base', kind: 'text', auto: true },
    { k: 'major', label: '学科专业', group: 'base', kind: 'text', auto: true, w: 100 },
    { k: 'supervisor', label: '导师', group: 'base', kind: 'text', auto: true },
    { k: 'keywords', label: '关键词', group: 'base', kind: 'text', auto: true, w: 190 },
    { k: 'abstract', label: '摘要', group: 'base', kind: 'textarea', auto: true },
    { k: 'pages', label: '页数', group: 'base', kind: 'number', auto: true, w: 56 },

    // ---- 研究内容（深度字段）----
    { k: 'background', label: '研究背景', group: 'deep', kind: 'textarea', auto: true,
      hint: '为什么做这个研究，问题从何而来' },
    { k: 'purpose', label: '研究目的', group: 'deep', kind: 'textarea', auto: true,
      hint: '作者想解决什么问题、达成什么目标' },
    { k: 'method', label: '研究方法', group: 'deep', kind: 'textarea', auto: true,
      hint: '识别/评价/建模用了哪些方法，如 WBS-RBS、AHP、模糊综合评价' },
    { k: 'framework', label: '理论框架', group: 'deep', kind: 'textarea', auto: true,
      hint: '依托的理论，如霍尔三维结构、利益相关者理论' },
    { k: 'innovation', label: '亮点与创新点', group: 'deep', kind: 'textarea', auto: true,
      hint: '相对已有研究的新意：视角、方法、对象、结论' },
    { k: 'conclusion', label: '主要结论', group: 'deep', kind: 'textarea', auto: true,
      hint: '得出了什么结论、识别出哪些关键因素' },
    { k: 'dimensions', label: '维度与具体因素', group: 'deep', kind: 'textarea', auto: true,
      hint: '风险/指标如何分层，一级维度与下属因素' },
    { k: 'criteria', label: '评价标准体系', group: 'deep', kind: 'textarea', auto: true,
      hint: '评价用什么标度、分级标准、权重确定方式' },
    { k: 'figures', label: '图示', group: 'deep', kind: 'figures', auto: false,
      hint: '检阅模式里框选截图收藏' },

    // ---- 与自己研究的关系（人工判断）----
    { k: 'topics', label: '相关主题', group: 'own', kind: 'text', auto: true, w: 190 },
    { k: 'relevance', label: '与自己论文的相关性', group: 'own', kind: 'select', auto: false, w: 90 },
    { k: 'tags', label: '标签', group: 'own', kind: 'text', auto: false, w: 110 },
    { k: 'note', label: '备注 / 笔记', group: 'own', kind: 'textarea', auto: false },

    // ---- 系统字段 ----
    { k: 'fileName', label: '源文件名', group: 'sys', kind: 'text', auto: true }
  ];

  const BY_KEY = {};
  ALL.forEach(f => BY_KEY[f.k] = f);

  const LABELS = {};
  ALL.forEach(f => LABELS[f.k] = f.label);

  // 表格默认显示的列（窄列，避免横向过宽）
  const TABLE_COLS = ['title', 'authors', 'year', 'type', 'source', 'major', 'keywords', 'pages', 'relevance', 'tags'];

  // 对比视图默认行（用户指定的 14 项 + 通用的研究方法/理论框架）
  const COMPARE_ROWS = [
    'title', 'authors', 'year', 'type', 'topics', 'relevance',
    'background', 'purpose', 'innovation', 'method', 'framework',
    'conclusion', 'dimensions', 'criteria', 'figures',
    // 以下保留在对比中便于核对，但排在后面
    'source', 'major', 'supervisor', 'keywords', 'abstract', 'note'
  ];

  // AI 抽取要填的字段（只处理深度字段，不动人工字段）
  const AI_FIELDS = [
    { k: 'background', ask: '研究背景：为什么做这项研究，问题从何而来' },
    { k: 'purpose', ask: '研究目的：作者要解决什么问题、达成什么目标' },
    { k: 'method', ask: '研究方法：用了哪些方法与技术（如 WBS-RBS、德尔菲、AHP、模糊综合评价）' },
    { k: 'framework', ask: '理论框架：依托哪些理论或模型（如霍尔三维结构）' },
    { k: 'innovation', ask: '亮点与创新点：相对已有研究的新意' },
    { k: 'conclusion', ask: '主要结论：得出的结论、识别出的关键因素' },
    { k: 'dimensions', ask: '维度与具体因素：指标/风险如何分层，一级维度与下属因素' },
    { k: 'criteria', ask: '评价标准体系：评价标度、分级标准、权重确定方式' }
  ];

  // 检阅模式「一键填充」可选的目标字段（只列深度字段）
  const FILL_TARGETS = ALL.filter(f => f.group === 'deep' && f.kind !== 'figures');

  return { ALL, BY_KEY, LABELS, TABLE_COLS, COMPARE_ROWS, AI_FIELDS, FILL_TARGETS };
});
