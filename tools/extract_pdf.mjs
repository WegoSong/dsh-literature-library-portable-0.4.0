#!/usr/bin/env node
/**
 * extract_pdf.mjs —— 学术 PDF 文本抽取器（纯本地，无 API 依赖）
 *
 * 目标：把「双栏、带公式与角标、分页截断」的论文 PDF，还原成一份
 * 可直接用于翻译的干净 Markdown。
 *
 * 处理链：
 *   1. run 聚合    —— 按阅读顺序排列 item，用「水平连续性」判断是否同一 run
 *   2. 行聚合      —— y 容差（容纳上下标）+ 水平连续性（区分左右栏同高文本）
 *   3. 碎片归位    —— 角标、跨行断词插回原行
 *   4. 版面划分    —— 递归划分「主导双栏区 + 上下遗留元素」
 *   5. 段落重建    —— 首行缩进与句末标点判段、跨页续段合并
 *   6. 版式清理    —— 页眉页脚页码剔除、章节标记、参考文献区标记
 *
 * 用法：
 *   node tools/extract_pdf.mjs <input.pdf> [--out <dir>] [--name <slug>] [--pages 1-4] [--no-json]
 *   node tools/extract_pdf.mjs <input.pdf> --pages 1 --debug-cols   # 单页版面诊断
 */

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, basename, extname } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { REGION_VERSION, itemBox, unionBoxes, detectShadedPanels, identifyPageRegions, auditCoverage } from './page_regions.mjs';
import { ARTICLE_ROLES } from './manual_regions.mjs';
import { MEDIA_POLICY, mediaOptions, pageGraphics, identifyMedia, tableGrid, markdownTable } from './media_regions.mjs';
import { readMathGlyphs, reconstructFormula } from './formula_latex.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = resolve(HERE, '..');
const requireFromHere = createRequire(import.meta.url);

// ───────────────────────── CLI ─────────────────────────

function parseArgs(argv) {
  const args = { positional: [], out: null, name: null, json: true, pages: null, debugCols: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else if (a === '--name') args.name = argv[++i];
    else if (a === '--no-json') args.json = false;
    else if (a === '--asset-prefix') args.assetPrefix = argv[++i];
    else if (a === '--file-route') args.fileRoute = argv[++i];
    else if (a === '--pages') args.pages = argv[++i];
    else if (a === '--debug-cols') args.debugCols = true;
    else if (a === '--dump-layout') { args.dumpLayout = true; args.debugCols = true; }
    else if (a === '--preview-pages') args.previewPages = argv[++i];
    else if (a === '--overrides') args.overrides = argv[++i];
    else if (a === '--raw-layout') args.rawLayout = true;
    else if (a === '--include-figures') args.figures = true;
    else if (a === '--translate-tables') args.tables = true;
    else if (a === '--no-formula-images') args.formulaFallback = false;
    else if (a === '--help' || a === '-h') args.help = true;
    else args.positional.push(a);
  }
  return args;
}

const USAGE = `用法: node tools/extract_pdf.mjs <input.pdf> [选项]

选项:
  --out <dir>     输出根目录（默认 library/extracted）
  --name <slug>   输出文件名前缀（默认取 PDF 文件名）
  --pages <范围>  只处理指定页，如 1-4 或 1,3,5
  --no-json       不输出结构化 JSON
  --no-formula-images  公式优先 LaTeX；关闭不确定公式的原图兜底，保留待核对候选文本
  --debug-cols    打印版面划分诊断
  --preview-pages <范围>  输出指定页的区域框 PNG 与阅读顺序报告（本地，无 API）
  -h, --help      显示帮助`;

// ─────────────────── pdf.js 载入 ───────────────────

let pdfjsCache = null;

async function loadPdfjs() {
  if (pdfjsCache) return pdfjsCache;
  const candidates = [];
  // 市场安装：pdfjs-dist 是包依赖，从当前模块解析（pnpm/npm 都能找到）
  for (const spec of ['pdfjs-dist/legacy/build/pdf.mjs', 'pdfjs-dist/build/pdf.mjs']) {
    try { candidates.push(requireFromHere.resolve(spec)); } catch { /* 试下一种布局 */ }
  }
  // 旧的“工作区/便携包”布局：node_modules 在工作区根目录
  candidates.push(
    join(WORKSPACE, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs'),
    join(WORKSPACE, 'node_modules/pdfjs-dist/build/pdf.mjs'),
  );
  let lastErr = null;
  for (const p of [...new Set(candidates)]) {
    try {
      pdfjsCache = await import(new URL(`file://${p.replace(/\\/g, '/')}`).href);
      return pdfjsCache;
    } catch (err) { lastErr = err; }
  }
  throw new Error(`无法载入 pdfjs-dist，请在工作区执行 npm install。原始错误: ${lastErr?.message ?? '未知'}`);
}

// ─────────────────── 文本规范化 ───────────────────

const MATH_CHARS = /[=≈≠≤≥±×÷∑∏∫√∂∞∝→←↔⟨⟩⌈⌉⌊⌋αβγδεζηθικλμνξπρστυφχψωΓΔΘΛΞΠΣΦΨΩ]/u;

const SUP_MAP = {
  '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6',
  '⁷': '7', '⁸': '8', '⁹': '9', '⁺': '+', '⁻': '-', '⁼': '=', '⁽': '(', '⁾': ')',
};
const SUB_MAP = {
  '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5', '₆': '6',
  '₇': '7', '₈': '8', '₉': '9', '₊': '+', '₋': '-', '₌': '=', '₍': '(', '₎': ')',
};

/** 行内规范化：Unicode 上下标与常见数学符号转 LaTeX */
function normalizeInline(s) {
  let t = s.replace(/\u00AD/gu, '');
  t = t.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾]+/gu, (m) => `^{${[...m].map((c) => SUP_MAP[c]).join('')}}`);
  t = t.replace(/[₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎]+/gu, (m) => `_{${[...m].map((c) => SUB_MAP[c]).join('')}}`);
  t = t.replace(/×/gu, '\\times ').replace(/÷/gu, '\\div ').replace(/−/gu, '-');
  t = t.replace(/≈/gu, '\\approx ').replace(/≤/gu, '\\leq ').replace(/≥/gu, '\\geq ')
    .replace(/≠/gu, '\\neq ').replace(/±/gu, '\\pm ').replace(/∝/gu, '\\propto ')
    .replace(/∞/gu, '\\infty ');
  return t.replace(/[ \t]{2,}/gu, ' ').trim();
}

// ─────────────────── 步骤 1：run 聚合 ───────────────────

/**
 * pdf.js 把文本切成大量 item（角标、断词、字距调整都会独立成项）。
 * 按阅读顺序（y 降序、x 升序）扫描，把「同一行 + 字号一致 + 间距合理」的
 * item 合成 run；间距出现明显跳跃说明跨栏，必须断开——否则左右两栏会被拼成一句。
 */
function buildRuns(items, debugOpts = {}) {
  const mapped = items
    .filter((it) => (it.str ?? '').length > 0
      // 侧边竖排下载水印不能参与正文几何分析。
      && Math.abs(it.transform?.[1] ?? 0) < Math.abs(it.transform?.[0] ?? 1) * 0.5)
    .map((it) => ({
      str: it.str,
      x: it.transform?.[4] ?? 0,
      y: it.transform?.[5] ?? 0,
      size: Math.abs(it.transform?.[3] ?? it.height ?? 0),
      w: it.width ?? 0,
      sourceId: it.str.trim() ? it.sourceId : undefined,
    }));
  const sorted = [...mapped].sort((a, b) => b.y - a.y || a.x - b.x);

  const runs = [];
  let cur = null;
  for (const it of sorted) {
    if (!cur) {
      cur = { text: it.str, x0: it.x, x1: it.x + it.w, y: it.y, size: it.size, itemIds: [it.sourceId] };
      continue;
    }
    const gap = it.x - cur.x1;
    const em = Math.max(Math.max(cur.size, it.size), 1);
    const tol = Math.max(1.0, em * 0.32);
    const sameLine = Math.abs(it.y - cur.y) <= tol;
    const sameSize = Math.abs(it.size - cur.size) < Math.max(0.75, cur.size * 0.12);
    const crossColumn = gap > em * 1.4;
    const overlaps = gap < -em * 0.62;
    const reasonable = gap < em * 0.95;
    // 基线上的两个文本块之间若夹着更小且上下偏移的 glyph，它就是上下标。
    // 此时绝不能先把两侧基线块合成一个 run，否则稍后只能得到 BiTe_{2}，
    // 无法恢复正确的 Bi_{2}Te_{3} 顺序。
    const scriptBetween = mapped.some((s) => s !== it
      && s.size <= em * 0.86
      && Math.abs(s.y - it.y) <= em * 0.85
      && Math.abs(s.y - it.y) >= em * 0.08
      && s.x >= cur.x1 - em * 0.12
      && s.x <= it.x + em * 0.12);

    const fence = debugOpts.gutter;
    const crossesFence = fence && cur.x1 <= fence.start + 1 && it.x >= fence.end - 1;
    const headingNumber = /^\d+(?:\.\d+)*\.?$/u.test(cur.text.trim()) && sameLine
      && /^[A-Z]/u.test(it.str) && gap < em * 5;
    if (sameLine && sameSize && !crossesFence && !overlaps && (( !crossColumn && reasonable && !scriptBetween) || headingNumber)) {
      // 诊断：左栏一行与右栏一行在同一基线上，间距极小（本论文栏间距仅约 11pt，
      // 与字距同级），"跨栏须有 1.4em 间隔"这条规则会漏判，从而把两栏拼成一行。
      if (debugOpts?.dumpLayout && debugOpts.pageWidth) {
        const before = cur.x1 - cur.x0;
        const after = Math.max(cur.x1, it.x + it.w) - Math.min(cur.x0, it.x);
        const fromLeft = (cur.x0 + cur.x1) / 2 < debugOpts.pageWidth / 2;
        const toRight = (it.x + it.w / 2) > debugOpts.pageWidth / 2;
        if (after > debugOpts.pageWidth * 0.62 && before <= debugOpts.pageWidth * 0.62 && fromLeft && toRight) {
          console.error(`[RUN-CROSS p${debugOpts.page}] y=${cur.y.toFixed(1)} `
            + `left=[${cur.x0.toFixed(1)},${cur.x1.toFixed(1)}]"${cur.text.slice(-22)}" `
            + `+ right=[${it.x.toFixed(1)},${(it.x + it.w).toFixed(1)}]"${it.str.slice(0, 22)}" gap=${gap.toFixed(1)}`);
        }
      }
      if (headingNumber || gap > em * 0.2 && /[\p{L}\p{N}(]/u.test(it.str[0]) && !/[\s\-/]$/u.test(cur.text)) cur.text += ' ';
      cur.text += it.str;
      cur.x1 = Math.max(cur.x1, it.x + it.w);
      cur.itemIds.push(it.sourceId);
    } else {
      runs.push(cur);
      cur = { text: it.str, x0: it.x, x1: it.x + it.w, y: it.y, size: it.size, itemIds: [it.sourceId] };
    }
  }
  if (cur) runs.push(cur);
  return runs;
}

// ─────────────────── 步骤 2：行聚合 ───────────────────

/**
 * run → 行。两个约束同时满足：
 *   a) y 容差要容纳上下标；b) 同高不等于同行——双栏的左右栏常共处同一 y，
 *      必须再要求水平方向连续。
 * 角标走单独分支：字号更小 + 基线偏移 + 紧贴基准文本。
 */
function groupLines(runs, debugOpts = {}) {
  return groupBaselineLines(runs, debugOpts.gutter);
}

// 先建立正文基线，再把小字号上/下标归入最近的宿主。旧算法只看上一条行，
// 上标先出现时会把引文编号搬到下一行开头，也会把两栏同高内容合在一起。
function groupBaselineLines(runs, gutter) {
  const lines = [];
  for (const r of [...runs].sort((a, b) => b.size - a.size || b.y - a.y || a.x0 - b.x0)) {
    const candidates = lines.filter((line) => {
      const smaller = r.size <= line.size * 0.88;
      const tolerance = smaller ? line.size * 0.82 : Math.max(0.7, line.size * 0.16);
      const gap = Math.max(r.x0 - line.x1, line.x0 - r.x1, 0);
      if (gutter && ((r.x0 >= gutter.end - 1 && line.x1 <= gutter.start + 1)
        || (line.x0 >= gutter.end - 1 && r.x1 <= gutter.start + 1))) return false;
      return Math.abs(line.y - r.y) <= tolerance && gap <= line.size * 1.0;
    }).sort((a, b) => {
      const score = (line) => Math.abs(line.y - r.y) + (r.size <= line.size * 0.88
        ? Math.min(...line.runs.map((base) => Math.abs(base.x1 - r.x0))) * 2 : 0);
      return score(a) - score(b);
    });
    const target = candidates[0];
    if (target) {
      target.runs.push(r);
      target.x0 = Math.min(target.x0, r.x0);
      target.x1 = Math.max(target.x1, r.x1);
    } else lines.push({ y: r.y, x0: r.x0, x1: r.x1, size: r.size, runs: [r] });
  }
  for (const line of lines) {
    line.runs.sort((a, b) => a.x0 - b.x0 || b.y - a.y);
    line.text = composeLineText(line.runs);
  }
  // 后加入的片段可能桥接了两个先前独立的基线块，需合并到稳定状态。
  for (let i = 0; i < lines.length; i += 1) {
    for (let j = i + 1; j < lines.length; j += 1) {
      const a = lines[i], b = lines[j];
      const gap = Math.max(a.x0 - b.x1, b.x0 - a.x1, 0);
      const crossed = gutter && ((a.x1 <= gutter.start + 1 && b.x0 >= gutter.end - 1)
        || (b.x1 <= gutter.start + 1 && a.x0 >= gutter.end - 1));
      if (!crossed && Math.abs(a.y - b.y) < Math.max(a.size, b.size) * 0.18
        && gap < Math.max(a.size, b.size) * 1.15) {
        a.runs.push(...b.runs); a.runs.sort((x, y) => x.x0 - y.x0);
        a.x0 = Math.min(a.x0, b.x0); a.x1 = Math.max(a.x1, b.x1);
        a.text = composeLineText(a.runs);
        lines.splice(j--, 1);
      }
    }
  }
  return lines.sort((a, b) => Math.round(b.y * 4) - Math.round(a.y * 4) || a.x0 - b.x0);
}

function legacyGroupLines(runs, debugOpts = {}) {
  const sorted = [...runs].sort((a, b) => b.y - a.y || a.x0 - b.x0);
  const lines = [];

  for (const r of sorted) {
    const last = lines[lines.length - 1];
    let handled = false;

    if (last) {
      const base = Math.max(last.size, r.size);
      const em = Math.max(base, 1);
      const dy = Math.abs(last.y - r.y);
      const horizontal = r.x0 <= last.x1 + em * 1.2 && r.x1 >= last.x0 - em * 0.4;

      const isScript = horizontal && r.size <= last.size * 0.9 && dy <= Math.max(1, em * 0.45);
      if (isScript) {
        if (debugOpts?.dumpLayout && debugOpts.pageWidth) {
          const after = Math.max(last.x1, r.x1) - Math.min(last.x0, r.x0);
          if (after > debugOpts.pageWidth * 0.62) {
            console.error(`[WIDE-SCRIPT p${debugOpts.page}] y=${last.y.toFixed(1)}+${r.y.toFixed(1)} `
              + `prev=[${last.x0.toFixed(0)},${last.x1.toFixed(0)}] + r=[${r.x0.toFixed(0)},${r.x1.toFixed(0)}] `
              + `=> ${after.toFixed(0)} "${last.text.slice(0, 30)}" | "${r.text.slice(0, 30)}"`);
          }
        }
        last.runs.push(r);
        last.x1 = Math.max(last.x1, r.x1);
        last.x0 = Math.min(last.x0, r.x0);
        handled = true;
      } else {
        const tol = Math.max(1.0, base * 0.32);
        const continuity = r.x0 > last.x0 && r.x0 - last.x1 < em * 1.2;
        if (dy <= tol && continuity) {
          // 诊断：任何让行跨度超过页宽 62% 的合并都记录下来
          if (debugOpts?.dumpLayout && debugOpts.pageWidth) {
            const after = Math.max(last.x1, r.x1) - Math.min(last.x0, r.x0);
            if (after > debugOpts.pageWidth * 0.62 && last.x1 - last.x0 <= debugOpts.pageWidth * 0.62) {
              console.error(`[WIDE-JOIN p${debugOpts.page}] y=${last.y.toFixed(1)}+${r.y.toFixed(1)} `
                + `prev=[${last.x0.toFixed(0)},${last.x1.toFixed(0)}] + r=[${r.x0.toFixed(0)},${r.x1.toFixed(0)}] `
                + `gap=${(r.x0 - last.x1).toFixed(1)} tol=${tol.toFixed(1)} => ${after.toFixed(0)} `
                + `"${last.text.slice(0, 26)}" | "${r.text.slice(0, 26)}"`);
            }
          }
          last.runs.push(r);
          last.x0 = Math.min(last.x0, r.x0);
          last.x1 = Math.max(last.x1, r.x1);
          last.size = Math.max(last.size, r.size);
          handled = true;
        }
      }
    }

    if (!handled) lines.push({ y: r.y, x0: r.x0, x1: r.x1, size: r.size, runs: [r] });
  }

  for (const ln of lines) {
    ln.runs.sort((a, b) => a.x0 - b.x0);
    ln.text = composeLineText(ln.runs);
  }
  return lines;
}

/**
 * 行内拼接。角标必须紧贴基准词（`Bi_2Te_3` 不能写成 `Bi _2 Te _3`），
 * 因此 ^{} / _{} 标记必须在这里就地生成——各段一旦被 trim 拼接，
 * 几何信息就丢了，之后再也判断不出哪一段是角标。
 */
function composeLineText(runs) {
  let out = '';
  for (let i = 0; i < runs.length; i += 1) {
    const r = runs[i];
    const prev = runs[i - 1];
    const piece = r.text.trim();
    let script = null;

    if (prev) {
      const gap = r.x0 - prev.x1;
      const spaceThreshold = Math.max(0.9, prev.size * 0.24);
      const dy = r.y - prev.y;
      const smaller = r.size <= prev.size * 0.85;
      const offset = dy > prev.size * 0.1 || dy < -prev.size * 0.03;
      const adjacent = gap < Math.max(2.5, prev.size * 0.7);
      const token = /^[0-9A-Za-z+\-=()]{1,6}$/u.test(piece);

      if (smaller && offset && adjacent && token) script = dy > 0 ? '^' : '_';
      else if (gap > spaceThreshold && !/[-–—/(]$/u.test(out) && !/^[),.;:%]/u.test(piece)) out += ' ';
    }

    out += script ? `${script}{${piece}}` : piece;
    // 下标后面的正文词需要空格；公式的标点/连续符号仍保持紧贴。
    const next = runs[i + 1];
    if (script && next && /^[A-Za-z]{2,}\b/u.test(next.text.trim()) && next.size > r.size * 1.1
      && !(next.text.trim().length <= 2 && runs[i + 2]?.size <= next.size * 0.85)) out += ' ';
  }
  return normalizeInline(out);
}

// ─────────────────── 步骤 3：碎片归位 ───────────────────

/**
 * 把「本是同一行却被拆散」的碎片并回原行：角标与跨行断词。
 * 判据必须严格（同一栏 + 字号更小或紧接 + 水平紧贴），否则会把
 * 被断行分开的正文误并进来。
 */
function mergeFragments(lines, gutter) {
  const out = [];
  const colOf = (l) => {
    if (!gutter) return 'S';
    const mid = (l.x0 + l.x1) / 2;
    if (mid < gutter.start) return 'L';
    if (mid > gutter.end) return 'R';
    return 'S';
  };

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const ln = lines[lineIndex];
    const next = lines[lineIndex + 1];
    // 上标的基线高于正文，按 y 降序时会先于其宿主行出现。若这个小碎片的
    // x 完全落在下一条基线内，先塞进下一行，避免把公式编号/平方项变成独立段落。
    const attachesForward = next
      && ln.size <= next.size * 0.82
      && Math.abs(ln.y - next.y) <= Math.max(1.2, next.size * 0.58)
      && ln.runs.every((r) => r.x0 >= next.x0 - 2 && r.x1 <= next.x1 + 2)
      && /^[\p{L}\p{N}\-+=().,;:]{1,8}$/u.test(ln.runs.map((r) => r.text).join('').trim());
    if (attachesForward) {
      next.runs.push(...ln.runs);
      next.runs.sort((a, b) => a.x0 - b.x0);
      next.x0 = Math.min(next.x0, ln.x0);
      next.x1 = Math.max(next.x1, ln.x1);
      next.text = composeLineText(next.runs);
      continue;
    }
    const prev = out[out.length - 1];
    const textOnly = ln.runs.map((r) => r.text).join('').trim();
    const close = prev ? Math.abs(ln.y - prev.y) <= Math.max(1.2, prev.size * 0.55) : false;
    const sameCol = prev ? colOf(ln) === colOf(prev) : false;

    if (prev && close && sameCol) {
      const tiny = ln.size <= prev.size * 0.82;
      const wordish = /^[\p{L}\p{N}\-+=().,;:]{1,8}$/u.test(textOnly);
      const gap = ln.x0 - prev.x1;
      const tight = gap > -Math.max(1, prev.size) * 0.6 && gap < Math.max(4, prev.size * 0.9);

      const scriptsInside = tiny && ln.runs.every((r) => r.x0 >= prev.x0 - 2 && r.x1 <= prev.x1 + 2);
      if (tiny && wordish && (tight || scriptsInside) && textOnly.length > 0) {
        let idx = prev.runs.findIndex((r) => r.x0 > ln.x0);
        if (idx < 0) idx = prev.runs.length;
        prev.runs.splice(idx, 0, ...ln.runs);
        prev.x0 = Math.min(prev.x0, ln.x0);
        prev.x1 = Math.max(prev.x1, ln.x1);
        prev.text = composeLineText(prev.runs);
        continue;
      }

      // 跨行断词：上行以连字符结尾，本行以小写字母开头
      if (/[\p{L}]-$/u.test(prev.text) && /^\p{Ll}/u.test(textOnly)) {
        prev.text = prev.text.replace(/-$/u, '') + ln.text;
        prev.x1 = Math.max(prev.x1, ln.x1);
        prev.runs.push(...ln.runs);
        continue;
      }
    }
    out.push(ln);
  }
  return out;
}

/** 公式的延续片段（如 "described by V = S dT, ..."）不应作为独立公式块 */
function isEquationFragment(line) {
  const t = line.text.trim();
  if (t.length === 0 || t.length > 120) return false;
  if (!/^[a-z(,;]/u.test(t)) return false;
  return /[=≈≤≥]/u.test(t) || MATH_CHARS.test(t);
}

// ─────────────────── 步骤 4：版面划分 ───────────────────

/**
 * 结构性防护：把「任何行都不得跨越中缝」作为全局不变式来执行。
 *
 * 双栏页面里，一条行要么完全在左栏、要么完全在右栏；跨越中缝的行只可能是
 * 通栏元素（标题、通栏表）。若某条非通栏行横跨了中缝，说明两栏的文本被错误
 * 拼接了——无论拼接发生在哪一步，都会在这里被拆回两条行。
 *
 * 这样处理后，阅读顺序的正确性就不再依赖「拼接发生在哪一步」这类脆弱假设。
 */
function splitCrossGutterLines(lines, pageWidth) {
  if (lines.length < 12) return lines;
  const narrow = lines.filter((l) => l.x1 - l.x0 <= pageWidth * 0.62);
  // 只有「窄行」数量足够、且能构成双栏结构时才执行拆分。
  // 否则（例如通栏摘要块）整块应原样保留，拆了反而会把句子切碎。
  if (narrow.length < 10 || narrow.length < lines.length * 0.5) return lines;
  const colInfo = detectColumns(narrow.map((l) => ({ x0: l.x0, x1: l.x1 })), pageWidth);
  if (colInfo.columns !== 2) return lines;

  const { gutterStart, gutterEnd } = colInfo;
  const out = [];
  let splitCount = 0;

  for (const l of lines) {
    const width = l.x1 - l.x0;
    const crossesGutter = l.x0 < gutterStart && l.x1 > gutterEnd;
    if (!crossesGutter || width > pageWidth * 0.62) { out.push(l); continue; }

    // 在行的 runs 之间找落在中缝里的断点，据此拆回两条行
    const runs = [...l.runs].sort((a, b) => a.x0 - b.x0);
    const cuts = [];
    for (let i = 1; i < runs.length; i += 1) {
      const gapMid = (runs[i - 1].x1 + runs[i].x0) / 2;
      if (gapMid >= gutterStart - 2 && gapMid <= gutterEnd + 2) cuts.push(i);
    }
    if (cuts.length === 0) { out.push(l); continue; }

    let start = 0;
    for (const cut of cuts) {
      const part = runs.slice(start, cut);
      if (part.length) out.push(makeLine(part));
      start = cut;
    }
    const tail = runs.slice(start);
    if (tail.length) out.push(makeLine(tail));
    splitCount += 1;
  }

  if (splitCount > 0 && process.env.DEBUG_COLS_DETAIL) {
    console.error(`[splitCrossGutter] 拆回 ${splitCount} 条跨栏行 (gutter=[${gutterStart.toFixed(0)},${gutterEnd.toFixed(0)}])`);
  }
  return out;
}

/** 由一组 run 构造一条行（重算边界与文本） */
function makeLine(runs) {
  const sorted = [...runs].sort((a, b) => a.x0 - b.x0);
  return {
    y: sorted[0].y,
    x0: Math.min(...sorted.map((r) => r.x0)),
    x1: Math.max(...sorted.map((r) => r.x1)),
    size: Math.max(...sorted.map((r) => r.size)),
    runs: sorted,
    text: composeLineText(sorted),
  };
}

/**
 * 在正确的中缝定义下重新归属每一行。
 * 行本身不跨越中缝，因此归属只看它整体位于中缝的哪一侧。
 */
function assignSides(lines, pageWidth) {
  const narrow = lines.filter((l) => l.x1 - l.x0 <= pageWidth * 0.62);
  if (narrow.length < 10) return null;
  const colInfo = detectColumns(narrow.map((l) => ({ x0: l.x0, x1: l.x1 })), pageWidth);
  if (colInfo.columns !== 2) return null;
  for (const l of lines) {
    if (l.x1 - l.x0 > pageWidth * 0.62) { l.side = 'S'; continue; }
    if (l.x1 <= colInfo.gutterEnd) l.side = 'L';
    else if (l.x0 >= colInfo.gutterStart) l.side = 'R';
    else l.side = 'S';
  }
  return colInfo;
}

/**
 * 中缝检测（按栏边界统计，比「找空白带」稳健）。
 *
 * 思路：先按行起始位置 x0 聚类，找出「最靠左的一簇」（左栏左边界）与
 * 「位于右侧的一簇」（右栏左边界）。两者之差就是栏宽。中缝必然落在这两个
 * 起点之间，于是用左栏行的最大右边界 x1 与右栏行的最小左边界 x0 夹出中缝。
 *
 * 为什么不用「在页面中部找最宽空白带」：真实论文的栏间距常常只有 6~10pt
 * （实测本论文部分页面即为 8pt），与字距同级，空白带检测极易被行内的
 * 公式碎片或短行破坏，一旦失败就是静默的跨栏错拼。
 */
function detectColumns(lines, pageWidth, opts = {}) {
  const none = { columns: 1, gutterStart: 0, gutterEnd: 0 };
  const usable = lines.filter((l) => Number.isFinite(l.x0) && Number.isFinite(l.x1));
  if (usable.length < 10) return none;

  // 通栏行（标题、摘要框、通栏表）不能参与栏边界统计
  const narrow = usable.filter((l) => l.x1 - l.x0 <= pageWidth * 0.62);
  if (narrow.length < 8) return none;

  // 按 x0 聚类：以 15pt 为一档做直方图，取最高峰为左栏起点
  const BIN = 15;
  const hist = new Map();
  for (const l of narrow) {
    const k = Math.floor(l.x0 / BIN);
    hist.set(k, (hist.get(k) ?? 0) + 1);
  }
  let leftKey = null;
  let leftPeak = 0;
  let bestPair = -1;
  for (const [k, n] of hist) {
    for (const [right, count] of hist) {
      const distance = (right - k) * BIN;
      if (distance < pageWidth * 0.25 || distance > pageWidth * 0.6 || Math.min(n, count) < 3) continue;
      const score = Math.min(n, count) * 2 + n + count;
      if (score > bestPair) { bestPair = score; leftPeak = n; leftKey = k; }
    }
  }
  if (leftKey === null) return none;
  const leftStart = leftKey * BIN;

  // 右栏起点：位于左栏起点右侧至少 0.25 页宽、且计数达到左峰 25% 的最靠左峰
  let rightKey = null;
  for (const k of [...hist.keys()].sort((a, b) => a - b)) {
    const start = k * BIN;
    if (start - leftStart < pageWidth * 0.25) continue;
    if (hist.get(k) < Math.max(3, leftPeak * 0.25)) continue;
    rightKey = k;
    break;
  }
  if (rightKey === null) return none;
  const rightStart = rightKey * BIN;

  // 中缝：左栏行的最大 x1 与右栏行的最小 x0 之间
  const leftLines = narrow.filter((l) => l.x0 < rightStart - 10 && l.x1 <= rightStart - 2);
  const rightLines = narrow.filter((l) => l.x0 >= rightStart - 5 && l.x0 <= rightStart + BIN + 5);
  if (leftLines.length < 3 || rightLines.length < 3) return none;

  const leftEnd = Math.max(...leftLines.map((l) => l.x1));
  const rightBegin = Math.min(...rightLines.map((l) => l.x0));
  // 中缝取「左栏右边界」与「右栏左边界」的中点；两者交叉时退化为右栏起点
  let gutterStart = Math.min(leftEnd, rightBegin);
  let gutterEnd = Math.max(leftEnd, rightBegin);
  if (gutterEnd - gutterStart < 1) {
    gutterStart = rightStart - 2;
    gutterEnd = rightStart + 2;
  }

  const minSide = Math.max(3, narrow.length * 0.12);
  const lCount = narrow.filter((l) => l.x1 <= gutterEnd).length;
  const rCount = narrow.filter((l) => l.x0 >= gutterStart).length;
  if (lCount < minSide || rCount < minSide) return none;

  if (process.env.DEBUG_COLS_DETAIL) {
    console.error(`[detect] narrow=${narrow.length} leftStart=${leftStart} rightStart=${rightStart} `
      + `gutter=[${gutterStart.toFixed(1)},${gutterEnd.toFixed(1)}] l=${lCount} r=${rCount} minSide=${minSide.toFixed(1)}`);
  }
  return { columns: 2, gutterStart, gutterEnd };
}

/**
 * 纵向切块：按行距空白与「版面换段」把页面切成块。
 *
 * 两种信号都必须用：
 *   - 纵向空白：标题/摘要/正文/页脚之间的常规分隔；
 *   - 版面换段：摘要框与双栏正文在垂直方向重叠，两者间距太小，
 *     只能靠结构识别——「上一行属于右栏、本行属于左栏」即进入新的版面段。
 * 若不做切块而直接在整页找中缝，摘要的宽行会把中缝填掉，
 * 整页会被误判成单栏，正文左右栏随即交错。
 */
function splitBands(lines, pageWidth) {
  if (lines.length < 2) return lines.length ? [lines] : [];
  const sorted = [...lines].sort((a, b) => b.y - a.y);

  // 行距估计：含上下标的行 y 会偏高约 3pt，使相邻间距忽大忽小；
  // 因此只用 1~60pt 的间距做统计并取 60% 分位，避免把行距算得过小。
  const leads = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const lead = sorted[i - 1].y - sorted[i].y;
    if (lead > 1 && lead < 60) leads.push(lead);
  }
  leads.sort((a, b) => a - b);
  const typicalLead = leads.length ? leads[Math.floor(leads.length * 0.6)] : 12;
  const gapThreshold = Math.max(2.5, typicalLead) * 1.8;

  // 中缝（用「窄行」估计，通栏行会填掉中缝）：只需粗定位，用于判断
  // 某一行属于左栏还是右栏。
  const narrow = sorted.filter((l) => l.x1 - l.x0 <= pageWidth * 0.62);
  const cols = detectColumns(narrow.map((l) => ({ x0: l.x0, x1: l.x1 })), pageWidth);
  const mid = cols.columns === 2 ? (cols.gutterStart + cols.gutterEnd) / 2 : null;
  const sideOf = (l) => {
    if (mid === null) return null;
    if (l.x1 - l.x0 > pageWidth * 0.62) return null; // 通栏行，无栏属
    return (l.x0 + l.x1) / 2 < mid ? 'L' : 'R';
  };

  const bands = [];
  let cur = [sorted[0]];
  let prevSide = sideOf(sorted[0]);
  for (let i = 1; i < sorted.length; i += 1) {
    const line = sorted[i];
    const lead = sorted[i - 1].y - line.y;
    const side = sideOf(line);
    // 版面换段：上一行在右栏、本行回到左栏 → 新的版面段开始
    // （同一栏内阅读时不会出现这种左移）
    const layoutSwitch = prevSide === 'R' && side === 'L';
    if (lead > gapThreshold || layoutSwitch) { bands.push(cur); cur = []; }
    cur.push(line);
    if (side !== null) prevSide = side;
  }
  if (cur.length) bands.push(cur);
  return bands;
}

/**
 * 合并相邻的同类版面块。
 * 换块判据（行距/版面换段）偶尔会在同一栏内部误切一刀，产生只含一两行的
 * 碎片块。若相邻两块的栏结构相同、且 y 区间相接，就合并回去。
 */
function coalesceBlocks(blocks) {
  const out = [];
  for (const b of blocks) {
    const prev = out[out.length - 1];
    if (!prev) { out.push(b); continue; }
    const sameLayout = (prev.gutter === null) === (b.gutter === null);
    if (!sameLayout) { out.push(b); continue; }
    const ys = (g) => [Math.min(...g.lines.map((l) => l.y)), Math.max(...g.lines.map((l) => l.y))];
    const [pMin, pMax] = ys(prev);
    const [bMin, bMax] = ys(b);
    // y 区间相接或重叠（容差取 1 行左右），且块本身不宽（宽块通常是通栏元素）
    const adjacent = bMax >= pMin - 14 && pMax >= bMin - 14;
    if (adjacent && b.lines.length <= 3) {
      prev.lines.push(...b.lines);
      continue;
    }
    out.push(b);
  }
  return out;
}

/**
 * 一页的版面块序列。
 * 先纵向切块，再对「够大够宽」的块做递归划分（块内仍可能是
 * 「通栏公式 + 双栏正文」，第 4 页就有这种情况），最后合并同类碎片块。
 */
function pageBlocks(lines, pageWidth) {
  // 整页直接做递归版面划分：partitionLayout 会自行处理
  // 「通栏摘要框 + 双栏正文」这类上下并存的混合版面。
  // 不再先做纵向切块——切块会在换段处切断行序，
  // 使碎片块丢失中缝归属，反而把左右栏的行并成一句。
  return coalesceBlocks(partitionLayout(lines, pageWidth, 0));
}

/**
 * 递归版面划分：在当前行集合里找中缝，把窄行归入左/右栏，
 * 跨栏的宽行作为「遗留元素」按 y 分成上、下两组并递归。
 * 这样块内若还有「通栏公式 + 双栏正文」也能正确还原阅读顺序。
 */
function partitionLayout(lines, pageWidth, depth = 0) {
  if (lines.length === 0) return [];
  if (lines.length < 12 || depth > 6) return [{ lines, gutter: null }];

  const colInfo = detectColumns(lines.map((l) => ({ x0: l.x0, x1: l.x1 })), pageWidth);
  if (colInfo.columns !== 2) return [{ lines, gutter: null }];

  const { gutterStart, gutterEnd } = colInfo;
  const gutter = { start: gutterStart, end: gutterEnd };
  const mid = (gutterStart + gutterEnd) / 2;
  const wideLimit = pageWidth * 0.62;

  const left = lines.filter((l) => l.x1 <= gutterEnd && l.x1 - l.x0 <= wideLimit);
  const right = lines.filter((l) => l.x0 >= gutterStart && l.x1 - l.x0 <= wideLimit);
  const claimed = new Set([...left, ...right]);
  const rest = lines.filter((l) => !claimed.has(l));

  // 明确跨栏的行才算「遗留元素」；其余窄行按中缝归属
  const spanning = rest.filter((l) => l.x1 - l.x0 > wideLimit
    || (l.x0 < gutterStart && l.x1 > gutterEnd));
  const spanSet = new Set(spanning);
  for (const l of rest) {
    if (spanSet.has(l)) continue;
    if ((l.x0 + l.x1) / 2 < mid) left.push(l); else right.push(l);
  }
  // 通栏摘要的末行往往很短，不能只按行宽将其划到左栏正文。
  if (spanning.length && left.length && right.length) {
    const bothStart = Math.min(Math.max(...left.map((l) => l.y)), Math.max(...right.map((l) => l.y)));
    for (const side of [left, right]) {
      for (let i = side.length - 1; i >= 0; i -= 1) {
        if (side[i].y > bothStart + side[i].size * 1.5
          && spanning.some((s) => s.y > side[i].y)) spanning.push(...side.splice(i, 1));
      }
    }
  }

  // 通栏内容按垂直位置分隔双栏段，而不是把所有 inside 行提前到正文前面。
  // 首页题名续行、作者、摘要都是通栏，必须完整读完后才开始左右栏正文。
  if (spanning.length) {
    const spans = [...spanning].sort((a, b) => b.y - a.y);
    const bands = [];
    for (const line of spans) {
      const last = bands[bands.length - 1];
      if (last && last[last.length - 1].y - line.y <= Math.max(line.size * 2, 18)) last.push(line);
      else bands.push([line]);
    }
    let remaining = [...left, ...right];
    const ordered = [];
    for (const band of bands) {
      const top = Math.max(...band.map((l) => l.y));
      const bottom = Math.min(...band.map((l) => l.y));
      const aboveBand = remaining.filter((l) => l.y > top + 1);
      ordered.push(...partitionLayout(aboveBand, pageWidth, depth + 1));
      const sameBand = remaining.filter((l) => l.y <= top + 1 && l.y >= bottom - 1);
      ordered.push({ lines: [...band, ...sameBand], gutter: null });
      remaining = remaining.filter((l) => l.y < bottom - 1);
    }
    ordered.push(...partitionLayout(remaining, pageWidth, depth + 1));
    return ordered;
  }

  const core = [...left, ...right];
  const spanTop = core.length ? Math.max(...core.map((l) => l.y)) : 0;
  const spanBottom = core.length ? Math.min(...core.map((l) => l.y)) : 0;
  const above = spanning.filter((l) => l.y > spanTop);
  const below = spanning.filter((l) => l.y < spanBottom);
  const inside = spanning.filter((l) => l.y <= spanTop && l.y >= spanBottom);

  const out = [];
  if (above.length) out.push(...partitionLayout(above, pageWidth, depth + 1));
  if (inside.length) out.push({ lines: inside, gutter });
  if (left.length) out.push({ lines: left, gutter });
  if (right.length) out.push({ lines: right, gutter });
  if (below.length) out.push(...partitionLayout(below, pageWidth, depth + 1));
  return out;
}

// ─────────────────── 步骤 5：段落重建 ───────────────────

const SECTION_PATTERNS = [
  { re: /^\s*(?:abstract|a\s*b\s*s\s*t\s*r\s*a\s*c\s*t)\b/iu, tag: 'ABSTRACT' },
  { re: /^\s*(?:\d+\.?\s*)?introduction\b/iu, tag: 'INTRODUCTION' },
  { re: /^\s*(?:\d+\.?\s*)?(?:results?|experiments?|experimental)\b/iu, tag: 'RESULTS' },
  { re: /^\s*(?:\d+\.?\s*)?(?:discussions?)\b/iu, tag: 'DISCUSSION' },
  { re: /^\s*(?:\d+\.?\s*)?(?:conclusions?|summary)\b/iu, tag: 'CONCLUSION' },
  { re: /^\s*(?:\d+\.?\s*)?(?:methods?|materials?\s+and\s+methods?)\b/iu, tag: 'METHODS' },
  { re: /^\s*(?:references?|bibliography)\s*$/iu, tag: 'REFERENCES' },
  { re: /^\s*(?:acknowledge?ments?)\b/iu, tag: 'ACKNOWLEDGMENTS' },
  { re: /^\s*(?:supplementary|supporting\s+information)\b/iu, tag: 'SUPPLEMENTARY' },
];

function tagParagraph(p) {
  if (p.type !== 'heading') return null;
  for (const s of SECTION_PATTERNS) if (s.re.test(p.text)) return s.tag;
  return null;
}

/** 角标最终修正：把被空格隔开的 ^{} / _{} 贴回基准词（幂等） */
function withScripts(line) {
  let t = line.text ?? '';
  for (let i = 0; i < 3; i += 1) {
    const next = t
      .replace(/([\p{L}\p{N})\]])[ ]+([_^]\{)/gu, '$1$2')
      .replace(/([_^]\{[^}]{1,6}\})[ ]+([_^]\{)/gu, '$1$2')
      .replace(/([_^]\{[^}]{1,6}\})[ ]+([_^]\{)/gu, '$1$2');
    if (next === t) break;
    t = next;
  }
  return t.replace(/(?<![\w$])([\p{L}\p{N}]+(?:[_^]\{[^}]+\}[\p{L}\p{N}]*)+)/gu, '$$$1$$');
}

function endsSentence(t) { return /[.!?。！？:;]["')\]]?$/u.test(t.trim()); }

function lineSourceIds(line) { return [...new Set(line.runs.flatMap(r => r.itemIds || []).filter(Boolean))]; }
function appendSource(target, source) {
  target.sourceIds = [...(target.sourceIds || []), ...(source.sourceIds || [])];
  target.sourcePages = [...new Set([...(target.sourcePages || []), ...(source.sourcePages || [])])];
}

/** 行 → 段落 */
function linesToParagraphs(lines, ctx) {
  const { bodyLeft, bodyRight, bodySize, role, page } = ctx;
  const paras = [];
  let cur = null;

  // 标题编号常与标题分成两个 PDF item，合回同一基线以便保留层级。
  const normalized = [];
  for (const line of lines) {
    const prev = normalized[normalized.length - 1];
    if (prev && /^\d+(?:\.\d+)*\.?$/u.test(prev.text.trim())
      && Math.abs(prev.y - line.y) < line.size * 0.3
      && line.x0 > prev.x1 && line.x0 - prev.x1 < line.size * 5) {
      prev.text += ` ${line.text}`; prev.x1 = line.x1; prev.runs = [...prev.runs, ...line.runs]; continue;
    }
    normalized.push({ ...line });
  }
  for (const ln of normalized) {
    const text = withScripts(ln);
    if (!text) continue;
    if (cur?.type === 'caption' && (Math.abs(cur.size - ln.size) > 0.35
      || (cur.lastY ?? cur.y0) - ln.y > Math.max(cur.size, ln.size) * 1.8)) {
      paras.push(cur); cur = null;
    }

    const numberedHeading = /^\s*\d+(?:\.\d+)*\.?\s+[A-Z][A-Za-z]/u.test(text) && text.length < 100
      && !/[=,;:[\]”“"$]/u.test(text);
    const sectionHeading = /^(?:\d+(?:\.\d+)*\.?\s+)?(?:abstract|introduction|results?(?: and discussion)?|discussions?|conclusions?|summary|methods?|materials? and methods?|experimental(?: section| setup)?|references?|bibliography|acknowledge?ments?|supporting information|supplementary information)$/iu.test(text.trim());
    const priorHeading = paras[paras.length - 1];
    const headingContinuation = !cur && priorHeading?.type === 'heading'
      && Math.abs(priorHeading.size - ln.size) < 0.15 && priorHeading.y0 - ln.y > 0
      && priorHeading.y0 - ln.y < ln.size * 1.6 && /^[A-Z][A-Za-z -]{1,90}$/u.test(text);
    const isHeading = role !== 'abstract' && (ln.size > bodySize * 1.08 || numberedHeading || sectionHeading || headingContinuation) && text.length < 140;
    const hasRelation = /[=≈≤≥≪≫]/u.test(text);
    const wordCount = (text.match(/[\p{L}]{2,}/gu) ?? []).length;
    const formulaShape = wordCount <= 7;
    // 公式块判定从严：短、符号密集或居中的式子才独立；包含一个等号的完整英文句子仍是正文。
    const isEquation = hasRelation && text.length < 160 && formulaShape
      && MATH_CHARS.test(text) && !isEquationFragment(ln);

    const captionStart = /^(?:FIGURE|TABLE)\s*\d+\b/u.test(text)
      || /^(?:Fig\.|Figure|Table)\s+\d+[.:]\s*/iu.test(text);
    // A line beginning "Figure 1. The continuous ..." may continue the preceding
    // sentence ("as demonstrated in"). It is not necessarily a figure caption.
    const isCaption = role !== 'abstract' && captionStart && (!cur || endsSentence(cur.text)
      || (cur.lastY ?? cur.y0) - ln.y > ln.size * 1.8);
    const provenance = { sourceIds: lineSourceIds(ln), sourcePages: [page], flowId: role === 'abstract' ? 'abstract' : 'body' };

    if (isHeading || isEquation || isCaption || ln.formulaCrop) {
      if (cur) { paras.push(cur); cur = null; }
      const previous = paras[paras.length - 1];
      if (isHeading && !isCaption && previous?.type === 'heading'
        && !/^\d+(?:\.\d+)*\.?\s/u.test(text)
        && Math.abs(previous.size - ln.size) < 0.5 && previous.y0 - ln.y < ln.size * 1.5) {
        previous.text += ` ${text}`; previous.y0 = ln.y; appendSource(previous, provenance); continue;
      }
      const block = { type: ln.formulaCrop ? 'formula-source' : isCaption ? 'caption' : isHeading ? 'heading' : 'equation', text, x0: ln.x0, x1: ln.x1, y0: ln.y, lastY: ln.y, size: ln.size,
        ...provenance, ...(ln.formulaCrop ? { crop: ln.formulaCrop } : {}) };
      if (isCaption && !ln.formulaCrop) cur = block;
      else paras.push(block);
      continue;
    }

    if (!cur) {
      cur = { type: 'para', text, x0: ln.x0, x1: ln.x1, y0: ln.y, lastY: ln.y, size: ln.size, ...provenance };
      continue;
    }

    const indent = ln.x0 - bodyLeft;
    const startsNew = indent > (bodyRight - bodyLeft) * 0.022;
    const bigGap = (cur.lastY ?? cur.y0) - ln.y > ln.size * 1.75;
    const hyphenated = /[A-Za-z]-$/u.test(cur.text);
    const continuation = /[,;(\[]$/u.test(cur.text);
    const sameBlock = !endsSentence(cur.text) || (!startsNew && !bigGap) || hyphenated || continuation;

    if (sameBlock) {
      if (hyphenated) cur.text = cur.text.replace(/-$/u, '') + text;
      else cur.text += ' ' + text;
      cur.x0 = Math.min(cur.x0, ln.x0);
      cur.x1 = Math.max(cur.x1, ln.x1);
      cur.lastY = ln.y;
      appendSource(cur, provenance);
    } else {
      paras.push(cur);
      cur = { type: 'para', text, x0: ln.x0, x1: ln.x1, y0: ln.y, lastY: ln.y, size: ln.size, ...provenance };
    }
  }
  if (cur) paras.push(cur);
  return paras;
}

// ─────────────────── 步骤 6：版式清理 ───────────────────

/**
 * 剔除页眉页脚与页码。
 * 只按「靠近页边界」判断会误伤正文顶部的行，因此需要更强证据：
 * 纯页码样式，或在多页重复出现的短「家具文本」。
 */
function stripRunningHeads(lines, pageHeight, pageNumber, furniture, bodyLineCount) {
  const kept = [];
  const dropped = [];
  const innerText = bodyLineCount ?? lines.length;
  const topEdge = pageHeight * 0.925;
  const bottomEdge = pageHeight * 0.075;

  for (const l of lines) {
    const t = l.text.trim();
    if (/Downloaded from|Wiley Online Library.*(?:rules of use|Terms and Conditions)|Creative Commons License/iu.test(t)) {
      dropped.push({ text: t, reason: 'download-watermark', page: pageNumber }); continue;
    }
    const inTop = l.y >= topEdge;
    const inBottom = l.y <= bottomEdge;
    const inZone = inTop || inBottom;
    if (!inZone) { kept.push(l); continue; }

    const isPageNum = /^[\s|·•\-–—]*(\d{1,4}(?:\s+of\s+\d{1,4})?|[ivxlcIVXLC]{1,6})[\s|·•\-–—]*$/u.test(t)
      || /^\d{4,10}\s*\(\d+\s+of\s+\d+\)$/iu.test(t);
    if (isPageNum) { dropped.push({ text: t, reason: 'pagenum', page: pageNumber }); continue; }

    const furnitureLike = (furniture.has(t) && t.length <= 90)
      || (inTop && /^[A-Z]\.\s+.{1,60}\bet\s+al\.?$/u.test(t))
      || (inBottom && t.length < 140 && /^[A-Z]/u.test(t) && /\b(?:19|20)\d{2}\s*[;,]\s*\d/u.test(t))
      || (t.length <= 90 && /^(vol\.?|no\.?|pp?\.?|issn|doi|https?:|www\.|received|accepted|published|©|\d{4}\s)/iu.test(t));
    if (furnitureLike && innerText >= 6) {
      dropped.push({ text: t, reason: inTop ? 'running-head-top' : 'running-foot', page: pageNumber });
      continue;
    }
    kept.push(l);
  }
  return { kept, dropped };
}

/**
 * 页眉页脚不能简单等同于垃圾：期刊名、DOI、Received/Accepted/Published 日期
 * 经常只出现在那里。正文仍去掉重复家具，但把高价值行单独保存为元数据候选。
 */
function collectPublicationMetadata(pageCache, source) {
  const strong = /\b(?:doi|issn|received|revised|accepted|published|publication|journal|volume|vol\.|issue|copyright)\b|©|10\.\d{4,9}\//iu;
  const candidates = [];
  const add = (text, page, region, score) => {
    const clean = String(text ?? '').replace(/\s+/gu, ' ').trim();
    if (clean.length < 3 || clean.length > 500) return;
    candidates.push({ text: clean, page, region, score });
  };

  for (const pc of pageCache) {
    for (const line of pc.lines) {
      const region = line.y >= pc.height * 0.925 ? 'header'
        : (line.y <= pc.height * 0.075 ? 'footer' : 'body');
      if (strong.test(line.text)) add(line.text, pc.p, region, 100);
      // 第一页上部通常包含标题、作者、单位和期刊抬头；保留有限数量供模型辨认。
      else if (pc.p === 1 && pc.frontLines?.includes(line)) add(line.text, pc.p, line.regionRole, 40);
      else if (pc.p === 1 && line.y >= pc.height * 0.78) add(line.text, pc.p, 'first-page-top', 40);
      else if (region !== 'body' && /[A-Za-z]{3,}/u.test(line.text) && line.text.length <= 180) add(line.text, pc.p, region, 40);
    }
  }
  if (source.title) add(`原文标题: ${source.title}`, 0, 'pdf-metadata', 120);
  if (source.author) add(`作者: ${source.author}`, 0, 'pdf-metadata', 120);
  if (source.subject) add(`PDF Subject: ${source.subject}`, 0, 'pdf-metadata', 110);
  if (source.creationDate) add(`PDF CreationDate: ${source.creationDate}`, 0, 'pdf-metadata', 80);

  const seen = new Set();
  return candidates
    .sort((a, b) => b.score - a.score || a.page - b.page)
    .filter((item) => {
      const key = item.text.toLocaleLowerCase();
      if (seen.has(key)) return false;
      seen.add(key); return true;
    })
    .slice(0, 100)
    .map(({ score, ...item }) => item);
}

// ─────────────────── 单页处理 ───────────────────

function extractPageParagraphs(pc, furniture, ctx, opts, out) {
  const { bodyLeft, bodyRight, bodySize } = ctx;
  if (pc.manual) {
    out.stats.columns.push({ page: pc.p, columns: 1 });
    return pc.regions.filter(r => ARTICLE_ROLES.includes(r.role)).sort((a,b) => a.order-b.order).flatMap(r => {
      const lines = pc.lines.filter(l => l.manualRegion === r.id).sort((a,b) => b.y-a.y || a.x0-b.x0);
      const sourceIds = r.itemIds, sourcePages = [pc.p], flowId = r.role === 'body' ? 'body' : `manual-${pc.p}-${r.id}`;
      const text = lines.map(l => l.text).join(' ');
      if (r.role === 'table' || r.role === 'figure') return [mediaParagraph(pc,r,opts)];
      if (r.role === 'formula') return [{ type: 'formula-source', text, sourceIds, sourcePages, flowId,
        crop: { page: pc.p, left: r.bbox[0], bottom: r.bbox[1], right: r.bbox[2], top: r.bbox[3] } }];
      if (r.role === 'heading' || r.role === 'caption') return [{ type: r.role, text:r.captionText||text, sourceIds, sourcePages, flowId }];
      const safe = markFormulaRegions(lines, { left: r.bbox[0], right: r.bbox[2], page: pc.p });
      const paras = linesToParagraphs(safe, { bodyLeft: r.bbox[0], bodyRight: r.bbox[2], bodySize, role: r.role, page: pc.p });
      return paras.map(p => ({ ...p, flowId }));
    });
  }

  const { kept: cleaned, dropped } = stripRunningHeads(pc.lines, pc.height, pc.p, furniture, pc.bodyLines.length);
  for (const d of dropped) out.dropped.push(d);
  const droppedText = new Set(dropped.map(d => d.text));
  for (const line of pc.lines.filter(l => droppedText.has(l.text.trim()))) {
    registerRegion(pc, [line], 'running-matter', 'page-edge-or-watermark', null);
  }
  // 首页出版信息在独立元数据区保留，不再与摘要/正文混排。
  const kept = cleaned.filter((l) => !pc.frontLines?.includes(l) && !['abstract','table','figure','caption'].includes(l.regionRole));
  const abstractLines = cleaned.filter(l => l.regionRole === 'abstract');

  // 版面划分：递归处理「通栏摘要框 + 双栏正文」这类上下并存的混合版面，
  // 使摘要独立成组、正文左右栏各自成组。
  const groups = [ ...(abstractLines.length ? [{ lines: abstractLines, gutter: null, role: 'abstract' }] : []),
    ...pageBlocks(kept, pc.width).flatMap(g => splitWidthTransitions(g, pc.width)) ];

  // 组内防护：把任何「跨越中缝的非通栏行」拆回两栏。
  // 拼接可能发生在 run 聚合、行聚合或任何后续步骤，这里作为最后一道不变式，
  // 使阅读顺序的正确性不再依赖「拼接发生在哪一步」这类脆弱假设。
  for (const g of groups) {
    g.lines = splitCrossGutterLines(g.lines, pc.width);
  }

  const sawTwoColumn = groups.some((g) => g.gutter !== null)
    || abstractLines.length > 0 && kept.some(l => l.x0 > Math.max(...abstractLines.map(a => a.x1)));
  out.stats.columns.push({ page: pc.p, columns: sawTwoColumn ? 2 : 1 });

  if (opts.debugCols) {
    for (const g of groups) {
      const ys = g.lines.map((l) => l.y);
      console.error(`[group p${pc.p}] n=${g.lines.length} `
        + `gutter=${g.gutter ? `[${g.gutter.start.toFixed(0)},${g.gutter.end.toFixed(0)}]` : 'none'} `
        + `y=[${Math.min(...ys).toFixed(0)},${Math.max(...ys).toFixed(0)}] head="${g.lines[0].text.slice(0, 38)}"`);
    }
  }

  // --dump-layout：逐行打印分组与栏属，用于定位跨栏合并
  if (opts.dumpLayout) {
    // 按栏分别打印左右两栏在该页的内容，便于并排比对
    const gut = groups.find((g) => g.gutter)?.gutter ?? null;
    if (gut) {
      const colOf = (l) => {
        const c = (l.x0 + l.x1) / 2;
        if (c < gut.start) return 'L';
        if (c > gut.end) return 'R';
        return 'SPAN';
      };
      const all = groups.flatMap((g) => g.lines);
      console.error(`\n=== left column (p${pc.p}) ===`);
      for (const l of all.filter((l) => colOf(l) === 'L').sort((a, b) => b.y - a.y).slice(0, 6)) {
        console.error(`  y=${l.y.toFixed(0).padStart(4)} [${l.x0.toFixed(0)},${l.x1.toFixed(0)}] ${l.text.slice(0, 74)}`);
      }
      console.error(`=== right column (p${pc.p}) ===`);
      for (const l of all.filter((l) => colOf(l) === 'R').sort((a, b) => b.y - a.y).slice(0, 6)) {
        console.error(`  y=${l.y.toFixed(0).padStart(4)} [${l.x0.toFixed(0)},${l.x1.toFixed(0)}] ${l.text.slice(0, 74)}`);
      }
      console.error('=== SPAN lines (跨栏) ===');
      for (const l of all.filter((l) => colOf(l) === 'SPAN').sort((a, b) => b.y - a.y).slice(0, 8)) {
        console.error(`  y=${l.y.toFixed(0).padStart(4)} [${l.x0.toFixed(0)},${l.x1.toFixed(0)}] ${l.text.slice(0, 74)}`);
      }
    }
  }

  const pageParas = [];
  for (const g of groups) {
    if (g.role === 'abstract') {
      const region = pc.regions.find(r => r.role === 'abstract');
      region.flow = 'article'; region.order = 1;
      const labels = g.lines.filter(l => /^a\s*b\s*s\s*t\s*r\s*a\s*c\s*t\s*$/iu.test(l.text.trim()));
      pageParas.push({ type: 'heading', text: 'ABSTRACT', sourceIds: labels.flatMap(lineSourceIds), sourcePages: [pc.p], flowId: 'abstract' });
      g.lines = g.lines.filter(l => !labels.includes(l));
    } else registerRegion(pc, g.lines, 'body', 'column-geometry+width-transition', 'article');
    const ordered = [...g.lines].sort((a, b) => Math.round(b.y * 4) - Math.round(a.y * 4) || a.x0 - b.x0);
    const merged = mergeFragments(ordered, g.gutter);
    const localLeft = Math.min(...merged.map((l) => l.x0));
    const localRight = Math.max(...merged.map((l) => l.x1));
    const safeLines = markFormulaRegions(merged, { left: localLeft, right: localRight, page: pc.p });
    for (const para of linesToParagraphs(safeLines, { bodyLeft: localLeft, bodyRight: localRight, bodySize, role: g.role, page: pc.p })) {
      const previous = pageParas[pageParas.length - 1];
      if (previous?.type === 'para' && para.type === 'para' && previous.flowId === para.flowId && !endsSentence(previous.text)
        && (/^[a-z]/u.test(para.text) || /-$/u.test(previous.text))) {
        previous.text = previous.text.replace(/-$/u, '') + (/-$/u.test(previous.text) ? '' : ' ') + para.text;
        appendSource(previous, para);
      } else pageParas.push(para);
    }
  }
  // Floating objects come after the page's prose, never between two fragments of
  // a sentence. Ownership is still audited even for explicitly omitted contents.
  for(const r of pc.regions.filter(r=>['caption','table','figure'].includes(r.role))) {
    if(r.role==='caption') pageParas.push({type:'caption',text:r.captionText||pc.lines.filter(l=>l.manualRegion===r.id).sort((a,b)=>b.y-a.y).map(l=>l.text).join(' '),sourceIds:r.itemIds,sourcePages:[pc.p],flowId:`caption-${r.id}`});
    else pageParas.push(mediaParagraph(pc,r,opts));
  }
  return pageParas;
}

function mediaParagraph(pc,r,opts){
 const members=pc.rawItems.filter(i=>r.itemIds.includes(i.sourceId));
 const base={type:r.role,text:r.label||`${r.role==='table'?'Table':'Figure'} (page ${pc.p})`,sourceIds:r.itemIds,sourcePages:[pc.p],flowId:`media-${r.id}`,
   crop:{page:pc.p,left:r.bbox[0],bottom:r.bbox[1],right:r.bbox[2],top:r.bbox[3]}};
 if(r.role==='table'&&opts.tables){
   base.rows=tableGrid(members,r.bbox,pc.graphics,cell=>groupLines(buildRuns(cell)).map(l=>l.text).join(' ')
     .replace(/([\p{L}\d]+(?:[_^]\{[^{}]+\})+)/gu,m=>`$${m}$`));
   if(!base.rows)throw new Error(`第 ${pc.p} 页表格无法可靠还原行列或符号（复杂横表、缺失字形等）。请纠正表格框；也可将此表设为忽略并保留题注，或关闭表格内容翻译后重试。不会把单元格串成正文。`);
 }
 base.omitted=r.role==='table'?!opts.tables:!opts.figures;
 return base;
}

function registerRegion(pc, lines, role, evidence, flow) {
  const claimed = new Set(pc.regions.flatMap(r => r.itemIds));
  const ids = [...new Set(lines.flatMap(lineSourceIds))].filter(id => !claimed.has(id));
  if (!ids.length) return;
  const members = pc.rawItems.filter(i => ids.includes(i.sourceId));
  pc.regions.push({ id: `p${pc.p}-r${pc.regions.length + 1}`, role, flow,
    order: flow ? pc.regions.filter(r => r.flow === flow).length + 1 : null,
    evidence, confidence: 'rule-supported', bbox: unionBoxes(members.map(itemBox)), itemIds: ids });
}

/** A body flow can widen below a side panel. Split only persistent, large left-edge
 * changes, not ordinary indentation, short final lines, or a centered equation.
 */
function splitWidthTransitions(group, width) {
  if (group.gutter || group.lines.length < 8) return [group];
  const lines = [...group.lines].sort((a, b) => Math.round(b.y * 4) - Math.round(a.y * 4) || a.x0 - b.x0);
  const result = [], threshold = width * 0.06;
  let current = [], start = lines[0].x0;
  for (let i = 0; i < lines.length; i++) {
    const following = lines.slice(i, i + 3);
    if (current.length >= 3 && following.length === 3 && Math.abs(lines[i].x0 - start) > threshold
      && following.every(l => Math.abs(l.x0 - lines[i].x0) < 18)) {
      result.push({ ...group, lines: current }); current = []; start = lines[i].x0;
    }
    current.push(lines[i]);
  }
  if (current.length) result.push({ ...group, lines: current });
  return result;
}

/** Keep native ownership/crops until unmerged glyphs can reconstruct the math. */
function markFormulaRegions(lines, { left, right, page }) {
  const mathLike = (line) => {
    const text = line.text.normalize('NFKC');
    const words = text.match(/[A-Za-z]{3,}/gu) ?? [];
    return words.filter((w) => !['approx', 'times', 'leq', 'geq', 'frac', 'neq'].includes(w)).length <= 2
      && !words.some(w => /^[A-Za-z]{7,}$/u.test(w) && !['approx', 'infty'].includes(w))
      && !words.some(w => /^[a-z]{4,}$/u.test(w)
        && !['approx', 'times', 'frac', 'infty', 'load'].includes(w))
      && !/[A-Za-z]\s*:\s*$/u.test(text)
      && text.length < 220 && !/^\d+(?:\.\d+)+\.?\s+[A-Z]|^\d+\.?\s+(?:Introduction|Conclusions?|Results?|Discussion|Methods?|Abstract)\b/u.test(text);
  };
  const seed = (line) => mathLike(line) && /[=≈≠≤≥]|\\approx/u.test(line.text);
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!seed(lines[i])) { out.push(lines[i]); continue; }
    const region = [lines[i]];
    while (out.length && mathLike(out[out.length - 1])
      && out[out.length - 1].y - region[0].y < 20
      && !/^[A-Z][a-z]+/u.test(out[out.length - 1].text)) region.unshift(out.pop());
    while (i + 1 < lines.length && mathLike(lines[i + 1])
      && region[region.length - 1].y - lines[i + 1].y < 20) region.push(lines[++i]);
    const top = Math.max(...region.map((l) => l.y + l.size)) + 3;
    const bottom = Math.min(...region.map((l) => l.y - l.size * 0.35)) - 3;
    out.push({ ...region[0], text: region.map((l) => l.text).join(' '), runs: region.flatMap(l => l.runs),
      formulaCrop: { page, left: Math.max(0, left - 3), right: right + 3, top, bottom } });
  }
  return out;
}

async function renderFormulaSources(doc, result, opts) {
  let createCanvas;
  try {
    const requirePdf = createRequire(requireFromHere.resolve('pdfjs-dist/package.json'));
    ({ createCanvas } = requirePdf('@napi-rs/canvas'));
  } catch { /* 没有原生渲染器时明确提示，不把损坏文本伪装成公式。 */ }
  let sequence = 0, figureSequence = 0;
  for (const page of result.pages) {
    const formulas = page.paragraphs.filter((p) => p.type === 'formula-source' && !p.formula?.reliable && opts.formulaFallback!==false || p.type === 'figure' && !p.omitted);
    if (!formulas.length) continue;
    let sourcePage;
    if (createCanvas) sourcePage = await doc.getPage(page.page);
    for (const para of formulas) {
      const figure=para.type==='figure', number=figure?++figureSequence:++sequence;
      const kind=figure?'figures':'formulas', folder=join(opts.out,opts.name,kind);
      if (!createCanvas) { para.formulaWarning = true; continue; }
      const crop = para.crop;
      const scale = 2;
      const width = Math.ceil((crop.right - crop.left) * scale);
      const height = Math.ceil((crop.top - crop.bottom) * scale);
      if (width <= 0 || height <= 0 || width * height > 4_000_000) { para.formulaWarning = true; continue; }
      const canvas = createCanvas(width, height);
      try {
        await sourcePage.render({ canvasContext: canvas.getContext('2d'),
          viewport: sourcePage.getViewport({ scale }),
          transform: [1, 0, 0, 1, -crop.left * scale, -(page.height - crop.top) * scale],
          background: 'rgb(255,255,255)',
        }).promise;
        await mkdir(folder, { recursive: true });
        const name = `p${page.page}-${number}-${opts.sourceHash}.png`;
        await writeFile(join(folder, name), canvas.toBuffer('image/png'));
        const imagePath = `${opts.assetPrefix ?? `${opts.name}`}/${kind}/${name}`;
        para.image = opts.fileRoute ? `${opts.fileRoute}?path=${encodeURIComponent(imagePath)}` : imagePath;
      } catch (err) { para.formulaWarning = true; }
      finally { canvas.width = 0; canvas.height = 0; }
    }
    sourcePage?.cleanup();
  }
  result.stats.formulaSources = sequence;
  result.stats.figureSources = figureSequence;
}

async function resolveFormulaSources(doc,result,cache,opts){
 let converted=0,uncertain=0;
 let validator;
 try{const module={exports:{}};vm.runInNewContext(await readFile(join(HERE,'../vendor/katex.min.js'),'utf8'),{module,exports:module.exports});validator=module.exports;}
 catch{/* Missing validator must not turn an unrenderable candidate into a confirmed formula. */}
 for(const p of result.pages){
  const formulas=p.paragraphs.filter(b=>b.type==='formula-source');if(!formulas.length)continue;
  const pc=cache.find(c=>c.p===p.page),page=await doc.getPage(p.page);
  let glyphs=[],error=null;
  try{glyphs=await readMathGlyphs(page,(await loadPdfjs()).OPS,formulas.map(f=>f.crop));}
  catch{error='native-glyph-decoding-unavailable';}
  for(const f of formulas){
   f.formula=error?{latex:'',reliable:false,reasons:[error]}:reconstructFormula({glyphs,items:pc.rawItems.filter(i=>f.sourceIds.includes(i.sourceId)),paths:pc.graphics.paths,crop:f.crop});
   if(f.formula.reliable){
    try{if(!validator)throw new Error('validator unavailable');validator.renderToString(f.formula.latex,{throwOnError:true,displayMode:true,strict:false});}
    catch{f.formula.reliable=false;f.formula.reasons.push('latex-render-check-failed');}
   }
   f.formula.format=f.formula.reliable?'latex':opts.formulaFallback!==false?'image':'unverified-text';
   if(f.formula.reliable)converted++;
   else{uncertain++;pc.warnings.push(`formula-review: ${f.formula.reasons.join(',')} (${f.formula.format})`);}
  }
  page.cleanup();
 }
 result.stats.formulaLatex=converted;result.stats.formulaUncertain=uncertain;
}

function nativeCanvas(width, height) {
  const requirePdf = createRequire(requireFromHere.resolve('pdfjs-dist/package.json'));
  return requirePdf('@napi-rs/canvas').createCanvas(width, height);
}

async function renderBoundedPage(page, longest = 1100) {
  const unit = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: Math.min(1.5, longest / Math.max(unit.width, unit.height)) });
  const canvas = nativeCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  try {
    await page.render({ canvasContext: canvas.getContext('2d'), viewport, background: 'rgb(255,255,255)' }).promise;
    return { canvas, viewport };
  } catch (error) { canvas.width = 0; canvas.height = 0; throw error; }
}

async function renderLayoutPreviews(doc, cache, opts) {
  if (!opts.previewPages) return [];
  const wanted = parsePageRange(opts.previewPages, doc.numPages);
  if (!wanted) throw new Error('--preview-pages 页码范围无效');
  const previews = [];
  const folder = join(opts.out, opts.name, 'layout');
  await mkdir(folder, { recursive: true });
  for (const pc of cache) {
    if (!wanted.has(pc.p)) continue;
    const page = await doc.getPage(pc.p);
    let rendered;
    try {
      rendered = await renderBoundedPage(page, 1600);
      const { canvas, viewport } = rendered, ctx = canvas.getContext('2d');
      const scale = viewport.scale;
      for (const r of pc.regions) {
        const [x0, y0, x1, y1] = r.bbox;
        const color = r.role === 'abstract' ? '#b45309' : r.flow === 'article' ? '#1d4ed8' : '#7e22ce';
        const x = x0 * scale, y = (pc.height - y1) * scale, w = (x1 - x0) * scale, h = (y1 - y0) * scale;
        ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.strokeRect(x, y, w, h);
        const label = `${r.order ? `${r.order}: ` : ''}${r.role} [${r.id}]`;
        ctx.font = 'bold 13px sans-serif';
        const tw = ctx.measureText(label).width + 8;
        ctx.fillStyle = color; ctx.fillRect(x, Math.max(0, y - 17), tw, 17);
        ctx.fillStyle = '#ffffff'; ctx.fillText(label, x + 4, Math.max(13, y - 4));
      }
      const file = `p${pc.p}-${opts.sourceHash}.png`;
      await writeFile(join(folder, file), canvas.toBuffer('image/png'));
      previews.push({ page: pc.p, file: `layout/${file}` });
    } catch (error) {
      pc.warnings.push(`preview-unavailable: ${error.message}`);
    } finally {
      if (rendered) { rendered.canvas.width = 0; rendered.canvas.height = 0; }
      page.cleanup();
    }
  }
  return previews;
}

// ─────────────────── 主流程 ───────────────────

async function extract(pdfPath, opts) {
  const lib = await loadPdfjs();
  const data = new Uint8Array(await readFile(pdfPath));
  opts.sourceHash = createHash('sha256').update(data).digest('hex').slice(0, 12);
  const task = lib.getDocument({ data, useSystemFonts: false, isEvalSupported: false, verbosity: 0 });
  const doc = await task.promise;

  const total = doc.numPages;
  const wanted = opts.pages ? parsePageRange(opts.pages, total) : null;
  if (opts.debugCols) console.error(`[debug] numPages=${total}`);

  const out = {
    source: {
      path: pdfPath, file: basename(pdfPath), pages: total,
      title: null, author: null, subject: null, keywords: null, creationDate: null,
      metadataCandidates: [],
    },
    pages: [],
    dropped: [],
    stats: { pagesProcessed: 0, paragraphs: 0, columns: [] },
  };

  // 第一趟：抽取文本，区分正文区与页眉页脚区
  const pageCache = [];
  const overrides = opts.overrides ? JSON.parse(await readFile(opts.overrides, 'utf8')) : null;
  if (overrides && overrides.sourceHash !== opts.sourceHash) throw new Error('人工分区已过期：PDF 内容已更改');
  for (let p = 1; p <= total; p += 1) {
    if (wanted && !wanted.has(p)) continue;
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent({ includeMarkedContent: false });
    const originalItems = tc.items.filter((i) => typeof i.str === 'string');
    let panels = [], panelWarning = null;
    if (p === 1 && !originalItems.some(i => /^abstract$/iu.test(i.str.trim()))) {
      let rendered;
      try {
        rendered = await renderBoundedPage(page);
        const { canvas } = rendered;
        panels = detectShadedPanels(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height), vp.width, vp.height);
      } catch { panelWarning = 'panel-detection-unavailable: first-page shaded panels could not be inspected locally'; }
      finally { if (rendered) { rendered.canvas.width = 0; rendered.canvas.height = 0; } }
    }
    const semantic = identifyPageRegions(originalItems, { page: p, width: vp.width, height: vp.height, panels });
    const graphics = await pageGraphics(page, (await loadPdfjs()).OPS);
    const manual = overrides?.pages?.[p];
    if (manual) {
      semantic.regions = manual;
      const owners = new Map(manual.flatMap(r => r.itemIds.map(id => [id, r.id])));
      for (const item of semantic.items) item.regionId = owners.get(item.sourceId);
      semantic.warnings = [];
    }
    else identifyMedia(semantic,{page:p,width:vp.width,height:vp.height,graphics,
      previousTables:pageCache.at(-1)?.regions.filter(r=>r.role==='table')||[]});
    const rawItems = semantic.items, lines = [];
    // Build text independently inside each identified region. Once two native PDF
    // items have been fused across a panel edge, no later prompt can undo it.
    const bundles = [...semantic.regions.map(r => ({ id: r.id, role: r.role, items: rawItems.filter(i => i.regionId === r.id) })),
      { role: 'body', items: rawItems.filter(i => !i.regionId) }];
    for (const bundle of bundles) {
      if (bundle.role === 'watermark') continue;
      const rawColumns = manual || bundle.role === 'abstract' ? { columns: 1 } : detectColumns(bundle.items.filter(i => i.str.length > 35
        && i.width < vp.width * 0.62 && i.height > 5).map(i => ({ x0: i.transform[4], x1: i.transform[4] + i.width })), vp.width);
      const gutter = rawColumns.columns === 2 ? { start: rawColumns.gutterStart, end: rawColumns.gutterEnd } : null;
      const debug = { dumpLayout: opts.dumpLayout, page: p, pageWidth: vp.width, gutter };
      lines.push(...groupLines(buildRuns(bundle.items, debug), debug).filter(l => l.text.trim()).map(l => ({ ...l, regionRole: bundle.role, manualRegion: bundle.id })));
    }
    const abstract = p === 1 ? lines.find((l) => /^abstract$/iu.test(l.text.trim())) : null;
    const frontLines = manual ? lines.filter(l => !ARTICLE_ROLES.includes(l.regionRole))
      : lines.filter(l => !ARTICLE_ROLES.includes(l.regionRole)
        || abstract && l.y > abstract.y + 2 && l.regionRole !== 'abstract');
    const topEdge = vp.height * 0.925;
    const bottomEdge = vp.height * 0.075;
    const inZone = (l) => l.y >= topEdge || l.y <= bottomEdge;
    pageCache.push({
      p,
      width: vp.width,
      height: vp.height,
      lines,
      frontLines,
      rawItems,
      manual: !!manual,
      graphics,
      regions: semantic.regions,
      warnings: [...semantic.warnings, ...(panelWarning ? [panelWarning] : []),
        ...(page.rotate % 360 ? ['unresolved-page-rotation: rotated page coordinates require review'] : []),
        ...(Math.abs(page.view[0]) > 0.1 || Math.abs(page.view[1]) > 0.1 ? ['unresolved-page-origin: cropped page origin requires review'] : [])],
      bodyLines: lines.filter((l) => !inZone(l)),
      zoneLines: lines.filter(inZone),
    });
    page.cleanup();
  }

  // Manual mode can always expose native text geometry, even when automatic
  // paragraph reconstruction fails. Scans without native text remain unsupported.
  if (opts.rawLayout) {
    for (const pc of pageCache) {
      const claimed = new Set(pc.regions.flatMap(r => r.itemIds));
      const rest = pc.rawItems.filter(i => i.str.trim() && !claimed.has(i.sourceId));
      if (rest.length) pc.regions.push({ id: `p${pc.p}-raw-body`, role: 'body', bbox: unionBoxes(rest.map(itemBox)),
        itemIds: rest.map(i => i.sourceId), flow: 'article', order: 1, confidence: 'unreviewed' });
    }
    out.layout = { version: REGION_VERSION, sourceHash: opts.sourceHash, coverage: { ok: false }, previews: [],
      warnings: [], blockingWarnings: [], blocks: [], pages: pageCache.map(pc => ({ page: pc.p, width: pc.width, height: pc.height,
        regions: pc.regions, items: pc.rawItems.filter(i => i.str.trim()).map(i => ({ id: i.sourceId, text: i.str, bbox: itemBox(i) })) })) };
    await task.destroy();
    return out;
  }

  // 正文字号：正文区里较长行的中位数
  const probe = [];
  for (const pc of pageCache) for (const l of pc.bodyLines) if (l.text.length > 60) probe.push(l.size);
  let bodySize;
  if (probe.length) {
    probe.sort((a, b) => a - b);
    bodySize = probe[Math.floor(probe.length / 2)];
  } else {
    const all = pageCache.flatMap((x) => x.lines).map((l) => l.size).sort((a, b) => a - b);
    bodySize = all.length ? all[Math.floor(all.length / 2)] : 10;
  }

  // 跨页重复出现的短文本 = 家具（页眉/页脚/期刊名）
  const pageCount = pageCache.length || 1;
  const counts = new Map();
  for (const pc of pageCache) {
    const uniq = new Set();
    for (const l of pc.zoneLines) {
      const t = l.text.trim();
      if (t && t.length <= 90) uniq.add(t);
    }
    for (const t of uniq) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const furniture = new Set();
  for (const [t, n] of counts) if (n >= Math.max(2, Math.ceil(pageCount * 0.6))) furniture.add(t);

  // 正文左右边界（5% / 95% 分位，避免个别越界元素拉偏）
  const cleanBody = pageCache.flatMap((x) => x.bodyLines).filter((l) => !furniture.has(l.text.trim()));
  const wide = cleanBody.filter((l) => l.text.length > 40);
  const ref = wide.length >= 4 ? wide : cleanBody;
  let bodyLeft = 0;
  let bodyRight = pageCache[0]?.width ?? 600;
  if (ref.length) {
    const xs0 = ref.map((l) => l.x0).sort((a, b) => a - b);
    const xs1 = ref.map((l) => l.x1).sort((a, b) => b - a);
    bodyLeft = xs0[Math.floor(xs0.length * 0.05)];
    bodyRight = xs1[Math.floor(xs1.length * 0.05)];
  }

  // 第二趟：逐页还原阅读顺序 → 段落 → 跨页续段合并
  let pending = null;
  let refsStarted = false;

  for (const pc of pageCache) {
    const pageParas = extractPageParagraphs(pc, furniture, { bodyLeft, bodyRight, bodySize }, opts, out);
    const columns = out.stats.columns[out.stats.columns.length - 1].columns;

    for (const para of pageParas) {
      const tag = tagParagraph(para);
      if (tag === 'REFERENCES') refsStarted = true;
      if (tag === 'ABSTRACT') refsStarted = false;
      para.section = tag ?? (refsStarted ? 'REFERENCES' : null);
    }

    // 跨页续段：pending 可能跨多页累积，只累加、不覆盖
    if (pending && pageParas.length) {
    const first = pageParas.find(p => !['caption','table','figure'].includes(p.type));
      if (first?.type === 'para' && first.flowId === pending.flowId
        && (/^[a-z]/u.test(first.text) || /-$/u.test(pending.text)) && !first.section) {
        const glue = /-$/u.test(pending.text) ? '' : ' ';
        pending.text = (pending.text.replace(/-$/u, '') + glue + first.text).replace(/\s{2,}/gu, ' ').trim();
        appendSource(pending, first);
        pageParas.splice(pageParas.indexOf(first), 1);
      }
    }
    // Pending is a reference to an already retained paragraph, never a removed
    // paragraph. A heading/caption cannot make it disappear or move its anchor.
    const carried = pending;
    pending = null;

    const last = pageParas.findLast(p=>!['caption','table','figure'].includes(p.type));
    if (last && last.type === 'para' && last.flowId === 'body' && !endsSentence(last.text) && !last.section) {
      pending = last;
    } else if (!pageParas.some(p => !['caption','table','figure'].includes(p.type)) && carried && !endsSentence(carried.text)) pending = carried;

    out.pages.push({ page: pc.p, width: pc.width, height: pc.height, columns, paragraphs: pageParas });
    out.stats.pagesProcessed += 1;
    out.stats.paragraphs += pageParas.length;
  }

  try {
    const meta = await doc.getMetadata();
    out.source.title = meta?.info?.Title ?? null;
    out.source.author = meta?.info?.Author ?? null;
    out.source.subject = meta?.info?.Subject ?? null;
    out.source.keywords = meta?.info?.Keywords ?? null;
    out.source.creationDate = meta?.info?.CreationDate ?? null;
  } catch { /* 元数据缺失可忽略 */ }

  const front = pageCache.find((p) => p.p === 1);
  if (front?.frontLines?.length) {
    const titleSize = Math.max(...front.frontLines.map((l) => l.size));
    const titleLines = front.frontLines.filter((l) => l.size >= titleSize * 0.92).sort((a, b) => b.y - a.y);
    const titleBottom = Math.min(...titleLines.map((l) => l.y));
    if (!out.source.title && titleSize > bodySize * 1.3) out.source.title = titleLines.map((l) => l.text).join(' ');
    if (titleSize > bodySize * 1.3) {
      const authorRegions = new Set(front.regions.filter(r => r.role === 'front-matter').map(r => r.id));
      const cleanName = (i) => i.str.trim().replace(/^[,\s]+|[,\s*]+$/gu, '');
      const names = front.rawItems.filter((i) => authorRegions.has(i.regionId)
        && i.height >= titleSize * 0.48 && i.height <= titleSize * 0.82
        && /^[A-Z][A-Za-z.\s-]+$/u.test(cleanName(i)) && cleanName(i).split(/\s+/u).length >= 2
        && cleanName(i).split(/\s+/u).length <= 4);
      if (names.length > 1 || !out.source.author) out.source.author = names.map(cleanName).join(', ') || out.source.author;
      if (!out.source.author) {
        const authors = front.lines.filter(l => l.regionRole === 'front-matter' && l.size >= titleSize * 0.6
          && !/\b(?:University|Department|Institute|Laboratory|Correspondence)\b|@/iu.test(l.text));
        if (authors.length) out.source.author = authors.sort((a, b) => b.y - a.y).map(l => l.text).join(' ')
          .replace(/\*/gu, '').replace(/,?\s+and\s+/gu, ', ');
      }
    }
  }

  out.source.metadataCandidates = collectPublicationMetadata(pageCache, out.source);

  const sourceItems = pageCache.flatMap(pc => pc.rawItems);
  const regions = pageCache.flatMap(pc => pc.regions);
  const coverage = auditCoverage(sourceItems, regions, out.pages.flatMap(p => p.paragraphs));
  if (!coverage.ok) {
    await writeFile(join(opts.out, opts.name, `${opts.name}.layout-error.json`), JSON.stringify({ version: REGION_VERSION, coverage,
      pages: pageCache.map(pc => ({ page: pc.p, regions: pc.regions,
        items: pc.rawItems.filter(i => i.str.trim()).map(i => ({ id: i.sourceId, text: i.str, bbox: itemBox(i) })) })) }));
    throw new Error(`版面完整性校验失败，停止翻译；见 ${opts.name}.layout-error.json`);
  }
  out.stats.paragraphs = out.pages.reduce((n, p) => n + p.paragraphs.length, 0);
  await resolveFormulaSources(doc,out,pageCache,opts);
  const previews = await renderLayoutPreviews(doc, pageCache, opts);
  out.layout = { version: REGION_VERSION, mediaPolicy: MEDIA_POLICY, media: mediaOptions(opts), sourceHash: opts.sourceHash, coverage, previews,
    warnings: pageCache.flatMap(pc => pc.warnings.map(message => ({ page: pc.p, message }))),
    blockingWarnings: pageCache.flatMap(pc => pc.warnings.filter(message => message.startsWith('unresolved-')).map(message => ({ page: pc.p, message }))),
    blocks: out.pages.flatMap(p => p.paragraphs.map((block, index) => ({ id: `p${p.page}-b${index + 1}`, type: block.type,
      anchorPage: p.page, sourcePages: block.sourcePages, itemIds: block.sourceIds, text: block.text, ...(block.formula?{formula:block.formula}:{}) }))),
    pages: pageCache.map(pc => ({ page: pc.p, width: pc.width, height: pc.height, regions: pc.regions,
      items: pc.rawItems.filter(i => i.str.trim()).map(i => ({ id: i.sourceId, text: i.str, bbox: itemBox(i) })),
      readingOrder: pc.regions.filter(r => r.flow === 'article').sort((a, b) => a.order - b.order).map(r => r.id) })) };
  await renderFormulaSources(doc, out, opts);
  out.layout.formulas={latex:out.stats.formulaLatex,uncertain:out.stats.formulaUncertain,images:out.stats.formulaSources,imageFallback:opts.formulaFallback!==false};
  await task.destroy();
  out.stats.bodySize = Number(bodySize.toFixed(2));
  out.stats.bodyLeft = Number(bodyLeft.toFixed(1));
  out.stats.bodyRight = Number(bodyRight.toFixed(1));
  return out;
}

function parsePageRange(spec, total) {
  const set = new Set();
  for (const part of String(spec).split(',')) {
    const m = /^(\d+)\s*-\s*(\d+)$/u.exec(part.trim());
    if (m) {
      const a = Math.max(1, Number(m[1]));
      const b = Math.min(total, Number(m[2]));
      for (let i = a; i <= b; i += 1) set.add(i);
    } else if (/^\d+$/u.test(part.trim())) {
      const n = Number(part.trim());
      if (n >= 1 && n <= total) set.add(n);
    }
  }
  return set.size ? set : null;
}

// ─────────────────── 渲染 ───────────────────

function renderMarkdown(result) {
  const L = [];
  L.push(`<!-- source: ${result.source.file} | pages: ${result.source.pages} | extracted-at: ${new Date().toISOString()} -->`);
  L.push('<!-- 本文件由 extract_pdf.mjs 自动抽取，供翻译使用。===SEC:xxx=== 为章节标记，===PAGE n=== 为原页码。 -->');
  L.push('');
  if (result.source.title) L.push(`# ${result.source.title}`);
  if (result.source.author) L.push(`> ${result.source.author}`);
  L.push('');

  if (result.source.metadataCandidates?.length) {
    L.push('===META:BEGIN===');
    L.push('以下内容来自 PDF 文档属性、第一页顶部或页眉页脚；它们不是正文，但必须用于识别题名、作者、期刊、DOI 与发表日期：');
    for (const item of result.source.metadataCandidates) {
      L.push(`- [p${item.page || 'meta'} ${item.region}] ${item.text}`);
    }
    L.push('===META:END===');
    L.push('');
  }

  for (const page of result.pages) {
    L.push(`===PAGE ${page.page}===`);
    L.push(`===LAYOUT:COLUMNS ${page.columns}===`);
    L.push('');
    for (const p of page.paragraphs) {
      const text = p.text.trim();
      if (!text&&p.type!=='formula-source') continue;
      if (p.section) L.push(`===SEC:${p.section}===`);
      if(p.type==='table') {
        if(!p.omitted) L.push('===TABLE:BEGIN===',markdownTable(p.rows),'===TABLE:END===');
      }
      else if(p.type==='figure') {
        if(!p.omitted&&p.image)L.push(`![原文图片（第 ${page.page} 页）](${p.image})`);
        else if(!p.omitted)throw new Error(`第 ${page.page} 页图片截图失败，请关闭图片选项或重新分区。`);
      }
      else if (p.type === 'formula-source') {
        if(p.formula?.reliable)L.push(`$$${p.formula.latex}$$`);
        else if (p.image) L.push(`![原文公式（第 ${page.page} 页，识别不确定时保留原图）](${p.image})`);
        else{
          L.push('<!--DSH_UNCERTAIN_FORMULA-->','',`> **公式待核对（原文第 ${page.page} 页）**：已关闭原图兜底；以下是原始抽取文字，不是已核对公式。缺失符号以问号标出，请对照 PDF。`,'');
          if(text)L.push('```text',text.replace(/[\u0000\ufffd]/gu,'?').replace(/```/gu,'\u02cb\u02cb\u02cb'),'```');
          else L.push('本区域没有可用的原生公式文字，请对照 PDF。');
          L.push('','<!--/DSH_UNCERTAIN_FORMULA-->');
        }
      }
      else if (p.type === 'heading') L.push(`## ${text}`);
      else if (p.type === 'equation') L.push(`$$${text}$$`);
      else if (p.type === 'caption') L.push(`===CAPTION:BEGIN===\n${text}\n===CAPTION:END===`);
      else L.push(text);
      L.push('');
    }
  }
  return L.join('\n').replace(/\n{3,}/gu, '\n\n');
}

function renderReport(result) {
  const twoCol = result.stats.columns.filter((c) => c.columns === 2).length;
  const L = [];
  L.push(`抽取报告: ${result.source.file}`);
  L.push(`总页数: ${result.source.pages}，已处理: ${result.stats.pagesProcessed}`);
  L.push(`判定为双栏的页: ${twoCol} / ${result.stats.pagesProcessed}`);
  L.push(`正文字号估计: ${result.stats.bodySize}pt，正文x范围: ${result.stats.bodyLeft} ~ ${result.stats.bodyRight}`);
  L.push(`段落总数: ${result.stats.paragraphs}`);
  L.push(`公式: LaTeX ${result.stats.formulaLatex||0}，待核对 ${result.stats.formulaUncertain||0}，原图兜底 ${result.stats.formulaSources||0}`);
  L.push(`区域版本: ${result.layout.version}，原文文字项覆盖: ${result.layout.coverage.sourceItems}，完整性: ${result.layout.coverage.ok ? '通过' : '失败'}`);
  for (const warning of result.layout.warnings) L.push(`待核对 p${warning.page}: ${warning.message}`);
  L.push('');
  L.push(`剔除的页眉/页脚/页码 (${result.dropped.length}):`);
  for (const d of result.dropped.slice(0, 60)) L.push(`  p${d.page} [${d.reason}] ${d.text.slice(0, 90)}`);
  if (result.dropped.length > 60) L.push(`  ... 其余 ${result.dropped.length - 60} 条略`);
  L.push('');
  L.push('逐页栏数:');
  for (const c of result.stats.columns) L.push(`  p${c.page}: ${c.columns} 栏`);
  return L.join('\n');
}

function renderLayoutReview(result) {
  const L = ['# 版面检查与阅读顺序', '', '这是本地抽取诊断，不是翻译质量保证。蓝框为正文，棕框为摘要，紫框为出版/作者信息。',
    '框号对应阅读顺序；原文文字项仅属于一个区域。无明确 Abstract 标题的摘要推断仍需人工核对。', '',
    `文字项覆盖检查：${result.layout.coverage.ok ? '通过' : '失败'}；共 ${result.layout.coverage.sourceItems} 项。`, ''];
  for (const w of result.layout.warnings) L.push(`- 第 ${w.page} 页：${w.message}`);
  for (const page of result.layout.pages) {
    L.push('', `## 第 ${page.page} 页`, '');
    const preview = result.layout.previews.find(p => p.page === page.page);
    if (preview) L.push(`![第 ${page.page} 页区域框](${preview.file})`, '');
    const items = new Map(page.items.map(i => [i.id, i.text]));
    for (const r of [...page.regions].sort((a, b) => (a.order || 10000) - (b.order || 10000))) {
      L.push(`- ${r.order || '信息'} · ${r.id} · ${r.role} · ${r.confidence}：${r.itemIds.map(id => items.get(id)).join(' ').slice(0, 180)}`);
    }
  }
  return L.join('\n') + '\n';
}

// ─────────────────── 入口 ───────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.positional.length === 0) {
    console.log(USAGE);
    process.exit(args.help ? 0 : 1);
  }
  const pdfPath = resolve(args.positional[0]);
  const slug = args.name ?? basename(pdfPath, extname(pdfPath)).replace(/[\\/:*?"<>|\s]+/gu, '-').slice(0, 80);
  const outDir = join(resolve(args.out ?? join(WORKSPACE, 'library/extracted')), slug);
  args.out = resolve(args.out ?? join(WORKSPACE, 'library/extracted'));
  args.name = slug;
  await mkdir(outDir, { recursive: true });

  const started = Date.now();
  const result = await extract(pdfPath, args);
  if (args.rawLayout) {
    await writeFile(join(outDir, `${slug}.layout.json`), JSON.stringify(result.layout), 'utf8');
    return;
  }
  const md = renderMarkdown(result);

  await writeFile(join(outDir, `${slug}.md`), md, 'utf8');
  await writeFile(join(outDir, `${slug}.report.txt`), renderReport(result), 'utf8');
  await writeFile(join(outDir, `${slug}.layout.json`), JSON.stringify(result.layout), 'utf8');
  await writeFile(join(outDir, `${slug}.layout.md`), renderLayoutReview(result), 'utf8');
  if (args.json) await writeFile(join(outDir, `${slug}.json`), JSON.stringify(result, null, 1), 'utf8');

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`✓ 抽取完成 (${secs}s)`);
  console.log(`  源文件   : ${result.source.file}`);
  console.log(`  页数     : ${result.stats.pagesProcessed}/${result.source.pages}`);
  console.log(`  双栏页   : ${result.stats.columns.filter((c) => c.columns === 2).length}`);
  console.log(`  段落     : ${result.stats.paragraphs}  剔除页眉页脚: ${result.dropped.length}`);
  console.log(`  Markdown : ${join(outDir, `${slug}.md`)}`);
  console.log(`  正文字符 : ${md.length}`);
}

main().catch((err) => {
  console.error(`✗ 抽取失败: ${err?.message ?? err}`);
  if (process.env.DEBUG) console.error(err);
  process.exit(1);
});
