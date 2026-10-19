#!/usr/bin/env node
/**
 * library.mjs — 文献库的分类整理与 Markdown 导出。
 *
 * 设计目标：
 *   - 单一事实来源：library/library.json 记录每篇文献的元数据与分类；
 *   - 人可读导出：library/README.md 生成分类总览（可在 DSH 文档预览里直接看，支持公式）；
 *   - 给界面用：同时产出 library/index.json（供网页侧栏「文献库」面板读取）。
 *
 * 文献在库中的三种状态：
 *   extracted  仅完成 PDF 文本抽取
 *   translated 已完成中文翻译并导出 Markdown
 *   reviewed   已完成人工校对
 *
 * 用法：
 *   node tools/library.mjs list [--category 热物性]
 *   node tools/library.mjs add --slug <slug> --title <标题> [--year 2026] [--authors "A, B"]
 *                              [--category 传感器] [--source library/papers/x.pdf]
 *   node tools/library.mjs set --slug <slug> --status translated --translation library/translations/x/x.md
 *   node tools/library.mjs categorize --slug <slug> --category 自供电
 *   node tools/library.mjs export            # 重新生成 README.md 与 index.json
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, join, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex } from './library_index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WS = resolve(HERE, '..');
const LIB = join(WS, 'library');
const DB = join(LIB, 'library.json');
const README = join(LIB, 'README.md');
const INDEX = join(LIB, 'index.json');

/** 写 index.json；内容由共享模块 buildIndex 决定（见文件头注释） */
async function writeIndex(db) {
  await writeFile(INDEX, `${JSON.stringify(buildIndex(db), null, 2)}\n`, 'utf8');
}

const STATUS_ORDER = ['reviewed', 'translated', 'extracted', 'archived'];
const STATUS_LABEL = {
  extracted: '已抽取',
  translated: '已翻译',
  reviewed: '已校对',
  archived: '已归档',
};

const DEFAULT_CATEGORIES = [
  '热物性', '传感器', '自供电', '机械', '材料', '热物理', '计算机', '其他',
];

// ─────────────────────── 参数解析 ───────────────────────

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { _: [] };
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = rest[i + 1];
      if (val === undefined || val.startsWith('--')) opts[key] = true;
      else { opts[key] = val; i += 1; }
    } else opts._.push(a);
  }
  return { command, opts };
}

// ─────────────────────── 数据读写 ───────────────────────

async function loadDb() {
  if (!existsSync(DB)) {
    return { version: 1, updatedAt: null, categories: [...DEFAULT_CATEGORIES], papers: [] };
  }
  const raw = await readFile(DB, 'utf8');
  const db = JSON.parse(raw);
  db.papers ??= [];
  db.categories ??= [...DEFAULT_CATEGORIES];
  for (const c of DEFAULT_CATEGORIES) if (!db.categories.includes(c)) db.categories.push(c);
  return db;
}

async function saveDb(db) {
  db.updatedAt = new Date().toISOString();
  await mkdir(LIB, { recursive: true });
  await writeFile(DB, `${JSON.stringify(db, null, 2)}\n`, 'utf8');
}

function findPaper(db, slug) {
  const p = db.papers.find((x) => x.slug === slug);
  if (!p) throw new Error(`文献库中没有 slug 为 "${slug}" 的条目`);
  return p;
}

/** 生成 URL/文件名安全的 slug；保留中文（便于阅读与检索） */
export function slugify(input) {
  return String(input)
    .trim()
    .replace(/\.(pdf|md|txt|docx?)$/iu, '')
    .replace(/[\\/:*?"<>|]+/gu, '-')
    .replace(/\s+/gu, '-')
    .replace(/-{2,}/gu, '-')
    .replace(/^-|-$/gu, '')
    .slice(0, 80);
}

// ─────────────────────── 命令实现 ───────────────────────

async function cmdAdd(opts) {
  const db = await loadDb();
  const title = opts.title ?? opts._[0];
  if (!title) throw new Error('缺少 --title');
  const slug = opts.slug ?? slugify(title);
  if (db.papers.some((p) => p.slug === slug)) throw new Error(`slug "${slug}" 已存在`);

  const source = opts.source ?? null;
  const paper = {
    slug,
    title,
    year: opts.year ? Number(opts.year) : null,
    authors: opts.authors ?? null,
    category: opts.category ?? '其他',
    tags: opts.tags ? String(opts.tags).split(',').map((s) => s.trim()).filter(Boolean) : [],
    status: source ? 'extracted' : 'extracted',
    source: source ? relative(WS, resolve(WS, source)).replace(/\\/g, '/') : null,
    extracted: opts.extracted ? relative(WS, resolve(WS, opts.extracted)).replace(/\\/g, '/') : null,
    translation: null,
    translatedAt: null,
    addedAt: new Date().toISOString(),
    note: opts.note ?? null,
    // 期刊信息（用于侧栏面板展示，可在面板里直接编辑）
    journal: {
      name: opts.venue ?? null,          // 期刊全名
      abbr: opts.journal_abbr ?? null,   // 期刊缩写，如 Metrologia
      doi: opts.doi ?? null,
      impactFactor: opts.impact ? Number(opts.impact) : null,   // 影响因子
      jcrQuartile: opts.jcr ?? null,     // JCR 分区，如 Q1
      casQuartile: opts.cas ?? null,     // 中科院分区，如 2区
      isTop: opts.top === 'true' ? true : (opts.top === 'false' ? false : null), // 是否 Top 期刊
      issn: opts.issn ?? null,
      publisher: opts.publisher ?? null,
      indexedIn: opts.indexed ? String(opts.indexed).split(',').map((s) => s.trim()).filter(Boolean) : [],
      updatedAt: null,
    },
  };
  db.papers.push(paper);
  if (!db.categories.includes(paper.category)) db.categories.push(paper.category);
  await saveDb(db);
  await exportViews(db);
  console.log(`✓ 已登记文献: ${slug}`);
  console.log(`  标题: ${title}`);
  console.log(`  分类: ${paper.category}   状态: ${STATUS_LABEL[paper.status]}`);
  return paper;
}

async function cmdSet(opts) {
  const db = await loadDb();
  const p = findPaper(db, opts.slug);
  const fields = ['title', 'year', 'authors', 'category', 'status', 'source', 'extracted', 'translation', 'note'];
  let changed = 0;
  for (const f of fields) {
    if (opts[f] === undefined) continue;
    let v = opts[f];
    if (f === 'year') v = Number(v);
    if ((f === 'source' || f === 'extracted' || f === 'translation') && v !== true) {
      v = relative(WS, resolve(WS, String(v))).replace(/\\/g, '/');
    }
    if (p[f] === v) continue;
    p[f] = v;
    changed += 1;
  }

  // 期刊信息：写入 p.journal 下的对应字段（面板里也可直接编辑）
  const JOURNAL_FIELDS = {
    venue: ['name', String],
    journal_abbr: ['abbr', String],
    doi: ['doi', String],
    impact: ['impactFactor', Number],
    jcr: ['jcrQuartile', String],
    cas: ['casQuartile', String],
    issn: ['issn', String],
    publisher: ['publisher', String],
  };
  p.journal ??= {};
  for (const [opt, [field, cast]] of Object.entries(JOURNAL_FIELDS)) {
    if (opts[opt] === undefined) continue;
    const v = cast(opts[opt]);
    if (p.journal[field] === v) continue;
    p.journal[field] = v;
    p.journal.updatedAt = new Date().toISOString();
    changed += 1;
  }
  for (const [opt, field] of [['top', 'isTop'], ['indexed', 'indexedIn']]) {
    if (opts[opt] === undefined) continue;
    const v = field === 'isTop' ? opts[opt] === 'true' : String(opts[opt]).split(',').map((s) => s.trim()).filter(Boolean);
    p.journal[field] = v;
    p.journal.updatedAt = new Date().toISOString();
    changed += 1;
  }

  if (opts.status === 'translated' || opts.status === 'reviewed') p.translatedAt = new Date().toISOString();
  if (opts.category && !db.categories.includes(opts.category)) db.categories.push(opts.category);
  await saveDb(db);
  await exportViews(db);
  console.log(`✓ 已更新 ${opts.slug}（${changed} 个字段）`);
}

async function cmdCategorize(opts) {
  if (!opts.slug || !opts.category) throw new Error('需要 --slug 与 --category');
  await cmdSet({ slug: opts.slug, category: opts.category });
}

async function cmdList(opts) {
  const db = await loadDb();
  let papers = db.papers;
  if (opts.category) papers = papers.filter((p) => p.category === opts.category);
  if (opts.status) papers = papers.filter((p) => p.status === opts.status);
  if (!papers.length) { console.log('（文献库为空）'); return; }
  const byCat = new Map();
  for (const p of papers) {
    if (!byCat.has(p.category)) byCat.set(p.category, []);
    byCat.get(p.category).push(p);
  }
  for (const [cat, list] of byCat) {
    console.log(`\n【${cat}】${list.length} 篇`);
    for (const p of list.sort((a, b) => (b.year ?? 0) - (a.year ?? 0))) {
      console.log(`  - ${p.year ?? '----'}  ${p.title}`);
      console.log(`      slug=${p.slug}  状态=${STATUS_LABEL[p.status] ?? p.status}  翻译=${p.translation ?? '—'}`);
    }
  }
  console.log(`\n合计 ${papers.length} 篇 / 全部 ${db.papers.length} 篇`);
}

// ─────────────────────── 导出 ───────────────────────

async function exportViews(db) {
  const byCat = new Map();
  for (const p of db.papers) {
    if (!byCat.has(p.category)) byCat.set(p.category, []);
    byCat.get(p.category).push(p);
  }
  const lines = [];
  lines.push('# 文献库总览');
  lines.push('');
  lines.push(`> 共 ${db.papers.length} 篇 · 更新于 ${db.updatedAt ?? '—'}`);
  lines.push('> 本文件由 `tools/library.mjs export` 自动生成，请勿手工编辑。');
  lines.push('');
  lines.push('## 状态说明');
  lines.push('');
  lines.push('| 状态 | 含义 |');
  lines.push('|---|---|');
  for (const s of STATUS_ORDER) lines.push(`| ${STATUS_LABEL[s]} | ${s} |`);
  lines.push('');

  const catOrder = [...byCat.keys()].sort((a, b) => {
    const ai = db.categories.indexOf(a);
    const bi = db.categories.indexOf(b);
    return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
  });

  for (const cat of catOrder) {
    const list = byCat.get(cat).sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || a.title.localeCompare(b.title));
    lines.push(`## ${cat}（${list.length}）`);
    lines.push('');
    lines.push('| 年份 | 标题 | 期刊 | 影响因子 | 分区 | 状态 | 翻译稿 |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const p of list) {
      const link = p.translation
        ? `[${basename(p.translation, '.md')}](${relative(LIB, join(WS, p.translation)).replace(/\\/g, '/')})`
        : '—';
      const j = p.journal ?? {};
      const journal = j.name ?? j.abbr ?? '—';
      const ifv = j.impactFactor != null ? String(j.impactFactor) : '—';
      const zone = [j.jcrQuartile, j.casQuartile].filter(Boolean).join(' / ') || '—';
      const title = p.authors ? `${p.title} — ${p.authors}` : p.title;
      lines.push(`| ${p.year ?? '—'} | ${title} | ${journal} | ${ifv} | ${zone} | ${STATUS_LABEL[p.status] ?? p.status} | ${link} |`);
    }
    lines.push('');
  }

  await writeFile(README, lines.join('\n'), 'utf8');
  // index.json 的字段定义在 tools/library_index.mjs（与插件 host 半共用同一份），
  // 避免两处各写一遍导致字段分叉
  await writeIndex(db);
}

/** 扫描 library/translations 下的产物，自动补登记（用于手工放入翻译稿的场景） */
async function cmdScan() {
  const db = await loadDb();
  const tdir = join(LIB, 'translations');
  if (!existsSync(tdir)) { console.log('（没有 translations 目录）'); return; }
  let added = 0;
  for (const entry of await readdir(tdir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const slug = entry.name;
    if (db.papers.some((p) => p.slug === slug)) continue;
    const md = join(tdir, slug, `${slug}.md`);
    if (!existsSync(md)) continue;
    db.papers.push({
      slug,
      title: slug,
      year: null,
      authors: null,
      category: '其他',
      tags: [],
      status: 'translated',
      source: null,
      extracted: null,
      translation: relative(WS, md).replace(/\\/g, '/'),
      translatedAt: null,
      addedAt: new Date().toISOString(),
      note: '由 scan 自动登记',
    });
    added += 1;
  }
  await saveDb(db);
  await exportViews(db);
  console.log(`✓ 扫描完成，新增 ${added} 条`);
}

// ─────────────────────── 入口 ───────────────────────

const USAGE = `文献库管理

用法:
  node tools/library.mjs list [--category <分类>] [--status <状态>]
  node tools/library.mjs add --title "<标题>" [--slug <slug>] [--year 2026]
                            [--authors "A, B"] [--category 传感器] [--source <pdf路径>]
                            [期刊信息] 影响因子/分区等，见下
  node tools/library.mjs set --slug <slug> [--status translated] [--translation <md路径>] [期刊信息]
  node tools/library.mjs categorize --slug <slug> --category <分类>
  node tools/library.mjs scan      # 扫描 translations/ 自动补登记
  node tools/library.mjs export    # 重新生成 README.md 与 index.json

期刊信息参数（add / set 均可）:
  --venue "<期刊全名>"   --journal_abbr "<缩写>"   --doi "<DOI>"
  --impact <影响因子>    --jcr <Q1|Q2|...>         --cas <1区|2区|...>
  --top <true|false>     --issn "<ISSN>"           --publisher "<出版社>"
  --indexed "SCIE,EI"

分类（可扩展）: ${DEFAULT_CATEGORIES.join('、')}
状态: extracted(已抽取) / translated(已翻译) / reviewed(已校对) / archived(已归档)`;

async function main() {
  const { command, opts } = parseArgs(process.argv.slice(2));
  switch (command) {
    case 'add': await cmdAdd(opts); break;
    case 'set': await cmdSet(opts); break;
    case 'categorize': await cmdCategorize(opts); break;
    case 'list': await cmdList(opts); break;
    case 'scan': await cmdScan(); break;
    case 'export': { const db = await loadDb(); await exportViews(db); console.log('✓ 已重新生成 library/README.md 与 library/index.json'); break; }
    default: console.log(USAGE); process.exit(command ? 1 : 0);
  }
}

main().catch((e) => { console.error(`✗ ${e.message}`); process.exit(1); });
