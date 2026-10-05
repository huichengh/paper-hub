/* 论文元数据解析模块 —— 浏览器 / Node 通用 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PaperParser = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {

  // ---------- 文本归一化 ----------
  // 中文 PDF 提取出的文本有两个怪癖：
  //   1) 全角数字逐位分离："２ ０ ２ ０ 年"
  //   2) 字符间夹空格甚至换行："论 文 提 交" / "论\n \n文\n \n提"
  // 因此准备两个视图：
  //   squeeze()  —— 保留换行结构，用于分行的标题/作者判断
  //   flatten()  —— 彻底压掉所有空白，用于「标签:值」这类连续匹配
  function fw(s) {
    return String(s == null ? '' : s)
      .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      .replace(/[Ａ-Ｚａ-ｚ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  }
  function squeeze(s) {
    let t = fw(s).replace(/[­‏﻿]/g, '');
    // 逐位分离的数字（允许中间是空格/换行）：2 0 2 0 / 2\n0\n2\n0 -> 2020
    for (let i = 0; i < 4; i++) t = t.replace(/(\d)[\s]+(?=\d)/g, '$1');
    // 汉字之间的空格（不跨行）压掉
    t = t.replace(/[ \t](?=[一-龥])/g, '');
    t = t.replace(/[ \t]{2,}/g, ' ');
    return t.trim();
  }
  // 压平：所有空白全部去掉，只在英文单词间保留单空格
  function flatten(s) {
    let t = fw(s)
      .replace(/[­‏﻿]/g, '')
      .replace(/\s+/g, ' ');
    // 逐位数字先拼回来
    for (let i = 0; i < 4; i++) t = t.replace(/(\d) (?=\d)/g, '$1');
    t = t.replace(/(?<=[一-龥]) (?=[一-龥])/g, '')
         .replace(/[一-龥] (?=[一-龥])/g, '');
    return t.replace(/[ ]{2,}/g, ' ').trim();
  }
  function unspaced(s) {
    return flatten(s);
  }

  const TYPE_RULES = [
    { type: '博士学位论文', re: /博士\s*学位论文|博士论文|doctoral\s+dissertation/i },
    { type: '硕士学位论文', re: /硕士\s*学位论文|硕士论文|master'?s?\s+thesis/i },
    { type: '期刊论文', re: /期刊|学报|杂志|Vol\.\s*\d|Chinese\s+Journal|Transactions/i },
    { type: '会议论文', re: /会议论文|论文集|Proceedings|Conference|symposium|Workshop/i },
    { type: '研究报告', re: /研究报告|技术报告|白皮书|Research\s+Report/i },
    { type: '学术专著', re: / monograph|专著|图书|编著/ },
    { type: '学位论文（其他）', re: /学位论文/ }
  ];
  const CATEGORIES = ['期刊论文', '硕士学位论文', '博士学位论文', '会议论文', '研究报告', '学术专著', '学位论文（其他）', '其他'];

  const STOP_HEAD = /^(摘要|abstract|关键词|key\s*words?|引言|绪论|前言|目录|参考文献|致谢|攻读|第[一二三四五六七八九十0-9]+章|第[0-9]+\s*章|中图分类号|文献标识码|作者简介|基金项目|学位论文|专业学位)/i;

  // ---------- 主入口 ----------
  function parse(pdfMeta, rawText, pageCount, fileName) {
    const pages = String(rawText || '').split('\n===PAGE===\n');
    // 行结构版：保留换行，用于按行判断标题/作者
    const head = squeeze(pages.slice(0, 4).join('\n'));
    const whole = squeeze(rawText);
    // 压平版：去掉全部空白，用于「标签:值」匹配
    const H = flatten(pages.slice(0, 4).join('\n'));
    const W = flatten(rawText);
    const F = squeeze(fileName || '');

    const r = {
      id: '',
      title: '', authors: '', year: '', type: '', category: '',
      source: '', school: '', major: '', supervisor: '',
      keywords: '', abstract: '', pages: pageCount || 0,
      relevance: '', tags: '', note: '',
      fileName: fileName || '', fileSize: (pdfMeta && pdfMeta.size) || 0,
      addedAt: ''
    };

    r.title = pickTitle(pdfMeta, head, F, H);
    r.authors = pickAuthors(pdfMeta, head, F, r.title, H);
    r.year = pickYear(H, W);
    r.type = pickType(H, W);
    r.category = r.type || '其他';
    const s = pickSource(H, W, r.type);
    r.source = s.source; r.school = s.school;
    r.major = pickMajor(H);
    r.supervisor = pickSupervisor(H);
    r.keywords = pickKeywords(H, W);
    r.abstract = pickAbstract(pages);
    return r;
  }

  function linesOf(t) {
    return String(t || '').split(/\n+/).map(s => s.trim()).filter(Boolean);
  }

  // 候选标题打分：靠前、长度适中、含学术动词的更可能是真标题
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
    // 压平文本兜底：这类 PDF 按行切分会把标题打散成每行一个字
    if (!cands.length && H) {
      const m = H.match(/(?:学位论文|硕士论文|博士论文)?([一-龥0-9A-Za-z]{10,60}?(?:研究|分析|设计|评价|评估|管理|应用|优化|构建|探究|实证|影响|对策|机制|路径|策略|体系))/);
      if (m) cands.push({ t: m[1], s: 60 });
    }
    // 文件名 "题目_作者" 是很强的线索
    const seg = F.replace(/\.pdf$/i, '').split('_');
    if (seg.length >= 2 && seg[0].trim().length >= 8) cands.push({ t: seg[0].trim(), s: 78 });
    if (!cands.length) return cleanTitle(F.replace(/\.pdf$/i, '')) || '未识别题目';
    cands.sort((a, b) => b.s - a.s);
    return cleanTitle(cands[0].t);
  }
  function cleanTitle(t) {
    return flatten(t).replace(/^[\s　:：]+|[\s　:：]+$/g, '').slice(0, 120);
  }

  // 抓到的值里可能混进下一个字段标签，按标签词截断
  const LABEL_END = /(?:作者姓名|作\s*者\s*单\s*位?|学科专业|专\s*业\s*名\s*称|研究方向|指\s*导\s*教\s*师|导\s*师|所\s*在\s*学\s*院|学\s*位\s*授\s*予\s*单\s*位|授\s*予\s*学\s*位\s*单\s*位|授予单位|论\s*文\s*提\s*交\s*日\s*期|答\s*辩\s*日\s*期|申\s*请\s*学\s*位\s*级\s*别|中图分类号|文献标识码|学\s*号|学\s*校\s*代\s*号|分\s*类\s*号|学\s*位\s*授\s*予\s*日\s*期|答\s*辩\s*委\s*员\s*会|关键词|关\s*键\s*词|Abstract|ABSTRACT|DOI|基金项目|攻读学位期间)/;

  // 抓「标签:值」时，值取到下一个标签或行尾为止
  function fieldVal(text, labelRe) {
    const m = text.match(labelRe);
    if (!m) return '';
    const after = text.slice(m.index + m[0].length);
    const stop = after.search(LABEL_END);
    let v = stop >= 0 ? after.slice(0, stop) : after;
    return v.replace(/^[\s:：,，;；]+/, '').trim();
  }

  function cleanPeople(s) {
    let v = fw(String(s == null ? '' : s));
    v = v.replace(LABEL_END, ' ');
    v = v.replace(/[（(][^)）]*[)）]/g, '')
      .replace(/(教授|副教授|讲师|研究员|高级工程师|高级经济师|工程师|博士生导师|硕士生导师|指导教师|导师|博士|硕士|等)/g, ' ');
    const parts = v.split(/[,，;；、\/|·\s]+/).map(x => x.trim()).filter(Boolean);
    const good = parts.filter(p => /^[一-龥]{2,4}$/.test(p) || /^[A-Z][a-z]{1,15}$/.test(p));
    if (!good.length) return '';
    return good.slice(0, 8).join(' ');
  }

  function pickAuthors(meta, head, F, title, H) {
    let v = cleanPeople(fieldVal(H, /作\s*者\s*姓\s*名\s*[:：]?/));
    if (v) return v;
    v = cleanPeople(fieldVal(H, /作\s*者\s*[:：]/));
    if (v) return v;
    v = cleanPeople(fieldVal(H, /[Aa]uthors?\s*[:：]?/));
    if (v) return v;
    const seg = F.replace(/\.pdf$/i, '').split('_');
    if (seg.length >= 2) { const c = cleanPeople(seg.slice(1).join('_')); if (c && c.length <= 12) return c; }
    // 封面标题下一行
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

  function pickYear(H, W) {
    // 优先封面日期字段
    let m = H.match(/(?:论文提交日期|答辩日期|出版日期|收稿日期|发表时间|完成日期|学位授予日期|授予日期|授予学位日期)[^0-9]{0,20}((?:19|20)\d{2})/);
    if (m) return m[1];
    m = H.match(/(?:©|Copyright)\s*(\d{2}|\d{4})/i);
    if (m) { const v = m[1].length === 2 ? '20' + m[1] : m[1]; if (+v >= 1980) return v; }
    // 退回全文高频年份
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

  function pickType(H, W) {
    // 学位论文特征最强，优先判定，避免被正文里的「期刊」字样带偏
    if (/博士\s*学位论文|博士学位论文|博士论文/.test(H)) return '博士学位论文';
    if (/硕士\s*学位论文|硕士学位论文|硕士论文/.test(H)) return '硕士学位论文';
    for (const r of TYPE_RULES) if (r.re.test(H)) return r.type;
    const head2 = W.slice(0, 20000);
    if (/博士\s*学位论文|硕士学位论文|硕士论文/.test(head2)) return '硕士学位论文';
    for (const r of TYPE_RULES) if (r.re.test(head2)) return r.type;
    return '';
  }

  const SCHOOL_RE = /([一-龥]{2,14}(?:大学|学院|研究院|研究所))/;
  function pickSource(H, W, type) {
    // 校名只认以「大学/学院/研究院」结尾的完整机构名，
    // 这样天然排掉紧随其后的英文标签（如密级标识 Classified Index）
    const ORG = /([一-龥]{2,14}(?:大学|学院|研究院|研究所))/;
    let school = '';
    let mv = fieldVal(H, /学\s*位\s*授\s*予\s*单\s*位\s*[:：]?/) ||
              fieldVal(H, /授\s*予\s*学\s*位\s*单\s*位\s*[:：]?/) ||
              fieldVal(H, /所\s*在\s*学\s*院\s*[:：]?/);
    if (mv) { const om = mv.match(ORG); if (om) school = om[1]; }
    if (!school) {
      const m = H.match(SCHOOL_RE) || W.slice(0, 8000).match(SCHOOL_RE);
      if (m) school = cleanOrg(m[1]);
    }
    let source = '';
    if (/期刊/.test(type || '')) {
      const m = H.match(/([一-龥]{2,20}(?:学报|杂志|期刊))/) || W.slice(0, 6000).match(/([一-龥]{2,20}(?:学报|杂志|期刊))/);
      if (m) source = m[1];
    }
    if (!source) source = school;
    return { source, school };
  }

  function cleanOrg(s) {
    if (!s) return '';
    let v = flatten(s).replace(LABEL_END, ' ');
    v = v.replace(/[,，;；。、\s:：]+$/g, '').trim();
    // 去掉粘连的日期尾巴："华南理工大学 2020 年"
    v = v.replace(/\s*\d{4}\s*年.*$/, '').trim();
    // 去掉尾部残留的英文（"华北电力大学 C l a s s"）
    v = v.replace(/(?:[A-Za-z](?:\s*[A-Za-z])*)+$/, '');
    v = v.replace(/\s+$/,'').trim();
    if (v.length > 20) v = v.slice(0, 20);
    return v.trim();
  }

  function pickMajor(H) {
    let v = cleanOrg(fieldVal(H, /学\s*科\s*专\s*业\s*(?:名\s*称)?\s*[:：]?/));
    if (!v) v = cleanOrg(fieldVal(H, /专\s*业\s*名\s*称\s*[:：]?/));
    if (!v) v = cleanOrg(fieldVal(H, /研\s*究\s*方\s*向\s*[:：]?/));
    if (/学位论?文|专业学位|申请学位|中英文摘要/.test(v)) return '';
    return v;
  }

  function pickSupervisor(H) {
    let v = flatten(fieldVal(H, /指\s*导\s*教\s*师\s*(?:姓\s*名)?\s*[,、]?\s*职\s*称?\s*[:：]?/));
    if (!v) v = flatten(fieldVal(H, /[Ss]upervisor\s*[:：]?/));
    if (!v) return '';
    // 英文导师行后面常跟着单位名，遇到就截断
    v = v.replace(/\b(?:University|College|Institute|Huazhong|Nanjing|Beijing|Wuhan)\b.*$/i, '');
    v = v.replace(/\b(?:Prof|Dr|Mr|Ms|PhD|MD)\b\.?\s*/gi, ' ');
    return v.replace(/[（(][^)）]*[)）]/g, ' ')
      .replace(/(教授|副教授|讲师|研究员|高级工程师|高级经济师|工程师|博士生导师|硕士生导师|博士|硕士|等)/g, ' ')
      .replace(/[,，;；、\/\s]+/g, ' ')
      .trim().slice(0, 40);
  }

  function pickKeywords(H, W) {
    let v = cleanKw(fieldVal(H, /关\s*键\s*词\s*[:：]?/));
    if (!v) v = cleanKw(fieldVal(H, /[Kk]ey\s*[wW]ords?\s*[:：]?/));
    if (!v) v = cleanKw(fieldVal(W, /关\s*键\s*词\s*[:：]/));
    return v;
  }

  function cleanKw(s) {
    if (!s) return '';
    let v = flatten(s);
    v = v.replace(/[（(][^)）]*[)）]/g, '');
    v = v.replace(/^(关键词|key\s*words?)\s*[:：]?\s*/i, '');
    // 中文关键词常用「；」分隔；取第一段
    const idx = v.search(/[;；]/);
    if (idx > 0) v = v.slice(0, idx);
    // 去掉尾部残留的标点与序号（"工程管理 0 0"）
    v = v.replace(/[。．.、\s]+$/, '').trim();
    v = v.replace(/\s*\d+(\s+\d+)*$/, '').trim();
    return v.replace(/[。．.、\s]+$/, '').slice(0, 200);
  }


  function pickAbstract(pages) {
    for (let i = 0; i < Math.min(pages.length, 6); i++) {
      const p = flatten(pages[i]);
      const m = p.match(/(?:摘\s*要|\bAbstract\b)\s*[:：]?\s*([\s\S]{60,1500}?)(?=关\s*键\s*词|Key\s*[wW]ords?|\bAbstract\b|Keywords|第[一二三四五六七八九十0-9]+章|1\s*[绪引]\s*[论语]|引\s*言|一、\s*绪论)/i);
      if (m) {
        const v = m[1].replace(/[\s:：,，;；.。、]+$/, '').replace(/\s+/g, ' ').trim();
        if (v.length > 50) return v.slice(0, 1200);
      }
    }
    return '';
  }

  return { parse, cleanTitle, cleanPeople, flatten, squeeze, fw, CATEGORIES };
});
