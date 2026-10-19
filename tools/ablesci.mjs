/**
 * ablesci.mjs —— 从科研通（ablesci.com）查询期刊信息，用于自动补全。
 *
 * 为什么可行（实测确认，不是推测）：
 *   - 搜索：`GET /journal/index?keywords=<刊名或ISSN>`，结果里带 `journal/detail?id=<短id>`
 *     （参数名是 `keywords`。试过 keyword/wd/q/name 全部无效，会退化成默认列表）
 *   - 详情：`GET /journal/detail?id=<短id>`，**数据是服务端渲染的**（无 AJAX），
 *     全部信息都在 HTML 表格里。
 *
 * **关键教训（第一版就栽在这里）**：不能把页面所有 `<td>` 拉平成一个数组再取「下一格」。
 * 表格里标签与值**常在同一 `<tr>` 的不同列**，拉平后「下一格」往往是**下一行的标签**，
 * 于是字段全错位（实测：影响因子取空、JCR 分区取成了排名 34/81）。
 * 正确做法是**按 `<tr>` 逐行解析**：在行内找标签，取同行下一格；找不到再看下一行首格。
 *
 * 抓取仅用于补全事实性字段（影响因子、分区、ISSN 等），并在界面上标注来源；
 * 使用者应自行核对，尤其是影响因子逐年变化。
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const BASE = 'https://www.ablesci.com';

/** 请求页面；带超时，避免卡住整个流程 */
async function fetchText(url, { timeoutMs = 20000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: { 'user-agent': UA, accept: 'text/html', 'accept-language': 'zh-CN,zh;q=0.9' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** HTML 片段 → 纯文本 */
function toText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 把表格解析成「行数组」，每行是若干单元格文本。
 * 这是整个提取的基础——见文件头关于「不能拉平」的说明。
 */
function extractRows(html) {
  return [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((tr) => (
    [...tr[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => toText(m[1]))
  )).filter((r) => r.length > 0);
}

/**
 * 在行数组里找值。
 * 策略（按优先级）：
 *   1. 同一行里标签所在格之后的第一格；
 *   2. 标签是整行唯一内容时，取**下一行的第一格**（标签单独占一行的布局）。
 * @param {string[][]} rows
 * @param {RegExp} label - 标签匹配
 * @returns {string|null}
 */
function valueOf(rows, label) {
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const idx = row.findIndex((c) => label.test(c));
    if (idx < 0) continue;
    // 1) 同行右侧
    for (let k = idx + 1; k < row.length; k += 1) {
      if (row[k] !== '') return row[k];
    }
    // 2) 下一行首格（标签单独占一行的情形）
    for (let n = i + 1; n < Math.min(i + 3, rows.length); n += 1) {
      const first = rows[n].find((c) => c !== '');
      if (first) return first;
    }
  }
  return null;
}

/** 找出所有含指定标签的行（用于一对多，如 JCR 分类） */
function rowsMatching(rows, label) {
  return rows.filter((row) => row.some((c) => label.test(c)));
}

/**
 * 搜索期刊，返回候选列表（按结果页顺序）。
 * @returns {Promise<Array<{id:string,name:string}>>}
 */
export async function searchJournals(keywords) {
  const html = await fetchText(`${BASE}/journal/index?keywords=${encodeURIComponent(keywords)}`);
  const out = [];
  const seen = new Set();
  for (const m of html.matchAll(/journal\/detail\?id=([A-Za-z0-9]+)"[^>]*>([\s\S]{0,200}?)<\/a>/g)) {
    const id = m[1];
    const name = toText(m[2]);
    if (!name || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name });
  }
  return out;
}

/** 归一化刊名，用于比较 */
export function normalizeName(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
}

/**
 * 解析详情页 HTML，抽出结构化期刊信息。
 *
 * 各字段的取值位置都对照页面实测确认过：
 *   - 影响因子：标签格形如 `2026最新影响因子 (…) 与上一年的差值`，
 *     同行下一格是 `3.2 ↑ 0.8`（取第一个数字）
 *   - 历年影响因子：同一行混着年份（`2025年 2024年 … 2.4`）与后续格的数字，
 *     所以要**跨格收集纯数字**、并在遇到下一个标签时停止
 *   - WOS/JCR 分区：行形如 `[SCIE, Q2, 34/81, PHYSICS, APPLIED, …]`
 *   - 中科院分区：标签 `中科院2025年分区 （…）`，同行下一格是 `3区 工程技术`
 */
export function parseJournalDetail(html) {
  const rows = extractRows(html);
  const pick = (re) => valueOf(rows, re);

  // 影响因子：从 `3.2 ↑ 0.8` 这类文本里取第一个数字
  const rawIf = pick(/最新影响因子/);
  const ifM = /(\d+(?:\.\d+)?)/.exec(rawIf ?? '');
  const impactFactor = ifM ? Number(ifM[1]) : null;

  // 历年影响因子：找到含「历年影响因子」的行，从该行及后续行的单元格里收集数字
  const history = [];
  const hRows = rowsMatching(rows, /历年影响因子/);
  if (hRows.length) {
    const start = rows.indexOf(hRows[0]);
    for (let i = start; i < rows.length && history.length < 12; i += 1) {
      for (const cell of rows[i]) {
        // 单元格里可能混着「2025年 … 2.4」
        for (const m of cell.matchAll(/(?<![\d.])(\d+\.\d+)(?![\d.])/g)) history.push(Number(m[1]));
      }
      // 遇到下一个明显不同的标签就停
      if (i > start && rows[i].some((c) => /历年发表|被引量|h-index|自引率/.test(c))) break;
    }
  }

  // WOS / JCR：找含 SCIE/SSCI/ESCI 的行，取该行里的 Q几 与学科名
  let jcrQuartile = null;
  let jcrCategory = null;
  let indexedIn = null;
  for (const row of rows) {
    const dbIdx = row.findIndex((c) => /^(SCIE|SSCI|ESCI|AHCI)$/.test(c));
    if (dbIdx < 0) continue;
    indexedIn ??= row[dbIdx];
    // Q几 在同行
    const q = row.find((c) => /^Q[1-4]$/.test(c));
    jcrQuartile ??= q ?? null;
    // 学科名一般是同行里最长的纯大写英文词串
    const cat = row.slice(dbIdx + 1).find((c) => /^[A-Z][A-Z\s,&-]{3,}$/.test(c));
    jcrCategory ??= cat ?? null;
  }

  // 中科院分区：值格内部是**嵌套表格**（表头「大类 / 小类 / TOP期刊 / 综述期刊」），
  // 所以不能靠扁平的行解析，要单独把那个嵌套表拆出来。
  //
  // 结构长这样（实测）：
  //   <tr><td>中科院2025年分区 …</td><td>
  //       <table class="layui-table"><thead><tr>
  //         <th>大类</th><th>小类</th><th>TOP期刊</th><th>综述期刊</th>
  //       </tr></thead><tbody><tr>
  //         <td>3区 工程技术</td><td>…</td><td>否</td><td>否</td>
  //       </tr></tbody></table>
  //   </td></tr>
  function parseCasTable(sourceHtml) {
    // 注意：`<td>` 后面**紧跟**标签文字，中间没有空白——
    // 写成 `>\s*中科院` 会匹配失败（我为此绕了一轮）。
    // 另外用「中科院\d{4}年分区 之后不远处的第一个 <table>」这种宽松定位，
    // 比「标签格+值格」的严格相邻更稳（值格里还嵌着 <a>/<br>/<span>）。
    const marker = /中科院(\d{4})年分区[\s\S]{0,1500}?<table[^>]*>([\s\S]*?)<\/table>/i.exec(sourceHtml);
    if (!marker) return null;
    const year = Number(marker[1]);
    const inner = marker[2];

    const rows = [...inner.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((tr) => (
      [...tr[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => toText(m[1]))
    )).filter((r) => r.some((c) => c !== ''));

    // 去掉表头行（含「大类」），数据行取第一行
    const dataRow = rows.find((r) => !r.some((c) => /^大类$/.test(c)) && r.some((c) => /区/.test(c)));
    if (!dataRow) return null;
    const grade = /^([1-4]区)\s*(.*)$/u.exec(dataRow[0] ?? '');
    const flags = dataRow.slice(2);   // TOP期刊 / 综述期刊
    return {
      year,
      quartile: grade ? grade[1] : null,
      major: grade && grade[2] ? grade[2] : null,
      top: flags[0] === '是' ? true : (flags[0] === '否' ? false : null),
      review: flags[1] === '是' ? true : (flags[1] === '否' ? false : null),
    };
  }

  const cas = parseCasTable(html);
  const casQuartile = cas?.quartile ?? null;
  const casMajor = cas?.major ?? null;
  const isTop = cas?.top ?? null;

  const issnRaw = pick(/^期刊ISSN$/);
  const issnPrint = (/print:\s*([0-9Xx-]+)/.exec(issnRaw ?? '') ?? [])[1] ?? null;
  const issnOnline = (/on-line:\s*([0-9Xx-]+)/.exec(issnRaw ?? '') ?? [])[1] ?? null;

  return {
    name: pick(/^期刊全称$/),
    abbr: pick(/^期刊缩写$/),
    issnPrint,
    issnOnline,
    issn: issnPrint ?? issnOnline ?? null,
    impactFactor,
    impactHistory: [...new Set(history)].slice(0, 10),
    jcrQuartile,
    jcrCategory,
    indexedIn,
    casQuartile,
    casMajor,
    casYear: cas?.year ?? null,
    isTop,
    isReview: cas?.review ?? null,
    selfCiteRate: pick(/^自引率$/),
    hIndex: pick(/^h-index/),
    scope: pick(/^涉及的研究领域$/),
    publisher: pick(/^出版商$/),
    publisherAddress: pick(/^编辑部地址$/),
    country: pick(/^出版国家（地区）$/),
    language: pick(/^出版语言$/),
    frequency: pick(/^出版周期$/),
    foundedYear: pick(/^创刊年份$/),
    articlesPerYear: pick(/^每年出版文章数$/),
    goldOaRatio: pick(/^Gold OA文章占比$/),
    warningList: pick(/^中科院《国际期刊预警名单/),
    sourceUrl: null,
  };
}

/**
 * 按刊名（或 ISSN）查询并返回补全后的期刊信息。
 *
 * 匹配策略：先精确同名（归一化），再「互相包含」，最后才退回第一条。
 * 必须自己校验——ablesci 的搜索是模糊的，实测搜 Metrologia 时后面跟着一堆
 * 无关期刊（Scientific Reports、BMC Cancer…），直接取第一条很容易抓错刊。
 *
 * @param {{name?: string, issn?: string, abbr?: string}} query
 */
export async function lookupJournal(query) {
  // ISSN 唯一性高于刊名；同时给出两者时优先按 ISSN 搜，避免同名/近似刊名误匹配。
  const keywords = (query.issn || query.name || query.abbr || '').trim();
  if (!keywords) return { ok: false, error: '需要刊名或 ISSN' };

  let candidates;
  try {
    candidates = await searchJournals(keywords);
  } catch (err) {
    return { ok: false, error: `搜索失败：${err?.message ?? err}` };
  }
  if (candidates.length === 0) return { ok: false, error: `没有搜到「${keywords}」`, candidates: [] };

  const want = normalizeName(query.name || '');
  let pick = null;
  let matchMethod = 'fallback';
  if (want) {
    pick = candidates.find((c) => normalizeName(c.name) === want) ?? null;
    if (pick) matchMethod = 'exact-name';
    if (!pick) {
      pick = candidates.find((c) => {
        const n = normalizeName(c.name);
        return n.includes(want) || want.includes(n);
      }) ?? null;
      if (pick) matchMethod = 'contains-name';
    }
  }
  const matchedExactly = matchMethod === 'exact-name';
  pick ??= candidates[0];

  let html;
  try {
    html = await fetchText(`${BASE}/journal/detail?id=${encodeURIComponent(pick.id)}`);
  } catch (err) {
    return { ok: false, error: `打开详情页失败：${err?.message ?? err}`, candidates };
  }

  const info = parseJournalDetail(html);
  info.sourceUrl = `${BASE}/journal/detail?id=${pick.id}`;
  info.matchedName = pick.name;
  info.matchedExactly = matchedExactly;
  info.matchMethod = matchMethod;

  // 给了 ISSN 就用详情页里的 ISSN 再校验一次（防止抓错刊）
  if (query.issn) {
    const wantIssn = String(query.issn).replace(/[^0-9Xx]/g, '').toLowerCase();
    const got = [info.issnPrint, info.issnOnline]
      .filter(Boolean).map((x) => x.replace(/[^0-9Xx]/g, '').toLowerCase());
    info.issnMatched = got.includes(wantIssn);
    if (info.issnMatched) {
      info.matchedExactly = true;
      info.matchMethod = 'issn';
    }
  }

  return { ok: true, info, candidates: candidates.slice(0, 8) };
}

// ── 命令行自测 ──
if (process.argv[1] && process.argv[1].endsWith('ablesci.mjs')) {
  const q = process.argv.slice(2).join(' ').trim() || 'Metrologia';
  console.log(`查询：${q}\n`);
  const isIssn = /^[0-9]{4}-?[0-9]{3}[0-9Xx]$/.test(q);
  const r = await lookupJournal(isIssn ? { issn: q } : { name: q });
  if (!r.ok) {
    console.error(`✗ ${r.error}`);
    for (const c of r.candidates ?? []) console.log(`  ${c.id}  ${c.name}`);
    process.exit(1);
  }
  console.log('候选前 5：');
  for (const c of (r.candidates ?? []).slice(0, 5)) console.log(`  ${c.id}  ${c.name}`);
  console.log('\n抽到的信息：');
  for (const [k, v] of Object.entries(r.info)) {
    if (v === null || v === undefined || (Array.isArray(v) && v.length === 0)) continue;
    console.log(`  ${k}: ${Array.isArray(v) ? JSON.stringify(v) : v}`);
  }
}
