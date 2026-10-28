/**
 * dsh-literature-library —— 浏览器端半边。
 *
 * 功能：
 *   1. 左侧栏注册「文献库」图标（sidebar.panellist），点击切换到中央主区面板；
 *   2. 面板三段布局，**两处分隔条都可拖动调宽**（宽度持久化到 localStorage）：
 *        [ 目录树 + 文献列表 ] │ [ 原文 PDF ] │ [ 中文译文 ]
 *   3. 目录树按「分类 / 子文件夹」层级展示；未翻译的条目旁有「翻译」按钮，
 *      点击即让 host 创建翻译会话并投递提示词；
 *   4. 顶部可输入文件夹路径并「扫描」，把该文件夹下（含子文件夹）的 PDF 递归登记。
 *
 * 约束（按官方 cordis-plugin-development 技能 practices.md）：
 *   - 不 require 任何 Harness Client 包，只用 react / react/jsx-runtime；
 *   - 只用 --dsw-alias-* 主题变量；
 *   - 所有注册放在 apply 内、用 ctx.effect 管理生命周期。
 */

window.__ModuleLoader__.load({
  id: 'dsh-literature-library',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const ROUTE_PREFIX = '/literature-library';
    const PDFJS_BASE = `${ROUTE_PREFIX}/pdfjs`;
    // 带版本串，避免升级 pdfjs-dist 时浏览器仍用一年缓存的旧 worker
    const PDFJS_REV = '0.8.1';
    const LS_KEY = 'dsh-literature-library/layout';
    const FONT_PERCENT_KEY = 'dsh-literature-library/font-percent';
    // 旧版存的是倍率（1 / 1.1 / …），读取时迁移成百分比
    const FONT_SCALE_KEY = 'dsh-literature-library/font-scale';
    const READING_MEMORY_KEY = 'dsh-literature-library/reading-memory-v1';
    const TRANSLATION_USAGE_KEY = 'dsh-literature-library/translation-usage-v1';
    const OFFPEAK_ONLY_KEY = 'dsh-literature-library/offpeak-only';
    const FONT_MIN_PERCENT = 1;
    const FONT_MAX_PERCENT = 1000;
    const FONT_RANGES = [
      { id: 'normal', label: '1–200%', min: 1, max: 200 },
      { id: 'large', label: '201–500%', min: 201, max: 500 },
      { id: 'huge', label: '501–1000%', min: 501, max: 1000 },
    ];

    function loadReadingMemory() {
      try {
        const value = JSON.parse(window.localStorage.getItem(READING_MEMORY_KEY) || '{}');
        return {
          lastSlug: typeof value.lastSlug === 'string' ? value.lastSlug : null,
          pdfs: value.pdfs && typeof value.pdfs === 'object' ? value.pdfs : {},
          markdowns: value.markdowns && typeof value.markdowns === 'object' ? value.markdowns : {},
        };
      } catch { return { lastSlug: null, pdfs: {}, markdowns: {} }; }
    }

    function updateReadingMemory(update) {
      try {
        const current = loadReadingMemory();
        const next = update(current) ?? current;
        // 只保存数字位置和短锚点，不保存正文；因此可以为文献库中的每篇文章保留记录。
        const entries = Object.entries(next.pdfs ?? {});
        const markdownEntries = Object.entries(next.markdowns ?? {});
        window.localStorage.setItem(READING_MEMORY_KEY, JSON.stringify({
          lastSlug: next.lastSlug ?? null,
          pdfs: Object.fromEntries(entries),
          markdowns: Object.fromEntries(markdownEntries),
        }));
      } catch { /* localStorage 不可用时不影响阅读 */ }
    }

    function savePdfReadingState(slug, value) {
      if (!slug) return;
      updateReadingMemory((memory) => ({
        ...memory,
        pdfs: {
          ...memory.pdfs,
          [slug]: {
            page: Math.max(1, Math.round(Number(value.page) || 1)),
            offset: Math.min(1, Math.max(0, Number(value.offset) || 0)),
            zoom: Math.min(3, Math.max(0.4, Number(value.zoom) || 1)),
            updatedAt: new Date().toISOString(),
          },
        },
      }));
    }

    function saveMarkdownReadingState(slug, mode, value) {
      if (!slug) return;
      const safeMode = ['preview', 'source', 'edit'].includes(mode) ? mode : 'preview';
      updateReadingMemory((memory) => {
        const previous = memory.markdowns?.[slug] ?? {};
        return {
          ...memory,
          markdowns: {
            ...memory.markdowns,
            [slug]: {
              ...previous,
              mode: safeMode,
              positions: {
                ...(previous.positions ?? {}),
                [safeMode]: {
                  scrollTop: Math.max(0, Number(value.scrollTop) || 0),
                  scrollRatio: Math.min(1, Math.max(0, Number(value.scrollRatio) || 0)),
                  anchorIndex: Number.isInteger(value.anchorIndex) ? Math.max(0, value.anchorIndex) : null,
                  anchorOffset: Number.isFinite(value.anchorOffset) ? value.anchorOffset : 0,
                },
              },
              updatedAt: new Date().toISOString(),
            },
          },
        };
      });
    }

    function markdownReadingState(slug, mode) {
      const saved = loadReadingMemory().markdowns?.[slug];
      if (!saved) return null;
      return saved.positions?.[mode] ?? null;
    }

    function clampFontPercent(value) {
      const n = Math.round(Number(value));
      if (!Number.isFinite(n)) return 100;
      return Math.min(FONT_MAX_PERCENT, Math.max(FONT_MIN_PERCENT, n));
    }

    function fontRangeFor(value) {
      const percent = clampFontPercent(value);
      return FONT_RANGES.find((range) => percent >= range.min && percent <= range.max) ?? FONT_RANGES[0];
    }

    function saveFontPercent(value) {
      const percent = clampFontPercent(value);
      try { window.localStorage.setItem(FONT_PERCENT_KEY, String(percent)); } catch { /* 忽略 */ }
      return percent;
    }
    /**
     * 切换文献后的「停稳」时间。
     * 译文要尽快出现，所以短；PDF 重得多，所以长一些——快速连点时
     * 中间文献的 PDF 根本不会被请求，旧 iframe 也会立刻卸载。
     */
    const CONTENT_SETTLE_MS = 120;
    const PDF_SETTLE_MS = 400;

    // ─────────────────── 图标 ───────────────────

    function BookIcon({ size = 20 }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        h('path', { d: 'M12 6.5C10.5 5 8.5 4.5 6 4.5H3.5v13H6c2.5 0 4.5.5 6 2' }),
        h('path', { d: 'M12 6.5C13.5 5 15.5 4.5 18 4.5h2.5v13H18c-2.5 0-4.5.5-6 2' }),
        h('path', { d: 'M12 6.5v13' }),
      );
    }

    function SearchIcon({ size = 13 }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round',
        'aria-hidden': true,
      },
        h('circle', { cx: 10.5, cy: 10.5, r: 6.5 }),
        h('path', { d: 'm15.5 15.5 4.5 4.5' }),
      );
    }

    function PinIcon({ size = 12 }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        h('path', { d: 'M9 4h6l-1 5 3 3v1H7v-1l3-3-1-5Z' }),
        h('path', { d: 'M12 13v7' }),
      );
    }

    // ─────────────────── 样式 ───────────────────

    const CSS = `
.ll-root {
  --ll-accent: #4da3ff;
  --ll-success: #55d690;
  --ll-text: #f4f7fa;
  --ll-muted: #c3cad3;
  --ll-subtle: #8d98a6;
  --ll-bg: #0b0d10;
  --ll-nav-bg: #111419;
  --ll-nav-head-bg: #181c22;
  --ll-panel-bg: #14171c;
  --ll-head-bg: #1b1f26;
  --ll-reading-bg: #181c21;
  --ll-pdf-bg: #0e1013;
  --ll-control-bg: #20252c;
  --ll-control-hover: #2a313b;
  --ll-selected-bg: #193b63;
  --ll-quote-bg: #20262d;
  --ll-soft-border: #3c4551;
  --ll-paper-bg: #ffffff;
  --ll-paper-text: #1b2028;
  --ll-paper-muted: #566170;
  --ll-paper-soft: #f2f4f7;
  --ll-paper-border: #d6dbe2;
  /* 选区必须是半透明叠色：译文区是白纸黑字，用不透明深蓝底会让文字看不见 */
  --ll-selection-bg: rgba(100, 181, 255, .34);
  color-scheme: dark;
  display: flex; height: 100%; min-height: 0; color: var(--ll-text); font-size: calc(13px * var(--ll-font-scale, 1)); overflow: hidden;
  background: var(--ll-bg);
}
@media (prefers-color-scheme: light) {
  /* 宿主没有给出主题信号时才跟随系统；DSH 会写 data-ll-theme 覆盖这里 */
  .ll-root:not([data-ll-theme]) {
    --ll-accent: #0969da; --ll-success: #18794e; --ll-text: #16191d; --ll-muted: #46505c; --ll-subtle: #66717f;
    --ll-bg: #e5e9ee; --ll-nav-bg: #edf0f3; --ll-nav-head-bg: #dfe4e9; --ll-panel-bg: #f4f6f8;
    --ll-head-bg: #e8ecf0; --ll-reading-bg: #ffffff; --ll-pdf-bg: #d7dde4; --ll-control-bg: #e2e7ec;
    --ll-control-hover: #d2d9e1; --ll-selected-bg: #c9dff8; --ll-quote-bg: #eef1f4; --ll-soft-border: #9fa9b5;
  }
}
.ll-col { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.ll-nav-shell { background: var(--ll-nav-bg); border-right: 1px solid var(--ll-soft-border); }
.ll-main-shell { background: var(--ll-panel-bg); }
.ll-divider { flex: none; width: 5px; cursor: col-resize; background: transparent; position: relative; touch-action: none; }
.ll-divider:hover, .ll-divider.dragging { background: var(--dsw-alias-interactive-bg-hover); }
.ll-divider::after { content: ''; position: absolute; left: 2px; top: 0; bottom: 0; width: 1px; background: var(--ll-soft-border); }
.ll-nav-head { padding: 9px 10px 8px; border-bottom: 1px solid var(--ll-soft-border); display: flex; flex-direction: column; gap: 6px; flex: none; background: var(--ll-nav-head-bg); }
.ll-nav-title { display: flex; align-items: center; gap: 6px; font-weight: 600; }
.ll-scan { display: flex; gap: 4px; }
.ll-input { flex: auto; min-width: 0; background: var(--ll-panel-bg); border: 1px solid var(--ll-soft-border); border-radius: var(--dsw-radius-sm); color: var(--ll-text); font: inherit; font-size: calc(12px * var(--ll-font-scale, 1)); padding: 3px 6px; }
.ll-input:focus { outline: 1px solid var(--ll-accent); border-color: var(--ll-accent); }
.ll-btn { border: 1px solid var(--ll-soft-border); background: var(--ll-control-bg); color: var(--ll-text); font: inherit; font-size: calc(12px * var(--ll-font-scale, 1)); border-radius: var(--dsw-radius-sm); padding: 3px 8px; cursor: pointer; white-space: nowrap; }
.ll-btn:hover { background: var(--ll-control-hover); border-color: var(--ll-accent); }
.ll-btn:disabled { opacity: .5; cursor: default; }
.ll-nav-body { flex: auto; min-height: 0; overflow: auto; padding: 4px 0 12px; background: var(--ll-nav-bg); }
.ll-group { padding: 6px 10px 3px; color: var(--ll-muted); font-size: calc(11.5px * var(--ll-font-scale, 1)); font-weight: 600; display: flex; justify-content: space-between; gap: 6px; }
.ll-item { position: relative; display: flex; align-items: flex-start; gap: 6px; width: 100%; text-align: left; border: 0; background: none; cursor: pointer; padding: 7px 10px 7px 14px; color: inherit; font: inherit; }
.ll-item:hover { background: var(--ll-control-bg); }
.ll-item.active { background: var(--ll-selected-bg); box-shadow: inset 3px 0 0 var(--ll-accent); }
.ll-item-main { min-width: 0; flex: auto; }
.ll-item-title { display: -webkit-box; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; color: var(--ll-text); line-height: 1.4; font-weight: 620; overflow-wrap: anywhere; }
.ll-item-pub { display: flex; align-items: center; min-width: 0; gap: 5px; margin-top: 3px; color: var(--ll-muted); font-size: calc(11px * var(--ll-font-scale, 1)); line-height: 1.35; }
.ll-item-year { flex: none; color: var(--ll-accent); font-weight: 650; }
.ll-item-author { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ll-item-meta { display: flex; align-items: center; min-width: 0; gap: 4px; color: var(--ll-subtle); font-size: calc(10.5px * var(--ll-font-scale, 1)); margin-top: 3px; line-height: 1.35; }
.ll-item-journal { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ll-subtle); }
.ll-tag { display: inline-block; flex: none; font-size: calc(10px * var(--ll-font-scale, 1)); padding: 0 5px; border-radius: 999px; border: 1px solid var(--ll-soft-border); color: var(--ll-muted); }
.ll-tag.done { color: var(--ll-success); border-color: var(--ll-success); background: var(--ll-control-bg); }
.ll-act { flex: none; }
/* 目录树工具条 */
.ll-treebar { flex: none; display: flex; align-items: center; gap: 4px; padding: 4px 8px; border-bottom: 1px solid var(--ll-soft-border); background: var(--ll-nav-head-bg); }
.ll-btn-xs { font-size: calc(11px * var(--ll-font-scale, 1)); padding: 1px 6px; }
.ll-danger:hover { background: var(--dsw-alias-interactive-bg-hover); }
/* 可折叠的分类标题 */
.ll-group-clickable { cursor: pointer; user-select: none; }
.ll-group-clickable:hover { background: var(--ll-control-bg); }
.ll-group-selected {
  background: var(--ll-selected-bg); color: var(--ll-text);
  box-shadow: inset 2px 0 0 var(--ll-accent);
}
.ll-scan-target {
  flex: auto; min-width: 0; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; color: var(--ll-muted);
}
.ll-scan-target b { color: var(--ll-text); font-weight: 600; }
.ll-caret { flex: none; width: 10px; color: var(--ll-subtle); }
.ll-group-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ll-group-count { flex: none; }
.ll-group-actions { display: none; gap: 3px; flex: none; }
.ll-group-clickable:hover .ll-group-actions { display: inline-flex; }
/* 条目操作按钮：hover 才显示，平时不占视觉重量 */
.ll-item-actions { display: none; gap: 3px; flex: none; align-items: center; }
.ll-item:hover .ll-item-actions { display: inline-flex; }
.ll-item-hidden { opacity: .5; }
/* 右键菜单 */
.ll-menu { position: fixed; z-index: 60; min-width: 190px; max-width: 320px; padding: 4px; background: var(--ll-panel-bg); border: .5px solid var(--ll-soft-border); border-radius: var(--dsw-radius-md); box-shadow: 0 12px 34px rgba(0,0,0,.38); display: flex; flex-direction: column; }
.ll-menu-title { padding: 5px 10px 6px; font-size: calc(11.5px * var(--ll-font-scale, 1)); color: var(--ll-subtle); border-bottom: 1px solid var(--ll-soft-border); margin-bottom: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ll-menu-item { display: block; width: 100%; text-align: left; border: 0; background: none; color: var(--ll-text); font: inherit; font-size: calc(12.5px * var(--ll-font-scale, 1)); padding: 5px 10px; border-radius: var(--dsw-radius-sm); cursor: pointer; }
.ll-menu-item:hover:not(:disabled) { background: var(--ll-control-hover); }
.ll-menu-item:disabled { opacity: .5; cursor: default; }
.ll-menu-item.ll-danger { color: var(--ll-text); }
.ll-menu-sep { height: .5px; background: var(--dsw-alias-border-l3); margin: 4px 6px; }
/* 翻译进度 */
.ll-progress { display: flex; align-items: center; gap: 5px; margin-top: 3px; font-size: calc(10.5px * var(--ll-font-scale, 1)); color: var(--ll-subtle); }
.ll-progress-bar { flex: none; width: 54px; height: 3px; border-radius: 2px; background: var(--dsw-alias-border-l3); overflow: hidden; }
.ll-progress-fill { display: block; height: 100%; background: var(--dsw-alias-label-secondary); }
.ll-progress-running .ll-progress-fill { background: var(--dsw-alias-label-primary); animation: ll-pulse 1.2s ease-in-out infinite; }
.ll-progress-done .ll-progress-fill { background: var(--dsw-alias-label-secondary); }
.ll-progress-failed .ll-progress-fill { background: #d9534f; }
.ll-progress-queued .ll-progress-fill { opacity: .6; }
@keyframes ll-pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
/* 翻译费用/用量：一行小字，悬停看明细 */
.ll-translate-status { display: flex; min-width: 0; flex-direction: column; align-items: flex-start; }
.ll-translate-status .ll-progress { margin-top: 4px; max-width: 100%; }
.ll-usage {
  display: block; max-width: 100%; margin-top: 2px; overflow: hidden; text-overflow: ellipsis;
  color: var(--ll-subtle); font-size: calc(9.5px * var(--ll-font-scale, 1));
  line-height: 1.35; white-space: nowrap; font-variant-numeric: tabular-nums; cursor: help;
}
.ll-offpeak-toggle {
  display: inline-flex; align-items: center; gap: 3px; min-width: 0; cursor: pointer;
  color: var(--ll-subtle); font-size: calc(10.5px * var(--ll-font-scale, 1)); white-space: nowrap;
}
.ll-offpeak-toggle input { width: 12px; height: 12px; margin: 0; accent-color: var(--ll-accent); }
.ll-offpeak-toggle.on { color: var(--ll-accent); }
.ll-head { padding: 8px 12px; border-bottom: 1px solid var(--ll-soft-border); flex: none; display: flex; flex-wrap: wrap; gap: 5px 12px; align-items: flex-start; background: var(--ll-head-bg); }
.ll-head.ll-head-compact { padding-top: 7px; padding-bottom: 7px; }
.ll-head-titles { min-width: 0; flex: 1 1 520px; }
.ll-head h1 { color: var(--ll-text); font-size: calc(15px * var(--ll-font-scale, 1)); line-height: 1.35; margin: 0; font-weight: 700; }
.ll-title-en { color: var(--ll-muted); font-size: calc(12px * var(--ll-font-scale, 1)); line-height: 1.45; margin-top: 2px; }
.ll-title-en.ll-missing { color: var(--ll-subtle); font-style: italic; }
.ll-head-actions { flex: none; display: flex; gap: 5px; align-items: center; }
.ll-details-toggle { color: var(--ll-accent); }
.ll-head-details { display: flex; flex-wrap: wrap; align-items: center; gap: 5px 12px; width: 100%; padding-top: 5px; border-top: .5px solid var(--ll-soft-border); }
.ll-head .ll-byline { color: var(--ll-muted); font-size: calc(12px * var(--ll-font-scale, 1)); line-height: 1.5; }
.ll-journal { display: flex; flex-wrap: wrap; gap: 6px; width: 100%; margin-top: 3px; align-items: center; }
.ll-chip { border: 1px solid var(--ll-soft-border); border-radius: 999px; padding: 1px 8px; font-size: calc(11px * var(--ll-font-scale, 1)); color: var(--ll-muted); background: var(--ll-control-bg); }
.ll-chip b { color: var(--ll-text); font-weight: 650; }
.ll-split { flex: auto; min-height: 0; display: flex; }
.ll-pane { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.ll-pane-head { flex: none; height: 40px; min-height: 40px; box-sizing: border-box; padding: 0 10px; border-bottom: 1px solid var(--ll-soft-border); color: var(--ll-muted); font-size: calc(12px * var(--ll-font-scale, 1)); font-weight: 650; display: flex; gap: 6px; align-items: center; flex-wrap: nowrap; overflow: hidden; background: var(--ll-head-bg); }
.ll-pane-head a { color: inherit; }
.ll-pane-body { flex: auto; min-height: 0; overflow: auto; display: flex; flex-direction: column; }
.ll-pane-translation .ll-pane-body { background: var(--ll-paper-bg); color: var(--ll-paper-text); }
.ll-pane-pdf .ll-pane-head { background: var(--ll-nav-head-bg); }
.ll-pane-pdf .ll-pane-body { background: var(--ll-paper-bg); }
.ll-nav-body, .ll-pane-body { scrollbar-color: var(--ll-accent) transparent; scrollbar-width: thin; }
.ll-pane-body iframe { width: 100%; height: 100%; min-height: 0; border: 0; display: block; background: #fff; }
.ll-md { padding: 14px 18px; color: var(--ll-text); line-height: 1.75; }
.ll-md h1 { font-size: calc(19px * var(--ll-font-scale, 1)); margin: .2em 0 .6em; }
.ll-md h2 { font-size: calc(16px * var(--ll-font-scale, 1)); margin: 1.4em 0 .5em; }
.ll-md h3 { font-size: calc(14px * var(--ll-font-scale, 1)); margin: 1.2em 0 .4em; }
.ll-md p { margin: .6em 0; }
.ll-md blockquote { margin: .6em 0; padding: .3em .9em; border-left: 3px solid var(--ll-accent); color: var(--ll-muted); background: var(--ll-quote-bg); }
.ll-md code { background: var(--dsw-alias-interactive-bg-hover); padding: .1em .35em; border-radius: 4px; font-size: calc(12px * var(--ll-font-scale, 1)); }
.ll-md pre { background: var(--dsw-alias-interactive-bg-hover); padding: 10px 12px; border-radius: 6px; overflow: auto; }
.ll-md pre code { background: none; padding: 0; }
.ll-md table { border-collapse: collapse; margin: .8em 0; font-size: calc(12px * var(--ll-font-scale, 1)); width: 100%; }
.ll-md th, .ll-md td { border: .5px solid var(--dsw-alias-border-l3); padding: 4px 8px; text-align: left; vertical-align: top; }
.ll-md th { background: var(--dsw-alias-interactive-bg-hover); }
.ll-md .ll-table-scroll { max-width: 100%; overflow-x: auto; }
.ll-md .ll-table-scroll table { min-width: var(--ll-table-min, 560px); }
.ll-md figcaption { display: block; margin: .85em 0; font-family: Georgia, 'Noto Serif SC', 'Songti SC', SimSun, serif; font-style: italic; font-size: .9em; line-height: 1.6; color: #46515e; }
.ll-root .ll-media-options { display:flex; flex-wrap:wrap; align-items:center; gap:4px 10px; font-size:12px !important; line-height:1.4 !important; }
.ll-root .ll-media-options label { display:inline-flex; align-items:center; gap:4px; max-width:100%; font-size:12px !important; line-height:1.4 !important; margin:0 !important; white-space:normal; }
.ll-root .ll-media-options input[type=checkbox] { flex-shrink:0; width:13px !important; height:13px !important; min-height:13px !important; padding:0 !important; margin:0 !important; }
.ll-md hr { border: 0; border-top: .5px solid var(--dsw-alias-border-l3); margin: 1.4em 0; }
.ll-pane-translation .ll-md { color: var(--ll-paper-text); }
.ll-pane-translation .ll-md h1,
.ll-pane-translation .ll-md h2,
.ll-pane-translation .ll-md h3 { color: #11151a; }
.ll-pane-translation .ll-md blockquote { color: var(--ll-paper-muted); background: var(--ll-paper-soft); border-left-color: #3978bd; }
.ll-pane-translation .ll-md code { color: #20252c; background: var(--ll-paper-soft); }
.ll-pane-translation .ll-md pre { color: var(--ll-paper-text); background: var(--ll-paper-soft); border: 1px solid var(--ll-paper-border); }
.ll-pane-translation .ll-md th,
.ll-pane-translation .ll-md td { border-color: var(--ll-paper-border); }
.ll-pane-translation .ll-md th { color: #11151a; background: var(--ll-paper-soft); }
.ll-pane-translation .ll-md hr { border-top-color: var(--ll-paper-border); }
.ll-pane-translation .ll-math-bad { color: var(--ll-paper-muted); border-bottom-color: #8b95a3; }
.ll-pane-translation .ll-status,
.ll-pane-translation .ll-empty,
.ll-pane-pdf .ll-status,
.ll-pane-pdf .ll-empty { color: var(--ll-paper-muted); }
.ll-pane-translation .ll-status code,
.ll-pane-pdf .ll-status code { color: var(--ll-paper-text); background: var(--ll-paper-soft); }
.ll-math-block { margin: .9em 0; padding: 8px 0; overflow-x: auto; text-align: center; }
.ll-math-bad { background: none; border-bottom: 1px dashed var(--ll-soft-border); color: var(--ll-muted); cursor: help; }
.ll-status { padding: 12px 14px; color: var(--ll-muted); line-height: 1.7; }
.ll-status code { background: var(--dsw-alias-interactive-bg-hover); padding: .1em .35em; border-radius: 4px; word-break: break-all; }
.ll-empty { padding: 20px; color: var(--ll-muted); }
.ll-banner { padding: 6px 9px; border-radius: var(--dsw-radius-sm); border: .5px solid var(--dsw-alias-border-l3); font-size: calc(12px * var(--ll-font-scale, 1)); line-height: 1.6; }
.ll-banner a { color: inherit; }
.ll-banner.err { color: var(--ll-text); }
/* 编辑器 */
.ll-tabs { display: flex; gap: 2px; }
.ll-tab { border: 1px solid transparent; background: none; color: var(--ll-muted); font: inherit; font-size: calc(12px * var(--ll-font-scale, 1)); border-radius: var(--dsw-radius-sm); padding: 2px 8px; cursor: pointer; }
.ll-tab:hover { background: var(--dsw-alias-interactive-bg-hover); }
.ll-tab.on { color: var(--ll-text); background: var(--ll-selected-bg); border-color: var(--ll-accent); }
.ll-editor { flex: auto; min-height: 0; width: 100%; box-sizing: border-box; border: 0; outline: none; resize: none; background: transparent; color: inherit; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: calc(12.5px * var(--ll-font-scale, 1)); line-height: 1.7; padding: 12px 14px; tab-size: 2; }
.ll-editor:read-only { color: var(--ll-muted); }
.ll-pane-translation .ll-editor,
.ll-pane-translation .ll-editor:read-only { color: var(--ll-paper-text); background: var(--ll-paper-bg); }
.ll-wysiwyg { flex: auto; min-height: 0; overflow: auto; padding: 10px clamp(10px, 3vw, 34px) 40px; }
.ll-wysiwyg-inner { width: min(860px, 100%); margin: 0 auto; }
.ll-wysiwyg-help { position: sticky; top: 0; z-index: 2; width: fit-content; margin: 0 0 8px auto; padding: 3px 8px; border: 1px solid var(--ll-soft-border); border-radius: 999px; background: var(--ll-control-bg); color: var(--ll-muted); font-size: calc(10.5px * var(--ll-font-scale, 1)); line-height: 1.5; }
.ll-edit-block { position: relative; margin: 0 -9px; padding: 1px 9px; border: .5px solid transparent; border-radius: 6px; cursor: text; transition: background .12s ease, border-color .12s ease; }
.ll-edit-block:hover { background: var(--dsw-alias-interactive-bg-hover); border-color: var(--dsw-alias-border-l3); }
.ll-edit-block:focus-visible { outline: 1px solid var(--dsw-alias-border-l3); outline-offset: 1px; }
.ll-edit-block .ll-md { padding: 0; }
.ll-edit-block-active { margin-top: 5px; margin-bottom: 5px; padding: 7px 9px; background: var(--dsw-alias-interactive-bg-hover); border-color: var(--dsw-alias-border-l3); box-shadow: inset 2px 0 0 var(--dsw-alias-label-secondary); }
.ll-block-editor { display: block; width: 100%; min-height: 2.2em; box-sizing: border-box; overflow: hidden; resize: none; border: 0; outline: 0; background: transparent; color: inherit; font: inherit; font-size: calc(13px * var(--ll-font-scale, 1)); line-height: 1.75; padding: 0; tab-size: 2; white-space: pre-wrap; }
.ll-pane-translation .ll-wysiwyg-help { color: var(--ll-paper-muted); background: var(--ll-paper-bg); border-color: var(--ll-paper-border); }
.ll-pane-translation .ll-edit-block:hover { background: var(--ll-paper-soft); border-color: var(--ll-paper-border); }
.ll-pane-translation .ll-edit-block-active { background: var(--ll-paper-soft); border-color: var(--ll-paper-border); box-shadow: inset 2px 0 0 #3978bd; }
.ll-pane-translation .ll-block-editor { color: var(--ll-paper-text); }
.ll-pane-translation .ll-edit-empty { color: #7a8491; }
.ll-edit-empty { min-height: 2em; color: var(--ll-subtle); }
.ll-edit-empty::before { content: '点击输入内容'; font-size: calc(11px * var(--ll-font-scale, 1)); }
.ll-dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: currentColor; margin-left: 4px; vertical-align: middle; }
.ll-hint { color: var(--ll-subtle); font-size: calc(11px * var(--ll-font-scale, 1)); }
/* 期刊信息编辑器 */
.ll-meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 6px 10px; width: 100%; padding: 8px 0 2px; }
.ll-field { display: flex; flex-direction: column; gap: 2px; }
.ll-field label { font-size: calc(11px * var(--ll-font-scale, 1)); color: var(--ll-muted); }
.ll-field input, .ll-field select { background: var(--ll-control-bg); border: 1px solid var(--ll-soft-border); border-radius: var(--dsw-radius-sm); color: var(--ll-text); font: inherit; font-size: calc(12px * var(--ll-font-scale, 1)); padding: 3px 6px; }
.ll-field.wide { grid-column: 1 / -1; }
/* 文件夹浏览器 */
.ll-modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,.35); display: flex; align-items: center; justify-content: center; z-index: 40; }
.ll-modal { width: min(680px, 92vw); height: min(560px, 86vh); display: flex; flex-direction: column; background: var(--ll-panel-bg); color: var(--ll-text); border: 1px solid var(--ll-soft-border); border-radius: var(--dsw-radius-md); box-shadow: 0 8px 32px rgba(0,0,0,.45); overflow: hidden; }
.ll-modal-head { flex: none; display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: .5px solid var(--dsw-alias-border-l3); font-weight: 600; }
.ll-modal-path { flex: none; display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-bottom: .5px solid var(--dsw-alias-border-l3); font-size: calc(12px * var(--ll-font-scale, 1)); }
.ll-modal-path code { background: var(--dsw-alias-interactive-bg-hover); padding: 2px 6px; border-radius: 4px; word-break: break-all; }
.ll-modal-goto { flex: none; display: flex; gap: 6px; padding: 8px 10px 0; }
.ll-modal-sm { width: min(560px, 92vw); height: auto; max-height: 86vh; }
/* 配置对话框 */
.ll-cfg-status { font-size: calc(12.5px * var(--ll-font-scale, 1)); margin-bottom: 8px; }
.ll-update-section { margin-top: 10px; padding-top: 10px; border-top: .5px solid var(--ll-soft-border); }
.ll-update-section > b { display: block; margin-bottom: 3px; }
.ll-update-section .ll-update-actions { margin-top: 5px; }
.ll-update-meta a { color: var(--ll-accent); text-decoration: none; }
.ll-update-dir { margin: 4px 0 10px; }
.ll-update-dir code { word-break: break-all; }
.ll-update-list { display: flex; flex-direction: column; gap: 2px; }
.ll-update-row {
  display: flex; align-items: center; gap: 8px;
  padding: 7px 0; border-bottom: .5px solid var(--ll-soft-border);
}
.ll-update-meta { flex: auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.ll-update-meta .ll-hint { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ll-update-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 10px; }
.ll-update-file { max-width: 100%; color: var(--ll-muted); font-size: calc(11px * var(--ll-font-scale, 1)); }
.ll-update-ok { border-color: var(--ll-success); }
.ll-cfg-ok { color: var(--ll-text); }
.ll-cfg-bad { color: #d9534f; }
.ll-cfg-rows { display: flex; flex-direction: column; gap: 3px; margin-bottom: 12px; }
.ll-cfg-row { display: flex; gap: 8px; font-size: calc(11.5px * var(--ll-font-scale, 1)); align-items: baseline; }
.ll-cfg-label { flex: none; width: 150px; color: var(--ll-subtle); }
.ll-cfg-value { background: var(--dsw-alias-interactive-bg-hover); padding: 1px 5px; border-radius: 3px; word-break: break-all; }
.ll-cfg-value.bad { color: var(--ll-subtle); background: none; }
.ll-cfg-form label { font-size: calc(11.5px * var(--ll-font-scale, 1)); color: var(--ll-muted); }
/* 条目上的「⋯」菜单按钮：一直可见，降低「右键才能操作」的发现成本 */
.ll-item-more { flex: none; opacity: .55; }
.ll-item:hover .ll-item-more { opacity: 1; }
.ll-modal-body { flex: auto; min-height: 0; overflow: auto; padding: 4px 0; }
.ll-modal-foot { flex: none; display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-top: .5px solid var(--dsw-alias-border-l3); }
.ll-crumbs { flex: none; display: flex; flex-wrap: wrap; gap: 2px; padding: 6px 8px 0; overflow: hidden; }
.ll-crumb { border: 0; background: none; color: var(--ll-muted); font: inherit; font-size: calc(11.5px * var(--ll-font-scale, 1)); cursor: pointer; padding: 1px 5px; border-radius: var(--dsw-radius-sm); max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ll-crumb:hover { background: var(--ll-control-hover); color: var(--ll-text); }
.ll-crumb + .ll-crumb::before { content: '/'; color: var(--ll-subtle); margin-right: 4px; }

/* ───────────────────────────────────────────────────────────────
 * 界面优化（2026-10）：信息层级、搜索、手动排序 / 置顶、阅读区工具条
 * 这部分覆盖上面的基础样式，保留旧规则是为了让历史版本平稳升级。
 * ─────────────────────────────────────────────────────────────── */
.ll-root {
  --ll-accent: #64b5ff;
  --ll-success: #58d6a0;
  --ll-danger: #ff7070;
  --ll-text: #edf3f9;
  --ll-muted: #b2bdc9;
  --ll-subtle: #808b98;
  --ll-bg: #0a0c0f;
  --ll-nav-bg: #0f1216;
  --ll-nav-head-bg: #14181e;
  --ll-panel-bg: #121519;
  --ll-head-bg: #171b21;
  --ll-reading-bg: #171b20;
  --ll-pdf-bg: #0d0f12;
  --ll-control-bg: #1e242c;
  --ll-control-hover: #29313b;
  --ll-selected-bg: #17395c;
  --ll-quote-bg: #1c2229;
  --ll-soft-border: #303945;
  --ll-hover: #191f26;
  --ll-pin: #ffcb5c;
  /* Chromium/Edge 内置 PDF 阅读器的工具条在 100% 缩放下是 35px。
     「预览 / 源码 / 编辑」这一行必须同高，译文正文才能与 PDF 页面对齐。
     换浏览器或阅读器工具栏高度明显不同时，只改这个变量即可。 */
  --ll-pdf-toolbar-h: 35px;
  --ll-pdf-toolbar-bg: #3b3b3b;
  --ll-pdf-toolbar-fg: #f2f4f7;
  --ll-pdf-toolbar-muted: #c3c9d2;
  font-size: calc(13px * var(--ll-font-scale, 1));
  letter-spacing: .1px;
}
@media (prefers-color-scheme: light) {
  .ll-root:not([data-ll-theme]) {
    --ll-accent: #0b6bcb; --ll-success: #137a4b; --ll-danger: #c0392b;
    --ll-text: #151a20; --ll-muted: #49535f; --ll-subtle: #6b7684;
    --ll-bg: #e7ebef; --ll-nav-bg: #f1f4f7; --ll-nav-head-bg: #e9edf1;
    --ll-panel-bg: #f6f8fa; --ll-head-bg: #eef2f5; --ll-reading-bg: #ffffff;
    --ll-pdf-bg: #dce2e8; --ll-control-bg: #e5eaef; --ll-control-hover: #d6dde5;
    --ll-selected-bg: #d3e6fb; --ll-quote-bg: #eef2f5; --ll-soft-border: #c2cbd5;
    --ll-hover: #e7edf3; --ll-pin: #a46600;
    --ll-pdf-toolbar-bg: #eef1f4; --ll-pdf-toolbar-fg: #20252c; --ll-pdf-toolbar-muted: #5c6672;
    --ll-selection-bg: rgba(9, 105, 218, .22);
  }
}
/*
 * 浅色主题：由 JS 按 DSH 的 body[data-ds-dark-theme] 写到 .ll-root 上。
 * 不依赖 prefers-color-scheme——否则「DSH 浅色 + 系统深色」时面板仍是深色，
 * 和整页背景割裂。
 */
.ll-root[data-ll-theme="light"] {
  color-scheme: light;
  --ll-accent: #0b6bcb; --ll-success: #137a4b; --ll-danger: #c0392b;
  --ll-text: #151a20; --ll-muted: #49535f; --ll-subtle: #6b7684;
  --ll-bg: #e7ebef; --ll-nav-bg: #f1f4f7; --ll-nav-head-bg: #e9edf1;
  --ll-panel-bg: #f6f8fa; --ll-head-bg: #eef2f5; --ll-reading-bg: #ffffff;
  --ll-pdf-bg: #dce2e8; --ll-control-bg: #e5eaef; --ll-control-hover: #d6dde5;
  --ll-selected-bg: #d3e6fb; --ll-quote-bg: #eef2f5; --ll-soft-border: #c2cbd5;
  --ll-hover: #e7edf3; --ll-pin: #a46600;
  --ll-pdf-toolbar-bg: #eef1f4; --ll-pdf-toolbar-fg: #20252c; --ll-pdf-toolbar-muted: #5c6672;
  --ll-selection-bg: rgba(9, 105, 218, .22);
}
.ll-root[data-ll-theme="dark"] { color-scheme: dark; --ll-selection-bg: rgba(100, 181, 255, .34); }
.ll-root button, .ll-root input, .ll-root select, .ll-root textarea { font-family: inherit; }
.ll-root :focus-visible { outline: 2px solid var(--ll-accent); outline-offset: 1px; }
/*
 * 选中文字：半透明强调色 + 文字颜色继承。
 * 旧写法用不透明 --ll-selected-bg，而译文区是白底黑字，选中后变成
 * 「深蓝底 + 深色字」，完全看不清。
 */
.ll-root ::selection { background: var(--ll-selection-bg); color: inherit; }
.ll-root ::-moz-selection { background: var(--ll-selection-bg); color: inherit; }
.ll-pane-translation ::selection { background: rgba(11, 107, 203, .24); color: inherit; }
.ll-nav-shell { box-shadow: inset -1px 0 0 rgba(0, 0, 0, .18); container-type: inline-size; }
.ll-nav-head {
  padding: 10px 10px 9px;
  gap: 7px;
  background: linear-gradient(180deg, var(--ll-nav-head-bg), var(--ll-nav-bg));
}
.ll-nav-title { gap: 7px; font-size: calc(13px * var(--ll-font-scale, 1)); letter-spacing: .3px; }
.ll-nav-title > svg { color: var(--ll-accent); flex: none; }
.ll-count-pill {
  flex: none; margin-left: 2px; padding: 0 6px; border-radius: 999px;
  background: var(--ll-control-bg); border: 1px solid var(--ll-soft-border);
  color: var(--ll-muted); font-size: calc(10.5px * var(--ll-font-scale, 1)); font-weight: 600; line-height: calc(16px * var(--ll-font-scale, 1));
}
.ll-nav-title .ll-btn { margin-left: auto; }
.ll-search-wrap { position: relative; display: flex; align-items: center; }
.ll-search-icon {
  position: absolute; left: 8px; display: flex; color: var(--ll-subtle);
  pointer-events: none;
}
.ll-search {
  width: 100%; box-sizing: border-box; padding: 5px 26px 5px 27px;
  border: 1px solid var(--ll-soft-border); border-radius: 999px;
  background: var(--ll-panel-bg); color: var(--ll-text);
  font: inherit; font-size: calc(12px * var(--ll-font-scale, 1));
  transition: border-color .15s ease, background .15s ease;
}
.ll-search::placeholder { color: var(--ll-subtle); }
.ll-search:focus { outline: none; border-color: var(--ll-accent); background: var(--ll-nav-bg); }
.ll-search-clear {
  position: absolute; right: 5px; width: 18px; height: 18px; padding: 0;
  display: flex; align-items: center; justify-content: center;
  border: 0; border-radius: 50%; background: none; color: var(--ll-subtle);
  font: inherit; font-size: calc(13px * var(--ll-font-scale, 1)); line-height: 1; cursor: pointer;
}
.ll-search-clear:hover { background: var(--ll-control-hover); color: var(--ll-text); }
.ll-scan { align-items: center; }
.ll-scan .ll-input { padding: 4px 7px; }
.ll-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 4px;
  border-radius: 6px; padding: 3px 8px; line-height: 1.5;
  transition: background .13s ease, border-color .13s ease, color .13s ease;
}
.ll-btn:active:not(:disabled) { transform: translateY(.5px); }
.ll-icon-btn {
  flex: none; width: 20px; height: 20px; padding: 0;
  display: inline-flex; align-items: center; justify-content: center;
  border: 0; border-radius: 5px; background: none;
  color: var(--ll-muted); font: inherit; font-size: 11px; line-height: 1;
  cursor: pointer; transition: background .12s ease, color .12s ease;
}
.ll-icon-btn:hover:not(:disabled) { background: var(--ll-control-hover); color: var(--ll-text); }
.ll-icon-btn:disabled { opacity: .25; cursor: default; }
.ll-icon-btn.on { color: var(--ll-pin); background: var(--ll-control-bg); }
.ll-icon-btn.on:hover:not(:disabled) { color: var(--ll-pin); }
.ll-treebar {
  gap: 5px; padding: 5px 8px; flex-wrap: wrap;
  background: var(--ll-nav-head-bg);
}
.ll-treebar .ll-hint { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ll-toolbar {
  flex: none; display: flex; align-items: center; gap: 4px; flex-wrap: wrap;
  padding: 5px 8px; border-bottom: 1px solid var(--ll-soft-border);
  background: var(--ll-nav-head-bg);
}
.ll-api-dot {
  flex: none; width: 6px; height: 6px; border-radius: 50%;
  background: var(--ll-subtle); box-shadow: 0 0 0 3px transparent;
}
.ll-api-dot.ok { background: var(--ll-success); box-shadow: 0 0 0 3px rgba(88, 214, 160, .15); }
.ll-spacer { flex: auto; }
.ll-nav-body { padding: 3px 0 18px; }
.ll-nav-foot {
  flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px;
  padding: 5px 10px; border-top: 1px solid var(--ll-soft-border);
  background: var(--ll-nav-head-bg); color: var(--ll-subtle);
  font-size: calc(10.5px * var(--ll-font-scale, 1)); line-height: 1.55;
}
.ll-font-size {
  flex: none; display: inline-flex; align-items: center; gap: 3px;
  color: var(--ll-muted); white-space: nowrap;
}
.ll-font-range {
  width: 64px; height: 12px; margin: 0; padding: 0;
  accent-color: var(--ll-accent); cursor: pointer;
}
.ll-font-range::-webkit-slider-thumb { width: 12px; height: 12px; }
.ll-font-band {
  width: 70px; min-width: 0; box-sizing: border-box; padding: 0 2px;
  color: var(--ll-text); background: var(--ll-control-bg);
  border: 1px solid var(--ll-soft-border); border-radius: 4px;
  font: inherit; font-size: 10px; line-height: 1.4;
}
.ll-font-num {
  width: 52px; box-sizing: border-box;
  font: inherit; font-size: calc(10px * var(--ll-font-scale, 1)); line-height: 1.4;
  color: var(--ll-text); background: var(--ll-control-bg);
  border: 1px solid var(--ll-soft-border); border-radius: 4px;
  padding: 0 2px; text-align: right;
}
.ll-ver { flex: none; white-space: nowrap; font-variant-numeric: tabular-nums; }
.ll-ver b { color: var(--ll-muted); font-weight: 600; }
.ll-nav-foot-tag {
  flex: none; padding: 0 5px; border: 1px solid var(--ll-soft-border);
  border-radius: 999px; font-size: calc(9.5px * var(--ll-font-scale, 1)); line-height: calc(14px * var(--ll-font-scale, 1)); color: var(--ll-accent);
}
.ll-nav-foot-hint { flex: none; color: var(--ll-subtle); }
.ll-group {
  position: relative; align-items: center; gap: 6px;
  padding: 7px 10px 4px; border-radius: 0;
  letter-spacing: .25px; transition: background .12s ease, color .12s ease;
}
.ll-group-clickable:hover { background: var(--ll-hover); color: var(--ll-text); }
.ll-group-count {
  padding: 0 6px; border-radius: 999px; background: var(--ll-control-bg);
  border: 1px solid transparent; font-size: calc(10.5px * var(--ll-font-scale, 1)); line-height: calc(15px * var(--ll-font-scale, 1));
}
.ll-caret { width: 12px; font-size: calc(10px * var(--ll-font-scale, 1)); text-align: center; transition: transform .12s ease; }
.ll-item {
  padding: 7px 10px 7px 14px; gap: 7px;
  transition: background .12s ease, box-shadow .12s ease;
}
.ll-item:hover { background: var(--ll-hover); }
.ll-item.active { background: var(--ll-selected-bg); box-shadow: inset 3px 0 0 var(--ll-accent); }
.ll-item.active:hover { background: var(--ll-selected-bg); }
.ll-item-main { position: relative; padding-right: 22px; }
.ll-item-title { font-weight: 600; letter-spacing: .05px; padding-right: 2px; }
.ll-pin-mark {
  display: inline-flex; vertical-align: -2px; margin-right: 4px;
  color: var(--ll-pin);
}
.ll-item-pub { gap: 6px; margin-top: 2px; }
.ll-item-year { font-variant-numeric: tabular-nums; }
.ll-item-meta { gap: 5px; margin-top: 4px; flex-wrap: wrap; }
.ll-item-journal { flex: 0 1 auto; max-width: 100%; }
.ll-tag { line-height: calc(15px * var(--ll-font-scale, 1)); }
.ll-tag.done { color: var(--ll-success); border-color: var(--ll-success); background: transparent; }
.ll-tag-btn {
  cursor: pointer; color: var(--ll-accent);
  border: 1px solid var(--ll-accent); background: transparent;
  font: inherit; font-size: calc(10px * var(--ll-font-scale, 1)); padding: 0 5px;
  border-radius: 999px; line-height: calc(15px * var(--ll-font-scale, 1));
}
.ll-tag-btn:hover:not(:disabled) { background: var(--ll-accent); color: #fff; }
.ll-tag-btn:disabled { opacity: .45; cursor: default; }
.ll-item-actions {
  position: absolute; top: 5px; right: 4px; z-index: 1;
  display: inline-flex; align-items: center; gap: 1px;
  padding-left: 0; border-radius: 6px; background: none;
}
/* 平时只露出「⋯」，避免盖住标题；hover / 键盘聚焦时展开全部排序按钮 */
.ll-item-actions .ll-icon-btn { display: none; }
.ll-item-actions .ll-icon-btn.ll-item-more { display: inline-flex; opacity: .5; }
.ll-item:hover .ll-item-actions,
.ll-item:focus-within .ll-item-actions {
  padding-left: 12px;
  background: linear-gradient(90deg, transparent, var(--ll-hover) 26%);
}
.ll-item.active:hover .ll-item-actions {
  background: linear-gradient(90deg, transparent, var(--ll-selected-bg) 26%);
}
.ll-item:hover .ll-item-actions .ll-icon-btn,
.ll-item:focus-within .ll-item-actions .ll-icon-btn { display: inline-flex; }
.ll-item:hover .ll-item-actions .ll-icon-btn.ll-item-more,
.ll-item:focus-within .ll-item-actions .ll-icon-btn.ll-item-more { opacity: 1; }
.ll-item[draggable="true"] { cursor: grab; }
.ll-item.ll-dragging { opacity: .38; cursor: grabbing; }
.ll-item.ll-drop-before { box-shadow: inset 0 2px 0 var(--ll-accent); }
.ll-item.ll-drop-after { box-shadow: inset 0 -2px 0 var(--ll-accent); }
.ll-item-hidden { opacity: .48; }
.ll-progress { margin-top: 4px; }
.ll-progress-bar { width: 62px; height: 3px; }
.ll-progress-failed .ll-progress-fill { background: var(--ll-danger); }
.ll-head {
  padding: 10px 14px; gap: 8px 14px;
  background: linear-gradient(180deg, var(--ll-head-bg), var(--ll-panel-bg));
}
.ll-head.ll-head-compact { padding-top: 9px; padding-bottom: 9px; }
.ll-head-titles { flex: 1 1 460px; }
.ll-eyebrow {
  display: flex; align-items: center; gap: 6px; margin-bottom: 3px;
  color: var(--ll-subtle); font-size: calc(10.5px * var(--ll-font-scale, 1)); line-height: 1.4;
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
}
.ll-eyebrow .ll-sep { color: var(--ll-soft-border); }
.ll-head h1 { font-size: calc(16px * var(--ll-font-scale, 1)); line-height: 1.42; letter-spacing: .15px; }
.ll-title-en { margin-top: 3px; }
.ll-head-actions { gap: 4px; align-items: center; }
.ll-navpair {
  display: inline-flex; align-items: center; gap: 1px;
  padding: 1px; border: 1px solid var(--ll-soft-border); border-radius: 7px;
  background: var(--ll-control-bg);
}
.ll-navpair .ll-icon-btn { width: 20px; height: 20px; }
.ll-pagepos {
  min-width: 38px; padding: 0 3px; text-align: center;
  color: var(--ll-muted); font-size: calc(10.5px * var(--ll-font-scale, 1)); font-variant-numeric: tabular-nums;
}
.ll-head-details { padding-top: 8px; gap: 7px 12px; }
.ll-chip { background: var(--ll-control-bg); border-color: var(--ll-soft-border); }
.ll-pane-head {
  height: 40px; min-height: 40px; padding: 0 9px;
  background: var(--ll-head-bg); color: var(--ll-text);
}
.ll-pane-title { flex: none; font-weight: 650; letter-spacing: .2px; }
.ll-pane-tools {
  flex: none; box-sizing: border-box;
  height: var(--ll-pdf-toolbar-h); min-height: var(--ll-pdf-toolbar-h);
  display: flex; align-items: center; padding: 0 9px;
  border-bottom: 1px solid var(--ll-soft-border);
  background: var(--ll-pdf-toolbar-bg); color: var(--ll-pdf-toolbar-fg);
  font-size: calc(12px * var(--ll-font-scale, 1)); font-weight: 650;
  gap: 6px; overflow-x: auto; overflow-y: hidden; scrollbar-width: none;
}
.ll-pane-tools::-webkit-scrollbar { display: none; }
.ll-pane-tools .ll-btn { padding: 2px 7px; font-size: calc(11.5px * var(--ll-font-scale, 1)); }
.ll-pane-tools .ll-hint { flex: none; white-space: nowrap; color: var(--ll-pdf-toolbar-muted); }
.ll-pane-tools .ll-tab { color: var(--ll-pdf-toolbar-muted); }
.ll-pane-tools .ll-tab.on { color: #fff; }
.ll-wordcount {
  flex: none; color: var(--ll-subtle); font-size: calc(10.5px * var(--ll-font-scale, 1));
  font-variant-numeric: tabular-nums; white-space: nowrap;
}
/* PDF.js 阅读器：工具条与译文第 2 行同高，正文用 canvas 自己画 */
.ll-pdf-viewer { flex: 1 1 0; min-height: 0; min-width: 0; display: flex; flex-direction: column; container-type: size; }
.ll-root .ll-layout-controls { flex: 0 1 auto; min-height: 0; min-width: 0; max-height: 220px; overflow: auto; box-sizing: border-box; padding: 6px 8px; border-top: 1px solid var(--ll-soft-border); background: var(--ll-panel-bg); color: var(--ll-text); font: 12px/1.4 system-ui,sans-serif; overscroll-behavior: contain; }
/* At least two thirds of the actual viewer stays available to the PDF, even
   when the host header is expanded. vh alone cannot enforce that constraint. */
.ll-pdf-viewer > .ll-layout-controls { max-height: min(220px, 32vh); }
@supports (height: 1cqh) { .ll-pdf-viewer > .ll-layout-controls { max-height: min(220px, 34cqh); } }
.ll-root .ll-layout-row { display: flex; align-items: center; flex-wrap: nowrap; gap: 6px; max-width: 100%; min-width: 0; min-height: 26px; overflow-x: auto; }
.ll-layout-row > :not(.ll-layout-state):not(.ll-spacer) { flex-shrink: 0; }
.ll-layout-state { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ll-layout-row + .ll-layout-row, .ll-layout-editor { margin-top: 4px; }
.ll-root .ll-layout-actions { flex-wrap: wrap; overflow: visible; }
.ll-layout-row input[type=number] { width: 58px; margin-left: 3px; }
.ll-layout-row select { max-width: 100%; }
.ll-root .ll-layout-controls :is(p,label,summary,strong,span), .ll-root .ll-layout-controls :is(button,input,select),
.ll-root .ll-layout-mode { font-size: 12px !important; line-height: 1.4 !important; letter-spacing: normal; }
.ll-root .ll-layout-controls :is(button,input,select), .ll-root .ll-layout-mode { box-sizing: border-box; max-width: 100%; min-width: 0; min-height: 25px !important; height: 25px !important; margin: 0; padding: 2px 6px !important; font-family: inherit; border: 1px solid var(--ll-soft-border); border-radius: 4px; background: var(--ll-control-bg); color: var(--ll-text); }
.ll-root .ll-layout-mode { width: 160px; flex: 0 1 160px; text-overflow: ellipsis; }
.ll-root .ll-layout-controls label { display: inline-flex; align-items: center; white-space: nowrap; gap: 3px; }
.ll-root .ll-layout-hint { margin: 4px 0 !important; color: var(--ll-muted); }
.ll-root .ll-layout-error { margin: 4px 0 !important; color: #de8176; overflow-wrap: anywhere; max-height: 48px; overflow: auto; }
.ll-root .ll-layout-region-list { display: flex; flex-wrap: nowrap; gap: 4px; margin: 5px 0; max-width: 100%; overflow-x: auto; padding: 2px; }
.ll-layout-region-list > button { flex: none; }
.ll-layout-help { margin-top: 4px; color: var(--ll-muted); }
.ll-layout-help summary { cursor: pointer; width: fit-content; }
.ll-layout-region-list [aria-pressed=true] { outline: 2px solid var(--ll-accent); }
.ll-region-overlay { position: absolute; inset: 0; z-index: 6; user-select: none; }
.ll-region-box { position: absolute; border: 1.5px solid #1477b8; background: rgba(20,119,184,.055); box-sizing: border-box; cursor: move; }
.ll-region-box[data-role=abstract] { border-color: #9c6011; background: rgba(156,96,17,.06); }
.ll-region-box[data-role=publication], .ll-region-box[data-role=front-matter], .ll-region-box[data-role=article-info], .ll-region-box[data-role=affiliation], .ll-region-box[data-role=running-matter], .ll-region-box[data-role=watermark] { border-color: #646464; background: rgba(90,90,90,.06); }
.ll-region-box.is-selected { outline: 2px solid #111; }
.ll-region-label { position: absolute; left: 0; top: 0; background: #fff; color: #111; font: 11px/16px system-ui,sans-serif; padding: 0 3px; white-space: nowrap; pointer-events: none; }
.ll-region-handle { position: absolute; right: -4px; bottom: -4px; width: 10px; height: 10px; background: #1477b8; border: 1px solid white; cursor: nwse-resize; }
.ll-layout-queue-row { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--ll-soft-border); font-size: 13px; }
.ll-layout-queue-title { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; overflow-wrap: anywhere; }
.ll-layout-queue-title span { font-size: 12px; color: var(--ll-muted); }
.ll-pdf-tools { flex: none; }
.ll-page-input {
  flex: none; width: 44px; box-sizing: border-box; padding: 2px 3px;
  border: 1px solid var(--ll-soft-border); border-radius: 4px;
  background: var(--ll-control-bg); color: var(--ll-pdf-toolbar-fg);
  font: inherit; font-size: calc(11.5px * var(--ll-font-scale, 1)); text-align: center;
  -moz-appearance: textfield; appearance: textfield;
}
.ll-page-input::-webkit-outer-spin-button,
.ll-page-input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.ll-page-input:focus { outline: none; border-color: var(--ll-accent); }
.ll-pdf-pages, .ll-pdf-zoom {
  flex: none; color: var(--ll-pdf-toolbar-muted); font-size: calc(11px * var(--ll-font-scale, 1));
  font-variant-numeric: tabular-nums; white-space: nowrap;
}
.ll-pdf-zoom { min-width: 38px; text-align: center; }
.ll-pdf-body {
  flex: auto; min-height: 0; overflow: auto;
  /* 与纸面同色：不再在 PDF 页四周留一圈深色底 */
  padding: 0; background: var(--ll-paper-bg);
  overscroll-behavior: contain;
}
.ll-pdf-page-list {
  display: flex; flex-direction: column; align-items: center;
  gap: 12px; margin: 0 auto;
}
.ll-pdf-page {
  position: relative; flex: none; overflow: hidden;
  background: #fff; box-shadow: none;
}
.ll-pdf-canvas { position: absolute; left: 0; top: 0; display: block; }
.ll-pdf-text-layer {
  position: absolute; inset: 0; overflow: hidden; line-height: 1; opacity: 1;
  transform-origin: 0 0; text-size-adjust: none; forced-color-adjust: none;
  --min-font-size: 1; --user-unit: 1; --total-scale-factor: var(--scale-factor, 1);
}
.ll-pdf-text-layer span, .ll-pdf-text-layer br {
  position: absolute; color: transparent; white-space: pre; cursor: text;
  transform-origin: 0 0; user-select: text;
  --font-height: 0; --scale-x: 1; --rotate: 0deg;
  font-size: calc(var(--total-scale-factor) * var(--min-font-size) * var(--font-height));
  transform: rotate(var(--rotate)) scaleX(var(--scale-x)) scale(calc(1 / var(--min-font-size)));
}
.ll-pdf-text-layer .markedContent { display: contents; }
.ll-pdf-text-layer ::selection { background: rgba(40, 130, 255, .38); }
.ll-pdf-text-layer .ll-pdf-search-hit { background: rgba(255, 214, 55, .62); color: transparent; border-radius: 2px; }
.ll-pdf-search { width: 120px; flex: none; }
.ll-pdf-search-count { color: var(--ll-pdf-toolbar-muted); font-size: calc(10.5px * var(--ll-font-scale, 1)); white-space: nowrap; }
.ll-pdf-page-no {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  color: #8a94a0; font-size: calc(12px * var(--ll-font-scale, 1)); letter-spacing: .3px;
}
.ll-pdf-fallback { width: 100%; height: 100%; min-height: 70vh; border: 0; background: #fff; display: block; }
.ll-pdf-body .ll-status, .ll-pdf-body .ll-empty { max-width: 560px; color: var(--ll-paper-muted); margin: 24px auto; }
.ll-pdf-body .ll-status code { color: var(--ll-paper-text); background: var(--ll-paper-soft); }
.ll-tabs {
  flex: none; display: inline-flex; gap: 1px; padding: 1px;
  border-radius: 7px; background: var(--ll-control-bg);
}
.ll-tab { padding: 2px 9px; border-radius: 5px; border: 0; }
.ll-tab.on { background: var(--ll-accent); color: #fff; border-color: transparent; }
.ll-pane-translation .ll-pane-head { background: var(--ll-head-bg); }
.ll-md { padding: 16px 20px 48px; line-height: 1.78; }
.ll-md img, .ll-md-image { display: block; max-width: 100%; height: auto; margin: 12px auto; }
.ll-md a { color: #1769aa; text-decoration: underline; text-underline-offset: 2px; }
.ll-footnotes { margin-top: 28px; font-size: .92em; color: var(--ll-paper-muted); }
.ll-footnotes ol { padding-left: 22px; }
.ll-footnote-ref { line-height: 0; }
.ll-footnote-back { text-decoration: none !important; }
.ll-wysiwyg { padding-top: 14px; }
.ll-empty { padding: 26px 22px; line-height: 1.75; }
.ll-empty strong { display: block; margin-bottom: 4px; color: var(--ll-text); font-size: calc(13.5px * var(--ll-font-scale, 1)); }
.ll-empty .ll-btn { margin-top: 10px; }
.ll-banner { padding: 7px 10px; line-height: 1.55; background: var(--ll-control-bg); }
.ll-banner.err { border-color: var(--ll-danger); }
.ll-menu { padding: 5px; border-radius: 9px; box-shadow: 0 16px 44px rgba(0, 0, 0, .45); animation: ll-pop .12s ease-out; }
.ll-menu-item { padding: 6px 10px; border-radius: 5px; }
.ll-modal { border-radius: 11px; box-shadow: 0 28px 70px rgba(0, 0, 0, .55); }
.ll-modal-bg { background: rgba(0, 0, 0, .46); backdrop-filter: blur(2px); }
.ll-modal-head { padding: 10px 12px; }
.ll-modal-foot { padding: 9px 12px; }
@keyframes ll-pop { from { opacity: 0; transform: translateY(-3px) scale(.985); } to { opacity: 1; transform: none; } }
.ll-nav-body, .ll-pane-body, .ll-pdf-body, .ll-wysiwyg, .ll-modal-body, .ll-pane-tools {
  scrollbar-color: var(--ll-soft-border) transparent;
  scrollbar-width: thin;
}
.ll-nav-body::-webkit-scrollbar, .ll-pane-body::-webkit-scrollbar,
.ll-pdf-body::-webkit-scrollbar, .ll-wysiwyg::-webkit-scrollbar,
.ll-modal-body::-webkit-scrollbar { width: 8px; height: 8px; }
.ll-nav-body::-webkit-scrollbar-thumb, .ll-pane-body::-webkit-scrollbar-thumb,
.ll-pdf-body::-webkit-scrollbar-thumb, .ll-wysiwyg::-webkit-scrollbar-thumb,
.ll-modal-body::-webkit-scrollbar-thumb {
  background: var(--ll-soft-border); border-radius: 4px; border: 2px solid transparent;
  background-clip: content-box;
}
.ll-nav-body::-webkit-scrollbar-thumb:hover, .ll-pane-body::-webkit-scrollbar-thumb:hover,
.ll-pdf-body::-webkit-scrollbar-thumb:hover {
  background: var(--ll-muted); background-clip: content-box;
}
/* 专注阅读：只保留当前论文识别信息与核心操作，把垂直空间还给正文。 */
.ll-root.ll-focus { --ll-pdf-toolbar-h: 29px; }
.ll-focus .ll-head {
  min-height: 32px; padding: 4px 8px; gap: 4px 7px;
  flex-wrap: nowrap; align-items: center;
}
.ll-focus .ll-head.ll-head-compact { padding-top: 4px; padding-bottom: 4px; }
.ll-focus .ll-head-titles { flex: 1 1 auto; min-width: 0; }
.ll-focus .ll-eyebrow, .ll-focus .ll-title-en, .ll-focus .ll-focus-optional { display: none; }
.ll-focus .ll-head h1 {
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: calc(12.5px * var(--ll-font-scale, 1)); line-height: 1.35;
}
.ll-focus .ll-head-actions { gap: 3px; }
.ll-focus .ll-head-actions > .ll-btn { padding: 2px 7px; font-size: calc(11px * var(--ll-font-scale, 1)); }
.ll-focus .ll-navpair { height: 24px; }
.ll-focus .ll-head-details { padding-top: 5px; gap: 4px 8px; }
.ll-focus .ll-pane-head {
  height: 28px; min-height: 28px; padding: 0 7px;
  font-size: calc(11px * var(--ll-font-scale, 1));
}
.ll-focus .ll-wordcount { display: none; }
.ll-focus .ll-pane-tools { padding: 0 6px; gap: 4px; }
.ll-focus .ll-pane-tools .ll-btn { padding: 1px 6px; font-size: calc(10.5px * var(--ll-font-scale, 1)); }
.ll-focus .ll-tabs { padding: 0; border-radius: 5px; }
.ll-focus .ll-tab { padding: 1px 7px; border-radius: 4px; }
@media (max-width: 900px) {
  .ll-focus .ll-head h1 { max-width: 42vw; }
  .ll-focus .ll-pagepos { min-width: 32px; }
}
@container (max-width: 250px) {
  .ll-nav-head { padding: 7px 7px 6px; gap: 5px; }
  .ll-nav-title { gap: 4px; }
  .ll-nav-title > svg { width: 13px; height: 13px; }
  .ll-count-pill { margin-left: 0; padding: 0 4px; }
  .ll-nav-title .ll-btn { padding-left: 5px; padding-right: 5px; }
  .ll-treebar, .ll-toolbar { padding-left: 6px; padding-right: 6px; gap: 3px; }
  .ll-treebar .ll-btn, .ll-toolbar .ll-btn { padding-left: 5px; padding-right: 5px; }
  .ll-item { padding-right: 6px; }
  .ll-item-main { padding-right: 18px; }
  .ll-nav-foot { padding: 4px 6px; gap: 3px; }
  .ll-font-size { width: 100%; display: grid; grid-template-columns: auto 70px minmax(36px, 1fr) 42px auto; }
  .ll-font-range { width: 100%; }
  .ll-nav-foot-hint { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .ll-root *, .ll-root *::before, .ll-root *::after {
    animation-duration: .001ms !important; animation-iteration-count: 1 !important;
    transition-duration: .001ms !important;
  }
}
/* Flat reader chrome; empty translation pages still need paper-colour text. */
.ll-root { font-variant-numeric: tabular-nums; }
.ll-nav-head { background: var(--ll-nav-head-bg); }
.ll-head, .ll-head.ll-head-compact { background: var(--ll-head-bg); }
.ll-btn, .ll-tab { box-shadow: none; }
.ll-root button.ll-item { box-shadow: none; }
.ll-root .ll-item.active:not(.ll-drop-before):not(.ll-drop-after) { box-shadow: none; }
.ll-item.active .ll-item-journal { color: var(--ll-muted); }
.ll-pane-body .ll-empty strong { color: var(--ll-paper-text); }
.ll-modal-bg { backdrop-filter: none; }
/* Reading zoom belongs to the paper, not to navigation and form controls. */
.ll-root :is(.ll-nav-shell,.ll-head,.ll-pane-head,.ll-pane-tools,.ll-layout-controls,.ll-modal,.ll-menu) {
  --ll-font-scale: 1; font-size: 12px; line-height: 1.4;
}
.ll-root :is(.ll-nav-shell,.ll-head,.ll-pane-head,.ll-pane-tools,.ll-modal,.ll-menu) :is(button,input,select,label,summary) {
  font-family: inherit; font-size: 12px !important; line-height: 1.4 !important;
}
.ll-root :is(.ll-nav-shell,.ll-modal,.ll-menu) select {
  box-sizing: border-box; max-width: 100%; min-width: 0; height: 25px !important; min-height: 25px !important;
  margin: 0; padding: 2px 5px !important;
}
.ll-root .ll-nav-shell .ll-toolbar > .ll-btn { max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
.ll-root .ll-nav-title { flex-wrap: wrap; }
.ll-root .ll-nav-title > span { white-space: nowrap; flex-shrink: 0; }
.ll-root .ll-nav-head > .ll-banner { max-height: 52px; overflow: auto; font-size: 11px; line-height: 1.4; }
.ll-root .ll-head { max-height: min(210px, 28vh); overflow: auto; }
.ll-root .ll-pane-head { flex-shrink: 0; }
.ll-root .ll-pdf-body { flex: 1 1 0; min-height: 0; }
.ll-root .ll-pane-body :is(.ll-empty,.ll-status) {
  --ll-font-scale: 1; font: 13px/1.6 system-ui,sans-serif;
}
.ll-root .ll-pane-body .ll-empty strong { font-size: 14px; line-height: 1.4; }

/* 0.7 reader shell: controls, reading scale and editing geometry are separate. */
.ll-root { --ll-font-scale:1; font:13px/1.45 system-ui,sans-serif; letter-spacing:0; position:relative; box-sizing:border-box; }
.ll-root[data-ll-theme="dark"] {
 --ll-bg:#101010; --ll-nav-bg:#101010; --ll-nav-head-bg:#171717; --ll-panel-bg:#151515;
 --ll-head-bg:#171717; --ll-control-bg:#242424; --ll-control-hover:#303030;
 --ll-selected-bg:#282828; --ll-soft-border:#3b3b3b; --ll-text:#f4f4f4; --ll-muted:#bcbcbc; --ll-subtle:#a0a0a0;
}
.ll-root :is(button,input,select,textarea) { box-sizing:border-box; }
.ll-root :is(.ll-nav-shell,.ll-head,.ll-pane-head,.ll-pane-tools,.ll-modal,.ll-menu,.ll-layout-controls) { font:12px/1.4 system-ui,sans-serif; }
.ll-root .ll-pane-translation :is(.ll-md,.ll-editor,.ll-wysiwyg) { --ll-font-scale:var(--ll-reading-scale,1); font-size:calc(14px * var(--ll-reading-scale,1)); }
.ll-root .ll-md p { font-size:inherit; line-height:1.75; }
.ll-root .ll-md { color:var(--ll-paper-text); }
.ll-root .ll-nav-head { padding:10px; gap:10px; border:0; }
.ll-root .ll-nav-title { flex-wrap:nowrap; font-size:14px; }
.ll-root .ll-nav-title > span { white-space:nowrap; }
.ll-root .ll-nav-shell { min-width:200px; }
.ll-root .ll-nav-actions { display:flex; gap:6px; padding:0 10px 10px; }
.ll-root .ll-nav-actions .ll-btn { flex:1; min-width:0; padding:5px 4px; font-size:12px; }
.ll-root .ll-item.active { background:var(--ll-selected-bg); box-shadow:none; }
.ll-root .ll-item-meta,.ll-root .ll-item-journal,.ll-root .ll-item-pub,.ll-root .ll-progress,.ll-root .ll-usage { font-size:11px; }
.ll-root .ll-count-pill,.ll-root .ll-tag { font-size:11px; }
.ll-root .ll-head { padding:8px 12px; gap:6px 12px; max-height:170px; }
.ll-root .ll-head h1 { font-size:16px; line-height:1.4; }
.ll-root .ll-head-actions { align-items:center; gap:6px; }
.ll-root .ll-reader-select { max-width:112px; height:28px; padding:2px 5px; font:12px system-ui,sans-serif; background:var(--ll-control-bg); color:var(--ll-text); border:1px solid var(--ll-soft-border); border-radius:6px; }
.ll-root .ll-pane-head { height:32px; min-height:32px; }
.ll-root .ll-pane-tools { min-height:32px; height:32px; }
.ll-root .ll-btn { border-radius:6px; box-shadow:none; }
.ll-root .ll-tab.on { background:var(--ll-selected-bg); color:var(--ll-text); border-color:var(--ll-soft-border); }
.ll-root .ll-primary { background:var(--ll-text); color:var(--ll-bg); min-height:32px; padding:5px 12px; }
.ll-root .ll-nav-foot { flex-wrap:wrap; gap:6px; padding:8px 10px; }
.ll-root .ll-nav-foot .ll-nav-foot-tag { font-size:11px; }
.ll-root .ll-tools-dialog { width:min(680px,94vw); height:auto; max-height:86vh; }
.ll-root .ll-modal-head h2 { font:600 16px/1.4 system-ui,sans-serif; margin:0; }
.ll-root .ll-tool-tabs { display:flex; gap:6px; padding:8px 12px; flex-wrap:wrap; flex:none; }
.ll-root .ll-tool-tabs .ll-tab { min-height:30px; font-size:13px!important; padding:4px 8px; }
.ll-root .ll-tool-section { padding:12px 16px 20px; display:flex; flex-wrap:wrap; gap:12px; align-items:center; }
.ll-root .ll-tool-section h3 { width:100%; font:600 15px/1.4 system-ui,sans-serif; margin:0; }
.ll-root .ll-tool-section p { width:100%; font:13px/1.65 system-ui,sans-serif!important; margin:0; color:var(--ll-muted); }
.ll-root .ll-tool-section > .ll-scan { width:100%; display:flex; gap:8px; }
.ll-root .ll-tool-section .ll-treebar { width:100%; padding:8px 0; background:transparent; border:0; flex-wrap:wrap; }
.ll-root .ll-tool-section .ll-toolbar { display:flex; width:100%; flex-wrap:wrap; padding:0; gap:12px; background:transparent; border:0; }
.ll-root .ll-tool-section .ll-toolbar .ll-spacer { display:none; }
.ll-root .ll-tool-section .ll-layout-mode { flex:1 1 100%; max-width:100%; height:32px; }
.ll-root .ll-tool-section .ll-media-options { flex:1 1 100%; gap:10px 16px; }
.ll-root .ll-tool-section .ll-font-size { display:flex; flex:1 1 100%; align-items:center; gap:8px; }
.ll-root .ll-tool-section .ll-font-band { width:110px; }
.ll-root .ll-tool-section .ll-font-range { flex:1; width:100px; }
.ll-root .ll-tool-section .ll-font-num { width:70px; min-width:70px; }
.ll-root .ll-tool-section :is(input:not([type="checkbox"]):not([type="range"]),select) { height:32px; padding:4px 6px; }
.ll-root .ll-modal :is(button,input,select,label) { font-size:13px!important; }
.ll-root .ll-modal-bg { z-index:80; }
.ll-root .ll-menu { max-width:min(360px,calc(100vw - 16px)); max-height:calc(100vh - 16px); overflow:auto; z-index:90; }
.ll-root .ll-menu-item { min-height:32px; }
.ll-root .ll-layout-controls { max-height:min(34%,220px); flex:none; overflow:auto; font:12px/1.4 system-ui,sans-serif; }
.ll-root .ll-layout-controls p { font:12px/1.5 system-ui,sans-serif!important; margin:4px 0!important; }
.ll-root .ll-region-label { font:11px/1.2 system-ui,sans-serif!important; }
.ll-root .ll-reader-select,.ll-root .ll-icon-btn { flex-shrink:0; }
.ll-root.ll-reader-translation .ll-pane-pdf,.ll-root.ll-reader-pdf .ll-pane-translation,
.ll-root:not(.ll-reader-split) .ll-split > .ll-divider { display:none; }
.ll-root:not(.ll-reader-split) .ll-split > .ll-pane { flex:1 1 100%!important; min-width:0; }
.ll-root .ll-mobilebar { display:none; }
@media (max-width:1000px) {
 .ll-root .ll-nav-shell { min-width:180px; }
 .ll-root .ll-head-actions { flex-wrap:wrap; }
 .ll-root .ll-title-en { display:none; }
 .ll-root .ll-pane-pdf .ll-pdf-search { max-width:125px; }
}
@media (max-width:700px) {
 .ll-root { padding-top:44px; }
 .ll-root .ll-mobilebar { display:flex; align-items:center; gap:10px; position:absolute; top:0; left:0; right:0; height:44px; padding:6px 10px; background:var(--ll-head-bg); z-index:30; }
 .ll-root .ll-mobilebar > span { flex:1; text-align:center; font-size:14px; }
 .ll-root .ll-mobilebar .ll-btn { min-height:32px; }
 .ll-root .ll-nav-shell { display:none; }
 .ll-root.ll-nav-open .ll-nav-shell { display:flex; position:absolute; z-index:40; left:0; top:44px; bottom:0; width:min(300px,88vw); box-shadow:8px 0 20px #0004; }
 .ll-root > .ll-divider { display:none; }
 .ll-root .ll-main-shell { flex:1 1 100%!important; min-width:0; width:100%; }
 .ll-root .ll-head { max-height:150px; padding:8px 10px; }
 .ll-root .ll-head h1 { font-size:14px; }
 .ll-root .ll-head-actions { width:100%; justify-content:space-between; gap:4px; }
 .ll-root .ll-head-actions > .ll-focus-optional,.ll-root .ll-navpair { display:none; }
 .ll-root .ll-pane-tools { flex-wrap:nowrap; }
 .ll-root .ll-pdf-tools { overflow-x:auto; }
 .ll-root.ll-reader-split .ll-pane-pdf,.ll-root.ll-reader-split .ll-split > .ll-divider { display:none; }
 .ll-root.ll-reader-split .ll-pane-translation { flex:1 1 100%!important; }
 .ll-root .ll-modal-bg { padding:8px; box-sizing:border-box; }
 .ll-root .ll-tools-dialog { max-height:90vh; }
 .ll-root .ll-tool-tabs { gap:2px; padding:6px; }
 .ll-root .ll-tool-tabs .ll-tab { padding:6px; font-size:12px!important; }
 .ll-root .ll-tool-section { padding:12px; }
 .ll-root .ll-tool-section .ll-font-size { flex-wrap:wrap; }
}
/* DSH may embed this panel in a narrow host without resizing the window. */
.ll-root.ll-compact { padding-top:44px; }
 .ll-root.ll-compact .ll-mobilebar { display:flex; align-items:center; gap:10px; position:absolute; top:0; left:0; right:0; height:44px; padding:6px 10px; background:var(--ll-head-bg); z-index:30; }
 .ll-root.ll-compact .ll-mobilebar > span { flex:1; text-align:center; font-size:14px; }
 .ll-root.ll-compact .ll-mobilebar .ll-btn { min-height:32px; }
 .ll-root.ll-compact .ll-nav-shell { display:none; }
 .ll-root.ll-compact.ll-nav-open .ll-nav-shell { display:flex; position:absolute; z-index:40; left:0; top:44px; bottom:0; width:min(300px,88vw); box-shadow:8px 0 20px #0004; }
 .ll-root.ll-compact > .ll-divider { display:none; }
 .ll-root.ll-compact .ll-main-shell { flex:1 1 100%!important; min-width:0; width:100%; }
 .ll-root.ll-compact .ll-head { max-height:150px; padding:8px 10px; }
 .ll-root.ll-compact .ll-head h1 { font-size:14px; }
 .ll-root.ll-compact .ll-head-actions { width:100%; justify-content:space-between; gap:4px; }
 .ll-root.ll-compact .ll-head-actions > .ll-focus-optional,.ll-root.ll-compact .ll-navpair { display:none; }
 .ll-root.ll-compact .ll-pane-tools { flex-wrap:nowrap; }
 .ll-root.ll-compact .ll-pdf-tools { overflow-x:auto; }
 .ll-root.ll-compact.ll-reader-split .ll-pane-pdf,.ll-root.ll-compact.ll-reader-split .ll-split > .ll-divider { display:none; }
 .ll-root.ll-compact.ll-reader-split .ll-pane-translation { flex:1 1 100%!important; }
 .ll-root.ll-compact .ll-modal-bg { padding:8px; box-sizing:border-box; }
 .ll-root.ll-compact .ll-tools-dialog { max-height:90vh; }
 .ll-root.ll-compact .ll-tool-tabs { gap:2px; padding:6px; }
 .ll-root.ll-compact .ll-tool-tabs .ll-tab { padding:6px; font-size:12px!important; }
 .ll-root.ll-compact .ll-tool-section { padding:12px; }
 .ll-root.ll-compact .ll-tool-section .ll-font-size { flex-wrap:wrap; }
.ll-root .ll-job-diagnostic { max-width:100%; font-size:11px; }
.ll-root .ll-job-diagnostic summary { cursor:pointer; }
.ll-root .ll-job-diagnostic pre { max-height:120px; max-width:100%; white-space:pre-wrap; overflow:auto; font:11px/1.5 monospace; }
.ll-root .ll-pane-head { padding-right:18px; }
.ll-root .ll-pdf-tools { padding-right:18px; position:relative; overflow:visible; }
.ll-root .ll-pdf-extras { position:static; flex:none; }
.ll-root .ll-pdf-extras-panel { position:absolute; top:calc(100% + 5px); right:0; z-index:35; width:250px; display:flex; align-items:center; flex-wrap:wrap; gap:6px; padding:12px; background:var(--ll-nav-bg); border:1px solid var(--ll-soft-border); border-radius:6px; color:var(--ll-text); }
.ll-root .ll-pdf-extras-panel .ll-pdf-search { width:100%; max-width:100%; }
.ll-root .ll-pdf-pages,.ll-root .ll-pdf-zoom,.ll-root .ll-page-input { font-variant-numeric:tabular-nums; }
.ll-root .ll-pdf-tools { gap:3px; }
.ll-root .ll-pdf-tools .ll-page-input { width:36px; }
.ll-root .ll-pane-head { padding-left:16px; }
.ll-root.ll-compact .ll-head,.ll-root.ll-compact .ll-mobilebar { padding-left:16px; padding-right:16px; }
.ll-root .ll-count-pill { font-size:11px; }

/* 0.7.1: a small review bar; detailed edits are disclosures, not a wall of chips. */
.ll-root .ll-layout-controls { position:relative; z-index:25; padding:8px 16px; max-height:none; overflow:visible; background:var(--ll-nav-bg); }
.ll-root .ll-layout-mainbar { display:flex; align-items:center; gap:8px; min-height:30px; }
.ll-root .ll-layout-mainbar > strong { flex:none; font-size:12px; }
.ll-root .ll-layout-state { min-width:0; max-width:220px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:11px; color:var(--ll-muted); }
.ll-root .ll-layout-mainbar .ll-btn,.ll-root .ll-layout-selection .ll-btn { flex:none; min-height:28px; font-size:12px!important; padding:3px 8px; }
.ll-root .ll-layout-primary { background:var(--ll-text); color:var(--ll-bg); border-color:transparent; }
.ll-root .ll-layout-selection { display:flex; align-items:center; flex-wrap:wrap; gap:6px; margin-top:6px; }
.ll-root .ll-layout-selection select { font:12px/1.4 system-ui,sans-serif!important; height:28px!important; padding:3px 6px!important; width:auto; min-width:0; max-width:100%; border-radius:4px; }
.ll-root .ll-layout-region-select { flex:1 1 145px; }
.ll-root .ll-layout-selection select[aria-label="分区类型"] { flex:0 1 110px; }
.ll-root .ll-layout-more,.ll-root .ll-layout-inspector { flex:none; }
.ll-root .ll-layout-more > summary,.ll-root .ll-layout-inspector > summary { cursor:pointer; padding:5px 6px; min-height:18px; list-style:none; font-size:12px; border-radius:4px; color:var(--ll-text); }
.ll-root .ll-layout-more > summary:hover,.ll-root .ll-layout-inspector > summary:hover { background:var(--ll-control-hover); }
.ll-root .ll-layout-menu { position:absolute; bottom:calc(100% + 6px); right:16px; width:min(320px,calc(100% - 32px)); max-height:min(340px,60vh); overflow:auto; display:flex; flex-direction:column; align-items:stretch; gap:10px; padding:14px; box-sizing:border-box; background:var(--ll-nav-bg); color:var(--ll-text); border:1px solid var(--ll-soft-border); border-radius:6px; box-shadow:0 8px 24px #0003; z-index:50; }
.ll-root .ll-layout-menu .ll-btn { align-self:flex-start; min-height:28px; }
.ll-root .ll-layout-menu label { display:flex; align-items:center; gap:8px; font-size:12px!important; }
.ll-root .ll-layout-menu label input[type="checkbox"] { flex:none; }
.ll-root .ll-layout-menu > strong { font-size:13px; }
.ll-root .ll-layout-menu :is(p,summary) { font-size:12px!important; line-height:1.5!important; }
.ll-root .ll-layout-advanced .ll-btn { margin-top:8px; }
.ll-root .ll-layout-coordinates { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
.ll-root .ll-layout-coordinates label { display:flex; min-width:0; }
.ll-root .ll-layout-coordinates input { width:80px!important; height:28px!important; font:12px/1.4 system-ui,sans-serif!important; }
.ll-root .ll-layout-counts { font-size:11px; color:var(--ll-muted); margin-top:2px; }
.ll-root .ll-layout-controls .ll-layout-unsaved { color:var(--ll-muted); font-size:11px!important; margin:4px 0 0!important; }
.ll-root .ll-layout-upgrade { display:flex; align-items:center; gap:8px; font-size:12px; margin-top:6px; }
.ll-root .ll-region-box { background:transparent; border-width:1px; }
.ll-root .ll-region-box[data-role="formula"] { border-color:#a16bd4; }
.ll-root .ll-region-box[data-role="caption"] { border-color:#b7791f; }
.ll-root .ll-region-box[data-role="table"],.ll-root .ll-region-box[data-role="figure"] { border-color:#27806c; }
.ll-root .ll-region-box .ll-region-label { display:none; top:-15px; left:-1px; max-width:100%; overflow:hidden; text-overflow:ellipsis; background:#fff; color:#111; padding:1px 3px; font:11px/13px system-ui,sans-serif!important; }
.ll-root .ll-region-box:is(:hover,.is-selected) .ll-region-label,.ll-root .ll-region-box[data-labels="all"] .ll-region-label { display:block; }
.ll-root .ll-region-handle { width:7px; height:7px; right:-3px; bottom:-3px; }
@container (max-width:520px) {
 .ll-layout-mainbar { flex-wrap:wrap; gap:5px!important; }
 .ll-layout-mainbar > .ll-layout-state { flex:1; max-width:none; }
 .ll-layout-mainbar > .ll-spacer { display:none; }
}

.ll-root .ll-ai-options { margin:8px 12px; padding:12px; background:var(--ll-nav-bg); color:var(--ll-text); border:1px solid var(--ll-soft-border); border-radius:6px; font:13px/1.5 system-ui,sans-serif; }
.ll-root .ll-ai-options summary { cursor:pointer; font-size:13px; }
.ll-root .ll-ai-options form { display:grid; gap:12px; padding-top:12px; }
.ll-root .ll-ai-options label { display:flex; flex-direction:column; gap:6px; font-size:13px; min-width:0; }
.ll-root .ll-ai-options :is(input,select) { box-sizing:border-box; font:inherit; width:100%; min-width:0; max-width:100%; min-height:32px; padding:5px 8px; background:var(--ll-control-bg); color:var(--ll-text); border:1px solid var(--ll-soft-border); border-radius:4px; }
.ll-root .ll-ai-options fieldset { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:12px; border:1px solid var(--ll-soft-border); border-radius:6px; padding:12px; min-width:0; }
.ll-root .ll-ai-options legend { padding:0 6px; font-size:13px; }
.ll-root .ll-ai-options p,.ll-root .ll-job-billing p { font:12px/1.5 system-ui,sans-serif!important; overflow-wrap:anywhere; margin:6px 0!important; }
.ll-root .ll-job-billing { display:block; max-height:240px; overflow:auto; font-size:12px; font-variant-numeric:tabular-nums; }
.ll-root .ll-job-billing summary { cursor:pointer; white-space:normal; }
.ll-root .ll-modal .ll-layout-row { flex-wrap:wrap; overflow:visible; }
.ll-root .ll-region-box[data-role="pending"] { border-color:#ad843e; border-style:dashed; }
`;

    function injectCss() {
      const id = 'dsh-literature-library/style';
      if (typeof document === 'undefined') return;
      // A hot upgrade reuses the document. An existing tag is not evidence that
      // it contains this version's CSS (new layout selectors may be absent).
      const tags = [...document.querySelectorAll(`style[data-plugin-css="${id}"]`)];
      const tag = tags.shift() || document.createElement('style');
      tag.dataset.plugin = 'dsh-literature-library';
      tag.dataset.pluginCss = id;
      tag.dataset.pluginCssVersion = PDFJS_REV;
      if (tag.textContent !== CSS) tag.textContent = CSS;
      for (const duplicate of tags) duplicate.remove();
      document.head.appendChild(tag);
    }

    // ─────────────────── KaTeX（按需，失败降级） ───────────────────

    const KATEX_VERSION = '0.16.9';
    let katexPromise = null;

    /**
     * 按需加载 KaTeX。
     *
     * **两级来源**：先试 CDN，失败则用插件自带的本地副本（走 host 的 `/vendor` 路由）。
     * 为什么要兜底：面板装在用户自己的机器上，可能访问不了 jsdelivr；
     * 那时所有公式都会降级成代码块——而公式正是这个面板的核心价值之一。
     * 本地副本由 host 提供（`plugin/literature-library/vendor/`），不占客户端 bundle。
     *
     * 加载失败也不抛错：返回 null，调用方降级为「公式以代码显示」并给出提示。
     */
    function loadKatex() {
      if (katexPromise) return katexPromise;
      katexPromise = new Promise((resolve) => {
        if (typeof window !== 'undefined' && window.katex) { resolve(window.katex); return; }

        const sources = [
          { label: '本地副本', local: true },
          { label: 'CDN', base: `https://cdn.jsdelivr.net/npm/katex@${KATEX_VERSION}/dist` },
        ];

        const injectCss = (href, cross) => {
          const link = document.createElement('link');
          link.rel = 'stylesheet';
          link.href = href;
          if (cross) link.crossOrigin = 'anonymous';
          document.head.appendChild(link);
        };

        const trySource = (idx) => {
          if (idx >= sources.length) { resolve(null); return; }
          const src = sources[idx];
          const jsUrl = src.local
            ? `${ROUTE_PREFIX}/vendor?name=${encodeURIComponent('katex.min.js')}`
            : `${src.base}/katex.min.js`;
          const cssUrl = src.local
            ? `${ROUTE_PREFIX}/vendor?name=${encodeURIComponent('katex.min.css')}`
            : `${src.base}/katex.min.css`;

          injectCss(cssUrl, !src.local);
          const script = document.createElement('script');
          script.src = jsUrl;
          if (!src.local) script.crossOrigin = 'anonymous';
          script.onload = () => {
            if (window.katex) resolve(window.katex);
            else trySource(idx + 1);
          };
          script.onerror = () => trySource(idx + 1);
          document.head.appendChild(script);
        };

        trySource(0);
      });
      return katexPromise;
    }

    // ─────────────────── PDF.js（本地面包，按需加载） ───────────────────

    /**
     * PDF.js 由 host 的 `/pdfjs/*` 路由提供（工作区或便携包里的 pdfjs-dist）。
     *
     * 为什么不再用浏览器内置 PDF 阅读器：连续切换文章时，内置阅读器会反复创建
     * PDFium 实例，实测切到第三篇左右即可把整个渲染进程拖死；而且它会把整份
     * PDF 读进内存（库里有一篇 149MB 的博士论文）。PDF.js 由我们用 canvas 渲染，
     * 只拉当前页附近的 Range，切换时 `doc.destroy()` 能确定地释放。
     */
    let pdfjsPromise = null;

    function loadPdfjs() {
      if (pdfjsPromise) return pdfjsPromise;
      pdfjsPromise = import(`${PDFJS_BASE}/build/pdf.min.mjs?v=${PDFJS_REV}`).then((mod) => {
        const api = mod?.GlobalWorkerOptions ? mod : (mod?.default ?? mod);
        if (!api?.GlobalWorkerOptions || typeof api.getDocument !== 'function') {
          throw new Error('PDF.js 模块导出不完整');
        }
        api.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}/build/pdf.worker.min.mjs?v=${PDFJS_REV}`;
        return api;
      }).catch((err) => {
        pdfjsPromise = null;   // 允许下次重试
        throw err;
      });
      return pdfjsPromise;
    }

    // ─────────────────── 极简 Markdown ───────────────────

    const escapeHtml = (s) => String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const safeUrl = (value, image = false) => {
      const raw = String(value ?? '').trim();
      if (!raw || /[\u0000-\u001f\u007f]/u.test(raw)) return null;
      if (/^(?:https?:|mailto:|#)/iu.test(raw)) return raw;
      if (image && /^data:image\/(?:png|gif|jpe?g|webp);base64,/iu.test(raw)) return raw;
      if (/^library\//iu.test(raw)) return fileUrl(raw);
      if (!/^[a-z][a-z0-9+.-]*:/iu.test(raw) && !raw.startsWith('//')) return raw;
      return null;
    };

    /** 仅保留论文排版需要的安全 HTML；脚本、样式和 on* 属性一律丢弃。 */
    function sanitizeMarkdownHtml(source) {
      const allowed = new Set([
        'p', 'br', 'hr', 'strong', 'em', 'b', 'i', 'u', 's', 'del', 'ins', 'mark',
        'sub', 'sup', 'small', 'kbd', 'code', 'pre', 'blockquote', 'details', 'summary',
        'table', 'thead', 'tbody', 'tr', 'th', 'td', 'ul', 'ol', 'li', 'a', 'img', 'span', 'figcaption',
      ]);
      let html = String(source)
        .replace(/<!--[\s\S]*?-->/gu, '')
        .replace(/<(script|style|iframe|object|embed|form|input|button|textarea)\b[\s\S]*?<\/\1\s*>/giu, '');
      html = html.replace(/<\/?([a-z][\w-]*)([^>]*)>/giu, (full, rawTag, rawAttrs) => {
        const tag = rawTag.toLowerCase();
        if (!allowed.has(tag)) return escapeHtml(full);
        if (full.startsWith('</')) return `</${tag}>`;
        const attrs = [];
        String(rawAttrs).replace(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gu,
          (_, rawName, dq, sq, bare) => {
            const name = rawName.toLowerCase();
            const value = dq ?? sq ?? bare ?? '';
            if (name === 'title' || name === 'class' || name === 'colspan' || name === 'rowspan') {
              attrs.push(`${name}="${escapeHtml(value)}"`);
            } else if (tag === 'a' && name === 'href') {
              const url = safeUrl(value);
              if (url) attrs.push(`href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"`);
            } else if (tag === 'img' && name === 'src') {
              const url = safeUrl(value, true);
              if (url) attrs.push(`src="${escapeHtml(url)}"`);
            } else if (tag === 'img' && name === 'alt') attrs.push(`alt="${escapeHtml(value)}"`);
            return '';
          });
        return `<${tag}${attrs.length ? ` ${attrs.join(' ')}` : ''}>`;
      });
      return html;
    }

    /**
     * 这段 TeX 是否**必须**用独立公式（display mode）渲染。
     *
     * 判据是 `\tag`：KaTeX 规定 `\tag` 只能出现在 display 公式里，
     * 行内使用会抛 `\tag works only in display equations`。
     *
     * 实测译稿里公式常写成 `$Q_0 = \dots \tag{1}$`（单个 `$` 包裹但带编号），
     * 于是整条公式渲染失败、页面上出现红色错误。自动提升为 display 后，
     * 公式与编号都能正常显示。
     */
    const needsDisplayMode = (tex) => /\\tag\b|\\begin\{(?:align|equation|gather|multline)/.test(String(tex));

    /**
     * 统一的 KaTeX 渲染入口。
     *
     * 关键点：用 `throwOnError: true`（不是 false）。
     * `false` 时 KaTeX 会**把错误信息画进页面**（红色文字），
     * 而我们的 try/catch 永远不会触发——用户看到的就是「公式渲染出现错误」。
     * 改成 true 后我们能接住错误、走自己的降级路径。
     *
     * 降级顺序：行内 → display（`\tag` 等情况）→ 显示源码 + 错因（绝不留空白）。
     */
    function renderTex(tex, katex, wantDisplay) {
      if (!katex) return `<code>${escapeHtml(tex)}</code>`;
      const mode = wantDisplay || needsDisplayMode(tex);
      const wrap = (mode2, html) => (mode2
        ? `<div class="ll-math-block">${html}</div>`
        : `<span class="ll-math">${html}</span>`);

      let firstErr = null;
      for (const tryMode of mode ? [true] : [false, true]) {
        try {
          const html = katex.renderToString(tex, { throwOnError: true, displayMode: tryMode, strict: false });
          return wrap(tryMode, html);
        } catch (err) { firstErr ??= err; }
      }
      // 真渲染不了：显示源码，并把错因挂在 title 里（指向具体 TeX，便于核对）
      return `<code class="ll-math-bad" title="${escapeHtml(String(firstErr?.message ?? firstErr))}">`
        + `${escapeHtml(tex)}</code>`;
    }

    function renderInline(text, katex, footnoteRefs) {
      const parts = [];
      const stash = (html) => {
        parts.push(html);
        return `\u0000${parts.length - 1}\u0000`;
      };
      const stashMath = (_, tex) => {
        return stash(renderTex(tex, katex, false));
      };
      // 同时兼容常见的 Markdown `$...$` 与 LaTeX `\(...\)` 行内分隔符。
      // 先把公式换成 NUL 占位符，避免后续 Markdown 强调语法误伤 TeX 里的 `*`。
      const withTokens = String(text)
        .replace(/\\\(([^\n]+?)\\\)/g, stashMath)
        .replace(/\$([^$\n]+?)\$/g, stashMath)
        .replace(/!\[([^\]]*)\]\((\S+?)(?:\s+["']([^"']*)["'])?\)/g, (full, alt, url, title) => {
          const safe = safeUrl(url, true);
          return safe ? stash(`<img class="ll-md-image" src="${escapeHtml(safe)}" alt="${escapeHtml(alt)}"${title ? ` title="${escapeHtml(title)}"` : ''} loading="lazy">`) : full;
        })
        .replace(/\[([^\]]+)\]\((\S+?)\)/g, (full, label, url) => {
          const safe = safeUrl(url);
          return safe ? stash(`<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`) : full;
        })
        .replace(/\[\^([^\]]+)\]/g, (full, id) => {
          if (!footnoteRefs?.has(id)) return full;
          return stash(`<sup class="ll-footnote-ref"><a href="#ll-fn-${escapeHtml(id)}" id="ll-fnr-${escapeHtml(id)}">${footnoteRefs.get(id)}</a></sup>`);
        });
      let out = escapeHtml(withTokens);
      out = out.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
      out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      out = out.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
      out = out.replace(/\u0000(\d+)\u0000/g, (_, i) => parts[Number(i)]);
      return out;
    }

    function renderMarkdown(src, katex) {
      const originalLines = String(src).split(/\r?\n/);
      const footnotes = new Map();
      const lines = [];
      for (let n = 0; n < originalLines.length; n += 1) {
        const def = /^\s*\[\^([^\]]+)\]:\s*(.*)$/u.exec(originalLines[n]);
        if (!def) { lines.push(originalLines[n]); continue; }
        const body = [def[2]];
        while (n + 1 < originalLines.length && /^\s{2,}\S/u.test(originalLines[n + 1])) {
          n += 1; body.push(originalLines[n].trim());
        }
        footnotes.set(def[1], body.join(' '));
      }
      const footnoteRefs = new Map([...footnotes.keys()].map((id, index) => [id, index + 1]));
      const html = [];
      let i = 0;
      while (i < lines.length) {
        const line = lines[i];
        const caption = /^<figcaption>(.*)<\/figcaption>$/u.exec(line);
        if(caption){const text=caption[1].replace(/&lt;/gu,'<').replace(/&gt;/gu,'>').replace(/&amp;/gu,'&');html.push(`<figcaption>${renderInline(text,katex,footnoteRefs)}</figcaption>`);i++;continue;}

        // 译稿通常把块公式写在一行：`$$...$$`。必须在行内 `$...$` 解析前
        // 整体吃掉，否则中间两个 `$` 会被当作一对行内分隔符，首尾各残留 `$`。
        const oneLineDollarBlock = /^\s*\$\$(.+?)\$\$\s*$/.exec(line);
        if (oneLineDollarBlock) {
          html.push(renderTex(oneLineDollarBlock[1].trim(), katex, true));
          i += 1;
          continue;
        }

        if (/^\s*\$\$\s*$/.test(line)) {
          const buf = []; i += 1;
          while (i < lines.length && !/^\s*\$\$\s*$/.test(lines[i])) { buf.push(lines[i]); i += 1; }
          if (i < lines.length) i += 1;
          const tex = buf.join('\n').trim();
          // 统一走 renderTex（内部就是 display 模式，且失败会降级而不是画红字）
          html.push(renderTex(tex, katex, true));
          continue;
        }

        /*
         * 有些译稿把 `$$` 和公式第一行写在一起，例如：
         *   $$\boldsymbol{V}_{e,uc}=
         *   \begin{pmatrix} ... \end{pmatrix} \tag{19}$$
         * 上面的「单行 $$...$$」和「独占一行的 $$」都匹配不到。
         * 以前这里会落进下面的段落分支：段落循环看到行首 `$$` 就拒绝消费，
         * 而 i 又没有前进 —— 整个渲染进入死循环（实测切到《高压下气体流量标准的比较》必卡死）。
         * 这里显式把「行首 $$ + 内容」当作块公式起始，直到行尾出现 `$$`。
         */
        const openDollarBlock = /^\s*\$\$(.*)$/u.exec(line);
        if (openDollarBlock) {
          const buf = [openDollarBlock[1]];
          i += 1;
          while (i < lines.length) {
            const close = /\$\$\s*$/u.exec(lines[i]);
            if (close) {
              buf.push(lines[i].slice(0, close.index));
              i += 1;
              break;
            }
            buf.push(lines[i]);
            i += 1;
          }
          html.push(renderTex(buf.join('\n').trim(), katex, true));
          continue;
        }

        // 兼容 LaTeX 原生的 `\[...\]`（单行与多行）块公式。
        const oneLineBracketBlock = /^\s*\\\[(.+?)\\\]\s*$/.exec(line);
        if (oneLineBracketBlock) {
          html.push(renderTex(oneLineBracketBlock[1].trim(), katex, true));
          i += 1;
          continue;
        }

        if (/^\s*\\\[\s*$/.test(line)) {
          const buf = []; i += 1;
          while (i < lines.length && !/^\s*\\\]\s*$/.test(lines[i])) { buf.push(lines[i]); i += 1; }
          if (i < lines.length) i += 1;
          html.push(renderTex(buf.join('\n').trim(), katex, true));
          continue;
        }

        // 同上，兼容 `\[ 公式第一行` 这种写法
        const openBracketBlock = /^\s*\\\[(.*)$/u.exec(line);
        if (openBracketBlock) {
          const buf = [openBracketBlock[1]];
          i += 1;
          while (i < lines.length) {
            const close = /\\\]\s*$/u.exec(lines[i]);
            if (close) {
              buf.push(lines[i].slice(0, close.index));
              i += 1;
              break;
            }
            buf.push(lines[i]);
            i += 1;
          }
          html.push(renderTex(buf.join('\n').trim(), katex, true));
          continue;
        }

        if (/^\s*```/.test(line)) {
          const buf = []; i += 1;
          while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i]); i += 1; }
          i += 1;
          html.push(`<pre><code>${escapeHtml(buf.join('\n'))}</code></pre>`);
          continue;
        }

        if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
          const cells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
          const head = cells(line); i += 2;
          const body = [];
          while (i < lines.length && /^\s*\|/.test(lines[i])) { body.push(cells(lines[i])); i += 1; }
          html.push(`<div class="ll-table-scroll" style="--ll-table-min:${Math.max(560,head.length*130)}px"><table><thead><tr>` + head.map((c) => `<th>${renderInline(c, katex, footnoteRefs)}</th>`).join('') + '</tr></thead><tbody>'
            + body.map((r) => '<tr>' + r.map((c) => `<td>${renderInline(c, katex, footnoteRefs)}</td>`).join('') + '</tr>').join('')
            + '</tbody></table></div>');
          continue;
        }

        const heading = /^(#{1,4})\s+(.*)$/.exec(line);
        if (heading) { const l = heading[1].length; html.push(`<h${l}>${renderInline(heading[2], katex, footnoteRefs)}</h${l}>`); i += 1; continue; }

        if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) { html.push('<hr>'); i += 1; continue; }

        if (/^\s*>\s?/.test(line)) {
          const buf = [];
          while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i += 1; }
          html.push(`<blockquote>${buf.map((b) => renderInline(b, katex, footnoteRefs)).join('<br>')}</blockquote>`);
          continue;
        }

        if (/^\s*(?:[-*+]|\d+\.)\s+/.test(line)) {
          const ordered = /^\s*\d+\.\s+/.test(line);
          const items = [];
          while (i < lines.length && /^\s*(?:[-*+]|\d+\.)\s+/.test(lines[i])) {
            items.push(lines[i].replace(/^\s*(?:[-*+]|\d+\.)\s+/, '')); i += 1;
          }
          const tag = ordered ? 'ol' : 'ul';
          html.push(`<${tag}>${items.map((t) => `<li>${renderInline(t, katex, footnoteRefs)}</li>`).join('')}</${tag}>`);
          continue;
        }

        if (/^\s*</u.test(line)) {
          const buf = [];
          while (i < lines.length && lines[i].trim() !== '') { buf.push(lines[i]); i += 1; }
          html.push(sanitizeMarkdownHtml(buf.join('\n')));
          continue;
        }

        if (line.trim() === '') { i += 1; continue; }

        const buf = [];
        const paragraphStart = i;
        while (i < lines.length && lines[i].trim() !== ''
          && !/^\s*(?:#{1,4}\s|\$\$|\\\[|```|>|\||(?:[-*+]|\d+\.)\s)/.test(lines[i])) { buf.push(lines[i]); i += 1; }
        /*
         * 最后一道保险：如果某个边界字符（比如不完整的表格行 `|...`）让
         * 上面的 while 一行都没消费，这里必须强行前进一行。
         * 以前 renderMarkdown 会在这里原地打转，表现就是整个 DSH 卡死。
         */
        if (i === paragraphStart) { buf.push(lines[i]); i += 1; }
        html.push(`<p>${renderInline(buf.join(' '), katex, footnoteRefs)}</p>`);
      }
      if (footnotes.size > 0) {
        html.push('<section class="ll-footnotes"><hr><ol>'
          + [...footnotes].map(([id, body]) => `<li id="ll-fn-${escapeHtml(id)}">${renderInline(body, katex, footnoteRefs)} <a class="ll-footnote-back" href="#ll-fnr-${escapeHtml(id)}" aria-label="返回正文">↩</a></li>`).join('')
          + '</ol></section>');
      }
      return html.join('\n');
    }

    /**
     * 预览 HTML 的 LRU 缓存。
     *
     * 为什么需要：频繁切换文章时，如果每次都在渲染期同步跑整篇 Markdown +
     * KaTeX，主线程会被反复占满（译稿可以到 10 万字符）。缓存让「切回去」
     * 变成一次字符串查找；配合 selection debounce，快速连点只渲染最终那篇。
     */
    const MARKDOWN_CACHE_MAX = 8;
    const markdownCache = new Map();
    let latestLibraryIndex = null;
    // 只常驻「最近实际打开」的一篇译文。离开文献库再回来时无需重新请求；
    // 其他文章仍按需重新读取，但各自的浏览位置会从 localStorage 恢复。
    let latestMarkdownDocument = null;

    function cachedLatestMarkdown(paper) {
      if (!paper?.slug || !paper.translation) return null;
      return latestMarkdownDocument?.slug === paper.slug
        && latestMarkdownDocument.translation === paper.translation
        && latestMarkdownDocument.revision === (paper.translatedAt ?? paper.translation)
        ? latestMarkdownDocument : null;
    }

    function rememberLatestMarkdown(paper, translated) {
      if (!paper?.slug || !paper.translation) return;
      latestMarkdownDocument = {
        slug: paper.slug,
        translation: paper.translation,
        revision: paper.translatedAt ?? paper.translation,
        translated: String(translated ?? ''),
      };
    }

    function markdownScrollElement(root, mode) {
      if (!root) return null;
      if (mode === 'edit') return root.querySelector('.ll-wysiwyg') ?? root;
      if (mode === 'source') return root.querySelector('.ll-editor') ?? root;
      return root;
    }

    function captureMarkdownPosition(root, mode) {
      if (!root) return null;
      if (mode === 'preview' && !root.querySelector('.ll-md')) return null;
      if (mode === 'edit' && !root.querySelector('.ll-wysiwyg')) return null;
      if (mode === 'source' && !root.querySelector('.ll-editor')) return null;
      const scroller = markdownScrollElement(root, mode);
      if (!scroller) return null;
      const scrollTop = Math.max(0, Number(scroller.scrollTop) || 0);
      const maxScroll = Math.max(0, (Number(scroller.scrollHeight) || 0) - (Number(scroller.clientHeight) || 0));
      const result = {
        scrollTop,
        scrollRatio: maxScroll > 0 ? scrollTop / maxScroll : 0,
        anchorIndex: null,
        anchorOffset: 0,
      };
      if (mode !== 'preview') return result;

      const article = root.querySelector('.ll-md');
      const children = article ? [...article.children] : [];
      const viewport = scroller.getBoundingClientRect();
      const anchorIndex = children.findIndex((node) => node.getBoundingClientRect().bottom > viewport.top + 1);
      if (anchorIndex < 0) return result;
      const anchor = children[anchorIndex].getBoundingClientRect();
      result.anchorIndex = anchorIndex;
      result.anchorOffset = viewport.top - anchor.top;
      return result;
    }

    function restoreMarkdownPosition(root, mode, saved) {
      const scroller = markdownScrollElement(root, mode);
      if (!scroller || !saved) return;
      let target = Math.max(0, Number(saved.scrollTop) || 0);
      if (mode === 'preview' && Number.isInteger(saved.anchorIndex)) {
        const children = [...(root.querySelector('.ll-md')?.children ?? [])];
        const anchor = children[saved.anchorIndex];
        if (anchor) {
          const viewport = scroller.getBoundingClientRect();
          const rect = anchor.getBoundingClientRect();
          const anchorTop = scroller.scrollTop + rect.top - viewport.top;
          target = anchorTop + (Number(saved.anchorOffset) || 0);
        }
      }
      const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      if (target > maxScroll && Number(saved.scrollRatio) > 0) target = maxScroll * saved.scrollRatio;
      scroller.scrollTop = Math.min(maxScroll, Math.max(0, target));
    }

    /** FNV-1a，32 位；只用于判断「文本变没变」，比逐字符比较便宜 */
    function hashText(value) {
      const s = String(value);
      let h = 0x811c9dc5;
      for (let i = 0; i < s.length; i += 1) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
      }
      return (h >>> 0).toString(36);
    }

    /**
     * 带缓存的 Markdown 渲染。
     * 键里包含 slug、是否已加载 KaTeX；值里再校验长度/首尾片段，避免哈希碰撞。
     */
    function renderMarkdownCached(slug, text, katex) {
      const source = String(text ?? '');
      const key = `${slug ?? ''}|${katex ? 'katex' : 'plain'}`;
      const hash = hashText(source);
      const head = source.slice(0, 64);
      const tail = source.slice(-64);
      const hit = markdownCache.get(key);
      if (hit && hit.hash === hash && hit.length === source.length
        && hit.head === head && hit.tail === tail) {
        // 命中后移到队尾，维持 LRU 顺序
        markdownCache.delete(key);
        markdownCache.set(key, hit);
        return hit.html;
      }

      const html = renderMarkdown(source, katex);
      markdownCache.set(key, { hash, length: source.length, head, tail, html });
      while (markdownCache.size > MARKDOWN_CACHE_MAX) {
        markdownCache.delete(markdownCache.keys().next().value);
      }
      return html;
    }

    /**
     * 把 Markdown 切成可独立编辑的“文章块”。空行分隔符原样挂在前一个块后面，
     * 因而无论编辑多少次，重新拼接都不会改动原文件的换行风格或段落间距。
     */
    function splitMarkdownBlocks(src) {
      const input = String(src ?? '');
      const blocks = [];
      const separator = /\r?\n(?:[ \t]*\r?\n)+/g;
      let start = 0;
      let match;
      while ((match = separator.exec(input)) !== null) {
        blocks.push({ raw: input.slice(start, match.index), separator: match[0] });
        start = match.index + match[0].length;
      }
      blocks.push({ raw: input.slice(start), separator: '' });
      return blocks;
    }

    const joinMarkdownBlocks = (blocks) => blocks.map((block) => block.raw + block.separator).join('');

    /**
     * Typora 风格块编辑器：整篇保持渲染态，只把当前点击的块切换为 Markdown 输入框。
     * 数据层始终是 Markdown，不把浏览器生成的 HTML 反向序列化，避免损坏公式与引用。
     */
    function MarkdownBlockEditor({ value, katex, onChange }) {
      const [blocks, setBlocks] = React.useState(() => splitMarkdownBlocks(value));
      const [active, setActive] = React.useState(null);
      const [original, setOriginal] = React.useState('');
      const canceling = React.useRef(false);

      React.useEffect(() => {
        if (String(value ?? '') !== joinMarkdownBlocks(blocks)) {
          setBlocks(splitMarkdownBlocks(value));
          setActive(null);
        }
      }, [value]);

      const updateBlock = (index, raw) => {
        const next = blocks.map((block, i) => (i === index ? { ...block, raw } : block));
        setBlocks(next);
        onChange(joinMarkdownBlocks(next));
      };

      const finishBlock = () => {
        setActive(null);
        // 若用户在块内新加了空行，结束编辑时按新的段落结构重新切块。
        setBlocks(splitMarkdownBlocks(joinMarkdownBlocks(blocks)));
      };

      const cancelBlock = (index) => {
        canceling.current = true;
        const next = blocks.map((block, i) => (i === index ? { ...block, raw: original } : block));
        setBlocks(next);
        onChange(joinMarkdownBlocks(next));
      };

      const resizeInput = (el) => {
        if (!el) return;
        el.style.height = '0px';
        el.style.height = `${Math.max(38, el.scrollHeight)}px`;
      };

      return h('div', { className: 'll-wysiwyg' }, [
        h('div', { key: 'help', className: 'll-wysiwyg-help' }, '点击段落编辑 · Ctrl+Enter 完成 · Esc 撤销当前块'),
        h('div', { key: 'content', className: 'll-wysiwyg-inner' }, blocks.map((block, index) => (
          active === index
            ? h('div', { key: index, className: 'll-edit-block ll-edit-block-active' },
              h('textarea', {
                className: 'll-block-editor',
                value: block.raw,
                autoFocus: true,
                spellCheck: false,
                rows: Math.max(1, block.raw.split(/\r?\n/).length),
                ref: resizeInput,
                onChange: (e) => { updateBlock(index, e.target.value); resizeInput(e.target); },
                onFocus: (e) => resizeInput(e.target),
                onBlur: () => {
                  if (canceling.current) {
                    canceling.current = false;
                    setActive(null);
                    return;
                  }
                  finishBlock();
                },
                onKeyDown: (e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                    e.preventDefault();
                    e.currentTarget.blur();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    cancelBlock(index);
                    e.currentTarget.blur();
                  }
                },
              }))
            : h('div', {
              key: index,
              className: `ll-edit-block${block.raw.trim() === '' ? ' ll-edit-empty' : ''}`,
              role: 'button',
              tabIndex: 0,
              title: '点击编辑此段',
              onClick: () => { setOriginal(block.raw); setActive(index); },
              onKeyDown: (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setOriginal(block.raw);
                  setActive(index);
                }
              },
            }, block.raw.trim() === '' ? null : h('div', {
              className: 'll-md',
              dangerouslySetInnerHTML: { __html: renderMarkdown(block.raw, katex) },
            }))
        ))),
      ]);
    }

    // ─────────────────── 数据访问 ───────────────────

    async function fetchIndex(signal) {
      const res = await fetch(`${ROUTE_PREFIX}/index`, { signal });
      if (res.status === 404) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b?.hint ?? '文献库索引不存在');
      }
      if (!res.ok) throw new Error(`读取索引失败 HTTP ${res.status}`);
      return res.json();
    }

    const fileUrl = (rel) => `${ROUTE_PREFIX}/file?path=${encodeURIComponent(String(rel).replace(/\\/g, '/'))}`;
    // Chromium/Edge 内置 PDF 阅读器识别这些 fragment：首次打开即按栏宽铺满页面。
    const pdfViewerUrl = (url) => (url ? `${url}#view=FitH&zoom=page-width&pagemode=none` : null);

    async function fetchText(rel, signal) {
      const res = await fetch(fileUrl(rel), { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    }

    async function postJson(path, body) {
      const res = await fetch(`${ROUTE_PREFIX}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.message ?? `HTTP ${res.status}`);
      return data;
    }

    // ─────────────────── 费用与主题 ───────────────────

    function loadTranslationUsage() {
      try {
        const value = JSON.parse(window.localStorage.getItem(TRANSLATION_USAGE_KEY) || '{}');
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
      } catch { return {}; }
    }

    /**
     * 完成后仍保留每篇最近一次的用量摘要。host 重启后内存任务列表会清空，
     * 但用户仍应该能在文献条目下查看本地保存的费用记录。
     */
    function saveTranslationUsage(value) {
      try { window.localStorage.setItem(TRANSLATION_USAGE_KEY, JSON.stringify(value)); } catch { /* 忽略 */ }
    }

    function loadOffpeakOnly() {
      try { return window.localStorage.getItem(OFFPEAK_ONLY_KEY) === '1'; } catch { return false; }
    }

    /**
     * 读取 DSH 当前使用的主题（dark / light）。
     *
     * 为什么不用 `prefers-color-scheme`：DSH 的主题是用户偏好（system/dark/light），
     * 由启动脚本写到 `html[data-ds-theme-source]`，并在 `body` 上用
     * `data-ds-dark-theme` 切换。只跟随系统偏好的话，用户把 DSH 切成浅色、
     * 而 Windows 仍是深色时，面板会继续显示深色，和整页背景非常割裂。
     * 没有 DSH 主题信号时（独立预览或其它宿主）再退回系统偏好。
     */
    function readHostTheme() {
      if (typeof document === 'undefined') return 'dark';
      const hasHostSignal = Boolean(document.documentElement?.dataset?.dsThemeSource);
      if (hasHostSignal) {
        return document.body?.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light';
      }
      try {
        return window.matchMedia?.('(prefers-color-scheme: light)')?.matches ? 'light' : 'dark';
      } catch { return 'dark'; }
    }

    function firstFinite(...values) {
      for (const value of values) {
        if (value === null || value === undefined || value === '') continue;
        const number = Number(value);
        if (Number.isFinite(number) && number >= 0) return number;
      }
      return null;
    }

    function compactNumber(value) {
      if (!Number.isFinite(value)) return '—';
      if (value >= 1000000) return `${(value / 1000000).toFixed(value >= 10000000 ? 0 : 1)}m`;
      if (value >= 1000) return `${(value / 1000).toFixed(value >= 100000 ? 0 : 1)}k`;
      return String(Math.round(value));
    }

    /** 上海时间的工作日峰时；法定节假日最终以 host/API 返回的价格时段为准。 */
    function isLikelyDeepSeekPeak(isoTime) {
      try {
        const parts = new Intl.DateTimeFormat('en-US', {
          timeZone: 'Asia/Shanghai', weekday: 'short', hour: '2-digit', hourCycle: 'h23',
        }).formatToParts(isoTime ? new Date(isoTime) : new Date());
        const part = (type) => parts.find((item) => item.type === type)?.value;
        const weekday = part('weekday');
        const hour = Number(part('hour'));
        return !['Sat', 'Sun'].includes(weekday) && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18));
      } catch { return true; }
    }

    /**
     * 兼容原有 job 字段、DeepSeek 原生 usage 和 Anthropic 兼容层字段。
     * host 已计算的人民币费用优先；旧 host 则按当前 Flash/Pro 价格给出明确标注的估算。
     */
    function translationUsage(job) {
      const usage = job?.usageTotal ?? job?.usage ?? job?.totals ?? {};
      const inputDetails = usage.input_tokens_details ?? usage.prompt_tokens_details ?? {};
      const outputDetails = usage.output_tokens_details ?? usage.completion_tokens_details ?? {};
      const input = firstFinite(
        job?.tokensIn, job?.inputTokens, usage.inputTokens, usage.input_tokens, usage.prompt_tokens,
      ) ?? 0;
      const output = firstFinite(
        job?.tokensOut, job?.outputTokens, usage.outputTokens, usage.output_tokens, usage.completion_tokens,
      ) ?? 0;

      const nativeHit = firstFinite(
        job?.cacheHitTokens, usage.cacheHitTokens, usage.prompt_cache_hit_tokens,
        inputDetails.prompt_cache_hit_tokens, inputDetails.cached_tokens,
      );
      const anthropicHit = firstFinite(job?.cacheReadTokens, usage.cache_read_input_tokens);
      const cacheHit = nativeHit ?? anthropicHit;
      const explicitMiss = firstFinite(
        job?.cacheMissTokens, usage.cacheMissTokens, usage.prompt_cache_miss_tokens,
        inputDetails.prompt_cache_miss_tokens, usage.cache_creation_input_tokens,
      );
      // Anthropic usage 的 input_tokens 是未命中部分；DeepSeek 原生 prompt_tokens 则是总数。
      const cacheMiss = explicitMiss ?? (anthropicHit !== null
        ? input
        : (nativeHit !== null ? Math.max(0, input - nativeHit) : null));

      const reasoningRaw = firstFinite(
        job?.reasoningTokens, job?.thinkingTokens, usage.reasoningTokens, usage.thinkingTokens,
        usage.reasoning_tokens,
        outputDetails.reasoning_tokens, outputDetails.thinking_tokens,
      );
      const reasoningDisabled = job?.reasoningEffort === 'none'
        || job?.thinkingEnabled === false || job?.thinking === 'disabled';
      const reasoning = reasoningRaw ?? (reasoningDisabled ? 0 : null);
      const visibleRaw = firstFinite(
        job?.visibleOutputTokens, job?.visibleTokens, usage.visibleOutputTokens, usage.visible_output_tokens,
        outputDetails.visible_tokens,
      );
      const visible = visibleRaw ?? (reasoning !== null ? Math.max(0, output - reasoning) : output);
      const retries = firstFinite(job?.retryCount, job?.retries, usage.retry_count) ?? 0;
      const thinkingChars = firstFinite(job?.thinkingChars, usage.thinking_chars);

      const estimatedCost = firstFinite(
        job?.estimatedCostCny, usage.estimatedCostCny, usage.estimated_cost_cny,
      );
      const providedCost = estimatedCost ?? firstFinite(
        job?.costCny, job?.cost?.cny, usage.costCny, usage.cost_cny,
      );
      let costCny = providedCost;
      let costEstimated = estimatedCost !== null || job?.costEstimated === true;
      let pricingPeriod = job?.pricingPeriod ?? job?.pricePeriod ?? job?.cost?.period ?? null;
      if (costCny === null && (input > 0 || output > 0)) {
        const offpeak = pricingPeriod === 'offpeak' || pricingPeriod === 'off-peak'
          || job?.offpeak === true || job?.offPeak === true
          || (pricingPeriod !== 'peak' && !isLikelyDeepSeekPeak(job?.startedAt));
        pricingPeriod = offpeak ? 'offpeak' : 'peak';
        const pro = String(job?.model ?? '').toLowerCase().includes('pro');
        const price = pro
          ? (offpeak ? { hit: 0.15, miss: 4.5, output: 13.5 } : { hit: 0.3, miss: 9, output: 27 })
          : (offpeak ? { hit: 0.02, miss: 1, output: 4 } : { hit: 0.04, miss: 2, output: 8 });
        // 没有缓存明细时一律按未命中估算，不把费用低估。
        const hitForCost = cacheHit ?? 0;
        const missForCost = cacheMiss ?? input;
        costCny = ((hitForCost * price.hit) + (missForCost * price.miss) + (output * price.output)) / 1000000;
        costEstimated = true;
      }

      return {
        input, output, cacheHit, cacheMiss, reasoning, visible,
        visibleKnown: visibleRaw !== null || reasoning !== null,
        retries, thinkingChars, costCny, costEstimated, pricingPeriod,
      };
    }

    function formatCny(value) {
      if (!Number.isFinite(value)) return '—';
      if (value < 0.01) return value.toFixed(4);
      if (value < 1) return value.toFixed(3);
      return value.toFixed(2);
    }

    // ─────────────────── 拖动调宽 ───────────────────

    function loadLayout() {
      try {
        const raw = window.localStorage.getItem(LS_KEY);
        if (raw) {
          const v = JSON.parse(raw);
          // 兼容旧键名：早期版本用 pdfPct 表示左栏（PDF）宽度，现在是中栏译文宽度
          const trPct = typeof v.trPct === 'number' ? v.trPct
            : (typeof v.pdfPct === 'number' ? v.pdfPct : 50);
          if (typeof v.navPct === 'number') {
            // v2 将旧默认值 22% 一次性迁移到 18%；用户手动设置的其他宽度保持不变。
            const navPct = v.version === 2 ? v.navPct : (v.navPct === 22 ? 18 : v.navPct);
            return { version: 2, navPct, trPct };
          }
        }
      } catch { /* 忽略 */ }
      return { version: 2, navPct: 16, trPct: 52 };
    }

    /** 插件字号（只放大文字，不改变 PDF 画布缩放） */
    function loadFontPercent() {
      try {
        const current = window.localStorage.getItem(FONT_PERCENT_KEY);
        if (current != null) return clampFontPercent(current);
        const legacy = Number(window.localStorage.getItem(FONT_SCALE_KEY));
        if (Number.isFinite(legacy) && legacy > 0) {
          // 旧键是倍率：1.5 → 150%；如果旧键已经是 150 这种百分比也兼容
          return clampFontPercent(legacy <= 10 ? legacy * 100 : legacy);
        }
      } catch { /* 忽略 */ }
      return 100;
    }

    /** 折叠的文件夹路径集合（持久化，跨刷新保留「收起」状态） */
    const LS_COLLAPSED = 'dsh-literature-library/collapsed';

    function loadCollapsed() {
      try {
        const raw = window.localStorage.getItem(LS_COLLAPSED);
        if (raw) {
          const arr = JSON.parse(raw);
          if (Array.isArray(arr)) return new Set(arr.filter((x) => typeof x === 'string'));
        }
      } catch { /* 忽略 */ }
      return new Set();
    }

    function saveCollapsed(set) {
      try { window.localStorage.setItem(LS_COLLAPSED, JSON.stringify([...set])); } catch { /* 忽略 */ }
    }

    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

    /**
     * 分隔条。用 pointer events + setPointerCapture：
     * 指针拖出面板范围也不会丢事件。宽度用「占容器百分比」，窗口缩放后仍合理。
     */
    function Divider({ onDrag, onDoubleClick }) {
      const [dragging, setDragging] = React.useState(false);
      return h('div', {
        className: `ll-divider${dragging ? ' dragging' : ''}`,
        title: '拖动调整宽度（双击复位）',
        onDoubleClick,
        onPointerDown: (e) => {
          e.preventDefault();
          try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
          setDragging(true);
          onDrag.start(e.clientX);
        },
        onPointerMove: (e) => { if (dragging) onDrag.move(e.clientX); },
        onPointerUp: (e) => {
          if (!dragging) return;
          try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
          setDragging(false);
          onDrag.end();
        },
        onPointerCancel: () => { setDragging(false); onDrag.end(); },
      });
    }

    // ─────────────────── 目录树 ───────────────────

    const hasCjk = (value) => /[\u3400-\u9fff]/.test(String(value ?? ''));
    const stripTrailingYear = (value) => String(value ?? '')
      .replace(/[-_—–\s]*(?:19|20)\d{2}\s*$/, '')
      .trim();

    function chinesePaperTitle(paper) {
      const candidate = paper?.titleZh
        || (hasCjk(paper?.title) ? paper.title : null)
        || (hasCjk(paper?.slug) ? paper.slug : null)
        || paper?.title
        || paper?.titleEn
        || paper?.slug
        || '未命名文献';
      return stripTrailingYear(candidate) || String(candidate);
    }

    function englishPaperTitle(paper) {
      return paper?.titleEn
        || (!hasCjk(paper?.title) ? paper.title : null)
        || null;
    }

    function paperPublicationYear(paper) {
      if (paper?.year) return String(paper.year);
      const match = /(?:^|[-_\s])((?:19|20)\d{2})(?:$|[-_\s])/.exec(String(paper?.slug ?? ''));
      return match?.[1] ?? '年份未知';
    }

    function firstPaperAuthor(paper) {
      const value = String(paper?.authors ?? '').replace(/[*_]/g, '').trim();
      if (!value) return '作者未知';
      return value.split(/\s*(?:,|，|;|；|、|\band\b|&)\s*/i).find(Boolean) ?? '作者未知';
    }

    function sidebarPaperLabel(paper) {
      return `${chinesePaperTitle(paper)}-${paperPublicationYear(paper)}-${firstPaperAuthor(paper)}`;
    }

    /**
     * 侧栏条目的显示顺序。
     *
     * 优先级：**置顶** → 手动位次（`order`）→ 标题（中文按拼音）。
     * 旧库没有 order 字段，`null` 视为「未手动排过」，排在手排条目之后，
     * 因此升级后现有文献的顺序不会突然乱掉。
     */
    function comparePapers(a, b) {
      const ap = a?.pinned === true;
      const bp = b?.pinned === true;
      if (ap !== bp) return ap ? -1 : 1;

      const ao = Number.isFinite(a?.order) ? a.order : null;
      const bo = Number.isFinite(b?.order) ? b.order : null;
      if (ao !== bo) {
        if (ao === null) return 1;
        if (bo === null) return -1;
        if (ao !== bo) return ao - bo;
      }
      return sidebarPaperLabel(a).localeCompare(sidebarPaperLabel(b), 'zh-CN');
    }

    const sortPapers = (list) => [...list].sort(comparePapers);

    /** 搜索框匹配：标题（中/英）、作者、期刊、DOI、年份、分类路径都能命中 */
    function paperMatchesQuery(paper, rawQuery) {
      const q = String(rawQuery ?? '').trim().toLowerCase();
      if (q === '') return true;
      return [
        chinesePaperTitle(paper), paper?.title, paper?.titleZh, paper?.titleEn,
        paper?.slug, paper?.authors, paper?.category, paper?.folder, paper?.year,
        paper?.journal?.name, paper?.journal?.abbr, paper?.journal?.doi,
      ].some((value) => String(value ?? '').toLowerCase().includes(q));
    }

    /**
     * 按「分类路径」聚成树。
     * 路径来自登记时的子文件夹层级（folder 字段，如 "热物性/气体黏度"）；
     * 没有 folder 的旧条目退化为单层分类。
     */
    /**
     * 文献在目录树里的分组键，必须与 host 半的 `paperGroupKey()` 一致：
     * 有 folder 用完整分类路径，否则退回 category，再退回「未分类」。
     * 手动排序以它为作用域（同一文件夹内）。
     */
    function paperGroupKey(paper) {
      const folder = typeof paper?.folder === 'string'
        ? paper.folder.trim().replace(/\\/g, '/').replace(/\/+/gu, '/')
        : '';
      if (folder !== '') return folder.replace(/\/+$/u, '');
      const category = typeof paper?.category === 'string' ? paper.category.trim() : '';
      return category !== '' ? category : '未分类';
    }

    function buildTree(papers) {
      const root = { name: '', children: new Map(), papers: [] };
      for (const p of papers) {
        const path = (p.folder && String(p.folder).trim() !== '')
          ? String(p.folder).split('/').filter(Boolean)
          : [String(p.category ?? '').trim() || '未分类'];
        let node = root;
        for (const seg of path) {
          if (!node.children.has(seg)) node.children.set(seg, { name: seg, children: new Map(), papers: [] });
          node = node.children.get(seg);
        }
        node.papers.push(p);
      }
      return root;
    }

    function countPapers(node) {
      let n = node.papers.length;
      for (const c of node.children.values()) n += countPapers(c);
      return n;
    }

    /**
     * 文献条目的右键菜单。
     *
     * 为什么用右键：隐藏/删除是**破坏性或低频**操作，放在 hover 按钮里容易误点，
     * 也让每行显得拥挤。右键菜单把它们收起来，同时保留「翻译」这个高频按钮。
     *
     * 实现要点：
     *   - 用 fixed 定位跟随鼠标，`getBoundingClientRect` 防止超出窗口；
     *   - 点菜单外部 / 按 Esc / 滚动 都关闭；
     *   - 外部关闭监听运行在 capture 阶段，所以必须先判断点击目标是否仍在菜单内。
     *     否则它会在按钮的 React 事件之前卸载菜单，表现为「点隐藏/删除没反应」。
     */
    /* READER_RUNTIME:BEGIN */
    const readerRuntime = (function createReaderRuntime() {
  function createRenderQueue(limit=1) {
    let running=0,sequence=0;const pending=[];
    const cancelled=()=>Object.assign(new Error('Render request cancelled'),{name:'AbortException'});
    const pump=()=>{
      pending.sort((a,b)=>a.priority-b.priority||a.order-b.order);
      while(running<limit&&pending.length){
        const job=pending.shift();if(job.cancelled)continue;
        running++;job.started=true;
        Promise.resolve().then(()=>job.cancelled?Promise.reject(cancelled()):job.work())
          .then(job.resolve,job.reject).finally(()=>{running--;pump();});
      }
    };
    return {
      schedule(work,priority=0){
        const job={work,priority,order:sequence++,started:false,cancelled:false};
        const promise=new Promise((resolve,reject)=>Object.assign(job,{resolve,reject}));
        pending.push(job);pump();
        return {promise,cancel(){job.cancelled=true;if(!job.started){const i=pending.indexOf(job);if(i>=0)pending.splice(i,1);job.reject(cancelled());}}};
      },
      stats:()=>({running,pending:pending.length,limit}),
    };
  }
  function bindMenuDismissal({window:win,document:doc,element,close}) {
    const inside=event=>{
      const node=element();if(!node)return false;
      if(event?.composedPath?.().includes(node))return true;
      try{return !!event?.target&&node.contains(event.target);}catch{return false;}
    };
    const outside=e=>{if(!inside(e))close();},always=()=>close();
    // Window capture also sees non-bubbling blur from every descendant control.
    // Internal focus changes must finish their click before any dismissal occurs.
    const windowBlur=e=>{if(e.target===win)close();};
    const key=e=>{if(e.key==='Escape'){e.preventDefault?.();close();}};
    const visibility=()=>{if(doc?.visibilityState==='hidden')close();};
    const bindings=[['pointerdown',outside],['mousedown',outside],['contextmenu',outside],['wheel',outside],
      ['scroll',outside],['resize',always],['blur',windowBlur],['pagehide',always],['keydown',key]];
    const capture={capture:true};
    for(const [name,fn]of bindings)win.addEventListener(name,fn,capture);
    doc?.addEventListener?.('visibilitychange',visibility);
    return()=>{for(const [name,fn]of bindings)win.removeEventListener(name,fn,capture);doc?.removeEventListener?.('visibilitychange',visibility);};
  }
  function readingZoomShortcut(event,root) {
    if(!(event.ctrlKey||event.metaKey)||event.altKey||event.isComposing)return null;
    const values={'+':10,'=':10,'-':-10,'_':-10,'0':0};
    if(!Object.prototype.hasOwnProperty.call(values,event.key))return null;
    if(!root?.contains?.(event.target))return null;
    const target=event.target;
    // Consume the combination in coordinate/forms so neither this plugin nor
    // the host/global browser zoom can turn editing into a persistent font change.
    if(target.closest?.('input,select,textarea,[contenteditable="true"],.ll-layout-controls,.ll-modal,.ll-menu'))return {delta:null};
    if(!target.closest?.('.ll-pane-translation'))return null;
    return {delta:values[event.key]};
  }
  return {createRenderQueue,bindMenuDismissal,readingZoomShortcut};
})();
    /* READER_RUNTIME:END */
    const PDF_RENDER_QUEUE = readerRuntime.createRenderQueue(1);

    function useMenuLifecycle(ref, menu, onClose) {
      const [pos,setPos]=React.useState({x:menu.x,y:menu.y});
      React.useEffect(()=>{
        const r=ref.current?.getBoundingClientRect();if(!r)return;
        setPos({x:Math.max(8,Math.min(menu.x,window.innerWidth-r.width-8)),y:Math.max(8,Math.min(menu.y,window.innerHeight-r.height-8))});
      },[menu.x,menu.y]);
      React.useEffect(()=>readerRuntime.bindMenuDismissal({window,document,element:()=>ref.current,close:onClose}),[onClose]);
      return pos;
    }
    function ContextMenu({ menu, onClose, onOpen, onTranslate, onMutate, onArrange, busy }) {
      const ref = React.useRef(null);
      const pos=useMenuLifecycle(ref,menu,onClose);

      const p = menu.paper;
      const hidden = p.hidden === true;
      const item = (key, label, fn, opts = {}) => h('button', {
        key,
        className: `ll-menu-item${opts.danger ? ' ll-danger' : ''}`,
        disabled: opts.disabled === true,
        onClick: (e) => { e.stopPropagation(); onClose(); fn(); },
      }, label);

      return h('div', {
        ref,
        className: 'll-menu',
        role: 'menu', 'aria-label': '文献操作',
        style: { left: `${pos.x}px`, top: `${pos.y}px` },
        onMouseDown: (e) => e.stopPropagation(),
        onContextMenu: (e) => e.preventDefault(),
      }, [
        h('div', { className: 'll-menu-title', key: 't', title: p.title }, p.title ?? p.slug),
        item('open', '打开（阅读/编辑）', () => onOpen(p)),
        !p.translation
          ? item('tr', busy === p.slug ? '正在投递…' : '翻译这篇', () => onTranslate(p), { disabled: busy !== null })
          : item('retr', '重新翻译', () => onTranslate(p), { disabled: busy !== null }),
        h('div', { className: 'll-menu-sep', key: 's0' }),
        item(p.pinned ? 'unpin' : 'pin', p.pinned ? '取消置顶' : '置顶到本文件夹顶部', () => {
          onArrange({ action: p.pinned ? 'unpin' : 'pin', slug: p.slug });
        }, { disabled: busy !== null }),
        h('div', { className: 'll-hint', key: 'drag-tip', style: { padding: '4px 10px' } }, '排序：直接拖动文献条目'),
        h('div', { className: 'll-menu-sep', key: 's1' }),
        hidden
          ? item('show', '取消隐藏', () => onMutate({ action: 'unhide', slug: p.slug }, '已取消隐藏'))
          : item('hide', '隐藏（仍在库中）', () => onMutate({ action: 'hide', slug: p.slug }, '已隐藏')),
        p.translateSession
          ? item('sess', '打开翻译会话', () => window.open(
            `/?session=${encodeURIComponent(p.translateSession)}`, '_blank', 'noreferrer',
          ))
          : null,
        h('div', { className: 'll-menu-sep', key: 's2' }),
        item('del', '从文献库移除…', () => {
          if (window.confirm(`确定移除《${p.title ?? p.slug}》？\n\nPDF 会移到 library/trash/，不会永久删除。`)) {
            onMutate({ action: 'delete', slug: p.slug }, '已移除');
          }
        }, { danger: true }),
      ].filter(Boolean));
    }

    /**
     * 翻译进度显示。优先显示**直连 API 任务**（`translate-job`）的真实进度，
     * 没有直连任务时退回旧的 agent 会话进度。
     *
     * 直连任务能给出「第 3 / 12 块」这种真实进度；会话路径只能给出阶段。
     */
    /**
     * 翻译进度显示。优先显示**直连 API 任务**（`translate-job`）的真实进度与费用，
     * 没有直连任务时退回旧的 agent 会话进度。
     */
    function FolderMenu({menu,onClose,collapsed,toggleCollapse,doMutate}) {
      const ref=React.useRef(null),pos=useMenuLifecycle(ref,menu,onClose);
      return h('div', {
          key: 'menu-folder',
          ref, role: 'menu', 'aria-label': '文件夹操作', className: 'll-menu',
          style: { left: `${pos.x}px`, top: `${pos.y}px` },
          onMouseDown: (e) => e.stopPropagation(),
          onContextMenu: (e) => e.preventDefault(),
        }, [
          h('div', { className: 'll-menu-title', key: 't' }, `文件夹：${menu.folder}`),
          h('div', { className: 'll-hint', key: 'c', style: { padding: '2px 10px 6px' } },
            `共 ${menu.papers.length} 篇（隐藏 ${menu.hiddenCount}）`),
          h('button', {
            key: 'collapse', className: 'll-menu-item',
            onMouseDown: (e) => { e.stopPropagation(); toggleCollapse(menu.folder); onClose(); },
          }, collapsed.has(menu.folder) ? '展开此文件夹' : '收起此文件夹'),
          h('button', {
            key: 'hidetree', className: 'll-menu-item',
            onMouseDown: (e) => {
              e.stopPropagation();
              const body = { action: 'hide', folder: menu.folder };
              onClose();
              doMutate(body, '已隐藏文件夹');
            },
          }, '隐藏整个文件夹（含子文件夹）'),
          h('button', {
            key: 'showtree', className: 'll-menu-item',
            onMouseDown: (e) => {
              e.stopPropagation();
              const body = { action: 'unhide', folder: menu.folder };
              onClose();
              doMutate(body, '已恢复文件夹');
            },
          }, '取消隐藏整个文件夹'),
          h('div', { className: 'll-menu-sep', key: 's2' }),
          h('button', {
            key: 'deltree', className: 'll-menu-item ll-danger',
            onMouseDown: (e) => {
              e.stopPropagation();
              onClose();
              if (window.confirm(
                `确定移除文件夹「${menu.folder}」里的全部 ${menu.papers.length} 篇文献？\n\n`
                + 'PDF 会移到 library/trash/，不会永久删除。',
              )) {
                doMutate({ action: 'delete', folder: menu.folder }, '已移除文件夹');
              }
            },
          }, '移除整个文件夹…'),
        ]);
    }

    function TranslateProgress({ paper, progress, job, onOpen, onStartNow, startingNow, onRetry, retrying }) {
      if (job) {
        const phase = job.phase;
        const metrics = translationUsage(job);
        const label = {
          queued: job.stage || '排队中',
          running: job.stage || `翻译中 ${job.percent ?? 0}%`,
          done: '翻译完成',
          partial:`部分完成：${job.pendingRegions?.length||0} 区待确认补译`,
          failed: job.failure?.label || (/placeholder|structure-reordered|heading-lost|empty-paragraph|mostly-untranslated/iu.test(job.error ?? '')
            ? '翻译未完成：部分内容校验失败，可重试续传'
            : `翻译失败：${String(job.error ?? '未知原因').slice(0, 90)}`),
        }[phase] ?? phase;
        const cls = `ll-progress ll-progress-${phase === 'done' ? 'done' : phase === 'partial'||phase === 'failed' ? 'failed' : 'running'}`;
        const metricTitle = [
          `输入 token：${metrics.input.toLocaleString()}`,
          `缓存命中：${metrics.cacheHit === null ? '后端未返回' : metrics.cacheHit.toLocaleString()}`,
          `缓存未命中：${metrics.cacheMiss === null ? '后端未返回' : metrics.cacheMiss.toLocaleString()}`,
          `${metrics.visibleKnown ? '可见译文' : '输出'} token：${metrics.visible.toLocaleString()}`,
          `thinking/reasoning token：${metrics.reasoning === null ? '后端未返回' : metrics.reasoning.toLocaleString()}`,
          metrics.thinkingChars !== null && metrics.reasoning === null
            ? `thinking 字符：${metrics.thinkingChars.toLocaleString()}` : null,
          `重试：${metrics.retries} 次`,
          !('costReport' in job)&&metrics.costCny !== null
            ? `${metrics.costEstimated ? '预估' : '计费'}：¥${formatCny(metrics.costCny)}${metrics.pricingPeriod ? `（${metrics.pricingPeriod === 'peak' ? '峰时' : '闲时'}）` : ''}`
            : null,
          // 本地预处理省下的输入：参考文献、元数据、重复页眉不再发给模型
          job.preprocessing?.referenceChars
            ? `参考文献本地保留：${job.preprocessing.referenceChars.toLocaleString()} 字符`
            : null,
          job.preprocessing?.metadataChars
            ? `出版元数据本地解析：${job.preprocessing.metadataChars.toLocaleString()} 字符`
            : null,
          job.preprocessing?.protectedItems
            ? `受保护的公式/引用/DOI/URL：${job.preprocessing.protectedItems} 处`
            : null,
          job.preprocessing?.removedFurnitureLines
            ? `去除重复页眉页脚：${job.preprocessing.removedFurnitureLines} 行`
            : null,
          `本地分块缓存复用：${job.localCacheHits ?? 0} 块`,
          job.budgetRetries
            ? `输出上限不足而放大重试：${job.budgetRetries} 次`
            : null,
          job.droppedFormulas
            ? `未保留的公式残片：${job.droppedFormulas} 处（抽取碎片，已按警告记录）`
            : null,
        ].filter(Boolean);
        const title = [
          `任务 ${job.jobId}`,
          `模型 ${job.model}`,
          job.chunkTotal ? `块 ${job.chunkIndex}/${job.chunkTotal}` : null,
          `入 ${job.charsIn} 字 / 出 ${job.charsOut} 字`,
          ...metricTitle,
          job.outputPath ? `输出 ${job.outputPath}` : null,
          job.warning ? `⚠ ${job.warning}` : null,
          job.error ? `失败详情：${job.error}` : null,
        ].filter(Boolean).join('\n');
        const hasUsage = metrics.input > 0 || metrics.output > 0 || metrics.retries > 0 || metrics.costCny !== null;
        const usageLabel = [
          'costReport' in job?(job.costReport?'费用已按用量汇总':'费用待任务结束汇总'):metrics.costCny !== null ? `${metrics.costEstimated ? '约' : ''}¥${formatCny(metrics.costCny)}` : '¥—',
          `入 ${compactNumber(metrics.input)}`,
          `缓 ${compactNumber(metrics.cacheHit)}/未 ${compactNumber(metrics.cacheMiss)}`,
          `${metrics.visibleKnown ? '译' : '出'} ${compactNumber(metrics.visible)}/思 ${compactNumber(metrics.reasoning)}`,
          `重 ${metrics.retries}`,
          job.localCacheHits ? `复用 ${job.localCacheHits}` : null,
        ].filter(Boolean).join(' · ');

        return h('span', { className: 'll-translate-status', title }, [
          h('span', { className: cls, key: 'progress' }, [
            h('span', { className: 'll-progress-bar', key: 'bar' }, h('span', {
              className: 'll-progress-fill',
              style: {
                width: phase === 'done'||phase==='partial' ? '100%'
                  : phase === 'failed' ? '100%'
                    : `${Math.max(4, job.percent ?? 0)}%`,
              },
            })),
            h('span', { className: 'll-progress-text', key: 't' }, label),
            phase === 'failed' && onRetry && job.failure?.canResume !== false ? h('button', {
              key: 'retry', className: 'll-btn ll-btn-xs', disabled: retrying,
              title: '重试翻译，复用本版本已经校验通过的分块和段落',
              onClick: (e) => { e.stopPropagation(); onRetry(); },
            }, retrying ? '提交中…' : (job.failure?.action || '重试续传')) : null,
            phase === 'failed' ? h('details',{key:'diagnostic',className:'ll-job-diagnostic'},[
              h('summary',{key:'summary'},'诊断'),h('p',{key:'action'},job.failure?.action || '检查失败详情'),
              h('pre',{key:'error'},String(job.error || '无详细信息')),
            ]):null,
            job.schedule === 'offpeak' && ['queued', 'running'].includes(phase) && onStartNow
              ? h('button', {
                key: 'now', className: 'll-btn ll-btn-xs', disabled: startingNow,
                title: '取消该任务的闲时限制，按当前时段价格翻译；有任务执行时等待空位',
                onClick: (e) => { e.stopPropagation(); onStartNow(job); },
              }, startingNow ? '切换中…' : '立即翻译') : null,
            ['done','partial'].includes(job.phase) && onOpen ? h('button', {
              key: 'open', className: 'll-btn ll-btn-xs', style: { marginLeft: '4px' },
              title: '选中这篇以查看译文',
              onClick: (e) => { e.stopPropagation(); onOpen(); },
            }, '查看') : null,
          ]),
          hasUsage ? h('span', { className: 'll-usage', key: 'usage' }, usageLabel) : null,
          job.costReport?h('details',{key:'billing',className:'ll-job-billing',onClick:e=>e.stopPropagation()},[
            h('summary',{key:'s'},`累计：划分 ${costTotals(job.costReport.partition.totals)} · 翻译 ${costTotals(job.costReport.translation.totals)}`),
            h('p',{key:'total'},'合计：'+costTotals(job.costReport.totals)),h('p',{key:'pending'},job.costReport.partial?`${job.costReport.pendingCount} 个待确认区域尚未翻译，补译后继续累计。`:'本次可译内容已完成。'),
            ...job.costReport.partition.pages.map(p=>h('p',{key:p.page},`第 ${p.page} 页划分：${costTotals(p.totals)}`)),h('p',{key:'note'},job.costReport.note),
          ]):job.billingError?h('span',{key:'billing-error',className:'ll-usage'},job.billingError):null,
        ]);
      }

      // 旧路径：agent 会话
      if (!paper.translateSession) return null;
      const phase = progress?.phase;
      const label = {
        queued: '已投递，等待开始',
        running: progress?.detail ? `翻译中 · ${progress.detail}` : '翻译中',
        done: '翻译完成',
        failed: '翻译失败',
        missing: '会话文件丢失',
        unknown: '状态未知',
      }[phase] ?? '状态未知';
      const pct = phase === 'done' ? 100 : phase === 'queued' ? 8 : null;

      return h('span', {
        className: `ll-progress ll-progress-${phase ?? 'unknown'}`,
        title: progress
          ? `会话 ${paper.translateSession} · ${progress.events ?? 0} 个事件 · ${((progress.bytes ?? 0) / 1024).toFixed(1)} KB`
          : `会话 ${paper.translateSession}`,
      }, [
        h('span', { className: 'll-progress-bar', key: 'bar' }, h('span', {
          className: 'll-progress-fill',
          style: { width: pct === null ? '100%' : `${pct}%` },
        })),
        h('span', { className: 'll-progress-text', key: 't' }, label),
      ]);
    }

    /** 分类路径 → 该路径下所有文献（含子路径） */
    function papersUnder(papers, folder) {
      return papers.filter((p) => (
        p.folder === folder
        || p.category === folder
        || (typeof p.folder === 'string' && p.folder.startsWith(`${folder}/`))
      ));
    }

    /** 节点的完整分类路径（用 / 连接），用于折叠状态与「隐藏整个文件夹」 */
    function nodePath(node, parentPath) {
      return parentPath ? `${parentPath}/${node.name}` : node.name;
    }

    /**
     * 目录树节点。
     *
     * 折叠状态由父组件持有（`collapsed` 是 Set<路径>），因为：
     *   - 需要持久化到 localStorage，跨刷新保留；
     *   - 深层节点各自持有 state 会让「全部收起」这类操作很难做。
     */
    function TreeNode({
      node, depth, parentPath, selected, collapsed, toggleCollapse,
      onSelect, onTranslate, onMutate, onArrange, translating, showHidden,
      progressOf, jobOf, onContextMenu, papers, allPapers,
      selectedFolder, onSelectFolder, onStartNow, startingJob,
    }) {
      const [paperDrag, setPaperDrag] = React.useState(null);
      const path = nodePath(node, parentPath);
      const isCollapsed = collapsed.has(path);
      const kids = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name));

      // 隐藏的条目默认不显示；「显示隐藏」打开后它们以淡色出现
      const visibleOwn = node.papers.filter((p) => showHidden || p.hidden !== true);
      const own = sortPapers(visibleOwn);

      /**
       * 本文件夹的**完整**顺序（不受搜索过滤影响）。
       * 搜索时如果把过滤后的子集直接重新编号，其余条目会突然排到子集后面；
       * 所以移动必须基于完整分组，只把可见目标与当前项在完整列表里交换。
       */
      const fullOwn = sortPapers(allPapers.filter((p) => paperGroupKey(p) === path));

      /** 在同一文件夹、同一置顶分组内拖放；未显示的条目仍保留原有相对顺序。 */
      const dropPaper = (paper, targetPaper, after) => {
        if (!paper || !targetPaper || paper.slug === targetPaper.slug) return;
        if ((paper.pinned === true) !== (targetPaper.pinned === true)) return;
        const list = fullOwn.map((p) => p.slug);
        const from = list.indexOf(paper.slug);
        let to = list.indexOf(targetPaper.slug);
        if (from < 0 || to < 0) return;
        list.splice(from, 1);
        if (from < to) to -= 1;
        list.splice(to + (after ? 1 : 0), 0, paper.slug);
        onArrange({ action: 'order', folder: path, slugs: list });
      };

      // 全部条目都被隐藏时，整棵子树不显示（避免出现空壳文件夹）
      const totalVisible = countVisible(node, showHidden);
      if (node.name !== '' && totalVisible === 0) return null;

      const rows = [];

      if (node.name !== '') {
        const hiddenCount = countHidden(node);
        // 文件夹菜单里的「共 N 篇」应是整组真实数量，不受搜索过滤影响
        const under = papersUnder(allPapers, path);
        const underHidden = under.filter((p) => p.hidden === true).length;
        rows.push(h('div', {
          key: 'head',
          className: `ll-group ll-group-clickable${selectedFolder === path ? ' ll-group-selected' : ''}`,
          style: { paddingLeft: `${8 + depth * 10}px` },
          onClick: () => {
            onSelectFolder(path);
            toggleCollapse(path);
          },
          title: `${isCollapsed ? '点击展开' : '点击收起'}；同时选中为「扫描此文件夹」目标；右键打开文件夹菜单`,
          onContextMenu: (e) => {
            e.preventDefault();
            onContextMenu({
              x: e.clientX,
              y: e.clientY,
              kind: 'folder',
              folder: path,
              papers: under,
              hiddenCount: underHidden,
              visibleCount: under.length - underHidden,
            });
          },
        }, [
          h('span', { className: 'll-caret', key: 'caret' }, isCollapsed ? '▸' : '▾'),
          h('span', { key: 'n', className: 'll-group-name' }, node.name),
          h('span', { key: 'c', className: 'll-group-count' }, [
            String(totalVisible),
            hiddenCount > 0 ? h('span', { key: 'h', className: 'll-hint' }, ` (${hiddenCount} 隐藏)`) : null,
          ]),
          h('button', {
            key: 'more', className: 'll-btn ll-btn-xs ll-item-more',
            title: '文件夹操作：收起展开 / 隐藏整个文件夹 / 移除（也可以直接右键标题）',
            onClick: (e) => {
              e.stopPropagation();
              const r = e.currentTarget.getBoundingClientRect();
              onContextMenu({
                x: r.left - 170, y: r.bottom + 2,
                kind: 'folder', folder: path, papers: under,
                hiddenCount: underHidden, visibleCount: under.length - underHidden,
              });
            },
          }, '⋯'),
        ]));
      }

      if (!isCollapsed) {
        for (const p of own) {
          const openPaperMenu = (x, y) => onContextMenu({
            x, y, kind: 'paper', paper: p,
          });

          rows.push(h('div', {
            key: p.slug,
            className: `ll-item${p.slug === selected ? ' active' : ''}${p.hidden ? ' ll-item-hidden' : ''}${paperDrag?.slug === p.slug ? ' ll-dragging' : ''}${paperDrag?.over === p.slug ? ` ll-drop-${paperDrag.after ? 'after' : 'before'}` : ''}`,
            style: { paddingLeft: `${12 + depth * 10}px` },
            role: 'button',
            tabIndex: 0,
            draggable: translating === null,
            onDragStart: (e) => {
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', p.slug);
              setPaperDrag({ slug: p.slug, paper: p, over: null, after: false });
            },
            onDragOver: (e) => {
              if (!paperDrag || (paperDrag.paper.pinned === true) !== (p.pinned === true)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              const rect = e.currentTarget.getBoundingClientRect();
              setPaperDrag((current) => ({ ...current, over: p.slug, after: e.clientY >= rect.top + rect.height / 2 }));
            },
            onDrop: (e) => {
              e.preventDefault();
              if (paperDrag) dropPaper(paperDrag.paper, p, paperDrag.after);
              setPaperDrag(null);
            },
            onDragEnd: () => setPaperDrag(null),
            onClick: () => onSelect(p.slug),
            onKeyDown: (e) => {
              if (e.target !== e.currentTarget) return;
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelect(p.slug);
              }
            },
            onContextMenu: (e) => {
              e.preventDefault();
              openPaperMenu(e.clientX, e.clientY);
            },
          }, [
            h('div', { className: 'll-item-main', key: 'm' }, [
              h('span', { className: 'll-item-title', key: 't', title: sidebarPaperLabel(p) }, [
                p.pinned ? h('span', {
                  className: 'll-pin-mark', key: 'pin', title: '已置顶（始终排在本文件夹最前）',
                }, h(PinIcon, { size: 11 })) : null,
                p.hidden ? '🚫 ' : '',
                chinesePaperTitle(p),
              ]),
              h('span', { className: 'll-item-pub', key: 'pub' }, [
                h('span', { className: 'll-item-year', key: 'y' }, paperPublicationYear(p)),
                h('span', { key: 'sep', 'aria-hidden': true }, '·'),
                h('span', { className: 'll-item-author', key: 'a', title: p.authors ?? '作者未知' }, firstPaperAuthor(p)),
              ]),
              h('span', { className: 'll-item-meta', key: 's' }, [
                h('span', { className: 'll-item-journal', key: 'j', title: p.journal?.name ?? '期刊待补全' }, [
                  p.journal?.name ?? '期刊待补全',
                  p.journal?.impactFactor != null ? ` · IF ${p.journal.impactFactor}` : '',
                  p.journal?.casQuartile ? ` · ${p.journal.casQuartile}` : '',
                ]),
                // 「翻译」从 hover 操作区挪到标签位：未翻译的条目一眼就能看到入口
                p.translation
                  ? h('span', { className: 'll-tag done', key: 'd' }, '已翻译')
                  : h('button', {
                    className: 'll-tag-btn', key: 'u', disabled: translating !== null || p.hidden === true,
                    title: p.hidden === true ? '已隐藏的文献不参与翻译' : '开始翻译这篇文献',
                    onClick: (e) => { e.stopPropagation(); onTranslate(p); },
                  }, translating === p.slug ? '投递中…' : '翻译'),
                p.pinned ? h('span', {
                  className: 'll-tag', key: 'pp', style: { color: 'var(--ll-pin)', borderColor: 'var(--ll-pin)' },
                  title: '本文件夹内置顶',
                }, '置顶') : null,
                p.hidden ? h('span', { className: 'll-tag', key: 'hh' }, '已隐藏') : '',
              ]),
              h(TranslateProgress, {
                key: 'pr', paper: p, progress: progressOf(p), job: jobOf(p),
                onOpen: () => onSelect(p.slug),
                onStartNow, startingNow: startingJob === jobOf(p)?.jobId,
                onRetry: () => onTranslate(p), retrying: translating !== null,
              }),
            ]),
            // 置顶 / 更多。排序直接拖动整条文献。
            h('div', { className: 'll-item-actions', key: 'acts' }, [
              h('button', {
                key: 'pin', className: `ll-icon-btn${p.pinned ? ' on' : ''}`,
                disabled: translating !== null,
                'aria-pressed': p.pinned === true,
                title: p.pinned ? '取消置顶' : '置顶到本文件夹顶部',
                onClick: (e) => {
                  e.stopPropagation();
                  onArrange({ action: p.pinned ? 'unpin' : 'pin', slug: p.slug });
                },
              }, h(PinIcon, { size: 12 })),
              h('button', {
                key: 'more', className: 'll-icon-btn ll-item-more',
                title: '更多操作：翻译 / 置顶 / 隐藏 / 移除（排序请直接拖动）',
                onClick: (e) => {
                  e.stopPropagation();
                  const r = e.currentTarget.getBoundingClientRect();
                  openPaperMenu(r.left - 178, r.bottom + 2);
                },
              }, '⋯'),
            ]),
          ]));
        }

        for (const k of kids) {
          rows.push(h(TreeNode, {
            key: `n:${k.name}`, node: k, depth: depth + 1, parentPath: path,
            selected, collapsed, toggleCollapse,
            onSelect, onTranslate, onMutate, onArrange, translating, showHidden,
            progressOf, jobOf, onContextMenu, papers, allPapers,
            selectedFolder, onSelectFolder, onStartNow, startingJob,
          }));
        }
      }

      return h('div', null, rows);
    }

    /** 统计「可见」文献数；showHidden 打开时等于总数 */
    function countVisible(node, showHidden) {
      let n = node.papers.filter((p) => showHidden || p.hidden !== true).length;
      for (const c of node.children.values()) n += countVisible(c, showHidden);
      return n;
    }

    /** 统计节点子树里被隐藏的篇数 */
    function countHidden(node) {
      let n = node.papers.filter((p) => p.hidden === true).length;
      for (const c of node.children.values()) n += countHidden(c);
      return n;
    }

    // ─────────────────── API 配置对话框 ───────────────────

    /**
     * DeepSeek API 配置。
     *
     * 为什么写在面板里：以前只能靠手改 `~/.dsh/.credentials.yaml` 或设环境变量，
     * 对使用者太不友好。这里做成一个对话框，并**明确显示 key 从哪来**
     * （配置 / 环境变量 / 凭据文件），保存后还会回读验证。
     *
     * 安全：key 只会写进 DSH 自己的凭据文件（写前自动备份）；
     * 界面上永远只显示前缀（`sk-038…`），不显示完整 key。
     */
    function ConfigDialog({ onClose, onSaved }) {
      const [info, setInfo] = React.useState(null);
      const [key, setKey] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [msg, setMsg] = React.useState(null);

      const load = React.useCallback(async () => {
        try {
          const res = await fetch(`${ROUTE_PREFIX}/config`);
          const data = await res.json();
          setInfo(data);
        } catch (err) {
          setMsg({ kind: 'err', text: `读取配置失败：${err.message}` });
        }
      }, []);

      React.useEffect(() => { load(); }, [load]);

      async function save() {
        if (key.trim() === '') { setMsg({ kind: 'err', text: '请输入 API key' }); return; }
        setBusy(true); setMsg(null);
        try {
          const r = await postJson('/config', { apiKey: key.trim() });
          setMsg({
            kind: 'ok',
            text: `已保存并验证成功。\n文件：${r.file}\n备份：${r.backup ?? '(新建，无需备份)'}\n来源：${r.keySource}`,
          });
          setKey('');
          await load();
          onSaved?.();
        } catch (err) {
          setMsg({ kind: 'err', text: `保存失败：${err.message}` });
        } finally { setBusy(false); }
      }

      const row = (label, value, ok) => h('div', { className: 'll-cfg-row', key: label }, [
        h('span', { className: 'll-cfg-label', key: 'l' }, label),
        h('code', { className: `ll-cfg-value${ok === false ? ' bad' : ''}`, key: 'v' }, value ?? '(无)'),
      ]);

      return h('div', { className: 'll-modal-bg', onClick: (e) => { if (e.target === e.currentTarget) onClose(); } },
        h('div', { className: 'll-modal ll-modal-sm', onClick: (e) => e.stopPropagation() }, [
          h('div', { className: 'll-modal-head', key: 'h' }, [
            h('span', { key: 't' }, '配置 DeepSeek API'),
            h('button', { key: 'x', className: 'll-btn', style: { marginLeft: 'auto' }, onClick: onClose }, '关闭'),
          ]),
          h('div', { className: 'll-modal-body', key: 'b', style: { padding: '10px 12px' } }, [
            h('div', { className: 'll-cfg-status', key: 'st' }, info?.ready
              ? h('span', { className: 'll-cfg-ok', key: 'y' }, `✓ 已就绪（${info.keyPrefix}，来自 ${info.keySource}）`)
              : h('span', { className: 'll-cfg-bad', key: 'n' }, '✗ 尚未配置 API key')),

            h('div', { className: 'll-cfg-rows', key: 'rows' }, info ? [
              row('模型', info.model),
              row('端点', info.baseUrl),
              row('maxTokens', String(info.maxTokens)),
              row('每块 token', String(info.chunkTokens)),
              row('环境变量 DEEPSEEK_API_KEY', info.envHasKey ? '已设置' : '未设置', info.envHasKey ? undefined : false),
              row('插件配置 apiKey', info.configHasKey ? '已设置' : '未设置', info.configHasKey ? undefined : false),
              row('凭据文件', info.credentialsFile, info.credentialsFileExists ? undefined : false),
              row('凭据文件里的 key', info.credentialsHasKey ? '有' : '无', info.credentialsHasKey ? undefined : false),
            ] : null),

            h('div', { className: 'll-cfg-form', key: 'f' }, [
              h('label', { key: 'l' }, '粘贴新的 API key（保存后会写入上面的凭据文件，并自动备份原文件）'),
              h('div', { style: { display: 'flex', gap: '6px', marginTop: '4px' } }, [
                h('input', {
                  key: 'i', className: 'll-input', type: 'password', value: key, spellCheck: false,
                  placeholder: 'sk-…', autoComplete: 'off',
                  onChange: (e) => setKey(e.target.value),
                  onKeyDown: (e) => { if (e.key === 'Enter') save(); },
                }),
                h('button', {
                  key: 'b', className: 'll-btn', disabled: busy, onClick: save,
                }, busy ? '保存中…' : '保存并验证'),
              ]),
              h('div', { className: 'll-hint', key: 'h2', style: { marginTop: '6px' } },
                'key 只保存在本机，界面只显示前缀。获取地址：platform.deepseek.com'),
            ]),

            msg ? h('div', {
              className: 'll-banner', key: 'm',
              style: { marginTop: '10px', whiteSpace: 'pre-wrap' },
            }, msg.text) : null,
          ]),
        ]));
    }

    // ─────────────────── PDF.js / 切换节流 ───────────────────

    /**
     * 把一个高频变化的值延迟到「停稳」后再交给下游。
     *
     * 侧栏频繁点选文章时，真正昂贵的不是标题切换，而是：
     *   - 反复创建/销毁 PDF.js 文档与 worker；
     *   - 反复把整篇译文塞进 Markdown + KaTeX 渲染。
     * 中间那些「路过」的文献根本不需要加载。把选中项 debounce 之后，
     * 只有用户真正停下来的那篇才会触发这些工作。
     */
    function useDebouncedValue(value, delay) {
      const [debounced, setDebounced] = React.useState(value);
      React.useEffect(() => {
        const timer = setTimeout(() => setDebounced(value), delay);
        return () => clearTimeout(timer);
      }, [value, delay]);
      return debounced;
    }

    /**
     * PDF.js 阅读器。
     *
     * 与内置阅读器相比的关键差别：
     *   - 只有一个 PDF.js 文档对象；切换时 `destroy()` 是确定的，不会像 PDFium
     *     那样留下半初始化的阅读器实例；
     *   - 配合 host 的 Range，只拉当前页附近的数据（149MB 论文也不会整份进内存）；
     *   - 工具条是我们自己的 35px 行，和译文第 2 行始终严格对齐。
     *
     * 如果 PDF.js 因 CSP/worker 等原因加载失败，提供「兼容模式」按钮回退到
     * 浏览器内置阅读器（只在用户明确点击时创建，避免自动切换时再次卡死）。
     */
    const PDF_PAGE_DEFAULT_RATIO = 1.414;
    const PDF_PRELOAD_MARGIN = '65% 0px 65% 0px';

    /**
     * Canvas 内存约等于 width × height × 4。高 DPI + 300% 缩放时，旧实现单页
     * 可超过 150 MB；根据设备内存限制单页像素，宁可极端缩放时略微软一点，
     * 也不能让几个预加载页拖垮整个 DSH 渲染进程。
     */
    function pdfCanvasPixelBudget() {
      const memory = Number(window.navigator?.deviceMemory);
      if (Number.isFinite(memory) && memory <= 4) return 2_500_000;
      if (Number.isFinite(memory) && memory <= 8) return 4_000_000;
      return 6_000_000;
    }

    /**
     * 连续滚动中的一页。
     *
     * 只为「视口附近」的页创建 canvas；滚远后释放 canvas（`width=0`），
     * 但保留占位高度，所以滚动条不会跳动。父组件用 React.memo 包住它，
     * 页码变化时不会把 200 多页全部重渲染一遍。
     */
    const REGION_LABELS = { body: '正文', abstract: '摘要', heading: '章节标题', caption: '图表题注', formula: '公式', table: '表格', figure:'图片',pending:'待确认（暂不翻译）',references:'参考文献（保留原文）',
      title: '论文标题', 'front-matter': '作者信息', 'article-info': '文章信息', affiliation: '作者单位', publication: '出版信息',
      'running-matter': '页眉页脚', watermark: '忽略/水印' };
    const LAYOUT_PHASES = { queued: '等待分区', partitioning: '本地分区中', review: '待人工检查', approved: '分区已确认', failed: '分区失败' };
    const isArticleRegion=r=>['body','abstract','heading','caption','formula','table','figure','pending','references'].includes(r.role);
    const partitionEngine=()=>{try{return localStorage.getItem('dsh-literature-library/partition-engine')==='ai'?'ai':'local';}catch{return'local';}};
    function costTotals(totals){if(!totals?.length)return'0（无 API 调用）';return totals.map(c=>{if(c.low==null||c.high==null)return`${c.currency} 金额未知`;const f=n=>n>0&&n<.00001?'<0.00001':Number(n).toFixed(5);return`${c.currency} ${c.low===c.high?f(c.low):f(c.low)+'—'+f(c.high)}`;}).join(' / ');}
    async function confirmPartitionAI(engine,count=1){if(engine!=='ai')return true;const r=await fetch(`${ROUTE_PREFIX}/partition-ai-config`),c=await r.json();if(!r.ok||!c.ready)throw Error(c.message||'请先在分区/批量翻译中保存 AI 分区配置，并在原 API 配置中设置统一密钥');return window.confirm(`AI 三阶段分区：${count} 篇，每页最多 3 次请求。\n服务 ${c.endpoint}\n模型 ${c.model}\n使用统一翻译 API 密钥；发送论文页面图像及相邻页原文，不发送人工稿。\n分区和翻译分别计费，结束后汇总；待确认区域先跳过。继续？`);}
    function regionDisplayLabel(region,regions){
      const prefix=isArticleRegion(region)?String(regions.filter(isArticleRegion).findIndex(r=>r.id===region.id)+1):'信息';
      return prefix+' · '+(REGION_LABELS[region.role]||region.role);
    }
    function RegionOverlay({ viewport, view, setView }) {
      const drag = React.useRef(null);
      React.useEffect(()=>()=>drag.current?.cleanup?.(),[]);
      if (!viewport || !view?.page) return null;
      const regions = view.page.regions;
      const point = e => {
        // Selection fields and the unsaved notice may change toolbar height.
        // Keep the pointer's coordinate frame fixed for this gesture.
        const b = drag.current?.rect || e.currentTarget.getBoundingClientRect();
        const [x,y] = viewport.convertToPdfPoint((e.clientX-b.left)*viewport.width/b.width, (e.clientY-b.top)*viewport.height/b.height);
        return [Math.max(0,Math.min(view.page.width,x)), Math.max(0,Math.min(view.page.height,y))];
      };
      const begin = (e, r, resize) => {
        if (!view.editing || drag.current || e.button !== 0) return;
        e.preventDefault(); e.stopPropagation();
        const layer = e.currentTarget.closest('.ll-region-overlay');
        const b = layer.getBoundingClientRect();
        const p = viewport.convertToPdfPoint((e.clientX-b.left)*viewport.width/b.width, (e.clientY-b.top)*viewport.height/b.height);
        drag.current = { id: r.id, box: [...r.bbox], start: p, resize, rect: b };
        bindDrag(e,layer);
        setView(v => ({ ...v, selected: r.id }));
      };
      // Drag is a transient geometry gesture. Paint its box locally, then commit
      // once on release; do not rerender the reader/controls for every pointermove.
      const paint=(id,box)=>{
        const el=[...document.querySelectorAll('.ll-region-box')].find(n=>n.dataset.regionId===id);
        if(!el)return;
        const a=viewport.convertToViewportPoint(box[0],box[1]),b=viewport.convertToViewportPoint(box[2],box[3]);
        Object.assign(el.style,{left:`${Math.min(a[0],b[0])/viewport.width*100}%`,top:`${Math.min(a[1],b[1])/viewport.height*100}%`,
          width:`${Math.abs(a[0]-b[0])/viewport.width*100}%`,height:`${Math.abs(a[1]-b[1])/viewport.height*100}%`});
      };
      const finish=()=>{
        const d=drag.current;drag.current=null;d?.cleanup?.();if(!d?.preview)return;
        setView(v=>({...v,dirty:true,page:{...v.page,regions:v.page.regions.map(r=>r.id===d.id?{...r,bbox:d.preview}:r)}}));
      };
      const move=e=>{
        const d=drag.current;if(!d)return;
        const p=point(e),[x,y]=d.start;let box;
        if(d.draw)box=[Math.min(x,p[0]),Math.min(y,p[1]),Math.max(x,p[0]),Math.max(y,p[1])];
        else if(d.resize)box=[d.box[0],Math.min(d.box[3]-1,p[1]),Math.max(d.box[0]+1,p[0]),d.box[3]];
        else {const dx=Math.max(-d.box[0],Math.min(view.page.width-d.box[2],p[0]-x)),dy=Math.max(-d.box[1],Math.min(view.page.height-d.box[3],p[1]-y));box=d.box.map((n,i)=>n+(i%2?dy:dx));}
        d.preview=box;paint(d.id,box);
      };
      const cancel=()=>{
        const d=drag.current;drag.current=null;d?.cleanup?.();if(!d)return;
        if(d.draw)setView(v=>({...v,dirty:d.wasDirty,page:{...v.page,regions:v.page.regions.filter(r=>r.id!==d.id)}}));
        else paint(d.id,d.box);
      };
      const bindDrag=(e,layer)=>{
        const pointer=e.pointerId,capture={capture:true};
        const motion=event=>{if(event.pointerId===pointer)move(event);};
        const end=event=>{if(event.pointerId===pointer)finish();};
        const abort=event=>{if(event.pointerId===pointer)cancel();};
        window.addEventListener('pointermove',motion,capture);window.addEventListener('pointerup',end,capture);window.addEventListener('pointercancel',abort,capture);window.addEventListener('blur',cancel);
        drag.current.cleanup=()=>{window.removeEventListener('pointermove',motion,capture);window.removeEventListener('pointerup',end,capture);window.removeEventListener('pointercancel',abort,capture);window.removeEventListener('blur',cancel);};
        // DSH/React may reparent the overlay after selection and release capture.
        // Window listeners own this gesture until release, cancellation or unmount.
        try{layer.setPointerCapture(pointer);}catch{/* Window tracking remains active. */}
      };
      return h('div', { className: 'll-region-overlay', style: { pointerEvents: view.editing ? 'auto' : 'none', touchAction: 'none' },
        onPointerDown: e => {
          if (!view.editing || !view.drawing || drag.current || e.button !== 0) return;
          const p = point(e), id = `manual-${Date.now()}`;
          drag.current = { id, start: p, draw: true, wasDirty:view.dirty,rect: e.currentTarget.getBoundingClientRect() };bindDrag(e,e.currentTarget);
          setView(v => ({ ...v, dirty: true, selected: id, page: { ...v.page, regions: [...v.page.regions,
            { id, role: 'body', bbox: [p[0],p[1],p[0]+1,p[1]+1], itemIds: [] }] } }));
        },
      }, regions.filter(r=>view.showInfo||isArticleRegion(r)||r.id===view.selected).map((r,i) => {
        const b = [...viewport.convertToViewportPoint(r.bbox[0],r.bbox[1]), ...viewport.convertToViewportPoint(r.bbox[2],r.bbox[3])];
        const x = Math.min(b[0],b[2]), y = Math.min(b[1],b[3]);
        return h('div', { key: r.id, className: `ll-region-box${view.selected === r.id ? ' is-selected' : ''}`,
          'data-role': r.role, 'data-region-id':r.id,'data-labels':view.showLabels?'all':'selection','aria-label':regionDisplayLabel(r,regions),style: { left: `${x/viewport.width*100}%`, top: `${y/viewport.height*100}%`,
            width: `${Math.abs(b[2]-b[0])/viewport.width*100}%`, height: `${Math.abs(b[3]-b[1])/viewport.height*100}%` },
          onPointerDown: e => { if (view.drawing) return; begin(e,r,false); } }, [
          h('span', { key: 'label', className: 'll-region-label' }, regionDisplayLabel(r,regions)),
          view.editing && !view.drawing ? h('span', { key: 'resize', className: 'll-region-handle', onPointerDown: e => begin(e,r,true) }) : null,
        ]);
      }));
    }

    function MediaOptions({value={},onChange}){
      return h('div',{className:'ll-media-options'},[
        h('label',{key:'figures',title:'从 PDF 本地截图插入原图；只翻译图注，不翻译图内文字，不发送视觉 API'},[h('input',{key:'c',type:'checkbox',checked:value.figures===true,onChange:e=>onChange({...value,figures:e.target.checked})}),'插入图片']),
        h('label',{key:'tables',title:'按行列翻译单元格，会增加文本 token；关闭时只翻译表题'},[h('input',{key:'c',type:'checkbox',checked:value.tables===true,onChange:e=>onChange({...value,tables:e.target.checked})}),'翻译表格']),
        h('label',{key:'formula',title:'公式始终优先输出 LaTeX；仅不确定时保留本地原图。关闭后显示待核对候选文本，不猜写缺失符号。'},[h('input',{key:'c',type:'checkbox',checked:value.formulaFallback!==false,onChange:e=>onChange({...value,formulaFallback:e.target.checked})}),'不确定公式用图片']),
      ]);
    }

    function ToolDialog({tab,onTab,onClose,children}) {
      const ref=React.useRef(null),close=React.useRef(onClose);close.current=onClose;
      React.useEffect(()=>{
        const before=document.activeElement,node=ref.current;
        node?.querySelector('button')?.focus();
        const key=e=>{
          if(e.key==='Escape'){e.preventDefault();close.current();}
          if(e.key==='Tab'){
            const list=[...node.querySelectorAll('button,input,select,a[href],textarea')].filter(el=>!el.disabled&&el.getClientRects().length);
            const i=list.indexOf(document.activeElement),j=e.shiftKey?i-1:i+1;
            if(j<0||j>=list.length){e.preventDefault();list[e.shiftKey?list.length-1:0]?.focus();}
          }
        };
        node?.addEventListener('keydown',key);
        return()=>{node?.removeEventListener('keydown',key);if(before?.isConnected)before.focus({preventScroll:true});};
      },[]);
      return h('div',{className:'ll-modal-bg'},h('div',{className:'ll-modal ll-tools-dialog',role:'dialog','aria-modal':true,'aria-label':'文献工具',ref},[
        h('div',{key:'h',className:'ll-modal-head'},[h('h2',{key:'title'},'文献工具'),h('span',{key:'sp',className:'ll-spacer'}),h('button',{key:'close',className:'ll-btn',onClick:onClose},'关闭')]),
        h('div',{key:'tabs',className:'ll-tool-tabs',role:'tablist'},[['library','文献管理'],['translation','翻译与任务'],['reading','阅读'],['settings','插件设置']].map(([id,label])=>h('button',{key:id,role:'tab','aria-selected':tab===id,className:'ll-tab'+(tab===id?' on':''),onClick:()=>onTab(id)},label))),
        h('div',{key:'body',className:'ll-modal-body',role:'tabpanel'},children),
      ]));
    }
    function LayoutControls({ slug, page, mode, schedule, media, view, setView, show, setShow, onJob }) {
      const controlsRef=React.useRef(null);
      React.useEffect(()=>readerRuntime.bindMenuDismissal({window,document,element:()=>controlsRef.current,close:()=>controlsRef.current?.querySelectorAll('details[open]').forEach(d=>d.open=false)}),[]);
      const toggleDisclosure=e=>{if(e.currentTarget.open)controlsRef.current?.querySelectorAll('.ll-layout-more[open],.ll-layout-inspector[open]').forEach(d=>{if(d!==e.currentTarget&&!d.contains(e.currentTarget))d.open=false;});};
      const [data, setData] = React.useState(null), [error,setError] = React.useState(''), [busy,setBusy] = React.useState(false);
      const [epoch,setEpoch] = React.useState(0);
      React.useEffect(() => {
        const refresh = () => setEpoch(n => n+1);
        window.addEventListener('ll-layout-changed',refresh);
        return () => window.removeEventListener('ll-layout-changed',refresh);
      }, []);
      React.useEffect(() => {
        if (view?.dirty) return undefined;
        let cancelled = false, timer;
        const poll = async () => {
          try {
            const res = await fetch(`${ROUTE_PREFIX}/layout?slug=${encodeURIComponent(slug)}&page=${page}`);
            const d = await res.json(); if (!res.ok) throw new Error(d.message || '读取分区失败');
            if (cancelled) return;
            setData(d); setError('');
            setView(v => ({ ...v, page: d.page, state: d.state, dirty: false, editing: v?.editing || false }));
            if (['queued','partitioning'].includes(d.state?.phase)) timer = setTimeout(poll,2000);
            else if (d.state?.mode === 'auto' && d.state.phase === 'approved' && !d.state.error) {
              if (d.state.translationJobId) {
                const j = await fetch(`${ROUTE_PREFIX}/translate-job?id=${encodeURIComponent(d.state.translationJobId)}`);
                if(j.ok && !cancelled) onJob?.(await j.json());
              } else timer = setTimeout(poll,2000);
            }
          } catch (err) { if (!cancelled) setError(err.message); }
        };
        poll(); return () => { cancelled = true; clearTimeout(timer); };
      }, [slug,page,epoch,view?.dirty]);
      async function act(action, extra = {}) {
        setBusy(true); setError('');
        try {
          const r = await postJson('/layout', { action, slug, mode, schedule, media, revision: data?.state?.revision, ...extra });
          if (r.results?.[0]?.error) throw new Error(r.results[0].error);
          if (r.job) onJob?.(r.job);
          setView(v => ({ ...v, dirty: false })); setEpoch(n => n+1);
        } catch (err) { setError(err.message); }
        finally { setBusy(false); }
      }
      const s=data?.state,regions=view?.page?.regions||[],selected=regions.find(r=>r.id===view?.selected);
      const ready=!!s&&!['queued','partitioning'].includes(s.phase);
      const editing=!!view?.editing,dirty=!!view?.dirty,needsRefresh=!!s?.needsRefresh;
      const articles=regions.filter(isArticleRegion),visibleRegions=regions.filter(r=>view?.showInfo||isArticleRegion(r)||r.id===view?.selected);
      const counts=[['formula','公式'],['caption','图注'],['table','表格'],['figure','图片']].map(([role,label])=>{
        const n=articles.filter(r=>r.role===role).length;return n?n+' '+label:null;
      }).filter(Boolean).join(' · ');
      const changeRegion=update=>setView(v=>({...v,dirty:true,page:{...v.page,regions:v.page.regions.map(r=>r.id===v.selected?{...r,...update}:r)}}));
      const checkPage=()=>act('check-page',{page:view.page.page});
      const approve=()=>{if(window.confirm('确认已检查《'+s.title+'》的全部 '+s.pageCount+' 页？仅确认，不启动翻译。'))act('approve',{confirmAll:true});};
      const translate=()=>{if(window.confirm(s?.pendingCount?`先翻译可用内容，${s.pendingCount} 个待确认区保留占位，产生翻译费用。继续？`:'使用已确认分区翻译，将产生 API 费用。继续？'))act('translate');};
      const restart=async()=>{
        const engine=mode==='manual'?'local':partitionEngine();try{if(!await confirmPartitionAI(engine))return;}catch(e){setError(e.message);return;}
        if(mode==='auto'&&!window.confirm('自动模式自检后会调用 API 翻译并产生费用。继续？'))return;
        if(s&&!window.confirm('重新分区会清除当前人工修改和确认；旧版本文件仍保留。继续？'))return;
        setShow(true);act('start',{force:!!s,engine,aiConsent:engine==='ai'});
      };
      const edit=()=>{
        if(editing&&dirty){setError('请先保存，或在更多中放弃修改。');return;}
        setShow(true);setView(v=>({...v,editing:!v?.editing}));
      };
      const summary=s?(s.aiProgress?`AI ${s.aiProgress.stage} · 第 ${s.aiProgress.page}/${s.aiProgress.total} 页`:(LAYOUT_PHASES[s.phase]||s.phase))+' · 已检查 '+s.checkedPages.length+'/'+s.pageCount+' 页'+(s.pendingCount?` · ${s.pendingCount} 区暂缓翻译`:''):'尚未分区';
      return h('section',{ref:controlsRef,className:'ll-layout-controls','aria-label':'论文分区检查'},[
        h('div',{key:'bar',className:'ll-layout-mainbar'},[
          h('strong',{key:'page'},'分区'+(view?.page?' · 第 '+view.page.page+' 页':'')),
          h('span',{key:'state',className:'ll-layout-state',title:summary},summary),
          h('span',{key:'sp',className:'ll-spacer'}),
          s?.ai&&s.phase==='partitioning'?h('button',{key:'cancel-ai',className:'ll-btn ll-btn-xs',disabled:busy,onClick:()=>act('cancel-ai')},'停止后续 AI'):null,
          ready&&view?.page?h('button',{key:'edit',className:'ll-btn ll-btn-xs',disabled:busy,onClick:edit},editing?'结束编辑':'手动纠错'):null,
          ready&&view?.page&&!needsRefresh?h('button',{key:'primary',className:'ll-btn ll-btn-xs ll-layout-primary',disabled:busy||(editing?!dirty&&s.mode!=='manual':dirty),
            'aria-label':editing?'保存本页并自检':s.phase==='approved'||s.canTranslate?'按确认分区翻译':'此页已检查',
            onClick:editing?()=>act('save-page',{page:view.page.page,regions:regions.map(({id,role,bbox})=>({id,role,bbox}))}):s.phase==='approved'||s.canTranslate?translate:checkPage},editing?'保存':s.canTranslate&&s.pendingCount?'翻译可用区域':s.phase==='approved'||s.canTranslate?'翻译':'此页已检查'):null,
          !s?h('button',{key:'start',className:'ll-btn ll-btn-xs',disabled:busy,onClick:restart},'开始分区'):null,
          h('details',{key:'more',className:'ll-layout-more',onToggle:toggleDisclosure},[
            h('summary',{key:'toggle','aria-label':'分区更多操作'},'更多'),
            h('div',{key:'panel',className:'ll-layout-menu'},[
              h('strong',{key:'view'},'预览显示'),
              h('button',{key:'show',className:'ll-btn ll-btn-xs',disabled:!view?.page,onClick:()=>setShow(!show)},show?'隐藏分区':'显示分区'),
              h('label',{key:'info'},[h('input',{type:'checkbox',checked:!!view?.showInfo,onChange:e=>setView(v=>({...v,showInfo:e.target.checked}))}),'显示页眉、作者等信息区']),
              h('label',{key:'labels'},[h('input',{type:'checkbox',checked:!!view?.showLabels,onChange:e=>setView(v=>({...v,showLabels:e.target.checked}))}),'显示全部框标签']),
              ready&&s.ai?h('button',{key:'check-ai',className:'ll-btn ll-btn-xs',disabled:busy||dirty,onClick:checkPage},'确认本页待确认区'):null,
              ready?h('p',{key:'options'},'此稿：图片'+(s.media?.figures?'开':'关')+' · 表格'+(s.media?.tables?'开':'关')+' · 公式原图兜底'+(s.media?.formulaFallback!==false?'开':'关')):null,
              ready&&(needsRefresh||!!s.media?.figures!==!!media?.figures||!!s.media?.tables!==!!media?.tables||(s.media?.formulaFallback!==false)!==(media?.formulaFallback!==false))?
                h('button',{key:'apply',className:'ll-btn ll-btn-xs',disabled:busy||dirty,onClick:()=>act('set-media')},'更新识别（保留人工框）'):null,
              ready&&!editing&&s.phase!=='approved'?h('button',{key:'approve',className:'ll-btn ll-btn-xs',disabled:busy||dirty||needsRefresh,onClick:approve},'确认整篇'):null,
              h('details',{key:'advanced',className:'ll-layout-advanced'},[
                h('summary',{key:'s'},'重新识别与修改恢复'),
                h('button',{key:'restart',className:'ll-btn ll-btn-xs',disabled:busy||dirty||!ready,onClick:restart},s?'重新分区':'开始分区'),
                editing?h('button',{key:'discard',className:'ll-btn ll-btn-xs',disabled:busy||!dirty,onClick:()=>{setError('');setView(v=>({...v,dirty:false,page:data.page}));setEpoch(n=>n+1);}},'放弃未保存修改'):null,
                editing?h('button',{key:'clear',className:'ll-btn ll-btn-xs',disabled:busy,onClick:()=>{if(window.confirm('清空本页分区重新画框？未覆盖文字会阻止保存。'))setView(v=>({...v,dirty:true,selected:null,page:{...v.page,regions:[]}}));}},'清空本页重画'):null,
              ]),
              h('details',{key:'help',className:'ll-layout-help'},[
                h('summary',{key:'s'},'操作说明与费用'),
                h('p',{key:'p'},'本地规则分区不调用 API；AI 模式分区与翻译分别计费、共用密钥。待确认区不发送给翻译模型，先译其他内容。框号与选择项一致，点框选择并纠错，确认后补译。'),
              ]),
            ]),
          ]),
        ]),
        needsRefresh?h('div',{key:'upgrade',className:'ll-layout-upgrade'},['此稿是旧版识别结果。',h('button',{key:'refresh',className:'ll-btn ll-btn-xs',disabled:busy||dirty,onClick:()=>act('set-media'),title:'更新公式、图注与分区显示，保留原人工框，不调用翻译 API'},'更新识别')]):null,
        ready&&view?.page&&editing?h('div',{key:'selection',className:'ll-layout-selection'},[
          h('select',{key:'region',className:'ll-layout-region-select','aria-label':'选择分区',value:selected?.id||'',onChange:e=>setView(v=>({...v,selected:e.target.value,drawing:false}))},
            [h('option',{key:'none',value:''},'选择分区（'+visibleRegions.length+'）'),...visibleRegions.map(r=>h('option',{key:r.id,value:r.id},regionDisplayLabel(r,regions)))]),
          h('select',{key:'role','aria-label':'分区类型',disabled:!selected,value:selected?.role||'body',onChange:e=>changeRegion({role:e.target.value})},Object.entries(REGION_LABELS).map(([id,label])=>h('option',{key:id,value:id},label))),
          h('button',{key:'draw',className:'ll-btn ll-btn-xs','aria-label':view.drawing?'停止画框':'画新分区','aria-pressed':!!view.drawing,onClick:()=>setView(v=>({...v,drawing:!v.drawing}))},view.drawing?'停止画框':'+ 画框'),
          selected?h('details',{key:'precise',className:'ll-layout-inspector',onToggle:toggleDisclosure},[
            h('summary',{key:'s'},'精确调整'),
            h('div',{key:'panel',className:'ll-layout-menu'},[
              h('strong',{key:'title'},regionDisplayLabel(selected,regions)),
              h('div',{key:'coords',className:'ll-layout-coordinates'},['左','下','右','上'].map((label,i)=>h('label',{key:label},[label,h('input',{type:'number',step:1,value:Math.round(selected.bbox[i]*10)/10,'aria-label':'分区'+label+'边界',onChange:e=>{const box=[...selected.bbox];box[i]=Number(e.target.value);changeRegion({bbox:box});}})]))),
              h('div',{key:'order',className:'ll-layout-row'},[
                ...[-1,1].map(step=>h('button',{key:step,className:'ll-btn ll-btn-xs',onClick:()=>setView(v=>{
                  const a=[...v.page.regions],i=a.findIndex(r=>r.id===v.selected),j=i+step;if(j<0||j>=a.length)return v;
                  [a[i],a[j]]=[a[j],a[i]];return{...v,dirty:true,page:{...v.page,regions:a}};
                })},step<0?'提前':'后移')),
                h('button',{key:'delete',className:'ll-btn ll-btn-xs ll-danger',onClick:()=>setView(v=>({...v,dirty:true,selected:null,page:{...v.page,regions:v.page.regions.filter(r=>r.id!==v.selected)}}))},'删除框'),
              ]),
            ]),
          ]):null,
        ]):ready&&counts?h('div',{key:'counts',className:'ll-layout-counts'},counts):null,
        (error||s?.error||data?.stale)?h('p',{key:'error',role:'alert',className:'ll-layout-error'},error||(data.stale?'PDF 已变化，请重新分区':s.error)):null,
        dirty?h('p',{key:'dirty',className:'ll-layout-unsaved'},'本页有未保存修改。请保存或放弃后再检查其他页。'):null,
        data?.blockingWarnings?.length?h('p',{key:'warnings',className:'ll-layout-error'},'待处理页：'+[...new Set(data.blockingWarnings.map(w=>w.page))].join('、')):null,
      ]);
    }

    function PartitionAIOptions(){
      const [c,setC]=React.useState(null),[message,setMessage]=React.useState(''),[saving,setSaving]=React.useState(false);
      React.useEffect(()=>{let dead=false;fetch(`${ROUTE_PREFIX}/partition-ai-config`).then(r=>r.json()).then(x=>{if(!dead)setC(x);}).catch(e=>setMessage(e.message));return()=>{dead=true;};},[]);
      const field=(name,label,type='text')=>h('label',{key:name},[label,h('input',{value:c[name]??'',type,min:type==='number'?1024:undefined,max:type==='number'?16000:undefined,onChange:e=>setC(x=>({...x,[name]:type==='number'?Number(e.target.value):e.target.value}))})]);
      const prices=(name,title)=>h('fieldset',{key:name},[h('legend',{key:'l'},title),h('label',{key:'currency'},['币种',h('select',{value:c[name]?.currency||'CNY',onChange:e=>setC(x=>({...x,[name]:{...x[name],currency:e.target.value}}))},['CNY','USD','EUR'].map(v=>h('option',{key:v},v)))]),...['inputPerMillion','cacheHitPerMillion','outputPerMillion'].map((f,i)=>h('label',{key:f},[['输入未命中','输入命中','生成（含思考）'][i],h('input',{type:'number',min:0,step:'any',value:c[name]?.[f]??'',onChange:e=>setC(x=>({...x,[name]:{...x[name],[f]:e.target.value===''?null:Number(e.target.value)}}))})]))]);
      return h('details',{className:'ll-ai-options'},[h('summary',{key:'s'},'AI 分区与费用设置（共用翻译密钥）'),c?h('form',{key:'f',onSubmit:async e=>{e.preventDefault();setSaving(true);try{const result=await postJson('/partition-ai-config',{endpoint:c.endpoint,model:c.model,maxTokens:c.maxTokens,semanticThinking:c.semanticThinking,pricing:c.pricing,translationPricing:c.translationPricing,qualityPricing:c.qualityPricing});setC(result);setMessage('已保存，不含密钥；尚未调用 AI。');}catch(e){setMessage(e.message);}finally{setSaving(false);}}},[
        h('p',{key:'h'},'密钥使用原“配置 API”中的同一份，不另存、不显示。分区模型须支持视觉；共享密钥只发送到与翻译服务同源的接口。'),field('endpoint','视觉接口完整地址','url'),field('model','支持视觉的分区模型'),field('maxTokens','每阶段最大生成 token（含思考）','number'),
        h('label',{key:'think'},['语义与跨页思考（官方 DeepSeek）',h('select',{value:c.semanticThinking||'low',onChange:e=>setC(x=>({...x,semanticThinking:e.target.value}))},[['low','低强度'],['high','高强度'],['disabled','关闭思考模式']].map(([v,l])=>h('option',{key:v,value:v},l)))]),
        h('p',{key:'unit'},`以下为每百万 token 单价，未知留空。翻译模型：${c.translationModel||'默认'}；更换模型须核对单价。失败调用也累计，结束后分别汇总，不把未知金额计为零。`),prices('pricing','页面划分单价'),prices('translationPricing','翻译单价'),h('details',{key:'quality'},[h('summary',{key:'s'},'升级模型单价（可选）'),prices('qualityPricing','质量升级模型；未知留空')]),
        h('button',{key:'save',type:'submit',className:'ll-btn',disabled:saving},saving?'保存中…':'保存 AI 与费用设置'),
      ]):h('p',{key:'load'},'读取配置中…'),message?h('p',{key:'m',role:'status'},message):null]);
    }
    function LayoutBatchDialog({ papers, mode, setMode, schedule, media, setMedia, onClose, onSelect, onJob }) {
      const [chosen,setChosen] = React.useState(new Set()), [states,setStates] = React.useState([]), [notice,setNotice] = React.useState(''), [busy,setBusy] = React.useState(false);
      const [engine,setEngine]=React.useState(partitionEngine);
      React.useEffect(() => {
        let dead = false;
        const poll = async () => { try { const r = await fetch(`${ROUTE_PREFIX}/layout`); if (!r.ok) throw new Error('无法读取分区队列'); const d = await r.json(); if (!dead) setStates(d.states || []); } catch (err) { if (!dead) setNotice(err.message); } };
        poll(); const timer = setInterval(poll,2500); return () => { dead = true; clearInterval(timer); };
      }, []);
      const candidates = papers.filter(p => p.source && !p.hidden), bySlug = new Map(states.map(s => [s.slug,s]));
      async function run(action) {
        if (!chosen.size) return;
        if(action==='start'){try{if(!await confirmPartitionAI(mode==='manual'?'local':engine,chosen.size))return;}catch(e){setNotice(e.message);return;}}
        if (action === 'start' && mode === 'auto' && !window.confirm(`自动模式将分区并翻译选中的 ${chosen.size} 篇，产生 API 费用。继续？`)) return;
        if (action === 'approve' && !window.confirm('确认已人工检查所有选中文献的全部页面？此操作不会启动翻译。')) return;
        if (action === 'translate' && !window.confirm('翻译所有选中且已确认的文献，将产生 API 费用。继续？')) return;
        setBusy(true); const errors = []; let count = 0;
        try {
          if (action === 'start') {
            const r = await postJson('/layout',{action,slugs:[...chosen],mode,schedule,media,engine:mode==='manual'?'local':engine,aiConsent:mode!=='manual'&&engine==='ai'});
            count = r.results.filter(x => !x.error).length; errors.push(...r.results.filter(x => x.error).map(x => x.error));
          } else for (const slug of chosen) {
            const s = bySlug.get(slug);
            if (!s || action === 'translate' && s.phase !== 'approved'&&!s.canTranslate) { errors.push(`${slug} 尚未确认或没有可译区域`); continue; }
            try { const r = await postJson('/layout',{action,slug,revision:s.revision,confirmAll:action==='approve',schedule}); if(r.job) onJob(r.job); count++; }
            catch(err) { errors.push(err.message); }
          }
          setNotice(`已处理 ${count} 篇${errors.length ? `；${errors.length} 篇未处理：${errors.slice(0,3).join('；')}` : ''}`);
        } catch(err) { setNotice(err.message); } finally { setBusy(false); }
      }
      return h('div',{className:'ll-modal-bg'},h('div',{className:'ll-modal',role:'dialog','aria-label':'分区与翻译队列'},[
        h('div',{key:'h',className:'ll-modal-head'},['分区与翻译队列',h('span',{className:'ll-spacer',key:'sp'}),h('button',{key:'close',className:'ll-btn ll-btn-xs',onClick:onClose},'关闭')]),
        h('div',{key:'tools',className:'ll-layout-controls'},[
          h('div',{key:'row',className:'ll-layout-row'},[
            h('select',{key:'engine','aria-label':'分区引擎',disabled:mode==='manual',value:mode==='manual'?'local':engine,onChange:e=>{setEngine(e.target.value);try{localStorage.setItem('dsh-literature-library/partition-engine',e.target.value);}catch{}}},[h('option',{key:'local',value:'local'},'本地规则（不收费）'),h('option',{key:'ai',value:'ai'},'AI 三阶段分区')]),
            h('select',{key:'mode',value:mode,'aria-label':'分区模式',onChange:e=>setMode(e.target.value)},[
              h('option',{key:'auto',value:'auto'},'自动：分区自检后翻译'),h('option',{key:'semi',value:'semi'},'半自动：检查后翻译'),h('option',{key:'manual',value:'manual'},'手动：人工分区后翻译')]),
            h('button',{key:'all',className:'ll-btn ll-btn-xs',onClick:()=>setChosen(chosen.size===candidates.length?new Set():new Set(candidates.map(p=>p.slug)))},'全选/取消'),
            ...[['start','分区选中'],['approve','确认已检查选中'],['translate','翻译可用区域']].map(([action,label])=>h('button',{key:action,className:'ll-btn ll-btn-xs',disabled:busy || !chosen.size,onClick:()=>run(action)},label)),
          ]),
          h(MediaOptions,{key:'media',value:media,onChange:setMedia}),
          h('p',{key:'hint',className:'ll-layout-hint'},'图片和表格默认只译题注；公式优先 LaTeX，可选不确定公式原图兜底。插图本身仅本地截图，AI 分区另行调用视觉接口。待确认区先跳过，其他区域可先译；纠错后补译。变更选项保留人工框并重新检查。'),
          notice ? h('p',{key:'notice',role:'status'},notice):null,
        ]),
        h('div',{key:'list',className:'ll-modal-body'},[h(PartitionAIOptions,{key:'ai-options'}),...candidates.map(p=>{
          const s=bySlug.get(p.slug);
          return h('div',{key:p.slug,className:'ll-layout-queue-row'},[
            h('input',{key:'c',type:'checkbox','aria-label':`选择 ${chinesePaperTitle(p)}`,checked:chosen.has(p.slug),onChange:()=>setChosen(old=>{const n=new Set(old);n.has(p.slug)?n.delete(p.slug):n.add(p.slug);return n;})}),
            h('div',{key:'title',className:'ll-layout-queue-title'},[h('strong',{key:'name'},chinesePaperTitle(p)),h('span',{key:'phase'},s?`${LAYOUT_PHASES[s.phase]} · ${s.checkedPages.length}/${s.pageCount} 页${s.pendingCount?' · '+s.pendingCount+' 区待确认':''}${s.error ? ` · ${s.error}` : ''}`:'未分区')]),
            h('button',{key:'open',className:'ll-btn ll-btn-xs',onClick:()=>{onSelect(p.slug);onClose();}},'打开检查'),
          ]);
        })]),
      ]));
    }

    function PdfToolsMenu({children}) {
      const [open,setOpen]=React.useState(false),ref=React.useRef(null);
      React.useEffect(()=>open?readerRuntime.bindMenuDismissal({window,document,element:()=>ref.current,close:()=>setOpen(false)}):undefined,[open]);
      return h('div',{ref,className:'ll-pdf-extras'},[
        h('button',{key:'toggle',className:'ll-btn ll-btn-xs','aria-expanded':open,onClick:()=>setOpen(v=>!v)},'工具'),
        open?h('div',{key:'panel',className:'ll-pdf-extras-panel',role:'group','aria-label':'PDF 查找与打印'},children):null,
      ]);
    }

    const PdfPage = React.memo(function PdfPage({
      doc, pdfjs, pageNumber, width, ratio, onMeasure, registerRef, rootRef,
      searchQuery, searchPage, regionView, setRegionView, eligible,
    }) {
      const wrapRef = React.useRef(null);
      const canvasRef = React.useRef(null);
      const textRef = React.useRef(null);
      const renderTaskRef = React.useRef(null);
      const textTaskRef = React.useRef(null);
      const pageProxyRef = React.useRef(null);
      const [active, setActive] = React.useState(pageNumber === 1);
      const [rendered, setRendered] = React.useState(false);
      const [error, setError] = React.useState(null);
      const [regionViewport, setRegionViewport] = React.useState(null);

      React.useEffect(() => {
        const el = wrapRef.current;
        registerRef(pageNumber, el);
        // 传 expected：换文章时旧组件的 cleanup 不能把新组件的 ref 删掉
        return () => registerRef(pageNumber, null, el);
      }, [pageNumber, registerRef]);

      React.useEffect(() => {
        const el = wrapRef.current;
        if (!el) return undefined;
        if (typeof IntersectionObserver !== 'function') { setActive(true); return undefined; }
        const io = new IntersectionObserver((entries) => {
          const entry = entries[0];
          if (entry) setActive(entry.isIntersecting);
        }, {
          root: rootRef.current,
          // 上下各提前约 2/3 屏：兼顾快速滚动与笔记本内存占用。
          rootMargin: PDF_PRELOAD_MARGIN,
          threshold: 0.01,
        });
        io.observe(el);
        return () => io.disconnect();
      }, [rootRef]);

      React.useEffect(() => {
        if (!active || !eligible || !doc || width <= 0) {
          try { renderTaskRef.current?.cancel(); } catch { /* ignore */ }
          try { textTaskRef.current?.cancel(); } catch { /* ignore */ }
          renderTaskRef.current = null;
          textTaskRef.current = null;
          if (canvasRef.current) {
            canvasRef.current.width = 0;
            canvasRef.current.height = 0;
          }
          textRef.current?.replaceChildren();
          try { pageProxyRef.current?.cleanup?.(); } catch { /* ignore */ }
          pageProxyRef.current = null;
          setRendered(false);
          return undefined;
        }
        let cancelled = false;
        const ticket=PDF_RENDER_QUEUE.schedule(async () => {
          try {
            try { renderTaskRef.current?.cancel(); } catch { /* ignore */ }
            renderTaskRef.current = null;
            const pageObj = await doc.getPage(pageNumber);
            if (cancelled) { try { pageObj.cleanup?.(); } catch { /* ignore */ } return; }
            pageProxyRef.current = pageObj;
            const base = pageObj.getViewport({ scale: 1 });
            const scale = width / base.width;
            const viewport = pageObj.getViewport({ scale });
            setRegionViewport(viewport);
            onMeasure(pageNumber, viewport.height / viewport.width);
            const canvas = canvasRef.current;
            if (!canvas) return;
            const nativeDpr = Math.min(window.devicePixelRatio || 1, 1.5);
            const cssPixels = Math.max(1, viewport.width * viewport.height);
            const budgetScale = Math.sqrt(pdfCanvasPixelBudget() / cssPixels);
            const outputScale = Math.max(0.05, Math.min(nativeDpr, budgetScale));
            canvas.width = Math.max(1, Math.floor(viewport.width * outputScale));
            canvas.height = Math.max(1, Math.floor(viewport.height * outputScale));
            canvas.style.width = `${Math.floor(viewport.width)}px`;
            canvas.style.height = `${Math.floor(viewport.height)}px`;
            const ctx = canvas.getContext('2d', { alpha: false });
            ctx.save();
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.restore();
            const renderTask = pageObj.render({
              canvasContext: ctx,
              viewport,
              transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null,
            });
            renderTaskRef.current = renderTask;
            await renderTask.promise;
            if (renderTaskRef.current === renderTask) renderTaskRef.current = null;
            const textLayer = textRef.current;
            if (textLayer && pdfjs?.TextLayer) {
              try {
                textLayer.replaceChildren();
                textLayer.style.setProperty('--scale-factor', String(scale));
                const textTask = new pdfjs.TextLayer({
                  textContentSource: pageObj.streamTextContent({ includeMarkedContent: true }),
                  container: textLayer,
                  viewport,
                });
                textTaskRef.current = textTask;
                await textTask.render();
                if (textTaskRef.current === textTask) textTaskRef.current = null;
              } catch (textErr) {
                // 没有文字层的扫描件仍应正常显示 canvas；只失去选择与搜索高亮。
                if (textErr?.name !== 'AbortException') console.warn('PDF 文字层渲染失败', textErr);
              }
            }
            if (!cancelled) { setRendered(true); setError(null); }
          } catch (err) {
            if (!cancelled && err?.name !== 'RenderingCancelledException') {
              setError(String(err?.message ?? err));
              setRendered(false);
            }
          }
        },pageNumber);
        ticket.promise.catch(err=>{if(!cancelled&&err.name!=='AbortException')setError(String(err.message||err));});
        return () => {
          cancelled = true;
          ticket.cancel();
          try { renderTaskRef.current?.cancel(); } catch { /* ignore */ }
          try { textTaskRef.current?.cancel(); } catch { /* ignore */ }
        };
      }, [active, eligible, doc, pdfjs, pageNumber, width, onMeasure]);

      React.useEffect(() => () => {
        try { renderTaskRef.current?.cancel(); } catch { /* ignore */ }
        try { textTaskRef.current?.cancel(); } catch { /* ignore */ }
        if (canvasRef.current) { canvasRef.current.width = 0; canvasRef.current.height = 0; }
        textRef.current?.replaceChildren();
        try { pageProxyRef.current?.cleanup?.(); } catch { /* ignore */ }
        pageProxyRef.current = null;
      }, []);

      React.useEffect(() => {
        const layer = textRef.current;
        if (!layer) return;
        const needle = String(searchQuery ?? '').trim().toLocaleLowerCase();
        for (const span of layer.querySelectorAll('span')) {
          span.classList.toggle('ll-pdf-search-hit', pageNumber === searchPage
            && !!needle && span.textContent.toLocaleLowerCase().includes(needle));
        }
      }, [rendered, searchQuery, searchPage, pageNumber]);

      const height = Math.max(24, Math.round(width * (ratio || PDF_PAGE_DEFAULT_RATIO)));
      return h('div', {
        className: 'll-pdf-page',
        'data-pdf-page': pageNumber,
        ref: wrapRef,
        title: error ? `第 ${pageNumber} 页渲染失败：${error}` : `第 ${pageNumber} 页`,
        style: { width: `${Math.round(width)}px`, height: `${height}px` },
      }, [
        h('canvas', { key: 'c', ref: canvasRef, className: 'll-pdf-canvas' }),
        h('div', { key: 't', ref: textRef, className: 'll-pdf-text-layer textLayer' }),
        active && regionView?.page?.page === pageNumber ? h(RegionOverlay, { key:'regions',viewport:regionViewport,view:regionView,setView:setRegionView }) : null,
        !rendered
          ? h('span', { key: 'n', className: 'll-pdf-page-no' },
            error ? `第 ${pageNumber} 页渲染失败` : `第 ${pageNumber} 页`)
          : null,
      ]);
    });

    /**
     * 连续滚动 PDF 阅读器。
     *
     * 所有页先按比例占位，滚动时只渲染视口附近的页；鼠标滚轮/触控板
     * 直接滚 `.ll-pdf-body`，不再需要点「上一页/下一页」。工具条的页码会
     * 随滚动实时更新；输入页码/点翻页按钮则会平滑滚到对应页。
     */
    function PdfViewer({ address, title, switching, documentKey, layoutMode, schedule, media, onJob, openLayout, onLayoutDirty }) {
      const [layoutOpen,setLayoutOpen] = React.useState(!!openLayout);
      const [showRegions,setShowRegions] = React.useState(!!openLayout);
      const [regionView,setRegionView] = React.useState(null);
      React.useEffect(() => {
        const open = () => { setLayoutOpen(true); setShowRegions(true); };
        window.addEventListener('ll-layout-changed',open);
        return () => window.removeEventListener('ll-layout-changed',open);
      },[]);
      React.useEffect(() => {
        onLayoutDirty?.(regionView?.dirty ? documentKey : null);
        const prevent = e => { e.preventDefault(); e.returnValue = ''; };
        if(regionView?.dirty) window.addEventListener('beforeunload',prevent);
        return () => { window.removeEventListener('beforeunload',prevent); onLayoutDirty?.(null); };
      },[regionView?.dirty,documentKey,onLayoutDirty]);
      React.useEffect(() => { if(openLayout) {setLayoutOpen(true);setShowRegions(true);} },[openLayout]);
      const [doc, setDoc] = React.useState(null);
      const [pdfjs, setPdfjs] = React.useState(null);
      const [numPages, setNumPages] = React.useState(0);
      const [page, setPage] = React.useState(1);
      const [zoom, setZoom] = React.useState(1);
      const [phase, setPhase] = React.useState('idle');
      const [error, setError] = React.useState(null);
      const [progress, setProgress] = React.useState(null);
      const [fallback, setFallback] = React.useState(false);
      const [width, setWidth] = React.useState(0);
      const [pageInput, setPageInput] = React.useState('1');
      const [baseRatio, setBaseRatio] = React.useState(PDF_PAGE_DEFAULT_RATIO);
      const [ratios, setRatios] = React.useState({});
      const [searchInput, setSearchInput] = React.useState('');
      const [searchQuery, setSearchQuery] = React.useState('');
      const [searchResults, setSearchResults] = React.useState([]);
      const [searchAt, setSearchAt] = React.useState(-1);
      const [searching, setSearching] = React.useState(false);
      const textCacheRef = React.useRef(new Map());
      const searchGeneration = React.useRef(0);
      const scrollRef = React.useRef(null);
      const pageRefs = React.useRef(new Map());
      const pageRef = React.useRef(1);
      const zoomRef = React.useRef(zoom);
      const restoreRef = React.useRef(null);
      const persistTimerRef = React.useRef(null);

      // 容器宽度（拖动分隔条/窗口缩放都会触发重新适配）
      React.useEffect(() => {
        const el = scrollRef.current;
        if (!el) return undefined;
        let timer = null;
        const update = () => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => setWidth(el.clientWidth), 80);
        };
        update();
        if (typeof ResizeObserver === 'function') {
          const ro = new ResizeObserver(update);
          ro.observe(el);
          return () => { ro.disconnect(); if (timer) clearTimeout(timer); };
        }
        window.addEventListener('resize', update);
        return () => { window.removeEventListener('resize', update); if (timer) clearTimeout(timer); };
      }, []);

      // 换文章：销毁旧文档，加载新文档
      React.useEffect(() => {
        setFallback(false);
        searchGeneration.current++;
        setPdfjs(null);
        const saved = documentKey ? loadReadingMemory().pdfs?.[documentKey] : null;
        const savedPage = Math.max(1, Math.round(Number(saved?.page) || 1));
        const savedZoom = Math.min(3, Math.max(0.4, Number(saved?.zoom) || 1));
        restoreRef.current = saved ? { page: savedPage, offset: Number(saved.offset) || 0 } : null;
        setPage(savedPage);
        setPageInput(String(savedPage));
        setZoom(savedZoom);
        setRatios({});
        setBaseRatio(PDF_PAGE_DEFAULT_RATIO);
        setSearchQuery(''); setSearchResults([]); setSearchAt(-1); setSearching(false);
        textCacheRef.current.clear();
        pageRef.current = savedPage;
        pageRefs.current.clear();
        if (!address) {
          setDoc(null); setNumPages(0); setPhase('idle'); setError(null); setProgress(null);
          return undefined;
        }
        let cancelled = false;
        let task = null;
        let loaded = null;
        setDoc(null); setNumPages(0); setPhase('loading'); setError(null); setProgress(null);
        (async () => {
          try {
            const pdfjs = await loadPdfjs();
            if (cancelled) return;
            task = pdfjs.getDocument({
              url: address,
              cMapUrl: `${PDFJS_BASE}/cmaps/`,
              cMapPacked: true,
              standardFontDataUrl: `${PDFJS_BASE}/standard_fonts/`,
              wasmUrl: `${PDFJS_BASE}/wasm/`,
              iccUrl: `${PDFJS_BASE}/iccs/`,
              rangeChunkSize: 1 << 18,
              disableAutoFetch: true,
              // disableAutoFetch 只有关闭流式整文件下载时才真正生效；否则大型论文
              // 仍会在后台逐步读完整份文件并常驻 worker 内存。
              disableStream: true,
            });
            task.onProgress = (p) => {
              if (!cancelled && p && p.total) setProgress({ loaded: p.loaded, total: p.total });
            };
            loaded = await task.promise;
            if (cancelled) {
              // PDF.js 6 的 PDFDocumentProxy 没有 destroy()，销毁要落在 loadingTask 上
              try { await task.destroy(); } catch { /* ignore */ }
              loaded = null;
              return;
            }
            setDoc(loaded);
            setPdfjs(pdfjs);
            setNumPages(loaded.numPages || 0);
            setPhase('ready');
            setProgress(null);
            requestAnimationFrame(() => {
              if (scrollRef.current && !restoreRef.current) scrollRef.current.scrollTop = 0;
            });
          } catch (err) {
            if (!cancelled) {
              setPhase('error');
              setError(String(err?.message ?? err));
              setProgress(null);
            }
          }
        })();
        return () => {
          cancelled = true;
          searchGeneration.current++;
          // 只有 loadingTask.destroy() 会真正终止 worker + 释放文档；
          // 别调用 doc.destroy()（PDF.js 6 已没有这个方法）。
          try { task?.destroy(); } catch { /* ignore */ }
        };
      }, [address, documentKey]);

      const setCurrentPage = React.useCallback((n) => {
        pageRef.current = n;
        setPage(n);
      }, []);

      const scrollToPage = React.useCallback((target, behavior = 'smooth') => {
        const el = scrollRef.current;
        const node = pageRefs.current.get(target);
        if (!el || !node) return;
        const top = node.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 10;
        el.scrollTo({ top: Math.max(0, top), behavior });
      }, []);

      // 滚动时用「视口上方中心点落在哪一页」判断当前页，比遍历 200 多个 DOM 便宜
      React.useEffect(() => {
        const el = scrollRef.current;
        if (!el) return undefined;
        let raf = 0;
        const update = () => {
          raf = 0;
          const rect = el.getBoundingClientRect();
          const node = document.elementFromPoint(
            rect.left + rect.width / 2,
            rect.top + 24,
          );
          const pageEl = node?.closest?.('[data-pdf-page]');
          if (pageEl) {
            const n = Number(pageEl.getAttribute('data-pdf-page'));
            if (Number.isFinite(n) && n >= 1) {
              if (n !== pageRef.current) setCurrentPage(n);
              if (documentKey) {
                if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
                const offset = Math.min(1, Math.max(0,
                  (el.scrollTop - pageEl.offsetTop) / Math.max(1, pageEl.offsetHeight)));
                persistTimerRef.current = setTimeout(() => {
                  savePdfReadingState(documentKey, { page: n, offset, zoom: zoomRef.current });
                }, 180);
              }
            }
          }
        };
        const onScroll = () => { if (!raf) raf = requestAnimationFrame(update); };
        el.addEventListener('scroll', onScroll, { passive: true });
        update();
        return () => {
          el.removeEventListener('scroll', onScroll);
          if (raf) cancelAnimationFrame(raf);
        };
      }, [doc, numPages, setCurrentPage, documentKey]);

      React.useEffect(() => { setPageInput(String(page)); }, [page]);

      const handleMeasure = React.useCallback((n, ratio) => {
        if (!Number.isFinite(ratio) || ratio <= 0) return;
        if (n === 1) {
          setBaseRatio((prev) => (Math.abs(prev - ratio) < 0.0005 ? prev : ratio));
        }
        setRatios((prev) => {
          const old = prev[n];
          if (old && Math.abs(old - ratio) < 0.0005) return prev;
          return { ...prev, [n]: ratio };
        });
      }, []);

      const registerPage = React.useCallback((n, el, expected) => {
        if (el) pageRefs.current.set(n, el);
        else if (!expected || pageRefs.current.get(n) === expected) pageRefs.current.delete(n);
      }, []);

      const goTo = React.useCallback((n, behavior = 'smooth') => {
        const target = clamp(Math.round(n), 1, numPages || 1);
        setCurrentPage(target);
        scrollToPage(target, behavior);
      }, [numPages, scrollToPage, setCurrentPage]);

      const commitPage = () => {
        const n = Number(pageInput);
        if (!Number.isFinite(n)) { setPageInput(String(page)); return; }
        goTo(n, 'smooth');
      };

      const runSearch = React.useCallback(async (rawQuery) => {
        const generation=++searchGeneration.current;
        const query = String(rawQuery ?? '').trim();
        setSearchQuery(query); setSearchResults([]); setSearchAt(-1);
        if (!doc || !query) return;
        setSearching(true);
        const needle = query.toLocaleLowerCase();
        const found = [];
        try {
          for (let n = 1; n <= doc.numPages; n += 1) {
            if(generation!==searchGeneration.current)return;
            let text = textCacheRef.current.get(n);
            if (text == null) {
              const pageObj = await doc.getPage(n);
              const content = await pageObj.getTextContent();
              text = content.items.map((item) => item.str ?? '').join(' ');
              textCacheRef.current.set(n, text);
              while(textCacheRef.current.size>16)textCacheRef.current.delete(textCacheRef.current.keys().next().value);
              if(Math.abs(n-pageRef.current)>1)pageObj.cleanup();
            }
            if (text.toLocaleLowerCase().includes(needle)) found.push(n);
            await new Promise(resolve=>setTimeout(resolve,0));
          }
          if(generation!==searchGeneration.current)return;
          setSearchResults(found);
          if (found.length > 0) { setSearchAt(0); goTo(found[0]); }
        } catch(err) { if(generation===searchGeneration.current)console.warn('PDF 搜索已中止',err); }
        finally { if(generation===searchGeneration.current)setSearching(false); }
      }, [doc, goTo]);

      const stepSearch = (delta) => {
        if (searchResults.length === 0) { runSearch(searchInput); return; }
        const next = (searchAt + delta + searchResults.length) % searchResults.length;
        setSearchAt(next); goTo(searchResults[next]);
      };

      const printPdf = () => {
        if (!address) return;
        const frame = document.createElement('iframe');
        frame.style.position = 'fixed'; frame.style.width = '1px'; frame.style.height = '1px';
        frame.style.opacity = '0'; frame.style.pointerEvents = 'none'; frame.src = address;
        frame.onload = () => {
          try { frame.contentWindow?.focus(); frame.contentWindow?.print(); } catch { window.open(address, '_blank', 'noopener'); }
          setTimeout(() => frame.remove(), 60000);
        };
        document.body.appendChild(frame);
      };

      // 缩放后停留在当前页，而不是跳回第一页
      React.useEffect(() => {
        if (zoomRef.current === zoom) return undefined;
        zoomRef.current = zoom;
        if (documentKey) {
          const old = loadReadingMemory().pdfs?.[documentKey] ?? {};
          savePdfReadingState(documentKey, { page: pageRef.current, offset: old.offset, zoom });
        }
        const raf = requestAnimationFrame(() => scrollToPage(pageRef.current, 'auto'));
        return () => cancelAnimationFrame(raf);
      }, [zoom, scrollToPage, documentKey]);

      // body 已经去掉左右 padding：100% 时页面正好铺满栏宽，不再有四周黑边
      const pageWidth = width > 0 ? Math.round(Math.max(240, width) * zoom) : 0;
      const pages = React.useMemo(
        () => Array.from({ length: numPages }, (_, i) => i + 1),
        [numPages],
      );

      // 文档与占位尺寸都准备好后，恢复到该文献上次阅读页及页内偏移。
      React.useEffect(() => {
        const saved = restoreRef.current;
        if (!doc || pageWidth <= 0 || !saved) return undefined;
        let raf2 = 0;
        const raf1 = requestAnimationFrame(() => {
          raf2 = requestAnimationFrame(() => {
            const el = scrollRef.current;
            const node = pageRefs.current.get(Math.min(numPages || 1, saved.page));
            if (el && node) {
              el.scrollTop = Math.max(0, node.offsetTop + saved.offset * node.offsetHeight);
              setCurrentPage(Math.min(numPages || 1, saved.page));
              restoreRef.current = null;
            }
          });
        });
        return () => { cancelAnimationFrame(raf1); if (raf2) cancelAnimationFrame(raf2); };
      }, [doc, numPages, pageWidth, setCurrentPage]);

      React.useEffect(() => () => {
        if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
      }, []);

      const toolbar = h('div', { className: 'll-pane-tools ll-pdf-tools' }, [
        h('button',{key:'layout',className:'ll-btn ll-btn-xs','aria-expanded':layoutOpen,onClick:()=>{
          if (regionView?.dirty) { if(!window.confirm('有未保存的分区修改。放弃并关闭？')) return; setRegionView(v=>({...v,dirty:false})); }
          setLayoutOpen(!layoutOpen); if(layoutOpen) setShowRegions(false);
        }},'分区'),
        h('button', {
          key: 'prev', className: 'll-icon-btn', disabled: !doc || page <= 1,
          title: '上一页', 'aria-label': '上一页', onClick: () => goTo(pageRef.current - 1),
        }, '‹'),
        h('input', {
          key: 'page', className: 'll-page-input', type: 'number', min: 1, max: numPages || 1,
          value: pageInput, disabled: !doc, 'aria-label': '页码',
          onChange: (e) => setPageInput(e.target.value),
          onBlur: commitPage,
          onKeyDown: (e) => {
            if (e.key === 'Enter') { e.preventDefault(); commitPage(); e.currentTarget.blur(); }
          },
        }),
        h('span', { key: 'total', className: 'll-pdf-pages' }, `/ ${numPages || '…'}`),
        h('button', {
          key: 'next', className: 'll-icon-btn', disabled: !doc || page >= numPages,
          title: '下一页', 'aria-label': '下一页', onClick: () => goTo(pageRef.current + 1),
        }, '›'),
        h('span', { key: 'sp', className: 'll-spacer' }),
        h(PdfToolsMenu,{key:'extras'},[
        h('input', {
          key: 'search', className: 'll-input ll-pdf-search', value: searchInput,
          disabled: !doc || searching, placeholder: searching ? '搜索中…' : '搜索原文',
          'aria-label': '搜索 PDF 原文',
          onChange: (e) => setSearchInput(e.target.value),
          onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); runSearch(searchInput); } },
        }),
        h('button', { key: 'sf', className: 'll-icon-btn', disabled: !doc || searching, title: '查找', onClick: () => runSearch(searchInput) }, '⌕'),
        h('button', { key: 'sprev', className: 'll-icon-btn', disabled: searchResults.length === 0, title: '上一个匹配', onClick: () => stepSearch(-1) }, '↑'),
        h('button', { key: 'snext', className: 'll-icon-btn', disabled: searchResults.length === 0, title: '下一个匹配', onClick: () => stepSearch(1) }, '↓'),
        h('span', { key: 'sc', className: 'll-pdf-search-count' }, searching ? '…' : (searchQuery ? `${Math.max(0, searchAt + 1)}/${searchResults.length}` : '')),
        h('button', { key: 'print', className: 'll-btn ll-btn-xs', disabled: !doc, title: '打印原文', onClick: printPdf }, '打印'),
        ]),
        h('button', {
          key: 'zo', className: 'll-icon-btn', disabled: !doc, title: '缩小', 'aria-label': '缩小',
          onClick: () => setZoom((z) => Math.max(0.4, Math.round((z - 0.15) * 100) / 100)),
        }, '−'),
        h('span', { key: 'zoom', className: 'll-pdf-zoom', title: '缩放比例' }, `${Math.round(zoom * 100)}%`),
        h('button', {
          key: 'zi', className: 'll-icon-btn', disabled: !doc, title: '放大', 'aria-label': '放大',
          onClick: () => setZoom((z) => Math.min(3, Math.round((z + 0.15) * 100) / 100)),
        }, '+'),
        h('button', {
          key: 'fit', className: 'll-btn ll-btn-xs', disabled: !doc,
          title: '适应宽度（重置缩放）', onClick: () => setZoom(1),
        }, '适应'),
      ]);

      const content = fallback
        ? h('iframe', {
          className: 'll-pdf-fallback', src: pdfViewerUrl(address),
          title: title || '原文 PDF',
        })
        : phase === 'error'
          ? h('div', { className: 'll-status' }, [
            h('strong', { key: 't' }, 'PDF 渲染器加载失败'),
            h('p', { key: 'm' }, h('code', null, error ?? '未知错误')),
            h('p', { key: 'h', className: 'll-hint' }, '可以点右上角「新窗口打开」使用浏览器阅读器，或尝试兼容模式。'),
            h('button', {
              key: 'f', className: 'll-btn', onClick: () => setFallback(true),
            }, '兼容模式（内置阅读器）'),
          ])
          : switching || !address || !doc
            ? h('div', { className: 'll-status' }, switching || !address
              ? '正在准备原文…'
              : (progress
                ? `正在读取 PDF… ${Math.round((progress.loaded / progress.total) * 100)}%`
                : '正在读取 PDF…'))
            : pageWidth <= 0
              ? h('div', { className: 'll-status' }, '正在计算版面…')
              : h('div', {
                className: 'll-pdf-page-list',
                style: { width: `${pageWidth}px` },
              }, pages.map((n) => h(PdfPage, {
                key: n,
                doc,
                pdfjs,
                pageNumber: n,
                width: pageWidth,
                ratio: ratios[n] ?? baseRatio,
                onMeasure: handleMeasure,
                registerRef: registerPage,
                rootRef: scrollRef,
                searchQuery,
                searchPage: searchResults[searchAt],
                eligible: Math.abs(n-page)<=1,
                regionView: showRegions && regionView?.page?.page===n ? regionView : null,
                setRegionView,
              })));

      return h('div', { className: 'll-pdf-viewer' }, [
        toolbar,
        h('div', { className: 'll-pdf-body', ref: scrollRef }, content),
        layoutOpen ? h(LayoutControls,{key:'layout-tools',slug:documentKey,page,mode:layoutMode,schedule,media,view:regionView,setView:setRegionView,
          show:showRegions,setShow:setShowRegions,onJob}) : null,
      ]);
    }

    // ─────────────────── 文件夹浏览器 ───────────────────

    /**
     * 浏览主机目录，选一个「要收进文献库的文件夹」。
     *
     * 目录列举走**本插件 host 半自己的** `/browse` 路由，而不是 DSH 的
     * `remote.directoryPicker.list()`——后者是 Remote 服务，只在右侧栏的 session
     * 作用域下注入，本插件挂在 `main`（根作用域）上拿不到（实测报
     * 「本部署没有 directoryPicker 服务」）。自己实现还能顺带给出盘符列表。
     *
     * 另外提供**直接粘贴路径**的输入框：要收的文件夹常常分散在不同磁盘/盘符，
     * 逐层点进去很费事，粘贴一行路径最快。
     */
    function FolderBrowser({ onClose, onAdd, busy }) {
      const [listing, setListing] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [loading, setLoading] = React.useState(false);
      const [showHidden, setShowHidden] = React.useState(false);
      const [typed, setTyped] = React.useState('');

      const load = React.useCallback(async (path) => {
        setLoading(true); setError(null);
        try {
          const qs = (typeof path === 'string' && path.trim() !== '')
            ? `?path=${encodeURIComponent(path.trim())}`
            : '';
          const res = await fetch(`${ROUTE_PREFIX}/browse${qs}`);
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data?.message ?? `HTTP ${res.status}`);
          setListing(data);
          setTyped(data?.path ?? '');
        } catch (err) {
          setError(String(err?.message ?? err));
        } finally { setLoading(false); }
      }, []);

      React.useEffect(() => {
        // 不传 path → host 给起点（Windows 上是盘符列表）
        load();
      }, [load]);

      const dirs = (listing?.entries ?? []).filter((e) => showHidden || !e.hidden);
      const typedTrim = typed.trim();

      return h('div', { className: 'll-modal-bg', onClick: (e) => { if (e.target === e.currentTarget) onClose(); } },
        h('div', { className: 'll-modal', onClick: (e) => e.stopPropagation() }, [
          h('div', { className: 'll-modal-head', key: 'h' }, [
            h('span', { key: 't' }, '添加文件夹到文献库'),
            h('button', { key: 'x', className: 'll-btn', style: { marginLeft: 'auto' }, onClick: onClose }, '关闭'),
          ]),

          // 直接粘贴路径（跨磁盘时最省事）
          h('div', { className: 'll-modal-goto', key: 'goto' }, [
            h('input', {
              className: 'll-input', value: typed, spellCheck: false,
              placeholder: '直接粘贴文件夹路径，如 E:\\Wego\\科研项目',
              onChange: (e) => setTyped(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter' && typedTrim) load(typedTrim); },
            }),
            h('button', { className: 'll-btn', disabled: loading || !typedTrim, onClick: () => load(typedTrim) }, '前往'),
            h('button', { className: 'll-btn', disabled: loading, title: '回到主目录', onClick: () => load(undefined) }, '主目录'),
          ]),

          h('div', { className: 'll-crumbs', key: 'c' }, (listing?.crumbs ?? []).map((c) =>
            h('button', { key: c.path, className: 'll-crumb', title: c.path, onClick: () => load(c.path) },
              c.name || c.path))),
          h('div', { className: 'll-modal-path', key: 'p' }, [
            h('code', { key: 'c' }, listing?.path ?? '…'),
            h('label', { key: 'h2', className: 'll-hint', style: { marginLeft: 'auto', display: 'flex', gap: '4px', alignItems: 'center' } }, [
              h('input', {
                key: 'i', type: 'checkbox', checked: showHidden,
                onChange: (e) => setShowHidden(e.target.checked),
              }),
              h('span', { key: 's' }, '显示隐藏'),
            ]),
          ]),
          h('div', { className: 'll-modal-body', key: 'b' },
            loading ? h('div', { className: 'll-status' }, '读取中…')
              : error ? h('div', { className: 'll-status' }, ['读取失败：', h('code', null, error)])
                : dirs.length === 0
                  ? h('div', { className: 'll-status' }, '这个目录下没有子文件夹，可以直接点「导入这个文件夹」。')
                  : dirs.map((e) => h('button', {
                    key: e.path, className: 'll-item', style: { paddingLeft: '12px' },
                    onClick: () => load(e.path),
                  }, [
                    h('span', { className: 'll-item-title', key: 'n' }, e.name),
                    h('span', { className: 'll-item-meta', key: 'p' }, e.path),
                  ]))),
          h('div', { className: 'll-modal-foot', key: 'f' }, [
            h('span', { key: 'hint', className: 'll-hint' },
              '会把该文件夹（含所有子文件夹）里的 PDF 复制进 library/papers/，并保留目录结构作为分类。'),
            h('button', {
              key: 'add', className: 'll-btn', disabled: busy || !listing?.path,
              onClick: () => onAdd(listing.path),
            }, busy ? '导入中…' : '导入这个文件夹'),
          ]),
        ]));
    }

    // ─────────────────── 期刊信息编辑器 ───────────────────

    const JCR_OPTIONS = ['', 'Q1', 'Q2', 'Q3', 'Q4'];
    const CAS_OPTIONS = ['', '1区', '2区', '3区', '4区', '1区Top'];

    /**
     * 期刊信息表单。
     * 标题、作者、年份、DOI 与刊名可从译稿/抽取文本识别，并由 Crossref 校准；
     * 影响因子与分区再按校准后的刊名/ISSN 从科研通补全。表单保留作人工复核与修正。
     */
    function JournalEditor({ paper, busy, onSave }) {
      const j0 = paper.journal ?? {};
      const [form, setForm] = React.useState({
        paper: {
          titleZh: paper.titleZh ?? chinesePaperTitle(paper),
          titleEn: paper.titleEn ?? englishPaperTitle(paper) ?? '',
          year: paper.year ?? '',
          authors: paper.authors ?? '',
          category: paper.category ?? '',
          note: paper.note ?? '',
        },
        journal: {
          name: j0.name ?? '',
          abbr: j0.abbr ?? '',
          doi: j0.doi ?? '',
          impactFactor: j0.impactFactor ?? '',
          jcrQuartile: j0.jcrQuartile ?? '',
          casQuartile: j0.casQuartile ?? '',
          isTop: j0.isTop === true,
          issn: j0.issn ?? '',
          publisher: j0.publisher ?? '',
        },
      });

      const setP = (k) => (e) => setForm((f) => ({ ...f, paper: { ...f.paper, [k]: e.target.value } }));
      const setJ = (k) => (e) => setForm((f) => ({ ...f, journal: { ...f.journal, [k]: e.target.value } }));
      const field = (label, k, opts = {}) => h('div', { className: `ll-field${opts.wide ? ' wide' : ''}`, key: k }, [
        h('label', { key: 'l' }, label),
        opts.options
          ? h('select', { value: form.journal[k] ?? '', onChange: setJ(k) },
            opts.options.map((o) => h('option', { key: o, value: o }, o === '' ? '（未填）' : o)))
          : h('input', { value: form.journal[k] ?? '', onChange: setJ(k), spellCheck: false, placeholder: opts.ph ?? '' }),
      ]);

      return h('div', { className: 'll-meta', key: 'meta' }, [
        h('div', { className: 'll-field wide', key: 'titleZh' }, [
          h('label', { key: 'l' }, '中文译题'),
          h('input', { value: form.paper.titleZh, onChange: setP('titleZh'), spellCheck: false }),
        ]),
        h('div', { className: 'll-field wide', key: 'titleEn' }, [
          h('label', { key: 'l' }, '英文原题'),
          h('input', { value: form.paper.titleEn, onChange: setP('titleEn'), spellCheck: false }),
        ]),
        h('div', { className: 'll-field', key: 'year' }, [
          h('label', { key: 'l' }, '年份'),
          h('input', { value: form.paper.year ?? '', onChange: setP('year'), spellCheck: false, placeholder: '如 2005' }),
        ]),
        h('div', { className: 'll-field', key: 'authors' }, [
          h('label', { key: 'l' }, '作者'),
          h('input', { value: form.paper.authors ?? '', onChange: setP('authors'), spellCheck: false, placeholder: '如 Berg R F' }),
        ]),
        h('div', { className: 'll-field', key: 'category' }, [
          h('label', { key: 'l' }, '分类'),
          h('input', { value: form.paper.category ?? '', onChange: setP('category'), spellCheck: false }),
        ]),
        field('期刊名', 'name', { ph: '如 Metrologia' }),
        field('期刊缩写', 'abbr'),
        field('影响因子', 'impactFactor', { ph: '如 2.4' }),
        field('JCR 分区', 'jcrQuartile', { options: JCR_OPTIONS }),
        field('中科院分区', 'casQuartile', { options: CAS_OPTIONS }),
        field('ISSN', 'issn'),
        field('出版商', 'publisher'),
        field('DOI', 'doi', { wide: true, ph: '如 10.1088/0026-1394/42/1/002' }),
        h('div', { className: 'll-field wide', key: 'actions' }, [
          h('label', { key: 'l' }, ' '),
          h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' } }, [
            h('button', {
              key: 'save', className: 'll-btn', disabled: busy,
              onClick: () => onSave({
                paper: {
                  ...form.paper,
                  title: form.paper.titleZh || form.paper.titleEn || paper.title || paper.slug,
                  year: form.paper.year === '' ? null : form.paper.year,
                },
                journal: form.journal,
              }),
            }, busy ? '保存中…' : '保存期刊信息'),
            h('label', { key: 'top', style: { display: 'flex', gap: '4px', alignItems: 'center', fontSize: 'calc(12px * var(--ll-font-scale, 1))', color: 'var(--dsw-alias-label-secondary)' } }, [
              h('input', {
                key: 'c', type: 'checkbox', checked: form.journal.isTop === true,
                onChange: (e) => setForm((f) => ({ ...f, journal: { ...f.journal, isTop: e.target.checked } })),
              }),
              h('span', { key: 's' }, 'Top 期刊'),
            ]),
            h('span', { key: 'h', className: 'll-hint' }, '可先点上方“自动识别并补全”，再在这里复核修改'),
          ]),
        ]),
      ]);
    }

    // ─────────────────── 主面板 ───────────────────

    // ─────────────────── 离线更新对话框 ───────────────────

    /**
     * 更新对话框：GitHub 在线更新 + 本地 .tgz 上传。
     * 两者最终都走 host 的同一套校验/备份/回滚逻辑；离线时只用本地包。
     */
    function UpdateDialog({ onClose }) {
      const [info, setInfo] = React.useState(null);
      const [loading, setLoading] = React.useState(true);
      const [error, setError] = React.useState('');
      const [busy, setBusy] = React.useState('');
      const [file, setFile] = React.useState(null);
      const [done, setDone] = React.useState(null);
      const [github, setGithub] = React.useState(null);
      const [githubBusy, setGithubBusy] = React.useState(false);
      const [githubError, setGithubError] = React.useState('');

      React.useEffect(() => {
        let alive = true;
        (async () => {
          try {
            const res = await fetch(`${ROUTE_PREFIX}/plugin-update`);
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.message || data.error || `HTTP ${res.status}`);
            if (alive) setInfo(data);
          } catch (err) {
            if (alive) setError(String(err?.message ?? err));
          } finally {
            if (alive) setLoading(false);
          }
        })();
        return () => { alive = false; };
      }, []);

      const apply = async (url, options, label) => {
        setBusy(label);
        setError('');
        try {
          const res = await fetch(url, options);
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.message || data.error || `HTTP ${res.status}`);
          setDone(data);
        } catch (err) {
          setError(String(err?.message ?? err));
        } finally {
          setBusy('');
        }
      };

      const applyLocal = (pkg) => apply(
        `${ROUTE_PREFIX}/plugin-update/apply`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ file: pkg.file }),
        },
        pkg.file,
      );

      const upload = () => {
        if (!file) return;
        if (file.size > 32 * 1024 * 1024) {
          setError('更新包超过 32 MB');
          return;
        }
        const q = new URLSearchParams({ name: file.name });
        return apply(
          `${ROUTE_PREFIX}/plugin-update/apply?${q.toString()}`,
          { method: 'POST', headers: { 'content-type': 'application/gzip' }, body: file },
          file.name,
        );
      };

      const checkGithub = async () => {
        setGithubBusy(true);
        setGithubError('');
        try {
          const res = await fetch(`${ROUTE_PREFIX}/plugin-update/github`);
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.message || data.error || `HTTP ${res.status}`);
          setGithub(data);
        } catch (err) {
          setGithubError(String(err?.message ?? err));
        } finally {
          setGithubBusy(false);
        }
      };

      const applyGithub = async () => {
        setBusy('github');
        setError('');
        try {
          const res = await fetch(`${ROUTE_PREFIX}/plugin-update/github`, { method: 'POST' });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.message || data.error || `HTTP ${res.status}`);
          setDone(data);
        } catch (err) {
          setError(String(err?.message ?? err));
        } finally {
          setBusy('');
        }
      };

      const packages = info?.packages ?? [];
      return h('div', {
        className: 'll-modal-bg',
        onClick: (e) => { if (e.target === e.currentTarget) onClose(); },
      }, [
        h('div', { className: 'll-modal ll-modal-sm', onClick: (e) => e.stopPropagation() }, [
          h('div', { className: 'll-modal-head', key: 'h' }, [
            h('span', { key: 't' }, '离线更新插件'),
            h('span', { className: 'll-spacer', key: 's' }),
            h('button', { key: 'x', className: 'll-btn ll-btn-xs', onClick: onClose }, '关闭'),
          ]),
          h('div', { className: 'll-modal-body', key: 'b', style: { padding: '10px 12px' } }, [
            error ? h('div', { className: 'll-banner err', key: 'e' }, error) : null,
            done ? h('div', { className: 'll-banner ll-update-ok', key: 'ok' }, [
              h('b', { key: 'b' }, `已更新到 v${done.to}`),
              h('div', { key: 'd' }, '请完全退出 DSH 后重新启动；只刷新浏览器不会加载新的 host 代码。'),
              h('div', { key: 'p', className: 'll-hint' }, `旧版本备份：${done.backup}`),
            ]) : null,
            loading ? h('div', { className: 'll-hint' }, '正在扫描本地更新包…') : null,
            info ? h('div', { key: 'info' }, [
              h('div', { key: 'cur', className: 'll-cfg-status' }, [
                '当前版本：', h('b', { key: 'v' }, `v${info.current}`),
              ]),
              h('div', { key: 'gh', className: 'll-update-section' }, [
                h('b', { key: 't' }, '从 GitHub 更新'),
                h('div', { key: 'h', className: 'll-hint' }, '需要本机能访问 github.com；失败时请用下面的本地包。'),
                h('div', { key: 'a', className: 'll-update-actions' }, [
                  h('button', {
                    key: 'check', className: 'll-btn ll-btn-xs',
                    disabled: githubBusy || Boolean(busy) || Boolean(done),
                    onClick: checkGithub,
                  }, githubBusy ? '检查中…' : '检查 GitHub 更新'),
                ]),
                githubError ? h('div', { key: 'e', className: 'll-banner err' }, githubError) : null,
                github ? h('div', { key: 'r', className: 'll-update-row' }, [
                  h('div', { key: 'm', className: 'll-update-meta' }, [
                    h('b', { key: 'v' }, `GitHub 最新 v${github.latest}`),
                    github.releaseUrl
                      ? h('a', { key: 'l', className: 'll-hint', href: github.releaseUrl, target: '_blank', rel: 'noreferrer' }, '查看 Release')
                      : null,
                  ]),
                  github.newer ? h('button', {
                    key: 'go', className: 'll-btn ll-btn-xs',
                    disabled: Boolean(busy) || Boolean(done),
                    onClick: applyGithub,
                  }, busy === 'github' ? '更新中…' : `更新到 v${github.latest}`) : h('span', { key: 'ok', className: 'll-hint' }, '已是最新'),
                ]) : null,
              ]),
              h('div', { key: 'local', className: 'll-update-section' }, [
                h('b', { key: 't' }, '从本地更新包'),
                h('div', { key: 'dir', className: 'll-hint ll-update-dir' }, [
                  '本地更新包目录：', h('code', { key: 'c' }, info.updatesDir),
                ]),
                h('div', { key: 'list', className: 'll-update-list' }, packages.length
                  ? packages.map((pkg) => h('div', { key: pkg.file, className: 'll-update-row' }, [
                    h('div', { key: 'm', className: 'll-update-meta' }, [
                      h('b', { key: 'v' }, `v${pkg.version}`),
                      h('span', { key: 'f', className: 'll-hint' }, pkg.file),
                    ]),
                    h('button', {
                      key: 'go', className: 'll-btn ll-btn-xs',
                      disabled: Boolean(busy) || Boolean(done) || !pkg.newer,
                      title: pkg.newer ? `用 ${pkg.file} 覆盖当前插件` : '不是比当前更新的版本',
                      onClick: () => applyLocal(pkg),
                    }, pkg.newer ? (busy === pkg.file ? '更新中…' : '一键更新') : '当前/旧版本'),
                  ]))
                  : h('div', { key: 'none', className: 'll-hint' }, '没有发现本地 .tgz。可以在下面选择文件，或把文件放进上面的目录。')),
              ]),
            ]) : null,
            !done ? h('div', { key: 'up', className: 'll-update-actions' }, [
              h('input', {
                key: 'f', className: 'll-update-file', type: 'file',
                accept: '.tgz,.tar.gz,application/gzip',
                disabled: Boolean(busy),
                onChange: (e) => setFile(e.target.files?.[0] ?? null),
              }),
              h('button', {
                key: 'u', className: 'll-btn ll-btn-xs',
                disabled: !file || Boolean(busy),
                onClick: upload,
              }, busy && busy === file?.name ? '更新中…' : '上传并更新'),
            ]) : null,
            h('div', { key: 'hint', className: 'll-hint', style: { marginTop: '10px' } },
              'GitHub 更新和本地包走同一套校验：更新前自动备份，失败回滚；只覆盖程序文件，不会删除 library/。'),
          ]),
          h('div', { className: 'll-modal-foot', key: 'f' }, [
            h('span', { key: 's', className: 'll-hint' }, '更新完成后请重启 DSH'),
            h('span', { key: 'sp', className: 'll-spacer' }),
            h('button', { key: 'c', className: 'll-btn', onClick: onClose }, done ? '关闭' : '取消'),
          ]),
        ]),
      ]);
    }

    function LiteraturePanel({ remote }) {
      const [layout, setLayout] = React.useState(loadLayout);
      const [fontPercent, setFontPercent] = React.useState(loadFontPercent);
      const updateFontPercent = React.useCallback((value) => {
        setFontPercent((current) => saveFontPercent(typeof value === 'function' ? value(current) : value));
      }, []);
      const containerRef = React.useRef(null);
      const dragRef = React.useRef(null);
      const initialReadingRef = React.useRef(loadReadingMemory());
      const initialSlug = initialReadingRef.current.lastSlug;
      const initialPaper = latestLibraryIndex?.papers?.find((paper) => paper.slug === initialSlug) ?? null;
      const initialCachedDoc = cachedLatestMarkdown(initialPaper);
      const markdownPaneRef = React.useRef(null);
      const markdownReadingRef = React.useRef({ slug: initialSlug, mode: 'preview', ready: false });
      const markdownSaveTimerRef = React.useRef(null);

      const [state, setState] = React.useState({
        phase: latestLibraryIndex ? 'ready' : 'loading',
        index: latestLibraryIndex,
        error: null,
        selected: initialSlug,
      });
      const [katex, setKatex] = React.useState(() => window.katex ?? null);
      // doc.slug 记录「这份译文属于哪篇」，避免切换瞬间把上一篇的内容显示到新标题下
      const [doc, setDoc] = React.useState(initialCachedDoc
        ? { phase: 'ready', slug: initialCachedDoc.slug, translated: initialCachedDoc.translated, error: null }
        : { phase: 'idle', slug: initialSlug, translated: null, error: null });
      const [scanDir, setScanDir] = React.useState('library/papers');
      const [layoutBatchOpen,setLayoutBatchOpen] = React.useState(false);
      const [toolsTab,setToolsTab] = React.useState(null);
      const [navOpen,setNavOpen] = React.useState(false);
      const [compact,setCompact] = React.useState(()=>window.innerWidth<700);
      const [readerSurface,setReaderSurface] = React.useState(()=>window.innerWidth<1000?'translation':'split');
      React.useEffect(()=>{
        const resize=()=>{const width=containerRef.current?.clientWidth||window.innerWidth;
          if(width<1000)setReaderSurface(v=>v==='split'?'translation':v);
          setCompact(width<700);
        };
        const observer=new ResizeObserver(resize);if(containerRef.current)observer.observe(containerRef.current);resize();
        window.addEventListener('resize',resize);return()=>{observer.disconnect();window.removeEventListener('resize',resize);};
      },[]);
      const [layoutOpenSlug,setLayoutOpenSlug] = React.useState(null);
      const layoutDirtyRef = React.useRef(null);
      const recordLayoutDirty = React.useCallback(slug => {layoutDirtyRef.current=slug;},[]);
      const [layoutMode,changeLayoutMode] = React.useState(() => {
        try { const m=localStorage.getItem('dsh-literature-library/layout-mode'); return ['auto','semi','manual'].includes(m)?m:'semi'; } catch {return 'semi';}
      });
      const setLayoutMode = m => { changeLayoutMode(m); try {localStorage.setItem('dsh-literature-library/layout-mode',m);} catch {} };
      const [media,setMediaState]=React.useState(()=>{try{const v=JSON.parse(localStorage.getItem('dsh-literature-library/media-v1')||'{}');return {figures:v.figures===true,tables:v.tables===true,formulaFallback:v.formulaFallback!==false};}catch{return {figures:false,tables:false,formulaFallback:true};}});
      const setMedia=value=>{setMediaState(value);try{localStorage.setItem('dsh-literature-library/media-v1',JSON.stringify(value));}catch{}};
      const [selectedFolder, setSelectedFolder] = React.useState(null);
      const [busy, setBusy] = React.useState(null);
      const [notice, setNotice] = React.useState(null);
      const [tick, setTick] = React.useState(0);

      // 译文编辑器状态
      const [text, setText] = React.useState('');
      const [mode, setMode] = React.useState('preview');   // preview | source | edit
      const [dirty, setDirty] = React.useState(false);
      const [copied, setCopied] = React.useState(false);

      // 期刊信息编辑器
      const [metaOpen, setMetaOpen] = React.useState(false);
      const [detailsOpen, setDetailsOpen] = React.useState(false);
      const [focusMode, setFocusMode] = React.useState(false);
      // 文件夹浏览器
      const [browserOpen, setBrowserOpen] = React.useState(false);
      // 折叠的文件夹路径 + 是否显示隐藏文献 + 搜索词
      const [collapsed, setCollapsed] = React.useState(loadCollapsed);
      const [showHidden, setShowHidden] = React.useState(false);
      const [query, setQuery] = React.useState('');
      const searchRef = React.useRef(null);
      // 右键菜单 { x, y, kind: 'paper'|'folder', ... }
      const [menu, setMenu] = React.useState(null);
      const closeMenu=React.useCallback(()=>setMenu(null),[]);
      // 翻译进度（旧的 agent 会话路径，保留兼容）
      const [progress, setProgress] = React.useState({});
      // 直连 DeepSeek API 的翻译任务与配置
      const [jobs, setJobs] = React.useState([]);
      const [startingJob, setStartingJob] = React.useState(null);
      const [jobHistory, setJobHistory] = React.useState(loadTranslationUsage);
      const [offpeakOnly, setOffpeakOnly] = React.useState(loadOffpeakOnly);
      const [jobPollEpoch, setJobPollEpoch] = React.useState(0);
      const [batchState, setBatchState] = React.useState({
        phase: 'idle', current: 0, total: 0, completed: 0, failed: 0, title: '',
      });
      const batchCancelRef = React.useRef(false);
      const notifiedDone = React.useRef(new Set());
      const [apiConfig, setApiConfig] = React.useState(null);
      const [configOpen, setConfigOpen] = React.useState(false);
      const [updateOpen, setUpdateOpen] = React.useState(false);
      React.useEffect(()=>{setMenu(null);},[state.selected,focusMode,configOpen,updateOpen,browserOpen,layoutBatchOpen,toolsTab]);
      React.useEffect(()=>{setNavOpen(false);},[state.selected]);
      // 插件版本（由 host 的 /version 从 package.json 读取）
      const [versionInfo, setVersionInfo] = React.useState(null);
      // 跟随 DSH 的真实主题（body[data-ds-dark-theme]），而不是系统偏好
      const [themeMode, setThemeMode] = React.useState(readHostTheme);
      React.useEffect(() => {
        const update = () => setThemeMode(readHostTheme());
        update();
        const body = document.body;
        const observer = typeof MutationObserver === 'function' && body
          ? new MutationObserver(update)
          : null;
        observer?.observe(body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] });
        const media = typeof window !== 'undefined' && window.matchMedia
          ? window.matchMedia('(prefers-color-scheme: dark)')
          : null;
        media?.addEventListener?.('change', update);
        return () => {
          observer?.disconnect();
          media?.removeEventListener?.('change', update);
        };
      }, []);

      /**
       * 把已结束任务的关键指标留在 localStorage 里。
       * host 重启后内存任务表会清空，但用户仍应能在条目下看到上一次性价记录。
       */
      function rememberFinishedJobs(incoming) {
        const finished = (incoming ?? []).filter((j) => ['done','partial','failed'].includes(j.phase));
        if (finished.length === 0) return;
        setJobHistory((previous) => {
          const next = { ...previous };
          for (const job of finished) {
            if (!job?.slug) continue;
            next[job.slug] = { ...job, savedAt: new Date().toISOString() };
          }
          return next;
        });
      }

      function replaceJobs(incoming) {
        setJobs(incoming ?? []);
        rememberFinishedJobs(incoming);
      }

      function upsertJob(incoming) {
        if (!incoming?.jobId) return;
        setJobs((previous) => {
          const rest = previous.filter((j) => j.jobId !== incoming.jobId);
          return [incoming, ...rest].sort((a, b) => (
            String(b.startedAt ?? b.updatedAt ?? '').localeCompare(String(a.startedAt ?? a.updatedAt ?? ''))
          ));
        });
        if (['done','partial','failed'].includes(incoming.phase)) {
          rememberFinishedJobs([incoming]);
        }
      }

      // 用量历史变化即落盘：重启 host / 卸下面板后仍能看到上一次的费用
      React.useEffect(() => { saveTranslationUsage(jobHistory); }, [jobHistory]);

      const persistCurrentMarkdown = React.useCallback((slug, readingMode) => {
        const current = markdownReadingRef.current;
        const targetSlug = slug ?? current.slug;
        const targetMode = readingMode ?? current.mode;
        if (!targetSlug || !current.ready) return;
        if (markdownSaveTimerRef.current) {
          clearTimeout(markdownSaveTimerRef.current);
          markdownSaveTimerRef.current = null;
        }
        const position = captureMarkdownPosition(markdownPaneRef.current, targetMode);
        if (position) saveMarkdownReadingState(targetSlug, targetMode, position);
      }, []);

      const selectPaper = React.useCallback((slug) => {
        if (!slug) return;
        if(layoutDirtyRef.current && layoutDirtyRef.current !== slug
          && !window.confirm('当前文献有未保存的分区修改。放弃修改并切换文献？')) return false;
        // 点击发生时旧文章的 DOM 仍在，先同步落盘，避免切换占位页覆盖精确位置。
        persistCurrentMarkdown();
        setState((s) => ({ ...s, selected: slug }));
      }, [persistCurrentMarkdown]);

      const toggleCollapse = React.useCallback((path) => {
        setCollapsed((prev) => {
          const next = new Set(prev);
          if (next.has(path)) next.delete(path); else next.add(path);
          saveCollapsed(next);
          return next;
        });
      }, []);

      React.useEffect(() => {
        try { window.localStorage.setItem(LS_KEY, JSON.stringify(layout)); } catch { /* 忽略 */ }
      }, [layout]);

      React.useEffect(() => {
        try { window.localStorage.setItem(FONT_PERCENT_KEY, String(fontPercent)); } catch { /* 忽略 */ }
      }, [fontPercent]);

      React.useEffect(() => {
        try { window.localStorage.setItem(OFFPEAK_ONLY_KEY, offpeakOnly ? '1' : '0'); } catch { /* 忽略 */ }
      }, [offpeakOnly]);

      // 面板卸载时停止继续提交批量队列（已提交的后台任务不受影响）
      React.useEffect(() => () => { batchCancelRef.current = true; }, []);

      // Ctrl/Cmd + 放大，Ctrl/Cmd - 缩小，Ctrl/Cmd 0 复位。
      // 用 capture 抢在浏览器页面缩放/DSH 全局快捷键之前处理。
      React.useEffect(() => {
        const onKey = (e) => {
          const action=readerRuntime.readingZoomShortcut(e,containerRef.current);if(!action)return;
          e.preventDefault();e.stopPropagation();
          if(action.delta!==null)updateFontPercent(p=>action.delta===0?100:p+action.delta);
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
      }, [updateFontPercent]);

      // 索引
      React.useEffect(() => {
        const ac = new AbortController();
        loadKatex().then((k) => { if (!ac.signal.aborted) setKatex(k); });
        (async () => {
          try {
            const index = await fetchIndex(ac.signal);
            latestLibraryIndex = index;
            setState((s) => ({
              phase: 'ready', index, error: null,
              selected: s.selected && index.papers?.some((p) => p.slug === s.selected)
                ? s.selected
                : (() => {
                  const remembered = loadReadingMemory().lastSlug;
                  return index.papers?.some((p) => p.slug === remembered)
                    ? remembered : (index.papers?.[0]?.slug ?? null);
                })(),
            }));
          } catch (err) {
            if (!latestLibraryIndex) {
              setState({ phase: 'error', index: null, error: String(err?.message ?? err), selected: null });
            }
          }
        })();
        return () => ac.abort();
      }, [tick]);

      const papers = state.index?.papers ?? [];
      const selected = papers.find((p) => p.slug === state.selected) ?? null;

      React.useEffect(() => {
        if (!state.selected) return;
        updateReadingMemory((memory) => ({ ...memory, lastSlug: state.selected }));
      }, [state.selected]);

      /*
       * 选中项立刻更新（侧栏高亮/标题不等加载），但**内容**等停稳后再换：
       *   - 译文 120ms：足够快，又能在快速连点时跳过中间文献；
       *   - PDF 400ms：浏览器内置阅读器最贵，晚一点加载，旧 iframe 先卸载。
       * 这样连点 10 篇不会产生 10 次 PDF 下载 + 10 个阅读器实例。
       */
      const activeSlug = useDebouncedValue(state.selected, CONTENT_SETTLE_MS);
      const pdfSlug = useDebouncedValue(state.selected, PDF_SETTLE_MS);
      const activePaper = papers.find((p) => p.slug === activeSlug) ?? null;
      const pdfPaper = papers.find((p) => p.slug === pdfSlug) ?? null;
      const contentSwitching = Boolean(selected && selected.slug !== activeSlug);
      const pdfSwitching = Boolean(selected && selected.slug !== pdfSlug);

      // 译文
      React.useEffect(() => {
        const slug = activePaper?.slug ?? null;
        if (!activePaper?.translation) {
          setDoc({ phase: 'idle', slug, translated: null, error: null });
          return undefined;
        }
        const cached = cachedLatestMarkdown(activePaper);
        if (cached) {
          setDoc({ phase: 'ready', slug, translated: cached.translated, error: null });
          return undefined;
        }
        const ac = new AbortController();
        setDoc({ phase: 'loading', slug, translated: null, error: null });
        (async () => {
          try {
            const text = await fetchText(activePaper.translation, ac.signal);
            if (!ac.signal.aborted) {
              rememberLatestMarkdown(activePaper, text);
              setDoc({ phase: 'ready', slug, translated: text, error: null });
            }
          } catch (err) {
            if (!ac.signal.aborted) setDoc({ phase: 'error', slug, translated: null, error: String(err?.message ?? err) });
          }
        })();
        return () => ac.abort();
      }, [activePaper?.slug, activePaper?.translation, tick]);

      // 切换期间传 null：PdfViewer 会立刻销毁旧文档，不再创建新的 PDF 阅读器
      const pdfAddress = selected && !pdfSwitching && pdfPaper?.source
        ? fileUrl(pdfPaper.source) : null;
      // 「新窗口打开」仍交给浏览器内置阅读器（搜索/打印/选中文本时更好用）
      const pdfOpenUrl = selected?.source ? pdfViewerUrl(fileUrl(selected.source)) : null;

      const docBelongsToActive = doc.slug === activeSlug;
      // 连 idle 也要判断归属：否则刚切到新文献、effect 还没把它置为 loading 的那一帧，
      // 会把「这篇还没有译文」错误地闪一下。
      const docStale = !docBelongsToActive;
      const docReady = doc.phase === 'ready' && docBelongsToActive && !contentSwitching;

      /*
       * 预览/字数用「已加载完成的译文」，而不是编辑器里的 text。
       * doc 刚变 ready 时 text 还要等一个 effect 才同步；用 text 会闪一帧空白，
       * 也可能把上一篇的 text 短暂算进新文章。dirty 时才以编辑器内容为准。
       */
      const displayText = docReady ? (dirty ? text : (doc.translated ?? '')) : '';

      // 预览 HTML 只在「停稳 + 预览模式」时计算；切回看过的文章直接命中缓存。
      const previewHtml = React.useMemo(
        () => (docReady && mode === 'preview' && activeSlug
          ? renderMarkdownCached(activeSlug, displayText, katex)
          : ''),
        [docReady, mode, activeSlug, displayText, katex],
      );

      // 译文载入完成后同步到编辑器；换文献时重置编辑状态
      React.useEffect(() => {
        if (doc.phase === 'ready') { setText(doc.translated ?? ''); setDirty(false); setCopied(false); }
        else { setText(''); setDirty(false); setCopied(false); }
      }, [doc.phase, doc.translated]);
      React.useEffect(() => {
        const rememberedMode = loadReadingMemory().markdowns?.[selected?.slug]?.mode;
        setMode(['preview', 'source', 'edit'].includes(rememberedMode) ? rememberedMode : 'preview');
        setMetaOpen(false);
        setDetailsOpen(false);
      }, [selected?.slug]);

      // Markdown 阅读位置：预览用“可见块 + 块内偏移”精确定位，源码/编辑模式保存自身滚动条。
      React.useEffect(() => {
        markdownReadingRef.current = { slug: activeSlug, mode, ready: docReady };
        if (!activeSlug || !docReady || !markdownPaneRef.current) return undefined;

        const root = markdownPaneRef.current;
        const scroller = markdownScrollElement(root, mode);
        if (!scroller) return undefined;
        const saved = markdownReadingState(activeSlug, mode);
        let innerFrame = null;
        const outerFrame = requestAnimationFrame(() => {
          innerFrame = requestAnimationFrame(() => restoreMarkdownPosition(root, mode, saved));
        });

        const onScroll = () => {
          if (markdownSaveTimerRef.current) clearTimeout(markdownSaveTimerRef.current);
          markdownSaveTimerRef.current = setTimeout(() => {
            persistCurrentMarkdown(activeSlug, mode);
          }, 160);
        };
        scroller.addEventListener('scroll', onScroll, { passive: true });
        return () => {
          cancelAnimationFrame(outerFrame);
          if (innerFrame !== null) cancelAnimationFrame(innerFrame);
          scroller.removeEventListener('scroll', onScroll);
          if (markdownSaveTimerRef.current) {
            clearTimeout(markdownSaveTimerRef.current);
            markdownSaveTimerRef.current = null;
          }
          const position = captureMarkdownPosition(root, mode);
          if (position) saveMarkdownReadingState(activeSlug, mode, position);
        };
      }, [activeSlug, docReady, mode, katex, persistCurrentMarkdown]);

      React.useEffect(() => {
        const flush = () => persistCurrentMarkdown();
        window.addEventListener('pagehide', flush);
        window.addEventListener('beforeunload', flush);
        return () => {
          flush();
          window.removeEventListener('pagehide', flush);
          window.removeEventListener('beforeunload', flush);
        };
      }, [persistCurrentMarkdown]);

      // 拖动
      const width = () => containerRef.current?.getBoundingClientRect().width ?? 1000;
      const startDrag = (kind) => (startX) => { dragRef.current = { kind, startX, base: layout, w: width() }; };
      const moveDrag = (x) => {
        const d = dragRef.current;
        if (!d) return;
        const delta = ((x - d.startX) / d.w) * 100;
        if (d.kind === 'nav') setLayout((l) => ({ ...l, navPct: clamp(d.base.navPct + delta, 12, 45) }));
        else setLayout((l) => ({ ...l, trPct: clamp(d.base.trPct + delta, 20, 80) }));
      };
      const endDrag = () => { dragRef.current = null; };

      /** 保存译文：带上加载时的原始内容做乐观并发校验 */
      async function doSave() {
        if (!selected) return;
        setBusy('save'); setNotice(null);
        try {
          const r = await postJson('/save', {
            slug: selected.slug,
            content: text,
            baseContent: doc.translated ?? '',
          });
          setDoc((d) => ({ ...d, translated: text }));
          rememberLatestMarkdown(selected, text);
          setDirty(false);
          setNotice({ kind: 'ok', text: `已保存译稿（${r.bytes} 字节）→ ${r.path}` });
        } catch (err) {
          setNotice({ kind: 'err', text: `保存失败：${err.message}` });
        } finally { setBusy(null); }
      }

      async function doCopy() {
        try {
          await navigator.clipboard.writeText(dirty ? text : (doc.translated ?? text));
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // 剪贴板 API 可能被权限策略拒绝：退回选区复制
          setMode('source');
          setNotice({ kind: 'err', text: '浏览器拒绝了剪贴板访问，已切到源码模式，请手动全选复制。' });
        }
      }

      /** 把一个外部文件夹导入文献库 */
      async function doAddFolder(dir) {
        setBusy('addfolder'); setNotice(null);
        try {
          const r = await postJson('/add-folder', { dir });
          setNotice({
            kind: 'ok',
            text: `已从「${r.group}」导入 ${r.copied} 个 PDF（新增 ${r.added.length} 篇`
              + (r.skipped?.length ? `，跳过 ${r.skipped.length} 篇` : '') + `）→ ${r.dest}`,
          });
          setBrowserOpen(false);
          if (r.added.length) setTick((t) => t + 1);
        } catch (err) {
          setNotice({ kind: 'err', text: `导入失败：${err.message}` });
        } finally { setBusy(null); }
      }

      /** 保存期刊信息 / 元数据 */      async function doSaveMeta(form) {
        if (!selected) return;
        setBusy('meta'); setNotice(null);
        try {
          const r = await postJson('/update', {
            slug: selected.slug,
            paper: form.paper,
            journal: form.journal,
          });
          setNotice({ kind: 'ok', text: `已更新 ${r.changed.length} 个字段` });
          setMetaOpen(false);
          setTick((t) => t + 1);   // 重新拉索引，界面上的标签/芯片随之更新
        } catch (err) {
          setNotice({ kind: 'err', text: `更新失败：${err.message}` });
        } finally { setBusy(null); }
      }

      async function doScan() {
        setBusy('scan'); setNotice(null);
        try {
          const r = await postJson('/scan', { dir: scanDir });
          setNotice({
            kind: 'ok',
            text: `扫描 ${r.scanned} 个 PDF，新增 ${r.added.length} 篇`
              + (r.skipped?.length ? `，已存在跳过 ${r.skipped.length} 篇` : ''),
          });
          if (r.added.length) setTick((t) => t + 1);
        } catch (err) {
          setNotice({ kind: 'err', text: `扫描失败：${err.message}` });
        } finally { setBusy(null); }
      }

      async function doScanFolder() {
        if (!selectedFolder) return;
        setBusy('scan-folder'); setNotice(null);
        try {
          const r = await postJson('/scan-source', { folder: selectedFolder });
          setNotice({
            kind: 'ok',
            text: `扫描「${selectedFolder}」的原始文件夹：${r.scanned} 个 PDF，新增 ${r.added.length} 篇`
              + (r.copied ? `，复制 ${r.copied} 个新文件` : '')
              + (r.skipped?.length ? `，已存在跳过 ${r.skipped.length} 篇` : ''),
          });
          if (r.added.length) setTick((t) => t + 1);
        } catch (err) {
          setNotice({ kind: 'err', text: `扫描失败：${err.message}` });
        } finally { setBusy(null); }
      }

      /**
       * 开始翻译（直连 DeepSeek API）。
       *
       * 走 `/translate-job`：它**立即返回** jobId，真正的翻译在 host 后台跑，
       * 进度由下面的轮询读取。这比旧的「创建 agent 会话 + 投递提示词」
       * 路径可控得多——那条路径实测提示词根本进不去。
       */
      async function doTranslate(p) {
        if(selectPaper(p.slug) === false) return;
        setLayoutOpenSlug(p.slug);
        if (layoutMode === 'auto' && !window.confirm('自动模式：本地分区、自检通过后会付费翻译。继续？')) return;
        setBusy(p.slug);
        try {
          const engine=layoutMode==='manual'?'local':partitionEngine();if(!await confirmPartitionAI(engine))return;
          const r = await postJson('/layout',{action:'start',slug:p.slug,mode:layoutMode,media,schedule:offpeakOnly?'offpeak':'now',engine,aiConsent:engine==='ai'});
          if(r.results?.[0]?.error) throw new Error(r.results[0].error);
          window.dispatchEvent(new Event('ll-layout-changed'));
          setNotice({kind:'ok',text:'已打开 PDF 分区工具。半自动/手动模式检查确认后，点击「按确认分区翻译」。已有分区不会被覆盖。'});
        } catch(err) { setNotice({kind:'err',text:err.message}); }
        finally { setBusy(null); }
      }

      async function doStartNow(job) {
        setStartingJob(job.jobId);
        try {
          const updated = await postJson('/translate-job', { action: 'start-now', jobId: job.jobId });
          upsertJob(updated);
          setJobPollEpoch((value) => value + 1);
          setNotice({ kind: 'ok', text: `《${updated.title}》已取消闲时限制，按当前时段价格翻译；若有其他任务正在执行，将等待空位。` });
        } catch (err) {
          setNotice({ kind: 'err', text: `切换立即翻译失败：${err.message ?? err}` });
        } finally { setStartingJob(null); }
      }

      /** 重新拉一次任务列表（翻译完成后刷新索引，标签才会变成「已翻译」） */
      async function refreshJobs() {
        try {
          const res = await fetch(`${ROUTE_PREFIX}/translate-job`);
          if (!res.ok) return;
          const data = await res.json();
          const incoming = data.jobs ?? [];
          setJobs(incoming);
          rememberFinishedJobs(incoming);
          // 有任务刚从 running 变成 done → 重新拉索引，让「已翻译」标签与译文出现
          const doneJob = incoming.find((j) => ['done','partial'].includes(j.phase));
          if (doneJob && doneJob.finishedAt && !notifiedDone.current.has(doneJob.jobId)) {
            notifiedDone.current.add(doneJob.jobId);
            setTick((t) => t + 1);
          }
        } catch { /* 网络抖动忽略 */ }
      }

      /** 隐藏 / 取消隐藏 / 删除（文献或整个文件夹） */
      async function doMutate(body, okText) {
        setBusy('mutate'); setNotice(null);
        try {
          const r = await postJson('/mutate', body);
          const n = (r.affected ?? r.removed ?? []).length;
          const trashed = r.trashed?.filter((t) => t.to).length ?? 0;
          setNotice({
            kind: 'ok',
            text: `${okText}${n > 1 ? `（${n} 篇）` : ''}`
              + (trashed ? `，${trashed} 个 PDF 已移入 library/trash/` : ''),
          });
          setTick((t) => t + 1);   // 重新拉索引，树的显示随之更新
        } catch (err) {
          setNotice({ kind: 'err', text: `操作失败：${err.message}` });
        } finally { setBusy(null); }
      }

      /**
       * 手动排序 / 置顶。
       *
       * 排序不在客户端自己保存：把「该文件夹的新顺序」整体交给 `/reorder`，
       * host 写进 `library.json` 后刷新索引。这样刷新/重启/换机器后顺序都还在，
       * 而且比较器只有客户端一份（host 只按提交的数组编号）。
       */
      async function doArrange(body) {
        if (busy !== null) return;
        // 排序是高频轻量操作：成功时不弹提示条（避免每点一下都挤动布局），
        // 只有失败才把原因显示出来。
        setBusy('arrange');
        try {
          await postJson('/reorder', body);
          setTick((t) => t + 1);   // 重新拉索引，顺序/置顶标记随之更新
        } catch (err) {
          setNotice({ kind: 'err', text: `调整失败：${err.message}` });
        } finally { setBusy(null); }
      }

      /**
       * 拉取翻译进度。
       *
       * 数据源是 host 侧读的会话日志（多轮取事件数与阶段），所以：
       *   - 能反映「提示词到底有没有被接受」（`queued` = 只有会话头）；
       *   - 重启后仍然有效。
       * 有进行中的会话时每 3 秒轮询一次；全部结束就停下，避免无谓请求。
       */
      const sessionIds = React.useMemo(
        () => [...new Set(papers.map((p) => p.translateSession).filter(Boolean))],
        [papers],
      );

      // 已通知过完成的任务，避免重复刷新索引（声明在面板状态区，供 refreshJobs 使用）

      /**
       * 直连翻译任务的轮询。
       *
       * 只在「有任务在跑」时轮询，全部结束就停——避免无意义的请求。
       * 任务完成后自动重拉索引，界面上的「已翻译」标签与译文随之更新，
       * 用户不需要手动刷新。
       */
      React.useEffect(() => {
        let cancelled = false;
        let timer = null;

        const tickFn = async () => {
          if (cancelled) return;
          await refreshJobs();
          // 读最新状态决定是否继续
          try {
            const res = await fetch(`${ROUTE_PREFIX}/translate-job`);
            const data = res.ok ? await res.json() : { jobs: [] };
            if (cancelled) return;
            const live = (data.jobs ?? []).some((j) => j.phase === 'running' || j.phase === 'queued');
            if (live) timer = setTimeout(tickFn, 2500);
          } catch { /* 忽略 */ }
        };

        // 进入面板先拉一次（可能有上次没看完的任务）
        (async () => {
          await refreshJobs();
          try {
            const res = await fetch(`${ROUTE_PREFIX}/translate-job`);
            const data = res.ok ? await res.json() : { jobs: [] };
            if (!cancelled && (data.jobs ?? []).some((j) => j.phase === 'running' || j.phase === 'queued')) {
              timer = setTimeout(tickFn, 2500);
            }
          } catch { /* 忽略 */ }
        })();

        return () => { cancelled = true; if (timer) clearTimeout(timer); };
      }, [jobPollEpoch]);

      // 查一次 API 配置，顶部显示「直连翻译是否就绪」
      React.useEffect(() => {
        let cancelled = false;
        (async () => {
          try {
            const res = await fetch(`${ROUTE_PREFIX}/translate-config`);
            const data = res.ok ? await res.json() : null;
            if (!cancelled) setApiConfig(data);
          } catch { /* 忽略 */ }
        })();
        return () => { cancelled = true; };
      }, []);

      // 查一次版本号：显示在左栏底部；失败时显示 v…，不影响其它功能
      React.useEffect(() => {
        let cancelled = false;
        (async () => {
          try {
            const res = await fetch(`${ROUTE_PREFIX}/version`);
            if (!res.ok) return;
            const data = await res.json();
            if (!cancelled) setVersionInfo(data);
          } catch { /* 忽略 */ }
        })();
        return () => { cancelled = true; };
      }, []);

      /** 某篇文献当前的直连翻译任务（取最近一条，失败后回退到本地保存的历史） */
      const jobOf = React.useCallback((p) => {
        const mine = jobs.filter((j) => j.slug === p.slug);
        if(mine.length)return mine[0];
        if(jobHistory[p.slug])return jobHistory[p.slug];
        const saved=p.translationStats;
        return saved?.costReport?{...saved,slug:p.slug,jobId:'persisted-'+p.slug,phase:saved.partial?'partial':'done',percent:100,costReport:saved.costReport,model:p.translateModel,outputPath:p.translation,usage:saved}:null;
      }, [jobs, jobHistory]);

      const progressOf = React.useCallback(
        (p) => (p.translateSession ? progress[p.translateSession] : null),
        [progress],
      );

      // 旧的 agent 会话进度轮询（仅当有条目引用了会话时才有意义）
      React.useEffect(() => {
        if (sessionIds.length === 0) return undefined;
        let cancelled = false;
        let timer = null;
        const poll = async () => {
          try {
            const res = await fetch(`${ROUTE_PREFIX}/sessions`);
            if (!res.ok) return;
            const data = await res.json();
            if (cancelled) return;
            const next = {};
            for (const s of data.sessions ?? []) next[s.sessionId] = s;
            setProgress(next);
            const live = (data.sessions ?? []).some(
              (s) => s.phase === 'queued' || s.phase === 'running' || s.phase === 'unknown',
            );
            // 直连路径在跑时没必要再轮询会话，省点请求
            if (live && !cancelled && !jobs.some((j) => j.phase === 'running')) {
              timer = setTimeout(poll, 5000);
            }
          } catch { /* 忽略 */ }
        };
        poll();
        return () => { cancelled = true; if (timer) clearTimeout(timer); };
      }, [sessionIds.join(','), tick]);

      // 搜索只影响展示，不改库；空搜索词等价于不过滤。
      const filteredPapers = React.useMemo(
        () => papers.filter((p) => paperMatchesQuery(p, query)),
        [papers, query],
      );
      // 搜索结果里也可能全是隐藏条目；这种情况要给出「去开显示隐藏」的出口，
      // 否则树是空的、界面看起来像坏了。
      const visibleFilteredCount = filteredPapers.filter(
        (p) => showHidden || p.hidden !== true,
      ).length;

      const tree = React.useMemo(() => buildTree(filteredPapers), [filteredPapers]);

      /**
       * 当前可见文献的深度优先顺序（文件夹内按置顶/手动位次排序），
       * 供「上一篇 / 下一篇」与键盘浏览使用。搜索时只在命中结果之间跳转。
       */
      const orderedPapers = React.useMemo(() => {
        const out = [];
        const walk = (node) => {
          out.push(...sortPapers(node.papers.filter((p) => showHidden || p.hidden !== true)));
          for (const child of [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name))) {
            walk(child);
          }
        };
        walk(tree);
        return out;
      }, [tree, showHidden]);

      const selectedPos = selected ? orderedPapers.findIndex((p) => p.slug === selected.slug) : -1;
      const prevPaper = selectedPos > 0 ? orderedPapers[selectedPos - 1] : null;
      const nextPaper = selectedPos >= 0 && selectedPos < orderedPapers.length - 1
        ? orderedPapers[selectedPos + 1] : null;

      /** 收起所有文件夹（只留顶层分类） */
      const collapseAll = () => {
        const paths = [];
        const walk = (node, parent) => {
          for (const child of node.children.values()) {
            const p = parent ? `${parent}/${child.name}` : child.name;
            paths.push(p);
            walk(child, p);
          }
        };
        walk(tree, '');
        const next = new Set(paths);
        setCollapsed(next);
        saveCollapsed(next);
      };
      const expandAll = () => { setCollapsed(new Set()); saveCollapsed(new Set()); };

      const hiddenCount = papers.filter((p) => p.hidden === true).length;
      const runningCount = jobs.filter((j) => j.phase === 'running' || j.phase === 'queued').length;
      const batchActive = batchState.phase === 'running' || batchState.phase === 'stopping';

      /** 等一篇文献翻译结束（done/failed）。批量队列用它保证同一时刻只跑一篇。 */
      async function waitForTranslateJob(jobId) {
        let transientFailures = 0;
        while (!batchCancelRef.current) {
          try {
            const res = await fetch(`${ROUTE_PREFIX}/translate-job?id=${encodeURIComponent(jobId)}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const job = await res.json();
            upsertJob(job);
            transientFailures = 0;
            if (['done','partial','failed'].includes(job.phase)) return job;
          } catch (err) {
            transientFailures += 1;
            // 短暂网络波动不应中断整条队列；连续失败才上报。
            if (transientFailures >= 8) {
              throw new Error(`连续 ${transientFailures} 次无法读取任务 ${jobId}：${err.message}`);
            }
          }
          await new Promise((resolve) => setTimeout(resolve, transientFailures ? 5000 : 2500));
        }
        return null;
      }

      function stopTranslateBatch() {
        batchCancelRef.current = true;
        setBatchState((stateValue) => ({ ...stateValue, phase: 'stopping' }));
        setNotice({ kind: 'ok', text: '已停止提交后续文献；已提交的当前任务仍会在后台完成。' });
      }

      /**
       * 翻译所有**可见**且未翻译的文献。
       *
       * 过滤条件（用户要求：只翻显示的，不翻隐藏的）：
       *   - `p.hidden !== true` —— 隐藏的不翻
       *   - `!p.translation`    —— 已译的不重翻
       *   - `p.source`          —— 没有 PDF 的跳过
       */
      async function doTranslateAll() {
        const pending = papers.filter((p) => p.hidden !== true && !p.translation && p.source);
        const skippedHidden = papers.filter((p) => p.hidden === true && !p.translation).length;
        if (pending.length === 0) {
          setNotice({
            kind: 'ok',
            text: '没有需要翻译的可见文献'
              + (skippedHidden ? `（另有 ${skippedHidden} 篇已隐藏，已按要求跳过）` : '') + '。',
          });
          return;
        }
        const schedule = offpeakOnly ? 'offpeak' : 'now';
        if (!window.confirm(
          `将依次翻译 ${pending.length} 篇可见且未翻译的文献。\n`
          + (skippedHidden ? `（已隐藏的 ${skippedHidden} 篇会跳过）\n` : '')
          + `\n调度：${schedule === 'offpeak' ? '仅 DeepSeek 闲时（峰时先排队）' : '立即执行'}。\n`
          + '客户端会等当前一篇完成后再提交下一篇，不再并发启动。\n'
          + '已提交的文献可在后台完成；若关闭此面板，尚未提交的后续文献会停止。\n\n确认开始？',
        )) return;
        batchCancelRef.current = false;
        setBatchState({
          phase: 'running', current: 0, total: pending.length, completed: 0, failed: 0, title: '',
        });
        setNotice({
          kind: 'ok',
          text: `已建立 ${pending.length} 篇的串行队列（跳过隐藏 ${skippedHidden} 篇），同一时刻只翻译一篇。`,
        });
        let completed = 0;
        let failed = 0;
        let stopped = false;
        for (let index = 0; index < pending.length; index += 1) {
          const p = pending[index];
          if (batchCancelRef.current) { stopped = true; break; }
          setBatchState({
            phase: 'running', current: index + 1, total: pending.length, completed, failed,
            title: chinesePaperTitle(p),
          });
          try {
            const launched = await postJson('/translate-job', { slug: p.slug, schedule });
            upsertJob(launched);
            setJobPollEpoch((value) => value + 1);
            if (!launched.jobId) throw new Error('后端未返回 jobId，无法等待本篇完成');
            const result = await waitForTranslateJob(launched.jobId);
            if (result === null) { stopped = true; break; }
            if (result.phase === 'done') {
              completed += 1;
              setTick((value) => value + 1);
            } else {
              failed += 1;
            }
          } catch (err) {
            failed += 1;
            setNotice({ kind: 'err', text: `第 ${index + 1} 篇（${p.slug}）失败：${err.message}` });
            break;
          }
        }
        await refreshJobs();
        const left = pending.length - completed - failed;
        setBatchState({ phase: 'idle', current: 0, total: 0, completed, failed, title: '' });
        setNotice({
          kind: failed ? 'err' : 'ok',
          text: `${stopped ? '已停止后续提交；' : ''}完成 ${completed} 篇`
            + (failed ? `，失败 ${failed} 篇` : '')
            + (left > 0 ? `，未处理 ${left} 篇` : '') + '。',
        });
      }

      /**
       * 自动识别论文元数据，再按 Crossref + 科研通补全期刊信息。
       *
       * 逐篇串行 + 延时：每次查询要发 2 个 HTTP 请求（搜索 + 详情），
       * 批量并发会对站点造成压力，也可能被限流。
       * 不再要求预先填写刊名：服务端会从译稿/抽取文本识别 DOI、标题、作者、年份与刊名。
       */
      async function doFillJournals(onlySlug) {
        const targets = onlySlug
          ? papers.filter((p) => p.slug === onlySlug)
          : papers.filter((p) => {
            const j = p.journal ?? {};
            const missing = (!j.name || !j.doi || j.impactFactor == null || !j.casQuartile || !j.jcrQuartile
              || !p.authors || !p.year || !p.titleZh || !p.titleEn || p.title === p.slug);
            return missing && Boolean(p.translation || p.extracted || p.source);
          });

        if (targets.length === 0) {
          setNotice({
            kind: 'ok',
            text: onlySlug
              ? '这篇的元数据已经齐全。'
              : '没有需要补全的条目。',
          });
          return;
        }
        if (!onlySlug && !window.confirm(
          `将逐篇自动识别 ${targets.length} 篇论文的标题、作者、年份、DOI 和期刊，\n`
          + '再通过 Crossref 与科研通校准并补全影响因子和分区。\n\n'
          + '每篇间隔 1.2 秒，避免给站点造成压力。\n'
          + '抓到的数据会写入 library.json，并在界面上标注来源。\n\n确认开始？',
        )) return;

        setBusy('fill');
        let done = 0;
        const failures = [];
        const uncertain = [];
        for (const p of targets) {
          setNotice({
            kind: 'ok',
            text: `正在识别并补全… ${done + 1}/${targets.length}（${p.slug}）`,
          });
          try {
            const r = await postJson('/fill-journal', { slug: p.slug });
            if (!r.ok) failures.push(`${p.slug}：${r.error}`);
            else {
              done += 1;
              // 刊名没精确匹配上 → 提示核对，别默默写错数据
              if (r.partial || (r.info && r.info.matchedExactly === false)) {
                uncertain.push(`${p.slug}${r.info?.warning ? `：${r.info.warning}` : '：仅识别到基础元数据'}`);
              }
            }
          } catch (err) {
            failures.push(`${p.slug}：${err.message}`);
          }
          await new Promise((resolve) => setTimeout(resolve, 1200));
        }

        setTick((t) => t + 1);
        setBusy(null);
        const parts = [`已识别并补全 ${done}/${targets.length} 篇`];
        if (failures.length) parts.push(`失败 ${failures.length} 篇（${failures.slice(0, 2).join('；')}${failures.length > 2 ? '…' : ''}）`);
        if (uncertain.length) parts.push(`⚠ ${uncertain.length} 篇只完成基础识别，请核对：${uncertain.slice(0, 2).join('；')}`);
        setNotice({ kind: failures.length ? 'err' : 'ok', text: parts.join('；') });
      }

      const j = selected?.journal ?? {};
      const journalFilled = !!(j.name || j.impactFactor != null || j.casQuartile || j.doi);

      const chips = selected ? [
        (j.name ?? j.abbr) ? h('span', { className: 'll-chip', key: 'j' }, ['期刊 ', h('b', { key: 'b' }, j.name ?? j.abbr)]) : null,
        j.impactFactor != null ? h('span', { className: 'll-chip', key: 'i' }, ['影响因子 ', h('b', { key: 'b' }, String(j.impactFactor))]) : null,
        j.jcrQuartile ? h('span', { className: 'll-chip', key: 'q' }, ['JCR ', h('b', { key: 'b' }, j.jcrQuartile)]) : null,
        j.casQuartile ? h('span', { className: 'll-chip', key: 'c' }, ['中科院 ', h('b', { key: 'b' }, j.casQuartile)]) : null,
        j.isTop === true ? h('span', { className: 'll-chip', key: 't' }, 'Top 期刊') : null,
        j.doi ? h('span', { className: 'll-chip', key: 'd' }, ['DOI ', h('b', { key: 'b' }, j.doi)]) : null,
      ].filter(Boolean) : [];

      const navBody = state.phase === 'loading'
        ? h('div', { className: 'll-status' }, '正在读取文献库索引…')
        : state.phase === 'error'
          ? h('div', { className: 'll-status' }, [
            h('p', { key: 'e' }, '读取文献库索引失败：'),
            h('p', { key: 'm' }, h('code', null, state.error ?? '')),
            h('p', { key: 'h' }, '可在工作区执行 '),
            h('pre', { key: 'c' }, h('code', null, 'node tools/library.mjs export')),
          ])
          : papers.length === 0
            ? h('div', { className: 'll-empty' }, [
              h('strong', { key: 't' }, '文献库还是空的'),
              h('span', { key: 'd' }, '把 PDF 放进 library/papers/ 的分类子文件夹，或点右上角「＋ 导入」添加外部文件夹。'),
            ])
            : filteredPapers.length === 0
              ? h('div', { className: 'll-empty' }, [
                h('strong', { key: 't' }, '没有匹配的文献'),
                h('span', { key: 'd' }, `没有找到包含「${query.trim()}」的标题、作者或期刊。`),
                h('button', {
                  key: 'b', className: 'll-btn',
                  onClick: () => { setQuery(''); searchRef.current?.focus(); },
                }, '清除搜索'),
              ])
              : visibleFilteredCount === 0 && !showHidden
                ? h('div', { className: 'll-empty' }, [
                  h('strong', { key: 't' }, query.trim() ? '匹配到的文献都被隐藏了' : '所有文献都被隐藏了'),
                  h('span', { key: 'd' }, query.trim()
                    ? `「${query.trim()}」命中 ${filteredPapers.length} 篇，但都处于隐藏状态。`
                    : `共 ${papers.length} 篇，可在下方勾选「显示隐藏」查看并恢复。`),
                  h('button', {
                    key: 'b', className: 'll-btn',
                    onClick: () => setShowHidden(true),
                  }, '显示隐藏的文献'),
                ])
                : h(TreeNode, {
                  node: tree, depth: 0, parentPath: '', selected: state.selected,
                  collapsed, toggleCollapse,
                  onSelect: selectPaper,
                  onTranslate: doTranslate, onMutate: doMutate, onArrange: doArrange,
                  translating: busy, showHidden,
                  progressOf, jobOf, onContextMenu: setMenu,
                  papers: filteredPapers, allPapers: papers,
                  selectedFolder, onSelectFolder: setSelectedFolder,
                  onStartNow: doStartNow, startingJob,
                });

      return h('div', {
        className: `ll-root ll-reader-${readerSurface}${focusMode ? ' ll-focus' : ''}${navOpen?' ll-nav-open':''}${compact?' ll-compact':''}`,
        ref: containerRef,
        'data-ll-theme': themeMode,
        style: { '--ll-reading-scale': String(fontPercent / 100) },
      }, [
        h('div',{key:'mobilebar',className:'ll-mobilebar'},[
          h('button',{key:'nav',className:'ll-btn','aria-expanded':navOpen,onClick:()=>{setFocusMode(false);setNavOpen(v=>!v);}},'文献库'),
          h('span',{key:'title'},'论文阅读'),
          h('button',{key:'tools',className:'ll-btn',onClick:()=>setToolsTab('translation')},'工具'),
        ]),
        // 第 1 段：目录树 + 列表
        !focusMode ? h('div', { className: 'll-col ll-nav-shell', key: 'nav', style: { flex: `0 0 ${layout.navPct}%` } }, [
          h('div', { className: 'll-nav-head', key: 'h' }, [
            h('div', { className: 'll-nav-title', key: 't' }, [
              h(BookIcon, { key: 'i', size: 16 }),
              h('span', { key: 's' }, '文献库'),
              h('span', {
                className: 'll-count-pill', key: 'c',
                title: query.trim() ? `搜索命中 ${filteredPapers.length} 篇 / 全库 ${papers.length} 篇` : `全库 ${papers.length} 篇`,
              }, query.trim() ? `${filteredPapers.length}/${papers.length}` : `${papers.length} 篇`),
              h('button', {
                key: 'add', className: 'll-btn ll-btn-xs', disabled: busy !== null,
                title: '浏览主机文件夹，把里面的 PDF（含子文件夹）复制进文献库',
                onClick: () => setBrowserOpen(true),
              }, '＋ 导入'),
            ]),
            h('div', { className: 'll-search-wrap', key: 'q' }, [
              h('span', { className: 'll-search-icon', key: 'i' }, h(SearchIcon)),
              h('input', {
                key: 'in', ref: searchRef, className: 'll-search', value: query,
                spellCheck: false, placeholder: '搜索标题 / 作者 / 期刊',
                title: '按标题、作者、期刊、DOI、年份或分类筛选；Esc 清除',
                onChange: (e) => setQuery(e.target.value),
                onKeyDown: (e) => {
                  if (e.key === 'Escape') { e.preventDefault(); setQuery(''); }
                  if (e.key === 'Enter') {
                    const first = orderedPapers[0];
                    if (first) selectPaper(first.slug);
                  }
                },
              }),
              query.trim() === '' ? null : h('button', {
                key: 'x', className: 'll-search-clear', title: '清除搜索',
                onClick: () => { setQuery(''); searchRef.current?.focus(); },
              }, '×'),
            ]),
            notice ? h('div', { className: 'll-banner', key: 'n' }, [
              h('span', { key: 't' }, notice.text),
              notice.url ? h('a', { key: 'a', href: notice.url, target: '_blank', rel: 'noreferrer' }, ' 打开会话 →') : null,
            ]) : null,
          ]),
          // 目录树工具条：折叠控制 + 显示隐藏
          h('div',{className:'ll-nav-actions',key:'tb'},[
            h('button',{key:'lib',className:'ll-btn',onClick:()=>setToolsTab('library')},'文献管理'),
            h('button',{key:'tasks',className:'ll-btn',onClick:()=>setToolsTab('translation')},'翻译与任务'),
          ]),
          // 直连翻译：就绪状态 + 配置入口 + 批量入口
          h('div', { className: 'll-nav-body', key: 'b' }, navBody),
          // 版本号常驻左栏底部：升级后不用翻文档就能确认运行的是哪一版
          h('div', { className: 'll-nav-foot', key: 'foot' }, [
            h('span', {
              key: 'v', className: 'll-ver',
              title: versionInfo
                ? `${versionInfo.name ?? 'dsh-literature-library'} v${versionInfo.version}\n路由：${versionInfo.routePrefix ?? ROUTE_PREFIX}`
                : '版本读取中…（如果一直显示 v…，可能是 host 半未重启）',
            }, ['v', h('b', { key: 'n' }, versionInfo?.version ?? '…')]),
            versionInfo?.pdfjs
              ? h('span', { key: 'p', className: 'll-nav-foot-tag', title: '原文由 PDF.js canvas 渲染' }, 'PDF.js')
              : null,
            h('span', { key: 'sp', className: 'll-spacer' }),
            h('button',{key:'read-tools',className:'ll-btn ll-btn-xs',onClick:()=>setToolsTab('reading')},'阅读设置'),
            h('button',{key:'settings',className:'ll-btn ll-btn-xs',onClick:()=>setToolsTab('settings')},'设置'),
            h('span', { key: 'h', className: 'll-nav-foot-hint', title: '当前文献总数' }, `${papers.length} 篇`),
          ]),
        ]) : null,

        !focusMode ? h(Divider, {
          key: 'd1',
          onDrag: { start: startDrag('nav'), move: moveDrag, end: endDrag },
          onDoubleClick: () => setLayout((l) => ({ ...l, navPct: 16 })),
        }) : null,

        // 第 2 段：文献区
        h('div', { className: 'll-col ll-main-shell', key: 'main', style: { flex: '1 1 auto' } }, selected ? [
          h('div', { className: `ll-head${detailsOpen ? '' : ' ll-head-compact'}`, key: 'head' }, [
            h('div', { className: 'll-head-titles', key: 'titles' }, [
              h('div', { className: 'll-eyebrow', key: 'crumb' }, [
                selected.pinned ? h(PinIcon, { key: 'p', size: 10 }) : null,
                h('span', { key: 'f' }, selected.folder || selected.category || '未分类'),
                h('span', { key: 's', className: 'll-sep' }, '·'),
                h('span', { key: 'y' }, paperPublicationYear(selected)),
              ]),
              h('h1', { key: 'zh', lang: 'zh-CN' }, chinesePaperTitle(selected)),
              h('div', {
                className: `ll-title-en${englishPaperTitle(selected) ? '' : ' ll-missing'}`,
                key: 'en', lang: 'en',
              }, englishPaperTitle(selected) || '英文题名待自动识别'),
            ]),
            h('div', { className: 'll-head-actions', key: 'actions' }, [
              h('select',{key:'surface',className:'ll-reader-select','aria-label':'阅读布局',value:readerSurface,onChange:e=>setReaderSurface(e.target.value)},[
                h('option',{key:'split',value:'split'},'双栏对照'),h('option',{key:'translation',value:'translation'},'只看译文'),h('option',{key:'pdf',value:'pdf'},'只看原文'),
              ]),
              h('div', { className: 'll-navpair', key: 'nav' }, [
                h('button', {
                  key: 'prev', className: 'll-icon-btn', disabled: !prevPaper,
                  title: prevPaper ? `上一篇：${chinesePaperTitle(prevPaper)}` : '已经是第一篇',
                  'aria-label': '上一篇',
                  onClick: () => { if (prevPaper) selectPaper(prevPaper.slug); },
                }, '‹'),
                h('span', {
                  key: 'pos', className: 'll-pagepos',
                  title: '当前文献在可见列表中的位置（受搜索与隐藏过滤影响）',
                }, selectedPos >= 0 ? `${selectedPos + 1} / ${orderedPapers.length}` : `— / ${orderedPapers.length}`),
                h('button', {
                  key: 'next', className: 'll-icon-btn', disabled: !nextPaper,
                  title: nextPaper ? `下一篇：${chinesePaperTitle(nextPaper)}` : '已经是最后一篇',
                  'aria-label': '下一篇',
                  onClick: () => { if (nextPaper) selectPaper(nextPaper.slug); },
                }, '›'),
              ]),
              h('button', {
                key: 'pin', className: `ll-icon-btn ll-focus-optional${selected.pinned ? ' on' : ''}`,
                disabled: busy !== null,
                'aria-pressed': selected.pinned === true,
                title: selected.pinned ? '取消置顶' : '置顶到本文件夹顶部',
                onClick: () => doArrange({
                  action: selected.pinned ? 'unpin' : 'pin', slug: selected.slug,
                }),
              }, h(PinIcon, { size: 14 })),
              h('button', {
                key: 'focus', className: 'll-btn ll-btn-xs',
                title: focusMode ? '恢复左侧文献列表' : '隐藏左侧列表，让译文和 PDF 占满宽度',
                onClick: () => setFocusMode((v) => {
                  const next = !v;
                  if (next) { setDetailsOpen(false); setMetaOpen(false); }
                  return next;
                }),
              }, focusMode ? '退出' : '专注阅读'),
              h('button', {
                key: 'details', className: 'll-btn ll-btn-xs ll-details-toggle',
                title: detailsOpen ? '收起作者、期刊与 DOI 信息' : '展开作者、期刊与 DOI 信息',
                'aria-expanded': detailsOpen,
                onClick: () => {
                  if (detailsOpen) setMetaOpen(false);
                  setDetailsOpen(!detailsOpen);
                },
              }, focusMode ? (detailsOpen ? '收起' : '详情') : (detailsOpen ? '收起详情 ︿' : '论文详情 ﹀')),
            ]),
            detailsOpen ? h('div', { className: 'll-head-details', key: 'details-panel' }, [
              h('span', { className: 'll-byline', key: 'o' }, [selected.authors || '作者未知', paperPublicationYear(selected)].join(' · ')),
              h('div', { className: 'll-journal', key: 'j' }, [
                ...chips,
                h('button', {
                  key: 'edit',
                  className: 'll-btn',
                  style: { marginLeft: 'auto' },
                  title: '编辑期刊信息（期刊名 / 影响因子 / 分区 / DOI 等）',
                  onClick: () => setMetaOpen((v) => !v),
                }, metaOpen ? '收起编辑表单' : (journalFilled ? '编辑信息' : '填写信息')),
                h('button', {
                  key: 'fill',
                  className: 'll-btn',
                  disabled: busy !== null,
                  title: '自动识别 DOI、标题、作者、年份与期刊，并补全影响因子和分区后直接保存',
                  onClick: async () => {
                    setBusy('meta');
                    setNotice(null);
                    try {
                      const r = await postJson('/fill-journal', { slug: selected.slug });
                      if (!r.ok) throw new Error(r.error ?? '查询失败');
                      const i = r.info;
                      setMetaOpen(false);
                      setTick((t) => t + 1);
                      setNotice({
                        kind: r.partial ? 'err' : 'ok',
                        text: (r.partial ? `已识别并保存基础信息；${i.warning ?? '影响因子/分区需人工核对'}` : '已自动识别并保存文献信息。')
                          + `\n期刊：${i.name ?? '未识别'}${i.doi ? `\nDOI：${i.doi}` : ''}`
                          + `${i.sourceUrl ? `\n来源：${i.sourceUrl}` : ''}`,
                      });
                    } catch (err) {
                      setNotice({ kind: 'err', text: `查询失败：${err.message}` });
                    } finally { setBusy(null); }
                  },
                }, busy === 'meta' ? '识别中…' : '自动识别并补全'),
              ]),
              metaOpen ? h(JournalEditor, {
                key: 'meta',
                paper: selected,
                busy: busy === 'meta',
                onSave: doSaveMeta,
              }) : null,
            ]) : null,
          ]),
          h('div', { className: 'll-split', key: 'split' }, [
            // ── 中：中文译文（可编辑的 md 编辑器） ──
            h('div', { className: 'll-pane ll-pane-translation', key: 'mid', style: { flex: `0 0 ${layout.trPct}%` } }, [
              // 第 1 行：与右侧「原文 PDF」标题栏严格同高（40px）
              h('div', { className: 'll-pane-head', key: 'h' }, [
                h('span', { className: 'll-pane-title', key: 't' }, '中文译文'),
                h('span', { className: 'll-spacer', key: 'sp' }),
                docReady ? h('span', {
                  key: 'wc', className: 'll-wordcount', title: '译文字符数（含 Markdown 标记）',
                }, `${displayText.length.toLocaleString()} 字符`) : null,
              ]),
              // 第 2 行：与 Chromium 内置 PDF 工具条严格同高（--ll-pdf-toolbar-h）
              h('div', { className: 'll-pane-tools', key: 'tools' }, [
                docReady ? h('span', { key: 'tabs', className: 'll-tabs' }, [
                  ...[['preview', '预览'], ['source', '源码'], ['edit', '编辑']].map(([id, label]) =>
                    h('button', {
                      key: id,
                      className: `ll-tab${mode === id ? ' on' : ''}`,
                      onClick: () => {
                        persistCurrentMarkdown(activeSlug, mode);
                        setMode(id);
                      },
                    }, label)),
                ]) : null,
                katex === null && (mode === 'preview' || mode === 'edit') && docReady
                  ? h('span', { key: 'k', className: 'll-hint' }, '公式未加载')
                  : null,
                dirty && docReady
                  ? h('span', { key: 'd', className: 'll-hint', title: '有未保存的修改' }, ['未保存', h('span', { className: 'll-dot' })])
                  : null,
                h('span', { className: 'll-spacer', key: 'sp' }),
                docReady ? h('button', {
                  key: 'copy', className: 'll-btn', title: '复制全文 Markdown 到剪贴板',
                  onClick: doCopy,
                }, copied ? '已复制 ✓' : '复制') : null,
                dirty && docReady ? h('button', {
                  key: 'save', className: 'll-btn', disabled: busy === 'save', onClick: doSave,
                }, busy === 'save' ? '保存中…' : '保存') : null,
                !selected.translation ? h('button', {
                  key: 'tr', className: 'll-btn', disabled: busy !== null, onClick: () => doTranslate(selected),
                }, busy === selected.slug ? '投递中…' : '翻译这篇') : null,
              ]),
              h('div', { className: 'll-pane-body', key: 'b', ref: markdownPaneRef, tabIndex:0, 'aria-label':'译文阅读区' },
                contentSwitching || docStale
                  ? h('div', { className: 'll-status' }, contentSwitching ? '正在切换文献…' : '正在读取译文…')
                  : doc.phase === 'loading'
                    ? h('div', { className: 'll-status' }, '正在读取译文…')
                    : doc.phase === 'error'
                      ? h('div', { className: 'll-status' }, ['读取译文失败：', h('code', null, doc.error ?? '')])
                      : doc.phase === 'idle'
                        ? h('div', { className: 'll-empty' }, [
                          h('strong', { key: 't' }, '还没有中文译文'),
                          h('span', { key: 'd' }, '点右上角「翻译这篇」用 DeepSeek 生成，完成后可在这里预览、编辑并保存。'),
                        ])
                        : mode === 'preview'
                          ? h('div', { key: 'pv', className: 'll-md', dangerouslySetInnerHTML: { __html: previewHtml } })
                          : mode === 'edit'
                          ? h(MarkdownBlockEditor, {
                            key: 'wysiwyg',
                            value: text,
                            katex,
                            onChange: (next) => {
                              setText(next);
                              setDirty(next !== (doc.translated ?? ''));
                              setCopied(false);
                            },
                          })
                          : h('textarea', {
                          key: 'ed',
                          className: 'll-editor',
                          value: text,
                          readOnly: true,
                          spellCheck: false,
                          wrap: 'off',
                        })),
            ]),

            h(Divider, {
              key: 'd2',
              onDrag: { start: startDrag('tr'), move: moveDrag, end: endDrag },
              onDoubleClick: () => setLayout((l) => ({ ...l, trPct: 50 })),
            }),

            // ── 右：原文 PDF ──
            h('div', { className: 'll-pane ll-pane-pdf', key: 'right', style: { flex: '1 1 auto' } }, [
              h('div', { className: 'll-pane-head', key: 'h' }, [
                h('span', { className: 'll-pane-title', key: 't' }, '原文 PDF'),
                h('span', { className: 'll-spacer', key: 'sp' }),
                pdfOpenUrl
                  ? h('a', { key: 'a', href: pdfOpenUrl, target: '_blank', rel: 'noreferrer' }, focusMode ? '新窗口 ↗' : '新窗口打开 →')
                  : null,
              ]),
              !selected.source
                ? h('div', { className: 'll-pane-body', key: 'b' }, h('div', { className: 'll-empty' }, [
                  h('strong', { key: 't' }, '没有原始 PDF'),
                  h('span', { key: 'd' }, '这篇文献只登记了译文或抽取文本。把 PDF 放进 library/papers/ 后重新扫描即可关联。'),
                ]))
                : h(PdfViewer, {
                  key: pdfAddress || 'pending',
                  address: pdfAddress,
                  documentKey: selected.slug,
                  title: selected.title ?? selected.slug,
                  switching: pdfSwitching || !pdfPaper,
                  layoutMode, media, schedule: offpeakOnly ? 'offpeak' : 'now', openLayout: layoutOpenSlug === selected.slug,
                  onJob: r => { upsertJob(r); setJobPollEpoch(v=>v+1); },
                  onLayoutDirty: recordLayoutDirty,
                }),
            ]),
          ]),
        ] : h('div', { className: 'll-empty', key: 'none' }, '请从左侧选择一篇文献。')),

        layoutBatchOpen ? h(LayoutBatchDialog,{key:'layout-batch',papers:filteredPapers,mode:layoutMode,setMode:setLayoutMode,
          media,setMedia,
          schedule:offpeakOnly?'offpeak':'now',onClose:()=>setLayoutBatchOpen(false),onSelect:slug=>{selectPaper(slug);setLayoutOpenSlug(slug);},
          onJob:r=>{upsertJob(r);setJobPollEpoch(v=>v+1);}}):null,
        browserOpen ? h(FolderBrowser, {
          key: 'browser',
          busy: busy === 'addfolder',
          onClose: () => setBrowserOpen(false),
          onAdd: doAddFolder,
        }) : null,

        toolsTab ? h(ToolDialog,{key:'tools',tab:toolsTab,onTab:setToolsTab,onClose:()=>setToolsTab(null)},[
          toolsTab==='library' ? h('section',{key:'library',className:'ll-tool-section'},[
            h('h3',{key:'h'},'登记与整理文献'),
            h('div', {
              className: `ll-scan${selectedFolder ? ' ll-scan-selected' : ''}`,
              key: 'sc',
            }, selectedFolder ? [
              h('span', {
                key: 't', className: 'll-scan-target',
                title: `扫描分类「${selectedFolder}」记录的原始外部文件夹；只复制新增 PDF`,
              }, ['扫描：', h('b', { key: 'b' }, selectedFolder)]),
              h('button', {
                key: 'go', className: 'll-btn ll-btn-xs',
                disabled: busy !== null, onClick: doScanFolder,
                title: '扫描该分类的原始来源文件夹，把新增 PDF 复制进这个分类',
              }, busy === 'scan-folder' ? '扫描中…' : '扫描新增'),
              h('button', {
                key: 'x', className: 'll-btn ll-btn-xs',
                disabled: busy !== null,
                title: '取消选中，回到手动扫描库内路径',
                onClick: () => setSelectedFolder(null),
              }, '×'),
            ] : [
              h('input', {
                key: 'i', className: 'll-input', value: scanDir, spellCheck: false,
                title: '手动扫描库内已有的文件夹（相对工作区路径）',
                onChange: (e) => setScanDir(e.target.value),
                onKeyDown: (e) => { if (e.key === 'Enter') doScan(); },
              }),
              h('button', {
                key: 'go', className: 'll-btn ll-btn-xs', disabled: busy !== null, onClick: doScan,
                title: '登记该库内文件夹（含子文件夹）里的 PDF；子文件夹会作为分类',
              }, busy === 'scan' ? '扫描中…' : '扫描'),
            ]),
          h('div', { className: 'll-treebar', key: 'tb' }, [
            h('button', {
              key: 'collapse', className: 'll-btn ll-btn-xs', onClick: collapseAll,
              title: '收起所有文件夹（只留顶层分类）',
            }, '全部收起'),
            h('button', {
              key: 'expand', className: 'll-btn ll-btn-xs', onClick: expandAll,
              title: '展开所有文件夹',
            }, '全部展开'),
            h('label', {
              key: 'hidden', className: 'll-hint',
              style: { marginLeft: 'auto', display: 'flex', gap: '4px', alignItems: 'center', cursor: 'pointer' },
              title: '显示被隐藏的文献（淡色显示，可点「显示」恢复）',
            }, [
              h('input', {
                key: 'i', type: 'checkbox', checked: showHidden,
                onChange: (e) => setShowHidden(e.target.checked),
              }),
              h('span', { key: 's' }, `显示隐藏${hiddenCount ? ` (${hiddenCount})` : ''}`),
            ]),
          ]),
            h('button', {
              key: 'fill', className: 'll-btn ll-btn-xs',
              disabled: busy !== null,
              title: '从译稿/抽取文本识别 DOI、标题、作者、年份和刊名，经 Crossref 校准后查询影响因子与分区',
              onClick: () => doFillJournals(),
            }, busy === 'fill' ? '补全中…' : '补全信息'),
          ]) : null,
          toolsTab==='translation' ? h('section',{key:'translation',className:'ll-tool-section'},[
            h('h3',{key:'h'},'翻译默认选项'),
            h('p',{key:'hint'},'本地分区不产生模型费用；确认后才进入翻译。图表默认只译题注，公式优先写为可编辑 LaTeX。'),
          h('div', { className: 'll-toolbar', key: 'tr' }, [
            h('span', {
              key: 'dot', className: `ll-api-dot${apiConfig?.ready ? ' ok' : ''}`,
              title: apiConfig?.ready
                ? `密钥来源：${apiConfig.keySource}\n端点：${apiConfig.baseUrl}\n模型：${apiConfig.model}`
                : '需要 DEEPSEEK_API_KEY：点右侧「配置」填写',
            }),
            h('span', {
              key: 'ok', className: 'll-hint',
              title: apiConfig?.ready
                ? `密钥来源：${apiConfig.keySource}\n端点：${apiConfig.baseUrl}\n模型：${apiConfig.model}`
                : '需要 DEEPSEEK_API_KEY：点右侧「配置」填写',
            }, apiConfig?.ready ? apiConfig.model : '未配置 API'),
            h('span', { className: 'll-spacer', key: 'sp' }),
            h('label', {
              key: 'offpeak', className: `ll-offpeak-toggle${offpeakOnly ? ' on' : ''}`,
              title: '按后端闲时调度；费用以服务端用量和账单为准',
            }, [
              h('input', {
                key: 'i', type: 'checkbox', checked: offpeakOnly, disabled: batchActive,
                onChange: (event) => setOffpeakOnly(event.target.checked),
              }),
              h('span', { key: 's' }, '闲时'),
            ]),
            h('button', {
              key: 'all', className: 'll-btn ll-btn-xs',
              disabled: batchState.phase === 'stopping' || busy !== null,
              title: batchActive
                ? `当前第 ${batchState.current}/${batchState.total} 篇：${batchState.title || '准备中'}。点击后不再提交后续文献，当前后台任务不会被取消。`
                : (runningCount > 0
                  ? `已有 ${runningCount} 个任务在跑`
                  : '把当前可见且未翻译的文献串行翻译：等上一篇完成后再提交下一篇'),
              onClick: batchActive ? stopTranslateBatch : () => { setToolsTab(null);setLayoutBatchOpen(true); },
            }, batchActive
              ? `停止后续 ${batchState.current}/${batchState.total}`
              : '分区/批量翻译'),
            h('select',{key:'layout-mode',className:'ll-layout-mode',value:layoutMode,'aria-label':'翻译分区模式',title:'选择分区与翻译流程',onChange:e=>setLayoutMode(e.target.value)},[
              h('option',{key:'auto',value:'auto'},'自动分区翻译'),h('option',{key:'semi',value:'semi'},'半自动·人工检查'),h('option',{key:'manual',value:'manual'},'手动分区'),
            ]),
            h(MediaOptions,{key:'media',value:media,onChange:setMedia}),
          ]),
            selected ? h('button',{key:'current',className:'ll-btn ll-primary',disabled:busy!==null,onClick:()=>{setToolsTab(null);doTranslate(selected);}},'准备当前文献') : null,
          ]) : null,
          toolsTab==='reading' ? h('section',{key:'reading',className:'ll-tool-section'},[
            h('h3',{key:'h'},'论文字号'),h('p',{key:'hint'},'只调整译文，不改变菜单、坐标输入或 PDF 缩放。设置自动保存。'),
            h('label', {
              key: 'fs', className: 'll-font-size',
              title: '先选择范围档位，再拖动微调；设置会立即保存，重启 DSH 后仍保留',
            }, [
              h('span', { key: 'l' }, '字号'),
              h('select', {
                key: 'band', className: 'll-font-band', value: fontRangeFor(fontPercent).id,
                'aria-label': '字号范围',
                onChange: (e) => {
                  const range = FONT_RANGES.find((item) => item.id === e.target.value) ?? FONT_RANGES[0];
                  updateFontPercent(Math.min(range.max, Math.max(range.min, fontPercent)));
                },
              }, FONT_RANGES.map((range) => h('option', { key: range.id, value: range.id }, range.label))),
              h('input', {
                key: 'r', className: 'll-font-range', type: 'range',
                min: fontRangeFor(fontPercent).min, max: fontRangeFor(fontPercent).max, step: 1,
                value: fontPercent,
                'aria-label': '字号滑块',
                onChange: (e) => updateFontPercent(e.target.value),
              }),
              h('input', {
                key: 'n', className: 'll-font-num', type: 'number',
                min: FONT_MIN_PERCENT, max: FONT_MAX_PERCENT, step: 1,
                value: fontPercent,
                'aria-label': '字号百分比',
                onChange: (e) => {
                  if (e.target.value === '') return;
                  updateFontPercent(e.target.value);
                },
              }),
              h('span', { key: 'p' }, '%'),
            ]),
          ]) : null,
          toolsTab==='settings' ? h('section',{key:'settings',className:'ll-tool-section'},[
            h('h3',{key:'h'},'插件与服务'),
            h('button', {
              key: 'cfg', className: 'll-btn ll-btn-xs',
              title: '配置 DeepSeek API key（写入 ~/.dsh/.credentials.yaml，自动备份）',
              onClick: () => {setToolsTab(null);setConfigOpen(true);},
            }, '配置'),
            h('button', {
              key: 'upd', className: 'll-btn ll-btn-xs',
              title: '从本地 .tgz 一键更新（不需要 GitHub 或外网）',
              onClick: () => {setToolsTab(null);setUpdateOpen(true);},
            }, '更新'),
          ]) : null,
        ]) : null,
        configOpen ? h(ConfigDialog, {
          key: 'config',
          onClose: () => setConfigOpen(false),
          onSaved: async () => {
            // 保存后刷新顶部的就绪状态
            try {
              const res = await fetch(`${ROUTE_PREFIX}/translate-config`);
              if (res.ok) setApiConfig(await res.json());
            } catch { /* 忽略 */ }
          },
        }) : null,

        updateOpen ? h(UpdateDialog, {
          key: 'update',
          onClose: () => setUpdateOpen(false),
        }) : null,

        // 右键菜单：文献或文件夹
        menu?.kind === 'paper' ? h(ContextMenu, {
          key: 'menu',
          menu,
          busy,
          onClose: closeMenu,
          onOpen: (p) => selectPaper(p.slug),
          onTranslate: (p) => doTranslate(p),
          onMutate: doMutate,
          onArrange: doArrange,
        }) : null,

        menu?.kind === 'folder' ? h(FolderMenu,{key:'menu-folder',menu,onClose:closeMenu,collapsed,toggleCollapse,doMutate}) : null,
      ]);
    }

    // ─────────────────── 注册 ───────────────────

    function PanelIcon({ size }) { return h(BookIcon, { size }); }

    const PANEL_ID = 'literature';
    const inject = ['slots', 'layout', 'remote'];

    function apply(ctx) {
      injectCss();
      ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
      }, LiteraturePanel)), 'literature: main panel');
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 20,
        label: () => '文献库',
      }, PanelIcon));
    }

    return { apply, inject, name: 'literature-library' };
  },
});
