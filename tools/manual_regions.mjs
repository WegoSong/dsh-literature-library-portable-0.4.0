/** Manual page replacements. Native text ownership is checked before extraction. */
export const ARTICLE_ROLES = ['body', 'abstract', 'heading', 'caption', 'formula', 'table'];
export const REGION_ROLES = [...ARTICLE_ROLES, 'title', 'front-matter', 'article-info', 'affiliation', 'publication', 'running-matter', 'watermark'];
export function validatePageRegions(page, drafts) {
  const fail = message => { throw Object.assign(new Error(message), { status: 422 }); };
  if (!Array.isArray(drafts) || drafts.length > 256) fail('每页最多 256 个分区');
  const ids = new Set();
  const regions = drafts.map((r, index) => {
    if (!REGION_ROLES.includes(r.role)) fail('分区类型无效');
    if (typeof r.id !== 'string' || ids.has(r.id)) fail('分区编号重复或无效');
    ids.add(r.id);
    const b = r.bbox;
    if (!Array.isArray(b) || b.length !== 4 || !b.every(Number.isFinite)
      || b[0] < -0.5 || b[1] < -0.5 || b[2] > page.width + 0.5 || b[3] > page.height + 0.5
      || b[2] - b[0] < 1 || b[3] - b[1] < 1) fail('分区边界无效或超出页面');
    const original = page.regions.find(o => o.id === r.id);
    const unchanged = original && original.bbox.every((n, j) => Math.abs(n - b[j]) < 0.01);
    return { id: r.id, role: r.role, bbox: [...b], itemIds: [], order: index + 1,
      flow: ARTICLE_ROLES.includes(r.role) ? 'article' : null,
      confidence: 'human-reviewed', evidence: 'manual-page-replacement',
      originalIds: unchanged ? new Set(original.itemIds) : null };
  });
  for (const item of page.items) {
    const [x0,y0,x1,y1] = item.bbox, x = (x0+x1)/2, y = (y0+y1)/2;
    const edited = regions.filter(r => !r.originalIds && x >= r.bbox[0] && x <= r.bbox[2] && y >= r.bbox[1] && y <= r.bbox[3]);
    if (edited.length > 1) fail(`重叠分区重复覆盖文字：${item.text.slice(0, 35)}`);
    const owners = edited.length ? edited : regions.filter(r => r.originalIds?.has(item.id));
    if (owners.length !== 1) fail(`存在未分区或重复文字：${item.text.slice(0, 35)}。可将非正文框为出版信息或页眉页脚。`);
    owners[0].itemIds.push(item.id);
  }
  return regions.map(({ originalIds, ...r }) => r);
}
