/**
 * 从译稿/抽取文本识别论文元数据，并可用 Crossref 按 DOI 或英文标题校准。
 * 本模块不写文件；调用方决定哪些字段落库。
 */

const CROSSREF = 'https://api.crossref.org';
const USER_AGENT = 'dsh-literature-library/0.1 (metadata enrichment)';

const first = (value) => (Array.isArray(value) ? value.find(Boolean) : value) ?? null;

export function hasCjk(value) {
  return /[\u3400-\u9fff]/.test(String(value ?? ''));
}

export function normalizeDoi(value) {
  const match = /10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i.exec(String(value ?? ''));
  return match ? match[0].replace(/[.,;:)>\]}]+$/g, '') : null;
}

function plainMarkdown(value) {
  let text = String(value ?? '');
  // Crossref 个别字段会返回一层甚至两层 HTML 实体编码。
  for (let i = 0; i < 2; i += 1) {
    text = text
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&nbsp;/gi, ' ');
  }
  return text
    .replace(/^\s*>\s?/, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanJournalName(value) {
  let text = plainMarkdown(value)
    .replace(/\b(?:doi|https?|ISSN)\s*[:：].*$/i, '')
    .replace(/\s+[·|].*$/, '')
    .trim();
  // `Metrologia 42 (2005)`、`Laser Photonics Rev. 2025, 19`：去掉卷期年份。
  text = text.replace(/\s+(?:19|20)\d{2}\s*[,;(].*$/, '').trim();
  text = text.replace(/\s+\d{1,4}\s*\((?:19|20)\d{2}\).*$/, '').trim();
  text = text.replace(/\s+(?:Vol\.?|Volume)\s*\d+.*$/i, '').trim();
  return text.length >= 2 && text.length <= 180 ? text : null;
}

function cleanAuthors(value) {
  const text = plainMarkdown(value)
    .replace(/\$\^\{[^}]+\}\$/g, '')
    .replace(/\\\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length >= 2 && text.length <= 800 ? text : null;
}

function looksLikeAuthorLine(value, raw = '') {
  const text = cleanAuthors(value);
  if (!text || text.length > 500) return false;
  if (/(?:大学|学院|研究所|实验室|department|university|institute|journal|期刊|单位|摘要)/i.test(text)) return false;
  const latinNames = text.match(/\b[A-Z][A-Za-zÀ-ž.'-]+\s+(?:[A-Z]\.?(?:\s+|$))*[A-Z][A-Za-zÀ-ž.'-]+\b/g) ?? [];
  if (latinNames.length >= 1 && (latinNames.length >= 2 || /^[>*_\s]*[A-Z]/.test(raw))) return true;
  return /^[\u3400-\u9fff]{2,4}(?:\s*[，、]\s*[\u3400-\u9fff]{2,4})*$/.test(text)
    && (/^\s*>/.test(raw) || /[，、]/.test(text));
}

function authorsNearTitle(source, title) {
  if (!title) return null;
  const lines = String(source).split(/\r?\n/).slice(0, 120);
  const titleIndex = lines.findIndex((raw) => {
    const match = /^(?:#|##)\s+(.+)$/.exec(raw.trim());
    return match && plainMarkdown(match[1]) === title;
  });
  if (titleIndex < 0) return null;
  let inspected = 0;
  for (let i = titleIndex + 1; i < lines.length && inspected < 8; i += 1) {
    const raw = lines[i].trim();
    if (!raw || raw === '---') continue;
    inspected += 1;
    const text = plainMarkdown(raw.replace(/^(?:#|##)\s+/, ''));
    if (looksLikeAuthorLine(text, raw)) return cleanAuthors(text);
  }
  return null;
}

function headingCandidates(text) {
  const headings = String(text).split(/\r?\n/).slice(0, 100)
    .map((line) => /^(?:#|##)\s+(.+)$/.exec(line.trim()))
    .filter(Boolean)
    .map((match) => plainMarkdown(match[1]))
    .filter((title) => title.length >= 8 && title.length <= 400
      && !/^(摘要|引言|综述|文章|abstract|introduction|review|you may also like)$/i.test(title));
  // 双栏 PDF 偶尔会把一行英文题名切成相邻两个标题节点；把明显的小写续行拼回去。
  const combined = [];
  for (let i = 0; i < headings.length; i += 1) {
    const left = headings[i];
    if (hasCjk(left) || (left.match(/[A-Za-z]{2,}/g) ?? []).length < 4) continue;
    const right = headings[i + 1];
    const continuesTitle = right
      && !hasCjk(right)
      && /^[a-z]/.test(right)
      && (right.match(/[A-Za-z]{2,}/g) ?? []).length <= 5;
    if (continuesTitle) combined.push(`${left} ${right}`);
  }
  return [...combined, ...headings];
}

function looksLikePaperTitle(value) {
  const title = plainMarkdown(value);
  return title.length >= 8
    && title.length <= 400
    && !/^(?:https?:|library[\\/]|.*\.pdf(?:\s|$))/i.test(title)
    && !/^(?:doi|issn)\s*[:：]/i.test(title)
    && !/^Microsoft\s+(?:Word|PowerPoint)\b/i.test(title)
    && !/^\d+(?:\.\d+)*\.?\s/.test(title);
}

function looksLikeEnglishTitle(value) {
  const title = plainMarkdown(value);
  return looksLikePaperTitle(title)
    && !hasCjk(title)
    && (title.match(/[A-Za-z]{2,}/g) ?? []).length >= 4
    && /^[A-Z0-9]/.test(title)
    && (title.match(/,/g) ?? []).length <= 2
    && !/a\s*r\s*t\s*i\s*c\s*l\s*e\s+i\s*n\s*f\s*o/i.test(title)
    && !/a\s*b\s*s\s*t\s*r\s*a\s*c\s*t/i.test(title)
    && !/partial fulfillment of the requirements/i.test(title);
}

/** 从文档开头提取可验证的本地元数据。 */
export function extractMetadataFromText(text, { fallbackTitle = '', slug = '' } = {}) {
  const source = String(text ?? '').slice(0, 120000);
  const lines = source.split(/\r?\n/).slice(0, 180);
  const result = {
    doi: normalizeDoi(source),
    title: null,
    titleEn: null,
    titleZh: null,
    authors: null,
    journal: null,
    year: null,
    issn: null,
    evidence: [],
  };

  for (const raw of lines) {
    const line = plainMarkdown(raw);
    if (!line) continue;
    let match = /^(?:原文标题|英文标题|original\s+title|原文)\s*[：:]\s*(.+)$/i.exec(line);
    if (!result.titleEn && match && looksLikeEnglishTitle(match[1])) {
      result.titleEn = plainMarkdown(match[1]);
      result.evidence.push('labeled-title');
    }
    match = /^(?:中文标题|译文标题|translated\s+title)\s*[：:]\s*(.+)$/i.exec(line);
    if (!result.titleZh && match && looksLikePaperTitle(match[1])) {
      result.titleZh = plainMarkdown(match[1]);
      result.evidence.push('labeled-title-zh');
    }
    match = /^(?:作者|authors?)\s*[：:]\s*(.+)$/i.exec(line);
    if (!result.authors && match) {
      result.authors = cleanAuthors(match[1]);
      result.evidence.push('labeled-authors');
    }
    match = /^(?:期刊(?:名称)?|刊名|出处|journal|publication)\s*[：:]\s*(.+)$/i.exec(line);
    if (!result.journal && match) {
      result.journal = cleanJournalName(match[1]);
      result.evidence.push('labeled-journal');
    }
    match = /\bISSN\s*[:：]?\s*([0-9]{4}-?[0-9]{3}[0-9Xx])\b/i.exec(line);
    if (!result.issn && match) {
      result.issn = match[1].replace(/^(\d{4})(\d{4})$/, '$1-$2').toUpperCase();
      result.evidence.push('issn');
    }
    match = /^(?:出版(?:日期|年份)?|发表(?:日期|年份)?|published|year)\s*[：:]?\s*((?:19|20)\d{2})/i.exec(line);
    if (!result.year && match) {
      result.year = Number(match[1]);
      result.evidence.push('labeled-year');
    }
  }

  const headings = headingCandidates(source);
  const fallbackNorm = plainMarkdown(fallbackTitle);
  const slugNorm = plainMarkdown(slug);
  const usableHeadings = headings.filter((title) => title !== slugNorm && looksLikePaperTitle(title));
  result.titleZh ??= usableHeadings.find(hasCjk) ?? null;
  result.titleEn ??= usableHeadings.find(looksLikeEnglishTitle) ?? null;
  // 旧调用方仍读取 title。优先英文，确保可以用它查询 Crossref。
  result.title = result.titleEn
    ?? result.titleZh
    ?? headings.find((title) => title !== fallbackNorm && title !== slugNorm)
    ?? headings[0]
    ?? null;
  if (result.title) result.evidence.push('heading-title');
  if (!result.authors) {
    result.authors = authorsNearTitle(source, result.titleZh ?? result.title);
    if (result.authors) result.evidence.push('near-title-authors');
  }

  if (!result.year) {
    const yearSource = source.slice(0, 12000).replace(/<!--[\s\S]*?-->/g, ' ');
    const yearMatch = /\b((?:19|20)\d{2})\b/.exec(yearSource);
    if (yearMatch) result.year = Number(yearMatch[1]);
  }
  if (result.doi) result.evidence.push('doi');
  return result;
}

export function mergeMetadata(...items) {
  const out = {
    doi: null, title: null, titleEn: null, titleZh: null,
    authors: null, journal: null, year: null, issn: null, evidence: [],
  };
  for (const item of items.filter(Boolean)) {
    for (const key of ['doi', 'title', 'titleEn', 'titleZh', 'authors', 'journal', 'year', 'issn']) {
      out[key] ??= item[key] ?? null;
    }
    if (Array.isArray(item.evidence)) out.evidence.push(...item.evidence);
  }
  out.evidence = [...new Set(out.evidence)];
  return out;
}

function crossrefDate(message) {
  for (const key of ['published-print', 'published-online', 'published', 'issued', 'created']) {
    const year = message?.[key]?.['date-parts']?.[0]?.[0];
    if (Number.isInteger(year)) return year;
  }
  return null;
}

export function parseCrossrefMessage(message) {
  if (!message || typeof message !== 'object') return null;
  const authors = Array.isArray(message.author)
    ? message.author.map((a) => [a.given, a.family].filter(Boolean).join(' ')).filter(Boolean).join(', ')
    : null;
  const issn = Array.isArray(message['issn-type'])
    ? (message['issn-type'].find((x) => x.type === 'print')?.value
      ?? message['issn-type'].find((x) => x.type === 'electronic')?.value)
    : first(message.ISSN);
  return {
    doi: normalizeDoi(message.DOI),
    title: plainMarkdown(first(message.title)),
    titleEn: plainMarkdown(first(message.title)),
    titleZh: null,
    authors: authors || null,
    journal: plainMarkdown(first(message['container-title'])),
    journalAbbr: plainMarkdown(first(message['short-container-title'])),
    year: crossrefDate(message),
    issn: issn ?? null,
    publisher: message.publisher ?? null,
    volume: message.volume ?? null,
    issue: message.issue ?? null,
    pages: message.page ?? message['article-number'] ?? null,
    type: message.type ?? null,
    url: message.URL ?? null,
    source: 'crossref',
  };
}

async function crossrefFetch(url, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { accept: 'application/json', 'user-agent': USER_AGENT },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    return payload?.message;
  } finally {
    clearTimeout(timer);
  }
}

export async function lookupCrossrefByDoi(doi, options = {}) {
  const normalized = normalizeDoi(doi);
  if (!normalized) return { ok: false, error: 'DOI 格式无效' };
  try {
    const message = await crossrefFetch(`${CROSSREF}/works/${encodeURIComponent(normalized)}`, options);
    const info = parseCrossrefMessage(message);
    return info ? { ok: true, info } : { ok: false, error: 'Crossref 未返回论文元数据' };
  } catch (error) {
    return { ok: false, error: `Crossref DOI 查询失败：${error?.message ?? error}` };
  }
}

const titleTokens = (value) => new Set(String(value ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? []);
export function titleSimilarity(a, b) {
  const left = titleTokens(a);
  const right = titleTokens(b);
  if (left.size === 0 || right.size === 0) return 0;
  let common = 0;
  for (const token of left) if (right.has(token)) common += 1;
  return (2 * common) / (left.size + right.size);
}

export async function lookupCrossrefByTitle(title, options = {}) {
  const query = plainMarkdown(title);
  if (!query || titleTokens(query).size < 4) return { ok: false, error: '英文标题信息不足' };
  try {
    const url = `${CROSSREF}/works?query.title=${encodeURIComponent(query)}&rows=5`;
    const message = await crossrefFetch(url, options);
    const ranked = (message?.items ?? []).map((item) => ({
      item,
      score: titleSimilarity(query, first(item.title)),
    })).sort((a, b) => b.score - a.score);
    if (!ranked[0] || ranked[0].score < 0.72) {
      return { ok: false, error: 'Crossref 没有足够可信的标题匹配', candidates: ranked.slice(0, 3).map((x) => ({ title: first(x.item.title), score: x.score })) };
    }
    return { ok: true, info: parseCrossrefMessage(ranked[0].item), titleScore: ranked[0].score };
  } catch (error) {
    return { ok: false, error: `Crossref 标题查询失败：${error?.message ?? error}` };
  }
}
