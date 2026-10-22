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

export const PIPELINE_VERSION = 'cost-quality-v3';
export const DEFAULT_CHUNK_TOKENS = 6000;
/**
 * 分块时，遇到章节标题最多提前多少比例收尾。
 *
 * 取值太低会让每块只装到一半（旧版 0.55 的实测平均值只有 3916/6000 token），
 * 系统提示词就要跟着多付一遍；0.85 仍保证标题不会落在块尾被截断。
 */
const STRUCTURAL_FLUSH_RATIO = 0.85;

const PLACEHOLDER_RE = /@@DSH_(?:FORMULA|URL|DOI|CITATION)_\d{6}@@/gu;
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

const REFERENCE_HEADING_WORD = /(?:references|bibliography|literature\s+cited|参考文献)/giu;
/** 参考文献条目编号：[12] / 12. / 12（RSC 等只用数字，后接大写作者名） */
const REFERENCE_ENTRY_MARK = /\[\d{1,3}\]|\n[ \t]*\d{1,3}[.)]?[ \t]+(?=[A-Z\u3400-\u9FFF])/gu;
const YEAR_RE = /\b(?:1[89]\d{2}|20\d{2})\b/u;

/** 一段文本里有多少「像参考文献条目」的编号标记，以及其中带年份的比例。 */
function referenceSignals(value) {
  const text = String(value ?? '');
  const marks = [...text.matchAll(REFERENCE_ENTRY_MARK)];
  let withYear = 0;
  for (const mark of marks) {
    if (YEAR_RE.test(text.slice(mark.index, mark.index + 240))) withYear += 1;
  }
  return { count: marks.length, withYear, ratio: marks.length ? withYear / marks.length : 0 };
}

/** 找「连续递增编号」的参考文献区段（不依赖有没有标题，也容忍少量乱序）。 */
function numberedReferenceStart(value) {
  const text = String(value ?? '');
  const marks = [];
  for (const match of text.matchAll(REFERENCE_ENTRY_MARK)) {
    const number = Number(/\d{1,3}/u.exec(match[0])?.[0] ?? NaN);
    if (Number.isFinite(number)) {
      marks.push({ number, index: match.index, lineStart: match[0].startsWith('\n') });
    }
  }
  if (marks.length < 12) return null;

  let best = null;
  for (let i = 0; i < marks.length; i += 1) {
    const first = marks[i];
    if (first.index < text.length * 0.35 || first.number > 3) continue;
    let last = first;
    let count = 1;
    let lineStarts = first.lineStart ? 1 : 0;
    let withYear = YEAR_RE.test(text.slice(first.index, first.index + 240)) ? 1 : 0;
    for (let j = i + 1; j < marks.length; j += 1) {
      const next = marks[j];
      if (next.index > last.index + 3000) break;
      if (next.number <= last.number) continue;
      if (next.number - last.number > 8) break;
      count += 1;
      if (next.lineStart) lineStarts += 1;
      if (YEAR_RE.test(text.slice(next.index, next.index + 240))) withYear += 1;
      last = next;
    }
    const coverage = last.index / text.length;
    const ratio = withYear / Math.max(1, count);
    if (count < 12 || ratio < 0.5 || coverage < 0.75) continue;
    /*
     * 条目必须是「行首编号」。正文里的 [12] 是嵌在句子中间的，
     * 即便碰巧按 1、2、3 递增也不能当成参考文献（引用密集的综述很容易这样）。
     */
    if (lineStarts / count < 0.25) continue;
    const score = count * ratio;
    if (!best || score > best.score) best = { index: first.index, count, ratio, score };
  }
  return best;
}

/** 文章后半部出现的 references / 参考文献 这个词（可能被双栏抽取挤在句子中间）。 */
function inlineReferenceHeading(value) {
  const text = String(value ?? '');
  let hit = null;
  for (const match of text.matchAll(REFERENCE_HEADING_WORD)) {
    const index = match.index ?? 0;
    if (index < text.length * 0.5) continue;
    const tail = text.slice(index);
    if (tail.length < text.length * 0.03) continue;
    const signals = referenceSignals(tail);
    if (signals.count < 6 || signals.ratio < 0.45) continue;
    hit = { index };
  }
  return hit;
}

/**
 * 独立成行的 References / 参考文献 标题。
 * 标题本身就是很强的信号，因此只要求后面有 3 条以上编号条目。
 */
function standaloneReferenceHeading(value) {
  const text = String(value ?? '');
  const headingRe = /^(?:#{1,4}\s*)?(?:references|bibliography|literature\s+cited|参考文献)\s*$/gimu;
  let hit = null;
  for (const match of text.matchAll(headingRe)) {
    const index = match.index ?? 0;
    if (index < text.length * 0.4) continue;
    const tail = text.slice(index);
    const entryLines = tail.split('\n').filter((line) => /^\s*(?:\[\d+[a-z]?\]|\d+[.)])\s+\S/u.test(line)).length;
    if (entryLines < 3 && referenceSignals(tail).count < 3) continue;
    hit = { index };
  }
  return hit;
}

function lineStartAt(text, index) {
  const at = text.lastIndexOf('\n', index);
  return at < 0 ? 0 : at + 1;
}

function cleanReferenceSection(value) {
  return String(value ?? '')
    // 抽取脚本的章节/版面标记可能被双栏文本挤到行中间，因此不能只匹配整行。
    .replace(/===SEC:REFERENCES===/gu, '\n\n')
    .replace(/===SEC:[A-Z_]+===/gu, '')
    .replace(/===LAYOUT:COLUMNS\s+\d+===/gu, '')
    .replace(/===PAGE\s+\d+===/gu, '')
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
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
  const value = String(text ?? '').replace(/\r\n?/gu, '\n');
  const candidates = [];

  const marker = /===SEC:REFERENCES===/gu;
  for (const match of value.matchAll(marker)) {
    const index = match.index ?? 0;
    if (index < value.length * 0.35) continue;
    candidates.push({ index, reason: 'section-marker' });
    break;
  }

  const numbered = numberedReferenceStart(value);
  if (numbered) candidates.push({ index: numbered.index, reason: 'numbered-list' });

  if (candidates.length === 0) {
    const heading = standaloneReferenceHeading(value);
    if (heading) candidates.push({ index: heading.index, reason: 'standalone-heading' });
  }

  if (candidates.length === 0) {
    const heading = inlineReferenceHeading(value);
    if (heading) candidates.push({ index: heading.index, reason: 'inline-heading' });
  }

  if (candidates.length === 0) return { body: value, references: '', reason: null };
  const chosen = candidates.sort((a, b) => a.index - b.index)[0];
  const cut = lineStartAt(value, chosen.index);
  // 切点太靠前说明判定不可靠：宁可保留原文，也不要吞掉正文。
  if (cut < value.length * 0.3) return { body: value, references: '', reason: null };
  return {
    body: value.slice(0, cut).trimEnd(),
    references: cleanReferenceSection(value.slice(cut)),
    reason: chosen.reason,
  };
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
    const candidates = lines
      .map((line, lineIndex) => ({ line, lineIndex, norm: normalizeLine(line) }))
      .filter((item) => item.norm && !/^===/u.test(item.norm));
    const edge = [...candidates.slice(0, 4), ...candidates.slice(-4)];
    return { raw, lines, edge };
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
  const rebuilt = pages.map((page) => page.lines.filter((line) => {
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
      if (page) return `[原文第 ${page[1]} 页]`;
      const columns = /^===LAYOUT:COLUMNS\s+(\d+)===$/u.exec(trimmed);
      if (columns) return `[本页版面：${columns[1]} 栏]`;
      const section = /^===SEC:([^=]+)===$/u.exec(trimmed);
      if (section) return `[章节：${section[1]}]`;
      return line;
    })
    .join('\n');
}

export function prepareDocument(text) {
  const original = String(text ?? '').replace(/\r\n?/gu, '\n');
  const meta = extractMetadataBlock(original);
  const refs = splitHighConfidenceReferences(meta.text);
  const furniture = removeRepeatedPageFurniture(refs.body);
  const withoutGeneratorComments = furniture.text.replace(
    /^<!--\s*(?:source:|本文件由 extract_pdf\.mjs)[\s\S]*?-->\s*$/gimu,
    '',
  );
  const hinted = layoutHints(withoutGeneratorComments).replace(/\n{3,}/gu, '\n\n').trim();
  const protectedResult = protectTechnicalTokens(hinted);
  return {
    text: protectedResult.text,
    references: refs.references,
    metadata: meta.metadata,
    placeholders: protectedResult.placeholders,
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
  /*
   * 公式占位符缺失分两种情况：
   *   - 长块里缺几个公式：多为双栏抽取留下的碎片，模型按语义忽略它是合理的，
   *     此时只记 warning（否则每块都要多花 2~3 倍 token 升级重译）；
   *   - 短语块里缺公式：说明模型真的漏了内容，仍按错误处理。
   * 引用/DOI/URL 缺失始终是错误——它们缺失通常意味着整段被跳过。
   */
  const formulaTolerant = sourcePlain.length >= 1500;
  let droppedFormulas = 0;
  for (const item of expected) {
    const count = occurrences(output, item.placeholder);
    if (count === 0) {
      if (item.type === 'formula' && formulaTolerant) droppedFormulas += 1;
      else errors.push(`missing-placeholder:${item.placeholder}`);
    } else if (count !== 1) errors.push(`duplicate-placeholder:${item.placeholder}`);
  }
  if (droppedFormulas > 0) warnings.push(`formula-dropped:${droppedFormulas}`);

  const outputPlain = output.replace(PLACEHOLDER_RE, '').replace(/\s+/gu, '');
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
