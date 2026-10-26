/**
 * translation_pipeline.mjs —— 翻译前后的纯函数流水线。
 *
 * 这里不访问网络，也不读写用户文件。host 负责持久化；本模块只负责：
 * - 本地剥离元数据/高置信参考文献；
 * - 保护公式、引用、DOI 与 URL；
 * - 按结构分块并校验译文完整性；
 * - 计算缓存键、闲时时间与预计费用。
 */

import { createHash } from 'node:crypto';
import { splitReferenceSections } from './document_structure.mjs';

export const PIPELINE_VERSION = 'layout-integrity-v6-recovery';
// Revalidate old cache entries under the new policy; unchanged source/prompt keys
// remain reusable. A validation-only relaxation must not force paid retranslations.
export const VALIDATION_VERSION = 'integrity-v9-caption-panels';
export const DEFAULT_CHUNK_TOKENS = 6000;
/**
 * 输出上限相对输入的比例（传给 resolveMaxTokens 的 inputRatio）。
 * 中文译文 token 数通常略少于英文原文，1.65 已留余量；真正需要放大的是
 * 「输出被截断」与「思考吃光预算」，见 nextOutputRatio()。
 */
export const BASE_OUTPUT_RATIO = 1.65;
/** 一块最多因为输出预算不足而放大几次上限 */
export const MAX_BUDGET_RETRIES = 2;

/**
 * 翻译某一块的尝试顺序。
 *
 * 翻译路径**不再主动引入思考**：公式已由占位符保护，思考收益有限，而思考
 * token 与正文共用 max_tokens，长块上很容易把预算吃光、一个正文都不输出
 * （0.6.0 的实盘就是第二档 low 思考用掉一万 token 直接失败）。
 * 现在：同模型重采样一次，再不行才换更贵的 qualityModel，全程保持调用方
 * 指定的 reasoningEffort（默认 none）。
 */
export function buildTranslationAttempts({
  model = 'deepseek-flash',
  qualityModel = 'deepseek-v4-pro',
  reasoningEffort = 'none',
  qualityEscalation = true,
} = {}) {
  if (!qualityEscalation) return [{ model, reasoningEffort }];
  const attempts = [
    { model, reasoningEffort },
    { model, reasoningEffort },
  ];
  if (qualityModel && qualityModel !== model) attempts.push({ model: qualityModel, reasoningEffort });
  return attempts;
}

/**
 * 输出预算不足时的放大系数：1.65 → 3.3 → 6.6。
 * 只放大 inputRatio，max_tokens 的绝对上限仍由 job.maxTokens 兜住。
 */
export function nextOutputRatio(budgetAttempt = 0) {
  const level = Math.max(0, Math.min(MAX_BUDGET_RETRIES, Number(budgetAttempt) || 0));
  return BASE_OUTPUT_RATIO * (2 ** level);
}
/**
 * 分块时，遇到章节标题最多提前多少比例收尾。
 *
 * 取值太低会让每块只装到一半（旧版 0.55 的实测平均值只有 3916/6000 token），
 * 系统提示词就要跟着多付一遍；0.85 仍保证标题不会落在块尾被截断。
 */
const STRUCTURAL_FLUSH_RATIO = 0.85;

const PLACEHOLDER_RE = /@@DSH_(?:FORMULA|URL|DOI|CITATION|BLOCK|OBJECT|CELLTOKEN|VALUE)_\d{6}@@/gu;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

export function estimateTokens(text) {
  const value = String(text ?? '');
  const cjk = (value.match(/[\u3400-\u9FFF\uF900-\uFAFF]/gu) ?? []).length;
  return Math.ceil(cjk * 0.6 + (value.length - cjk) * 0.3);
}

function normalizeLine(value) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim().toLowerCase();
}

function extractMetadataBlock(text) {
  const blocks = [];
  const stripped = String(text ?? '').replace(
    /^===META:BEGIN===\s*$[\s\S]*?^===META:END===\s*$/gmu,
    (block) => {
      blocks.push(block.trim());
      return '';
    },
  );
  return { text: stripped, metadata: blocks.join('\n\n') };
}


/**
 * 剥离参考文献，供翻译前从 API 输入里删除、翻译后原样接回。
 *
 * 旧版只认「整行的 ===SEC:REFERENCES===」和「独立的 References 标题」，
 * 而双栏 PDF 的抽取结果常把标题挤进句子中间、或整节与正文逐行交织，
 * 于是 43 篇语料里有 31 篇的文献表仍被送去翻译（个别综述占输入的 40%）。
 *
 * 现在的判定顺序（越靠前越可信）：
 *   1. 行内 / 整行的 `===SEC:REFERENCES===` 标记（抽取脚本的明确信号）；
 *   2. 连续递增的条目编号（[1] [2] … 或 1. 2. …），且编号密度显著高于正文；
 *   3. 文章后半部出现的 references / 参考文献 一词，其后确有成批带年份的条目。
 */
export function splitHighConfidenceReferences(text) {
  return splitReferenceSections(text);
}

/**
 * 仅清理由至少三页共同拥有、且位于每页首尾附近的短行。
 * 不对正文中的普通重复句做处理，避免误删实验步骤或结论。
 */
export function removeRepeatedPageFurniture(text) {
  const value = String(text ?? '');
  const matches = [...value.matchAll(/^===PAGE\s+\d+===\s*$/gmu)];
  if (matches.length < 3) return { text: value, removedLines: 0 };

  const pages = matches.map((match, index) => {
    const start = match.index ?? 0;
    const end = index + 1 < matches.length ? matches[index + 1].index : value.length;
    const raw = value.slice(start, end);
    const lines = raw.split('\n');
    const protectedLines=new Set();let formula=false;
    lines.forEach((line,i)=>{if(line.includes('<!--DSH_UNCERTAIN_FORMULA-->'))formula=true;if(formula)protectedLines.add(i);if(line.includes('<!--/DSH_UNCERTAIN_FORMULA-->'))formula=false;});
    const candidates = lines
      .map((line, lineIndex) => ({ line, lineIndex, norm: normalizeLine(line) }))
      .filter((item) => item.norm && !/^===/u.test(item.norm)&&!protectedLines.has(item.lineIndex));
    const edge = [...candidates.slice(0, 4), ...candidates.slice(-4)];
    return { raw, lines, edge, protectedLines };
  });

  const seen = new Map();
  pages.forEach((page, pageIndex) => {
    for (const item of page.edge) {
      if (item.norm.length < 6 || item.norm.length > 160) continue;
      if (/^#{1,6}\s/u.test(item.norm) || PLACEHOLDER_RE.test(item.norm)) continue;
      PLACEHOLDER_RE.lastIndex = 0;
      if (!seen.has(item.norm)) seen.set(item.norm, new Set());
      seen.get(item.norm).add(pageIndex);
    }
  });
  const threshold = Math.max(3, Math.ceil(pages.length * 0.35));
  const repeated = new Set([...seen].filter(([, set]) => set.size >= threshold).map(([line]) => line));
  if (!repeated.size) return { text: value, removedLines: 0 };

  let removedLines = 0;
  const rebuilt = pages.map((page) => page.lines.filter((line,index) => {
    if(page.protectedLines.has(index))return true;
    if (!repeated.has(normalizeLine(line))) return true;
    removedLines += 1;
    return false;
  }).join('\n')).join('');
  return { text: rebuilt, removedLines };
}

function replaceMatches(value, regex, type, placeholders, keep = () => true) {
  return value.replace(regex, (match) => {
    if (!keep(match)) return match;
    let sequence = placeholders.length + 1;
    let placeholder = `@@DSH_${type}_${String(sequence).padStart(6, '0')}@@`;
    while (value.includes(placeholder) || placeholders.some((item) => item.placeholder === placeholder)) {
      sequence += 1;
      placeholder = `@@DSH_${type}_${String(sequence).padStart(6, '0')}@@`;
    }
    placeholders.push({ placeholder, type: type.toLowerCase(), value: match });
    return placeholder;
  });
}

/**
 * 判断 `$$...$$` / `\[...\]` 里的内容到底是什么。
 *
 * 双栏 PDF 的抽取结果里混着三类东西，处理方式必须不同：
 *   - math：真公式（含 LaTeX 命令、上下标或足够多的字母数字）→ 换成占位符；
 *   - prose：被误判成公式的正文句子（如 `$$Applying the formal relationship...$$`）
 *     → 去掉定界符，交给模型正常翻译（旧做法会把它原样塞回译文，永远不翻）；
 *   - fragment：`$$=$$`、`$$P =$$` 这类被拆断的方程残片 → 同样去掉定界符，
 *     它没有可译内容，模型自然会忽略，也不会再触发「占位符丢失」。
 */
function formulaBody(raw) {
  const text = String(raw ?? '').trim();
  if (text.startsWith('$$') && text.endsWith('$$')) return text.slice(2, -2).trim();
  if (text.startsWith('$') && text.endsWith('$')) return text.slice(1, -1).trim();
  if (text.startsWith('\\[') && text.endsWith('\\]')) return text.slice(2, -2).trim();
  if (text.startsWith('\\(') && text.endsWith('\\)')) return text.slice(2, -2).trim();
  return text;
}

function classifyFormula(raw) {
  const body = formulaBody(raw);
  if (body === '') return 'fragment';
  // 含 LaTeX 命令的一律按公式处理：命令名本身是英文单词，不能被误判成句子。
  if (body.includes('\\')) return 'math';
  // 带上下标的短公式（$T_0$、$a^2$）也要保护，否则上下标会被抹平。
  if (/[_^]/u.test(body)) return 'math';
  const words = (body.match(/[A-Za-z\u3400-\u9FFF]{2,}/gu) ?? []).length;
  if (words >= 4) return 'prose';
  if (/[\p{L}\p{N}]\s*[=≈≠≤≥]\s*[\p{L}\p{N}]/u.test(body)) return 'math';
  const alnum = (body.match(/[\p{L}\p{N}]/gu) ?? []).length;
  return alnum >= 4 ? 'math' : 'fragment';
}

function replaceFormulas(value, regex, placeholders) {
  return String(value).replace(regex, (match) => {
    const kind = classifyFormula(match);
    if (kind !== 'math') return formulaBody(match).trim();
    let sequence = placeholders.length + 1;
    let placeholder = `@@DSH_FORMULA_${String(sequence).padStart(6, '0')}@@`;
    while (value.includes(placeholder) || placeholders.some((item) => item.placeholder === placeholder)) {
      sequence += 1;
      placeholder = `@@DSH_FORMULA_${String(sequence).padStart(6, '0')}@@`;
    }
    placeholders.push({ placeholder, type: 'formula', value: match });
    return placeholder;
  });
}

/** 用稳定 ASCII 占位符保护模型不应修改的技术内容。 */
export function protectTechnicalTokens(text) {
  let value = String(text ?? '');
  const placeholders = [];
  // Keep the uncertainty notice attached to its candidate. A translator must
  // never remove the warning while retaining a plausible-looking formula.
  value=replaceMatches(value,/<!--DSH_UNCERTAIN_FORMULA-->[\s\S]*?<!--\/DSH_UNCERTAIN_FORMULA-->/gu,'FORMULA',placeholders);

  // 本地公式截图只传短标记，不上传图片，不消耗视觉 token。
  value = replaceMatches(value, /!\[原文(?:公式|图片)[^\]]*\]\([^\n)]+\)/gu, 'FORMULA', placeholders);

  value = replaceMatches(
    value,
    /\\begin\{(equation\*?|align\*?|gather\*?|multline\*?|cases)\}[\s\S]*?\\end\{\1\}/gu,
    'FORMULA', placeholders,
  );
  value = replaceFormulas(value, /\$\$[\s\S]*?\$\$/gu, placeholders);
  value = replaceFormulas(value, /\\\[[\s\S]*?\\\]/gu, placeholders);
  value = replaceFormulas(value, /\\\([\s\S]*?\\\)/gu, placeholders);
  value = replaceFormulas(value, /\$(?!\$)(?:\\.|[^$\n]){1,1200}\$/gu, placeholders);

  // URL 要先于 DOI 处理，否则 URL 内部的 DOI 会被拆成两个占位符。
  value = replaceMatches(value, /https?:\/\/[^\s<>()\[\]{}]+[^\s<>().,;:!?\[\]{}]/giu, 'URL', placeholders);
  value = replaceMatches(value, /\b10\.\d{4,9}\/[A-Z0-9._;()/:+-]+/giu, 'DOI', placeholders);
  value = replaceMatches(
    value,
    /\[(?:\s*\d+[a-z]?(?:\s*[-–—,;]\s*\d+[a-z]?)*\s*)\]/giu,
    'CITATION', placeholders,
  );
  return { text: value, placeholders };
}

export function restoreTechnicalTokens(text, placeholders = []) {
  let value = String(text ?? '');
  for (const item of placeholders) {
    value = value.split(item.placeholder).join(item.value);
  }
  return value;
}

function layoutHints(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      const page = /^===PAGE\s+(\d+)===$/u.exec(trimmed);
      if (page) return '';
      const columns = /^===LAYOUT:COLUMNS\s+(\d+)===$/u.exec(trimmed);
      if (columns) return '';
      const section = /^===SEC:([^=]+)===$/u.exec(trimmed);
      if (section) return '';
      return line;
    })
    .join('\n');
}

export function prepareDocument(text) {
  const original = String(text ?? '').replace(/\r\n?/gu, '\n');
  // Remove tables BEFORE reference detection: a table's "References" column is
  // not a bibliography. Translate cells as separate blocks, reconstruct locally.
  let objects=[];
  const objectSource=original.replace(/===((?:TABLE|CAPTION)):BEGIN===\n([\s\S]*?)\n===\1:END===/gu,(_,kind,content)=>{
    const id=`@@DSH_OBJECT_${String(objects.length+1).padStart(6,'0')}@@`;
    const rows=kind==='TABLE'?content.trim().split('\n').filter((_,i)=>i!==1).map(l=>l.trim().replace(/^\||\|$/gu,'').split('|').map(s=>s.trim())):[[content.trim()]];
    if(!rows.length||!rows[0].length||rows.some(r=>r.length!==rows[0].length))throw new Error('表格行列结构不完整，停止翻译');
    objects.push({id,kind,rows,original:content.trim()});return `\n\n${id}\n\n`;
  });
  const meta = extractMetadataBlock(objectSource);
  const refs = splitHighConfidenceReferences(meta.text);
  // Captions after the bibliography belong to the locally retained reference
  // appendix. They must not leak internal anchors or be sent back for translation.
  for(const o of objects){
    const literal=o.kind==='TABLE'?o.original:`<figcaption>${o.original.replace(/&/gu,'&amp;').replace(/</gu,'&lt;').replace(/>/gu,'&gt;')}</figcaption>`;
    refs.references=refs.references.split(o.id).join(literal);
    for(const section of refs.sections)section.raw=section.raw.split(o.id).join(literal);
  }
  // Retain bibliography intervals at their original anchors. An appendix after
  // them remains translatable; references are restored locally, never by a model.
  let referenceBody='',referenceAt=0;
  refs.sections.forEach((section,index)=>{
    section.placeholder=`@@DSH_REFERENCE_${String(index+1).padStart(6,'0')}@@`;
    referenceBody+=meta.text.slice(referenceAt,section.start)+`\n\n${section.placeholder}\n\n`;
    referenceAt=section.end;
  });
  if(refs.sections.length)refs.body=referenceBody+meta.text.slice(referenceAt);
  objects=objects.filter(o=>refs.body.includes(o.id));
  const furniture = removeRepeatedPageFurniture(refs.body);
  const withoutGeneratorComments = furniture.text.replace(
    /^<!--\s*(?:source:|本文件由 extract_pdf\.mjs)[\s\S]*?-->\s*$/gimu,
    '',
  );
  const firstPageAt = withoutGeneratorComments.search(/^===PAGE\s+\d+===$/mu);
  const cleanFront = meta.metadata && firstPageAt >= 0
    ? withoutGeneratorComments.slice(0, firstPageAt).replace(/^>[^\n]*$/gmu, '') + withoutGeneratorComments.slice(firstPageAt)
    : withoutGeneratorComments;
  const hinted = layoutHints(cleanFront).replace(/\n{3,}/gu, '\n\n').trim();
  const protectedResult = protectTechnicalTokens(hinted);
  for(const section of refs.sections)protectedResult.placeholders.push({placeholder:section.placeholder,type:'reference',value:''});
  for(const o of objects)protectedResult.placeholders.push({placeholder:o.id,type:'object',value:''});
  const units = protectedResult.text.split(/\n{2,}/u).filter((unit) => unit.trim());
  const cellMap=new Map();
  for(const o of objects){
    o.cells=o.rows.map(row=>row.map(cell=>{
      if(!cell)return null;
      const protectedCell=protectTechnicalTokens(cell);
      // Rebase local token ids so they cannot collide with body or other cells.
      let value=protectedCell.text;
      for(const token of protectedCell.placeholders){
        const id=`@@DSH_CELLTOKEN_${String(protectedResult.placeholders.length+1).padStart(6,'0')}@@`;
        value=value.split(token.placeholder).join(id);protectedResult.placeholders.push({...token,placeholder:id});
      }
      value=replaceMatches(value,/(?<![\w@])\d+(?:[.,]\d+)*(?:\s*[–−-]\s*\d+(?:\.\d+)?)?(?![\w@])/gu,'VALUE',protectedResult.placeholders);
      const index=units.length;units.push(value);cellMap.set(index,{object:o.id});return index;
    }));
  }
  const structured = units.map((unit, index) => {
    const placeholder = `@@DSH_BLOCK_${String(index + 1).padStart(6, '0')}@@`;
    protectedResult.placeholders.push({ placeholder, type: 'block', value: '',
      heading: /^#{1,6}\s/u.test(unit), source: unit, cell:cellMap.get(index) });
    return `${placeholder}\n${unit}`;
  }).join('\n\n');
  return {
    text: structured,
    references: refs.references,
    referenceSections: refs.sections,
    metadata: meta.metadata,
    placeholders: protectedResult.placeholders,
    objects,
    stats: {
      originalChars: original.length,
      translatableChars: protectedResult.text.length,
      referenceChars: refs.references.length,
      metadataChars: meta.metadata.length,
      protectedItems: protectedResult.placeholders.length,
      removedFurnitureLines: furniture.removedLines,
      referenceReason: refs.reason,
    },
  };
}

/** Called only after every chunk has passed integrity validation. */
export function restoreDocument(parts,prepared){
 const restoreReferences=text=>{
  for(const section of prepared.referenceSections||[])text=text.split(section.placeholder).join(section.raw);
  return text;
 };
 if(!prepared.objects?.length)return parts.map(p=>restoreTechnicalTokens(restoreReferences(p),prepared.placeholders).trim());
 const joined=parts.join('\n\n'), blocks=translationBlocks(joined), translated=new Map(), body=[];
 for(const b of blocks){
   const meta=prepared.placeholders.find(p=>p.placeholder===b.marker);
   const clean=restoreTechnicalTokens(b.body,prepared.placeholders).trim();
   if(meta?.cell)translated.set(Number(b.marker.match(/(\d{6})@@$/u)[1])-1,clean);
   else body.push(b.source);
 }
 let result=body.join('\n\n');
 for(const o of prepared.objects){
   if(!result.includes(o.id))throw new Error('缺少图表定位标记，停止写入');
   const rows=o.cells.map(row=>row.map(index=>{
     if(index===null)return '';
     if(!translated.has(index))throw new Error('缺少表格单元格译文，停止写入');
     return translated.get(index).replace(/\r?\n/gu,' ').replace(/\|/gu,'&#124;');
   }));
   const value=o.kind==='TABLE'?rows.map((r,i)=>`| ${r.join(' | ')} |${i===0?'\n| '+r.map(()=>'---').join(' | ')+' |':''}`).join('\n')
     :`<figcaption>${rows[0][0].replace(/&/gu,'&amp;').replace(/</gu,'&lt;').replace(/>/gu,'&gt;')}</figcaption>`;
   result=result.replace(o.id,()=>value);
 }
 const restored=restoreTechnicalTokens(restoreReferences(result),prepared.placeholders).trim();
 if(prepared.placeholders.some(p=>restored.includes(p.placeholder)))throw new Error('图表技术标记未完整还原，停止写入');
 return [restored];
}

function splitOversizeUnit(unit, maxTokens) {
  const sentences = String(unit).split(/(?<=[。！？；.!?;])\s+/u).filter(Boolean);
  if (sentences.length <= 1) {
    const words = String(unit).split(/(\s+)/u);
    const out = [];
    let buffer = '';
    for (const word of words) {
      if (buffer && estimateTokens(buffer + word) > maxTokens) {
        out.push(buffer);
        buffer = '';
      }
      buffer += word;
    }
    if (buffer) out.push(buffer);
    const hardLimit = Math.max(1200, Math.floor(maxTokens / 0.3));
    return out.flatMap((part) => {
      if (estimateTokens(part) <= maxTokens) return [part];
      const pieces = [];
      for (let start = 0; start < part.length; start += hardLimit) {
        pieces.push(part.slice(start, start + hardLimit));
      }
      return pieces;
    });
  }
  const out = [];
  let buffer = '';
  for (const sentence of sentences) {
    if (buffer && estimateTokens(`${buffer} ${sentence}`) > maxTokens) {
      out.push(buffer);
      buffer = '';
    }
    buffer += `${buffer ? ' ' : ''}${sentence}`;
  }
  if (buffer) out.push(buffer);
  return out.flatMap((part) => (
    estimateTokens(part) > maxTokens ? splitOversizeUnit(part.replace(/\s+/gu, ' '), maxTokens) : [part]
  ));
}

/** 按章节/标题/段落边界切分，公式占位符与 Markdown 表格不会被逐字符截断。 */
export function chunkStructured(text, maxTokens = DEFAULT_CHUNK_TOKENS) {
  const value = String(text ?? '').replace(/\r\n?/gu, '\n').trim();
  if (!value) return [];
  const limit = Math.max(500, Number(maxTokens) || DEFAULT_CHUNK_TOKENS);
  const units = value.split(/\n{2,}/u).flatMap((unit) => (
    estimateTokens(unit) > limit ? splitOversizeUnit(unit, limit) : [unit]
  ));
  const chunks = [];
  let buffer = [];
  let tokens = 0;
  const flush = () => {
    if (buffer.length) chunks.push(buffer.join('\n\n').trim());
    buffer = [];
    tokens = 0;
  };

  for (const unit of units) {
    const unitTokens = estimateTokens(unit);
    const structuralBoundary = /^(?:#{1,6}\s|\[章节：)/u.test(unit.trim());
    if (structuralBoundary && tokens >= limit * STRUCTURAL_FLUSH_RATIO) flush();
    if (buffer.length && tokens + unitTokens > limit) flush();
    buffer.push(unit);
    tokens += unitTokens;
  }
  flush();
  return chunks.filter(Boolean);
}

function occurrences(text, needle) {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  while ((from = text.indexOf(needle, from)) >= 0) {
    count += 1;
    from += needle.length;
  }
  return count;
}

/**
 * 修掉「同一个占位符被模型重复输出」的情况：只保留前 N 个（N = 原文出现次数）。
 *
 * 模型偶尔会在句末把引用标记再抄一遍。旧逻辑会把它判成 duplicate-placeholder，
 * 进而整块升级重译（第三次还是 Pro + high 思考），为了一个多余的 `[12]`
 * 花掉整块的 2~3 倍费用。这里先做确定性修复，修不了再升级。
 */
export function repairDuplicatePlaceholders(source, translation, placeholders = []) {
  const input = String(source ?? '');
  let value = String(translation ?? '');
  const repairs = [];
  const expected = placeholders.length
    ? placeholders.filter((item) => input.includes(item.placeholder))
    : [...new Set(input.match(PLACEHOLDER_RE) ?? [])].map((placeholder) => ({ placeholder }));
  for (const item of expected) {
    // 段落/公式重复可能意味着正文重复或移位，不能靠删标记伪装成校验通过。
    if (!item.placeholder.startsWith('@@DSH_CITATION_')) continue;
    const want = occurrences(input, item.placeholder);
    if (want < 1) continue;
    const got = occurrences(value, item.placeholder);
    if (got <= want) continue;
    let seen = 0;
    let out = '';
    let from = 0;
    let at = value.indexOf(item.placeholder, from);
    while (at >= 0) {
      seen += 1;
      out += value.slice(from, at);
      if (seen <= want) out += item.placeholder;
      from = at + item.placeholder.length;
      at = value.indexOf(item.placeholder, from);
    }
    out += value.slice(from);
    value = out;
    repairs.push({ placeholder: item.placeholder, removed: got - want });
  }
  return { text: value, repairs };
}

/** 仅修复可证明等价的标记格式或原样技术内容，不猜测丢失的引文/公式。 */
export function repairEquivalentPlaceholders(source, translation, placeholders = []) {
  const input = String(source ?? '');
  let text = String(translation ?? '');
  const repairs = [];
  const expected = placeholders.filter((p) => input.includes(p.placeholder));
  const allowed = new Set(expected.map((p) => p.placeholder));
  text = text.replace(/[@＠]{2}\s*DSH\s*[_＿]\s*(FORMULA|CITATION|URL|DOI|BLOCK|OBJECT|CELLTOKEN|VALUE)\s*[_＿]\s*(\d{1,6})\s*[@＠]{2}/giu,
    (raw, type, id) => {
      const canonical = `@@DSH_${type.toUpperCase()}_${id.padStart(6, '0')}@@`;
      if (!allowed.has(canonical)) return raw;
      if (canonical !== raw) repairs.push({ placeholder: canonical, kind: 'format' });
      return canonical;
    });
  const values = new Map();
  for (const item of expected) {
    if (item.type === 'block' || !item.value) continue;
    const count = values.get(item.value) ?? 0;
    values.set(item.value, count + 1);
  }
  for (const item of expected) {
    if (!item.value || item.type === 'block' || text.includes(item.placeholder)) continue;
    if (values.get(item.value) !== 1 || occurrences(text, item.value) !== 1) continue;
    text = text.replace(item.value, () => item.placeholder);
    repairs.push({ placeholder: item.placeholder, kind: 'literal' });
  }
  return { text, repairs };
}

/** 仅按程序产生的边界切块；边界缺失时不能按译文段落数猜测对应关系。 */
export function translationBlocks(source) {
  const input = String(source ?? '');
  const matches = [...input.matchAll(/@@DSH_BLOCK_\d{6}@@/gu)];
  if (!matches.length) return [{ marker: '', body: input.trim(), source: input.trim() }];
  const out = [];
  if (input.slice(0, matches[0].index).trim()) out.push({ marker: '', body: input.slice(0, matches[0].index).trim(), source: input.slice(0, matches[0].index).trim() });
  matches.forEach((match, index) => {
    const end = matches[index + 1]?.index ?? input.length;
    const body = input.slice(match.index + match[0].length, end).trim();
    out.push({ marker: match[0], body, source: `${match[0]}\n${body}` });
  });
  return out;
}

/** 大块完整性失败后的段落恢复。边界由程序重建，只重译损坏段落。 */
export async function recoverStructuredTranslation({ source, translation, placeholders = [], translateBlock, onAccepted, onProgress }) {
  const blocks = translationBlocks(source);
  const originalBlocks = translationBlocks(translation);
  const originalMarkers = originalBlocks.map((b) => b.marker).filter(Boolean);
  const expectedMarkers = blocks.map((b) => b.marker).filter(Boolean);
  const aligned = JSON.stringify(originalMarkers) === JSON.stringify(expectedMarkers)
    && originalBlocks.length === blocks.length;
  const output = [];
  let reusedBlocks = 0, translatedBlocks = 0;
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    const frame = (text) => `${block.marker}${block.marker ? '\n' : ''}${text.trim()}`;
    let candidate = aligned ? originalBlocks[index]?.body ?? '' : '';
    const normalize = (value) => {
      let text = String(value ?? '').replace(/@@DSH_BLOCK_\d{6}@@/gu, '').trim();
      const heading = /^(#{1,6})\s/u.exec(block.body)?.[1];
      if (heading && text && !/^#{1,6}\s/u.test(text)) text = `${heading} ${text}`;
      const repaired = repairEquivalentPlaceholders(block.source, frame(text), placeholders);
      return repairDuplicatePlaceholders(block.source, repaired.text, placeholders).text;
    };
    let framed = normalize(candidate);
    let validation = validateTranslation(block.source, framed, placeholders);
    const onlyTechnical = block.body.replace(PLACEHOLDER_RE, '').replace(/[\s*#>|-]/gu, '') === '';
    if (onlyTechnical) {
      framed = block.source; validation = { ok: true, errors: [], warnings: [] };
    } else if (validation.ok && aligned) reusedBlocks += 1;
    else {
      onProgress?.({ index: index + 1, total: blocks.length });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = await translateBlock({ ...block, index, total: blocks.length, attempt });
        framed = normalize(result?.text ?? result);
        validation = validateTranslation(block.source, framed, placeholders, { truncated: result?.truncated === true });
        translatedBlocks += 1;
        if (validation.ok) break;
      }
      if (!validation.ok) throw Object.assign(new Error(`第 ${index + 1} 段恢复未通过：${validation.errors.join(', ')}`), {
        validation, failureContext: { source: block.source, translation: framed, paragraphIndex: index + 1 },
      });
      await onAccepted?.({ ...block, text: framed });
    }
    output.push(framed);
  }
  const text = output.join('\n\n');
  const validation = validateTranslation(source, text, placeholders);
  return { text, validation, reusedBlocks, translatedBlocks };
}

/** Only atomic inline symbols may move with Chinese word order. Display math,
 * formula crops and inline equations/inequalities remain ordered hard anchors.
 */
function isInlineVariable(item) {
  if (item.type !== 'formula' || !item.value) return false;
  const raw = item.value.trim();
  if (!(raw.startsWith('$') && !raw.startsWith('$$') || raw.startsWith('\\('))) return false;
  return /^(?:\\[A-Za-z]+|[\p{L}])[\p{L}\p{N}]*(?:(?:[_^]\{[\p{L}\p{N}]+\}|[_^][\p{L}\p{N}])[\p{L}\p{N}]*)*$/u.test(formulaBody(raw));
}

function tokenContexts(text, expected, hardAnchors) {
  const allowed = new Set(expected.map(i => i.placeholder));
  const result = new Map();
  let block = 'prefix', anchor = 'start';
  for (const match of text.matchAll(PLACEHOLDER_RE)) {
    const id = match[0];
    if (!allowed.has(id)) continue;
    if (id.startsWith('@@DSH_BLOCK_')) { block = id; anchor = 'start'; }
    else if (hardAnchors.has(id)) anchor = id;
    else result.set(id, `${block}/${anchor}`);
  }
  return result;
}

/** 返回 errors（必须重译）与 warnings（记录但不阻断）。 */
export function validateTranslation(source, translation, placeholders = [], options = {}) {
  const input = String(source ?? '');
  const output = String(translation ?? '');
  const errors = [];
  const warnings = [];
  if (!output.trim()) errors.push('empty-output');
  if (options.truncated === true) errors.push('truncated');

  const expected = placeholders.length
    ? placeholders.filter((item) => input.includes(item.placeholder))
    : [...new Set(input.match(PLACEHOLDER_RE) ?? [])].map((placeholder) => ({ placeholder }));
  const sourcePlain = input.replace(PLACEHOLDER_RE, '').replace(/\s+/gu, '');
  // 不论正文长短，受保护的公式和结构标记都必须完整。
  for (const item of expected) {
    const count = occurrences(output, item.placeholder);
    if (count === 0) {
      errors.push(`missing-placeholder:${item.placeholder}`);
    } else if (count !== 1) errors.push(`duplicate-placeholder:${item.placeholder}`);
  }
  for (const placeholder of new Set(output.match(PLACEHOLDER_RE) ?? [])) {
    if (!input.includes(placeholder)) errors.push(`unexpected-placeholder:${placeholder}`);
  }

  // A caption may naturally say "at 6 rpm, illuminate 100 LEDs" in Chinese.
  // Permit value order only inside the SAME explicitly labeled caption panel;
  // counts, panel ownership and paragraph boundaries remain strict.
  const captionPanel=(text,id)=>{
    const at=text.indexOf(id);if(at<0)return null;
    const prefix=text.slice(0,at),anchor=[...prefix.matchAll(/@@DSH_BLOCK_\d{6}@@/gu)].at(-1);
    const body=prefix.slice(anchor?anchor.index+anchor[0].length:0);
    if(!/^\s*(?:FIGURE|Figure|图)\s/u.test(body))return null;
    const panel=[...body.matchAll(/(?:^|[.。；;]\s*)[（(]([a-l](?:\s*[,，–-]\s*[a-l])*)[)）]/gu)].at(-1);
    return panel?`${anchor?.[0]||'single'}/${panel[1].replace(/\s/gu,'').replaceAll('，',',')}`:null;
  };
  const flexibleValues=new Set();
  for(const item of expected.filter(i=>i.type==='value')){
    const before=captionPanel(input,item.placeholder),after=captionPanel(output,item.placeholder);
    if(before&&before===after)flexibleValues.add(item.placeholder);
    else if(before&&output.includes(item.placeholder))errors.push(`caption-value-moved:${item.placeholder}`);
  }
  const ordered = expected.filter((item) => item.type === 'block' || ['object','value','reference'].includes(item.type) && !flexibleValues.has(item.placeholder) || item.type === 'formula' && !isInlineVariable(item))
    .sort((a, b) => input.indexOf(a.placeholder) - input.indexOf(b.placeholder));
  let previousPosition = -1;
  for (const item of ordered) {
    const position = output.indexOf(item.placeholder);
    if (position >= 0 && position < previousPosition) errors.push(`structure-reordered:${item.placeholder}`);
    if (position >= 0) previousPosition = position;
    if (item.type === 'block' && item.heading && position >= 0) {
      const headingText = output.slice(position + item.placeholder.length).split(/@@DSH_BLOCK_\d{6}@@/u)[0].trim();
      if (!/^#{1,6}\s+\S/u.test(headingText)) errors.push(`heading-lost:${item.placeholder}`);
    }
  }
  const hardAnchors = new Set(ordered.filter(i => i.type === 'formula').map(i => i.placeholder));
  const sourceContexts = tokenContexts(input, expected, hardAnchors);
  const outputContexts = tokenContexts(output, expected, hardAnchors);
  const cellBlocks=new Set(placeholders.filter(p=>p.cell).map(p=>p.placeholder));
  const sourceCells=tokenContexts(input,expected,new Set()), outputCells=tokenContexts(output,expected,new Set());
  for(const item of expected.filter(p=>p.type!=='block')){
    const a=sourceCells.get(item.placeholder), b=outputCells.get(item.placeholder);
    if(a&&(cellBlocks.has(a.split('/')[0])||item.type==='object')&&a!==b&&output.includes(item.placeholder))errors.push(`table-cell-token-moved:${item.placeholder}`);
  }
  const inline = expected.filter(isInlineVariable);
  for (const item of inline) {
    if (output.includes(item.placeholder) && sourceContexts.get(item.placeholder) !== outputContexts.get(item.placeholder)) {
      errors.push(`inline-variable-moved:${item.placeholder}`);
    }
  }
  const inlineIds = new Set(inline.map(i => i.placeholder));
  const inlineOrder = (text) => [...text.matchAll(PLACEHOLDER_RE)].map(m => m[0]).filter(id => inlineIds.has(id)).join(',');
  if (inline.length > 1 && inlineOrder(input) !== inlineOrder(output) && !errors.length) warnings.push('inline-variable-reordered-within-paragraph');
  if (/\[章节：|===SEC:|\[原文第 \d+ 页\]|\[本页版面：/u.test(output)) errors.push('internal-layout-marker-leaked');

  const outputPlain = output.replace(PLACEHOLDER_RE, '').replace(/\s+/gu, '');
  if (sourcePlain.length > 0 && outputPlain.length === 0) errors.push('empty-paragraph');
  if (sourcePlain.length > 300) {
    const ratio = outputPlain.length / sourcePlain.length;
    if (ratio < 0.12) errors.push(`output-too-short:${ratio.toFixed(2)}`);
    if (ratio > 4) warnings.push(`output-too-long:${ratio.toFixed(2)}`);
  }

  const latin = (sourcePlain.match(/[A-Za-z]/gu) ?? []).length;
  const cjk = (outputPlain.match(/[\u3400-\u9FFF\uF900-\uFAFF]/gu) ?? []).length;
  if (latin > 500 && cjk < Math.max(20, Math.floor(latin * 0.01))) errors.push('mostly-untranslated');

  const sourceHeadings = (input.match(/^#{1,6}\s+.+$/gmu) ?? []).length;
  const outputHeadings = (output.match(/^#{1,6}\s+.+$/gmu) ?? []).length;
  if (sourceHeadings >= 2 && outputHeadings === 0) warnings.push('headings-lost');

  const paragraphs = output.split(/\n{2,}/u).map((p) => normalizeLine(p)).filter((p) => p.length > 120);
  const unique = new Set(paragraphs);
  if (paragraphs.length >= 3 && unique.size < paragraphs.length) warnings.push('duplicate-paragraph');

  return { ok: errors.length === 0, errors, warnings };
}

export function chunkCacheKey({
  source,
  promptVersion = PIPELINE_VERSION,
  model,
  reasoningEffort = 'none',
  glossaryVersion = '',
} = {}) {
  return createHash('sha256').update(JSON.stringify({
    source: String(source ?? ''),
    promptVersion: String(promptVersion ?? ''),
    model: String(model ?? ''),
    reasoningEffort: String(reasoningEffort ?? ''),
    glossaryVersion: String(glossaryVersion ?? ''),
  })).digest('hex');
}

export function isPeakShanghai(at = new Date()) {
  const date = at instanceof Date ? at : new Date(at);
  const shifted = new Date(date.getTime() + SHANGHAI_OFFSET_MS);
  const day = shifted.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = shifted.getUTCHours() + shifted.getUTCMinutes() / 60 + shifted.getUTCSeconds() / 3600;
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
}

export function nextOffpeakTime(at = new Date()) {
  const date = at instanceof Date ? new Date(at.getTime()) : new Date(at);
  if (!isPeakShanghai(date)) return date;
  const shifted = new Date(date.getTime() + SHANGHAI_OFFSET_MS);
  const hour = shifted.getUTCHours();
  const boundaryHour = hour < 12 ? 12 : 18;
  const boundaryShifted = Date.UTC(
    shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(), boundaryHour, 0, 0, 0,
  );
  return new Date(boundaryShifted - SHANGHAI_OFFSET_MS);
}

export function normalizeUsage(usage = {}) {
  const inputTokens = Number(usage.inputTokens ?? usage.input_tokens ?? 0) || 0;
  const outputTokens = Number(usage.outputTokens ?? usage.output_tokens ?? 0) || 0;
  const cacheHitTokens = Number(
    usage.cacheHitTokens ?? usage.prompt_cache_hit_tokens ?? usage.cache_read_input_tokens ?? 0,
  ) || 0;
  const explicitMiss = usage.cacheMissTokens ?? usage.prompt_cache_miss_tokens;
  const cacheMissTokens = explicitMiss == null
    ? Math.max(0, inputTokens - cacheHitTokens)
    : (Number(explicitMiss) || 0);
  const reasoningTokens = Number(
    usage.reasoningTokens ?? usage.reasoning_tokens ?? usage.output_tokens_details?.reasoning_tokens ?? 0,
  ) || 0;
  return { inputTokens, outputTokens, cacheHitTokens, cacheMissTokens, reasoningTokens };
}

/** outputTokens 已含 reasoningTokens，费用计算不能再次把 reasoning 加一遍。 */
export function estimateCostCny(usage, { model = 'deepseek-flash', offpeak, at = new Date() } = {}) {
  const normalized = normalizeUsage(usage);
  const isPro = /(?:v4-?pro|pro)/iu.test(String(model));
  const rates = isPro
    ? { hit: 0.15, miss: 4.5, output: 13.5 }
    : { hit: 0.02, miss: 1, output: 4 };
  const multiplier = (offpeak ?? !isPeakShanghai(at)) ? 1 : 2;
  return multiplier * (
    normalized.cacheHitTokens * rates.hit
    + normalized.cacheMissTokens * rates.miss
    + normalized.outputTokens * rates.output
  ) / 1_000_000;
}

export function summarizeUsages(usages = [], model = 'deepseek-flash') {
  const total = {
    inputTokens: 0,
    outputTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    reasoningTokens: 0,
  };
  let estimatedCostCny = 0;
  for (const entry of usages) {
    const normalized = normalizeUsage(entry);
    for (const key of Object.keys(total)) total[key] += normalized[key];
    estimatedCostCny += estimateCostCny(entry, {
      model: entry?.model ?? model,
      at: entry?.requestedAt ?? entry?.at ?? new Date(),
    });
  }
  return { ...total, estimatedCostCny };
}
