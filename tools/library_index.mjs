/**
 * library_index.mjs —— 文献库「界面视图」（library/index.json）的唯一生成逻辑。
 *
 * 为什么抽成独立模块：这份结构有**两个调用方**——
 *   1. `tools/library.mjs export`（命令行导出）
 *   2. 文献库插件的 host 半（`/scan`、`/add-folder`、`/update` 之后要立刻刷新索引，
 *      否则面板看不到新导入的文献）
 * 早先这段逻辑只写在 library.mjs 里，host 半没有刷新索引，导致
 * 「library.json 有 14 篇、面板只显示 1 篇」。两处复制还会各自漏字段
 * （实测曾漏掉 `folder`，而面板的目录树正是靠它分层）。
 *
 * 所以：**索引字段只能在这里改**。两个调用方都调 `buildIndex()`。
 */

/** 状态码的固定顺序与中文名（README 与 index.json 共用） */
export const STATUS_ORDER = ['reviewed', 'translated', 'extracted', 'archived'];
export const STATUS_LABEL = {
  extracted: '已抽取',
  translated: '已翻译',
  reviewed: '已校对',
  archived: '已归档',
};
export const DEFAULT_CATEGORIES = [
  '热物性', '传感器', '自供电', '机械', '材料', '热物理', '计算机', '其他',
];

/**
 * 按分类分组，供 README 与统计共用。
 * @param papers - library.json 的 papers 数组
 * @returns Map<分类名, 文献数组>
 */
export function groupByCategory(papers) {
  const byCat = new Map();
  for (const p of papers) {
    const c = p.category ?? '未分类';
    if (!byCat.has(c)) byCat.set(c, []);
    byCat.get(c).push(p);
  }
  return byCat;
}

/**
 * 按 `db.categories` 声明顺序给分类排序，未声明的排到最后。
 * @param byCat - groupByCategory 的结果
 * @param declared - db.categories
 * @returns 排序后的分类名数组
 */
export function orderCategories(byCat, declared = []) {
  return [...byCat.keys()].sort((a, b) => {
    const ai = declared.indexOf(a);
    const bi = declared.indexOf(b);
    return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
  });
}

/**
 * 构造 library/index.json 的内容。
 *
 * 注意 `folder` 与 `translationPath` 是**面板必需**字段：
 *   - `folder` 决定目录树的层级（如 "参考文献/子类"）；
 *   - `translationPath` 让「未翻译但已规划输出位置」的条目也能正确显示。
 *
 * @param db - library.json 解析出的对象
 * @returns 可直接 JSON.stringify 的对象
 */
export function buildIndex(db) {
  const papers = db.papers ?? [];
  const byCat = groupByCategory(papers);
  const catOrder = orderCategories(byCat, db.categories ?? []);

  return {
    version: 1,
    updatedAt: db.updatedAt,
    categories: db.categories ?? [],
    counts: {
      total: papers.length,
      byStatus: Object.fromEntries(
        STATUS_ORDER.map((s) => [s, papers.filter((p) => p.status === s).length]),
      ),
      byCategory: Object.fromEntries(catOrder.map((c) => [c, byCat.get(c).length])),
    },
    papers: papers.map((p) => ({
      slug: p.slug,
      title: p.title,
      titleZh: p.titleZh ?? null,
      titleEn: p.titleEn ?? null,
      year: p.year,
      authors: p.authors,
      category: p.category,
      tags: p.tags,
      // 目录树靠这两个字段分层：folder 是「分类路径」，tags 是它去掉首层后的余下部分
      folder: p.folder ?? null,
      // 面板据此过滤：hidden 的文献默认不显示，但仍留在库里（可取消隐藏）
      hidden: p.hidden === true,
      hiddenAt: p.hiddenAt ?? null,
      // 手动排序 / 置顶：order 是「同一文件夹内」的升序位次，pinned 永远排在前面。
      // 字段缺失（旧库）时由面板回退到标题排序，不影响现有数据。
      pinned: p.pinned === true,
      pinnedAt: p.pinnedAt ?? null,
      order: Number.isFinite(p.order) ? p.order : null,
      status: p.status,
      source: p.source,
      extracted: p.extracted,
      translation: p.translation,
      translationPath: p.translationPath ?? null,
      translatedAt: p.translatedAt ?? null,
      // 翻译会话与状态：面板据此显示进度（并支持「打开会话」）
      translateSession: p.translateSession ?? null,
      translateStatus: p.translateStatus ?? null,
      translateStartedAt: p.translateStartedAt ?? null,
      // 最近一次直连翻译的真实用量与预计费用，供重启后继续展示。
      translationStats: p.translationStats ?? null,
      importedFrom: p.importedFrom ?? null,
      note: p.note,
      journal: p.journal ?? null,
    })),
  };
}
