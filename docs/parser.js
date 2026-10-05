/* 论文元数据解析模块 —— 浏览器 / Node 通用
 *
 * 针对真实中文 PDF 的三类坑设计：
 *  1) 提取文本形态：中文逐字带空格/换行（"论 文 提 交"），全角数字逐位分离（"２ ０ ２ ０ 年"）。
 *     => 维护 squeeze()（保结构）与 flatten()（压空白）两个视图。
 *  2) 字段标签因校而异：专业有「专业名称/专业领域/专业学位领域/管理领域（方向）」；
 *     导师有「指导教师/指导教师姓名/企业导师/实践导师」；日期有中文数字（「二零二四年」）。
 *     => 每个字段配一组别名正则，逐个尝试。
 *  3) 并非每篇都印「学位授予单位」，需从多标签、多页降级推断。
 *     => 先显式标签，再逐页查找，最后用机构名正则兜底。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PaperParser = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {

  // ================= 文本归一化 =================
  function fw(s) {
    return String(s == null ? '' : s)
      .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      .replace(/[Ａ-Ｚａ-ｚ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  }
  // 保结构：压数字间空格与行内汉字间空格，保留换行
  function squeeze(s) {
    let t = fw(s).replace(/[­‏﻿]/g, '');
    for (let i = 0; i < 4; i++) t = t.replace(/(\d)[\s]+(?=\d)/g, '$1');
    t = t.replace(/[ \t](?=[一-龥])/g, '');
    t = t.replace(/[ \t]{2,}/g, ' ');
    return t.trim();
  }
  // 压平：去掉全部空白，用于「标签:值」连续匹配
  function flatten(s) {
    let t = fw(s).replace(/[­‏﻿]/g, '').replace(/\s+/g, ' ');
    for (let i = 0; i < 4; i++) t = t.replace(/(\d) (?=\d)/g, '$1');
    t = t.replace(/(?<=[一-龥]) (?=[一-龥])/g, '').replace(/[一-龥] (?=[一-龥])/g, '');
    return t.replace(/ {2,}/g, ' ').trim();
  }
  function unspaced(s) { return flatten(s); }

  // 中文数字年份：二零二四 -> 2024
  const CN_DIGIT = { 〇: 0, 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  function cnYear(s) {
    if (!s) return '';
    const t = String(s).replace(/[^〇零一二三四五六七八九]/g, '');
    if (t.length < 3) return '';
    let y = '';
    for (const ch of t) { if (CN_DIGIT[ch] == null) return ''; y += CN_DIGIT[ch]; }
    y = y.slice(0, 4);
    return /^(19|20)\d{2}$/.test(y) ? y : '';
  }
  function anyYear(s) {
    const m = String(s || '').match(/(19|20)\d{2}/);
    if (m) return m[0];
    return cnYear(s);
  }

  // ================= 类型判定 =================
  const TYPE_RULES = [
    { type: '博士学位论文', re: /博\s*士\s*学\s*位\s*论\s*文|博\s*士\s*论\s*文|doctoral\s+dissertation/i },
    { type: '硕士学位论文', re: /硕\s*士\s*学\s*位\s*论\s*文|硕\s*士\s*论\s*文|master'?s?\s+thesis/i },
    { type: '会议论文', re: /会\s*议\s*论\s*文|论\s*文\s*集|proceedings|conference|symposium/i },
    { type: '期刊论文', re: /期\s*刊|学\s*报|杂\s*志|Vol\.\s*\d|Chinese\s+Journal|Transactions/i },
    { type: '研究报告', re: /研\s*究\s*报\s*告|技\s*术\s*报\s*告|白\s*皮\s*书|Research\s+Report/i },
    { type: '学术专著', re: /monograph|专\s*著|图\s*书|编\s*著/ }
  ];
  const CATEGORIES = ['期刊论文', '硕士学位论文', '博士学位论文', '会议论文', '研究报告', '学术专著', '学位论文（其他）', '其他'];

  const STOP_HEAD = /^(摘要|abstract|关键词|key\s*words?|引言|绪论|前言|目录|参考文献|致谢|攻读|第[一二三四五六七八九十0-9]+章|第[0-9]+\s*章|中图分类号|文献标识码|作者简介|基金项目|学位论文|专业学位|上传|扫码)/i;

  // 标签结束边界：抓到值后在此截断，避免吞进下一个字段
  const LABEL_END = /(?:作\s*者\s*姓\s*名|作\s*者\s*单\s*位?|学\s*科\s*专\s*业\s*名\s*称|专\s*业\s*名\s*称|专\s*业\s*领\s*域|专\s*业\s*学\s*位\s*领\s*域|管\s*理\s*领\s*域|研\s*究\s*方\s*向|研\s*究\s*领\s*域|指\s*导\s*教\s*师\s*姓\s*名|论\s*文\s*指\s*导\s*教\s*师|指\s*导\s*教\s*师|企\s*业\s*指\s*导\s*教\s*师|企\s*业\s*导\s*师|实\s*践\s*导\s*师|校\s*外\s*导\s*师|所\s*在\s*学\s*院|学\s*位\s*授\s*予\s*单\s*位|授\s*予\s*学\s*位\s*单\s*位|论\s*文\s*提\s*交\s*日\s*期|论\s*文\s*答\s*辩\s*日\s*期|答\s*辩\s*日\s*期|答\s*辩\s*委\s*员\s*会|学\s*习\s*方\s*式|研\s*究\s*方\s*向|中\s*文\s*摘\s*要|英\s*文\s*摘\s*要|学\s*科\s*专\s*业\s*类\s*别|申\s*请\s*学\s*位|学\s*位\s*授\s*予\s*日\s*期|完\s*成\s*日\s*期|中\s*图\s*分\s*类\s*号|文\s*献\s*标\s*识\s*码|学\s*号|学\s*校\s*代\s*号|分\s*类\s*号|关\s*键\s*词|key\s*words?|abstract|DOI|基\s*金\s*项\s*目)/i;

  /** 抓「标签:值」，值截到下一个标签；labelRes 为别名数组，逐个尝试 */
  function fieldVal(text, labelRes) {
    for (const re of labelRes) {
      const m = text.match(re);
      if (!m) continue;
      const after = text.slice(m.index + m[0].length);
      const stop = after.search(LABEL_END);
      let v = (stop >= 0 ? after.slice(0, stop) : after).replace(/^[\s:：,，;；]+/, '');
      if (v.trim()) return v.trim();
    }
    return '';
  }

  // ================= 主入口 =================
  function parse(pdfMeta, rawText, pageCount, fileName) {
    const pages = String(rawText || '').split('\n===PAGE===\n');
    const headRaw = pages.slice(0, 5).join('\n');
    const head = squeeze(headRaw);
    const H = flatten(headRaw);          // 压平：标签匹配
    const W = flatten(rawText);          // 全文压平：兜底
    const F = squeeze(fileName || '');
    // 逐页压平视图：有些学校封面信息在靠后的页
    const pageFlat = pages.slice(0, 12).map(flatten);

    const r = {
      id: '', title: '', authors: '', year: '', type: '', category: '',
      source: '', school: '', major: '', supervisor: '', coSupervisor: '',
      keywords: '', abstract: '', pages: pageCount || 0,
      relevance: '', tags: '', note: '',
      fileName: fileName || '', fileSize: (pdfMeta && pdfMeta.size) || 0,
      addedAt: '',
      needCheck: []       // 未能可靠识别、建议人工确认的字段名
    };

    r.title = pickTitle(pdfMeta, head, F, H);
    r.authors = pickAuthors(pdfMeta, head, F, r.title, H);
    r.type = pickType(H, W);
    r.category = r.type || '其他';
    r.year = pickYear(H, W, pageFlat);
    const org = pickOrg(H, W, pageFlat);
    r.school = org.school; r.source = org.source;
    r.major = pickMajor(H, pageFlat);
    const sup = pickSupervisor(H, pageFlat);
    r.supervisor = sup.main; r.coSupervisor = sup.co;
    r.keywords = pickKeywords(H, W);
    r.abstract = pickAbstract(pages);

    ['year', 'school', 'source', 'major', 'supervisor', 'keywords', 'abstract'].forEach(k => {
      if (!r[k]) r.needCheck.push(k);
    });
    return r;
  }

  // ================= 标题 =================
  function pickTitle(meta, head, F, H) {
    if (meta && meta.title && meta.title.trim().length > 6 && !/^Microsoft Word/i.test(meta.title)) {
      return cleanTitle(meta.title.trim());
    }
    const cands = [];
    linesOf(head).slice(0, 60).forEach((ln, i) => {
      const t = ln.replace(/\s+/g, ' ').trim();
      if (t.length < 8 || t.length > 90) return;
      if (STOP_HEAD.test(t)) return;
      if (/^[\d\s.,、\-]+$/.test(t)) return;
      if (/[一-龥]/.test(t)) {
        let s = 40 - i * 1.2 + Math.min(t.length, 30) * 0.4;
        if (/(研究|分析|设计|评价|评估|管理|应用|影响|对策|优化|构建|基于|探究|实证|案例|机制|路径|策略|体系)/.test(t)) s += 25;
        if (/[：:，,。]/.test(t)) s -= 8;
        cands.push({ t, s });
      } else if (/[A-Za-z]/.test(t) && t.split(/\s+/).length >= 4) {
        cands.push({ t, s: 18 - i * 0.8 });
      }
    });
    if (!cands.length && H) {
      const m = H.match(/(?:学位论文|硕士论文|博士论文)?([一-龥0-9A-Za-z]{10,60}?(?:研究|分析|设计|评价|评估|管理|应用|优化|构建|探究|实证|影响|对策|机制|路径|策略|体系))/);
      if (m) cands.push({ t: m[1], s: 60 });
    }
    const seg = F.replace(/\.pdf$/i, '').split('_');
    if (seg.length >= 2 && seg[0].trim().length >= 8) cands.push({ t: seg[0].trim(), s: 78 });
    if (!cands.length) return cleanTitle(F.replace(/\.pdf$/i, '')) || '未识别题目';
    cands.sort((a, b) => b.s - a.s);
    return cleanTitle(cands[0].t);
  }
  function cleanTitle(t) {
    return flatten(t).replace(/^[\s　:：]+|[\s　:：]+$/g, '').slice(0, 120);
  }

  // ================= 作者 =================
  function cleanPeople(s) {
    let v = fw(flatten(s)).replace(LABEL_END, ' ');
    v = v.replace(/[（(][^)）]*[)）]/g, '')
      .replace(/(教授|副教授|讲师|研究员|高级工程师|高级经济师|工程师|博士生导师|硕士生导师|指导教师|导师|博士|硕士|等)/g, ' ');
    // 去掉尾部英文（英文文献里作者后可能跟机构）
    v = v.replace(/[A-Za-z]{4,}(\s+[A-Za-z]{2,})*$/, '');
    const parts = v.split(/[,，;；、\/|·\s]+/).map(x => x.trim()).filter(Boolean);
    const NAME_CH = '\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF';
    const reName = new RegExp('^[' + NAME_CH + ']{2,4}$');
    const good = parts.filter(p => reName.test(p) || /^[A-Z][a-z]{1,15}$/.test(p));
    if (!good.length) return '';
    return good.slice(0, 8).join(' ');
  }
  const AUTHOR_LABELS = [
    /作\s*者\s*姓\s*名\s*[:：]?/, /作\s*者\s*[:：]/, /作\s*者\s*全\s*名\s*[:：]?/,
    /[Aa]uthors?\s*[:：]?/, /[Aa]uthor\s*[:：]?/
  ];
  function pickAuthors(meta, head, F, title, H) {
    const v = cleanPeople(fieldVal(H, AUTHOR_LABELS));
    if (v) return v;
    const seg = F.replace(/\.pdf$/i, '').split('_');
    if (seg.length >= 2) { const c = cleanPeople(seg.slice(1).join('_')); if (c && c.length <= 12) return c; }
    const ls = linesOf(head).slice(0, 30);
    const ti = ls.findIndex(l => cleanTitle(l) === title);
    if (ti >= 0) {
      for (let i = ti + 1; i < Math.min(ti + 4, ls.length); i++) {
        const c = cleanPeople(ls[i]);
        if (c && c.length <= 12) return c;
      }
    }
    if (meta && meta.author && meta.author.trim().length > 1) return meta.author.trim();
    return '';
  }

  // ================= 年份 =================
  const DATE_LABELS = '论\\s*文\\s*提\\s*交\\s*日\\s*期|论\\s*文\\s*答\\s*辩\\s*日\\s*期|答\\s*辩\\s*日\\s*期|完\\s*成\\s*日\\s*期|学\\s*位\\s*授\\s*予\\s*日\\s*期|授\\s*予\\s*日\\s*期|出\\s*版\\s*日\\s*期|收\\s*稿\\s*日\\s*期|签\\s*字\\s*日\\s*期';
  const DATE_YEAR = new RegExp('(?:' + DATE_LABELS + ')[^0-9〇零一二三四五六七八九]{0,26}((?:19|20)\\d{2}|[〇零一二三四五六七八九]{4})');
  function pickYear(H, W, pageFlat) {
    let m = H.match(DATE_YEAR);
    if (m) { const y = anyYear(m[1]); if (y) return y; }
    for (const p of pageFlat) {
      const mm = p.match(DATE_YEAR);
      if (mm) { const y = anyYear(mm[1]); if (y) return y; }
    }
    const c = H.match(/(?:©|Copyright)\s*(\d{2}|\d{4})/i);
    if (c) { const v = c[1].length === 2 ? '20' + c[1] : c[1]; if (+v >= 1980) return v; }
    const years = W.match(/(?:19|20)\d{2}/g);
    if (years && years.length) {
      const freq = {};
      years.forEach(y => { freq[y] = (freq[y] || 0) + 1; });
      const maxY = new Date().getFullYear() + 1;
      const cand = Object.keys(freq).filter(y => +y >= 1980 && +y <= maxY).sort((a, b) => freq[b] - freq[a]);
      if (cand.length) return cand[0];
    }
    return '';
  }

  // ================= 类型 =================
  function pickType(H, W) {
    if (/博\s*士\s*学\s*位\s*论\s*文|博\s*士\s*论\s*文/.test(H)) return '博士学位论文';
    if (/硕\s*士\s*学\s*位\s*论\s*文|硕\s*士\s*论\s*文/.test(H)) return '硕士学位论文';
    for (const r of TYPE_RULES) if (r.re.test(H)) return r.type;
    const h2 = W.slice(0, 20000);
    for (const r of TYPE_RULES) if (r.re.test(h2)) return r.type;
    return '';
  }

  // ================= 机构 / 来源 =================
  const ORG_FULL = /([一-龥]{2,14}(?:大学|学院|研究院|研究所))/;
  const ORG_LABELS = [
    /学\s*位\s*授\s*予\s*单\s*位\s*[:：]?/, /授\s*予\s*学\s*位\s*单\s*位\s*[:：]?/,
    /所\s*在\s*学\s*院\s*[:：]?/, /学\s*院\s*名\s*称\s*[:：]?/,
    /单\s*位\s*名\s*称\s*[:：]?/, /培\s*养\s*单\s*位\s*[:：]?/, /学\s*校\s*名\s*称\s*[:：]?/
  ];
  // 从任意文本里提取干净的机构名（优先「XX大学」，其次「XX学院/研究院」）
  function extractOrg(v) {
    if (!v) return '';
    const t = String(v).replace(/^不区分研究方向?/, '').replace(/^研究方向?/, '').trim();
    const u = t.match(/([一-龥]{2,14}大学)/);
    if (u) return u[1];
    const c = t.match(/([一-龥]{2,14}(?:学院|研究院|研究所))/);
    return c ? c[1] : '';
  }
  function pickOrg(H, W, pageFlat) {
    let school = extractOrg(fieldVal(H, ORG_LABELS));
    if (!school) {
      for (const p of pageFlat) {
        const u = extractOrg(fieldVal(p, ORG_LABELS));
        if (u) { school = u; break; }
      }
    }
    if (!school) school = extractOrg(H) || extractOrg(W.slice(0, 8000));
    let source = '';
    const jm = H.match(/([一-龥]{2,20}(?:学报|杂志|期刊))/) || W.slice(0, 6000).match(/([一-龥]{2,20}(?:学报|杂志|期刊))/);
    if (jm) source = jm[1];
    if (!source) source = school;
    return { source, school: school || '' };
  }

  // ================= 专业 =================
  const MAJOR_LABELS = [
    /学\s*科\s*专\s*业\s*(?:名\s*称)?\s*[:：]?/, /专\s*业\s*名\s*称\s*[:：]?/,
    /专\s*业\s*领\s*域\s*[:：]?/, /专\s*业\s*学\s*位\s*领\s*域\s*[:：]?/,
    /学\s*位\s*专\s*业\s*领\s*域\s*[:：]?/, /管\s*理\s*领\s*域\s*[（(]?\s*方\s*向\s*[)）]?\s*[:：]?/,
    /研\s*究\s*领\s*域\s*[:：]?/, /研\s*究\s*方\s*向\s*[:：]?/, /专\s*业\s*类\s*别\s*[:：]?/
  ];
  function pickMajor(H, pageFlat) {
    // 「不区分研究方向」「研究方向」等噪声前缀先剥掉
    const strip = v => v
      .replace(/^不区分研究方向?/, '')
      .replace(/^研究方向?/, '')
      .replace(/所在学院$/, '')
      .trim();
    const bad = v => !v || /学位论?文|专业学位|申请学位|中英文摘要|不区分|^无$|学院|大学/.test(v) || /^[\d\s.,]+$/.test(v);
    const one = txt => {
      let v = cleanOrg(fieldVal(txt, MAJOR_LABELS));
      // 值里常混入标签尾巴："工程管理硕士领域（方向）： 工程管理"
      v = strip(v)
        .replace(/(硕士|博士|学士)$/, '')
        .replace(/^[^：:]{0,8}(?:名称|领域|类别)\s*[（(]?\s*方\s*向\s*[)）]?\s*[:：]?\s*/, '')
        .replace(/[（(][^)）]{0,6}[)）]\s*[:：]?\s*$/, '')
        .trim();
      return bad(v) ? '' : v;
    };
    let v = one(H);
    if (!v) for (const p of pageFlat) { v = one(p); if (v) break; }
    return v;
  }

  // ================= 导师 =================
  const SUP_LABELS = [
    // 标准写法：标签后紧跟姓名（可带职称）
    /指\s*导\s*教\s*师\s*姓\s*名\s*[,、]?\s*职\s*称?\s*[:：]?/,
    /指\s*导\s*教\s*师\s*姓\s*名\s*[:：]?/,
    /指\s*导\s*教\s*师\s*(?:姓\s*名)?\s*[,、]?\s*职\s*称?\s*[:：]?/,
    /指\s*导\s*教\s*师\s*[:：]?/,
    /论\s*文\s*指\s*导\s*教\s*师\s*[:：]?/,
    /导\s*师\s*姓\s*名\s*[:：]?/,
    /[Ss]upervisor\s*[:：]?/,
    // 有些学校标签写在上一行末尾，值以冒号起头："…： 牛东晓教授 企业导师 ： 刘畅…"
    /教\s*师\s*[:：]\s*(?=[^企学创任博硕])/
  ];
  const CO_SUP_LABELS = [
    /企\s*业\s*导\s*师\s*[:：]?/, /实\s*践\s*导\s*师\s*[:：]?/, /校\s*外\s*导\s*师\s*[:：]?/,
    /企\s*业\s*指\s*导\s*教\s*师\s*[:：]?/, /联\s*合\s*导\s*师\s*[:：]?/
  ];
  const SUP_STOP = /^(姓名|名称|职称|工作单位|专业|研究方向|性别|年龄|籍贯|职称|导师)$/;
  function cleanSup(s) {
    if (!s) return '';
    let v = flatten(s);
    v = v.replace(/\b(?:University|College|Institute|Huazhong|Nanjing|Beijing|Wuhan|Classified)\b.*$/i, '');
    v = v.replace(/[（(][^)）]*[)）]/g, ' ')
      .replace(/(教授|副教授|讲师|研究员|高级工程师|高级经济师|工程师|博士生导师|硕士生导师|博士|硕士|等)/g, ' ');
    v = v.replace(/[A-Za-z]{3,}.*$/, '');
    v = v.replace(/[,，;；、\/\s]+/g, ' ').trim();
    // 人名：覆盖简体、繁体与生僻字（部分繁体字不在 U+4E00–U+9FFF，如「繆」在扩展区）
    const NAME_CH = '\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF';
    const cn = v.match(new RegExp('[' + NAME_CH + ']{2,4}(?:\\s+[' + NAME_CH + ']{2,4})*'));
    if (!cn) return '';
    const out = cn[0].replace(/\s+/g, ' ').trim();
    if (SUP_STOP.test(out)) return '';   // 「姓名」「职称」这类标签残留不算人名
    return out;
  }
  function pickSupervisor(H, pageFlat) {
    const one = txt => ({
      main: cleanSup(fieldVal(txt, SUP_LABELS)),
      co: cleanSup(fieldVal(txt, CO_SUP_LABELS))
    });
    let r = one(H);
    if (!r.main) for (const p of pageFlat) { r = one(p); if (r.main) break; }
    return r;
  }

  // ================= 关键词 =================
  const KW_LABELS = [/关\s*键\s*词\s*[:：]?/, /[Kk]ey\s*[wW]ords?\s*[:：]?/, /主题词\s*[:：]?/];
  function cleanKw(s) {
    if (!s) return '';
    let v = flatten(s);
    v = v.replace(/[（(][^)）]*[)）]/g, '');
    v = v.replace(/^(关键词|key\s*words?|主题词)\s*[:：]?\s*/i, '');
    v = v.replace(/^[】』》）)\]]+/, '').replace(/^[【『《（(\[]+/, '').trim();
    const cut = v.search(/[;；]/);
    if (cut > 0) v = v.slice(0, cut);
    else if (!/[一-龥]/.test(v) && v.includes(',')) v = v.split(',').slice(0, 6).join(', ');
    v = v.replace(/[。．.、\s]+$/, '').trim();
    v = v.replace(/\s*\d+(\s+\d+)*$/, '').trim();
    return v.replace(/[。．.、\s]+$/, '').slice(0, 200);
  }
  function pickKeywords(H, W) {
    let v = cleanKw(fieldVal(H, KW_LABELS));
    if (!v) v = cleanKw(fieldVal(W, KW_LABELS));
    return v;
  }

  // ================= 摘要 =================
  function pickAbstract(pages) {
    for (let i = 0; i < Math.min(pages.length, 8); i++) {
      const p = flatten(pages[i]);
      const m = p.match(/(?:摘\s*要|\bAbstract\b)\s*[:：]?\s*([\s\S]{60,1500}?)(?=关\s*键\s*词|Key\s*[wW]ords?|\bAbstract\b|Keywords|第[一二三四五六七八九十0-9]+章|1\s*[绪引]\s*[论语]|引\s*言|一、\s*绪论)/i);
      if (m) {
        const v = m[1].replace(/[\s:：,，;；.。、]+$/, '').replace(/\s+/g, ' ').trim();
        if (v.length > 50) return v.slice(0, 1200);
      }
    }
    return '';
  }

  function cleanOrg(s) {
    if (!s) return '';
    let v = flatten(s).replace(LABEL_END, ' ');
    v = v.replace(/^不区分研究方向?/, '').replace(/^研究方向?/, '').trim();
    v = v.replace(/\s*\d{4}\s*年?.*$/, '');
    v = v.replace(/(?:[A-Za-z](?:\s*[A-Za-z])*)+$/, '');
    v = v.replace(/[,，;；。、\s:：]+$/g, '').trim();
    // PDF 文本层常混入装饰符号（如「【摘要】」的括号残片）
    v = v.replace(/^[】』》）)\]]+/, '').replace(/^[【『《（(\[]+/, '').trim();
    if (v.length > 24) v = v.slice(0, 24);
    return v.replace(/[\s\u3000]+$/,'').trim();
  }
  function linesOf(t) { return String(t || '').split(/\n+/).map(s => s.trim()).filter(Boolean); }

  return {
    parse, cleanTitle, cleanPeople, cleanOrg, unspaced, squeeze, flatten, fw,
    cnYear, anyYear, CATEGORIES
  };
});
