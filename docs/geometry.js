/* 基于 PDF 几何坐标的元数据提取器
 *
 * 为什么需要它：
 * 这批中文 PDF 的文本层会把标题拆成单字（如「位」「位」「论」逐字成片段），
 * 且标题与「作者姓名」标签之间没有任何分隔符。靠"拼接文本 + 正则"在这类
 * 排版下注定不稳定。pdf.js 的 getTextContent() 同时返回每个片段的
 * transform 坐标，因此可以按几何关系把同一行的片段重组，再按字号与位置
 * 判断哪个是标题——这比正则鲁棒得多。
 *
 * 用法：
 *   const geo = await PdfGeometry.analyze(doc, 3);  // 分析前 3 页
 *   geo.title       -> 按坐标聚类得到的标题
 *   geo.lines       -> [{y,h,text}]，可用于按行定位「标签:值」
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PdfGeometry = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {

  // 全角数字/字母转半角；剥离私有区乱码（与 parser.js 保持一致）
  function norm(s) {
    return String(s == null ? '' : s)
      .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      .replace(/[Ａ-Ｚａ-ｚ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      .replace(/[\uE000-\uF8FF\u200B-\u200F\uFEFF\u2060-\u206F]/g, '');
  }

  // 把 getTextContent() 的 items 按 Y 坐标聚类成行
  function clusterLines(items, tolRatio) {
    const pts = [];
    for (const it of items) {
      if (!it.str || !it.str.trim()) continue;
      const tr = it.transform;
      const h = Math.hypot(tr[2], tr[3]) || 10;
      pts.push({ s: norm(it.str), x: tr[4], y: tr[5], h });
    }
    pts.sort((a, b) => b.y - a.y || a.x - b.x);
    const rows = [];
    for (const p of pts) {
      const last = rows[rows.length - 1];
      if (last && Math.abs(last.y - p.y) < Math.max(last.h, p.h) * (tolRatio || 0.6)) {
        last.parts.push(p);
        if (p.h > last.h) last.h = p.h;
      } else rows.push({ y: p.y, h: p.h, parts: [p] });
    }
    return rows.map(r => ({
      y: r.y, h: r.h,
      text: r.parts.sort((a, b) => a.x - b.x).map(p => p.s).join('').replace(/\s+/g, '')
    })).filter(l => l.text);
  }

  // 文献类型标签：这类文字（"专业硕士学位论文"）经常比标题还大，
  // 若不排除会被误当成标题 —— 这是几何法最主要的误判来源
  const TYPE_LINE = /^(?:专业学位)?(?:硕士|博士)?学位论文$|^专业学位$|^硕士学位论文$|^博士学位论文$|^专业硕士学位论文$|^研究生学位论文$/;

  // 判断一行是否像标题：长、含学术词、不是标签行、不是文献类型行
  function looksTitle(t) {
    if (!t || t.length < 6 || t.length > 90) return false;
    if (TYPE_LINE.test(t.replace(/\s/g, ''))) return false;
    if (/^(摘要|关键词|引言|绪论|目录|作者姓名|学科专业|指导教师|所在学院|论文提交日期|分类号|学校代号|学号|专业学位|学位论文|硕士|博士)/.test(t)) return false;
    if (/^[\d\s.,、\-:：]+$/.test(t)) return false;
    return /[一-龥]/.test(t);
  }

  /**
   * 分析 PDF 文档，返回几何化结果
   * @param doc pdf.js 的 PDFDocumentProxy
   * @param maxPages 分析的页数（默认 3）
   */
  async function analyze(doc, maxPages) {
    const all = [];
    let bestTitle = '';
    const n = Math.min(doc.numPages, maxPages || 3);
    for (let i = 1; i <= n; i++) {
      const pg = await doc.getPage(i);
      const vp = pg.getViewport({ scale: 1 });
      const tc = await pg.getTextContent();
      const lines = clusterLines(tc.items);
      all.push({ page: i, width: vp.width, height: vp.height, lines });
      // 只在第 1 页找标题：字号明显大于正文的行
      if (i === 1 && lines.length) {
        const sizes = lines.map(l => l.h).sort((a, b) => a - b);
        const median = sizes[Math.floor(sizes.length / 2)] || 10;
        // 候选：字号 >= 中位数 1.25 倍
        const cands = lines.filter(l => l.h >= median * 1.25 && looksTitle(l.text));
        if (cands.length) {
          // 按 Y 坐标从高到低（PDF 坐标系 y 向上），连续的候选行可合并（标题分两行的情况）
          cands.sort((a, b) => b.y - a.y);
          const merged = [];
          let cur = null;
          for (const c of cands) {
            if (cur && Math.abs(cur.y - c.y) < Math.max(cur.h, c.h) * 3.2) {
              // 相邻且同为大字号，拼接
              cur = { y: c.y, h: Math.max(cur.h, c.h), text: cur.text + c.text };
            } else {
              if (cur) merged.push(cur);
              cur = { y: c.y, h: c.h, text: c.text };
            }
          }
          if (cur) merged.push(cur);
          // 取最靠上（y 最大）的那组，但跳过页眉装饰
          merged.sort((a, b) => b.y - a.y);
          const pick = merged.find(m => looksTitle(m.text) && m.text.length >= 8) || merged[0];
          if (pick) bestTitle = pick.text;
        }
      }
    }
    return { title: bestTitle, pages: all };
  }

  return { analyze, clusterLines, norm };
});
