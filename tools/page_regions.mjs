/** Local page-region evidence. Coordinates use PDF space (origin at bottom left).
 * This module never calls an API and never invents/replaces source text.
 */
export const REGION_VERSION = 'page-regions-v2-labeled-abstract';

export function itemBox(item) {
  const x = item.transform?.[4] ?? 0, y = item.transform?.[5] ?? 0;
  const size = Math.abs(item.height || item.transform?.[3] || 0);
  return [x, y - size * 0.3, x + (item.width || 0), y + size];
}

export function unionBoxes(boxes) {
  if (!boxes.length) return [0, 0, 0, 0];
  return [Math.min(...boxes.map(b => b[0])), Math.min(...boxes.map(b => b[1])),
    Math.max(...boxes.map(b => b[2])), Math.max(...boxes.map(b => b[3]))];
}

/** Bounded, low-resolution connected components of neutral shaded backgrounds.
 * Text/figure anti-alias pixels cannot qualify unless they form a large, filled panel.
 */
export function detectShadedPanels({ data, width, height }, pageWidth, pageHeight) {
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    if (r >= 175 && r <= 242 && Math.max(r, g, b) - Math.min(r, g, b) <= 5) mask[i] = 1;
  }
  const queue = new Int32Array(mask.length), panels = [];
  for (let start = 0; start < mask.length; start++) {
    if (mask[start] !== 1) continue;
    let head = 0, tail = 1, x0 = width, y0 = height, x1 = 0, y1 = 0;
    queue[0] = start; mask[start] = 2;
    while (head < tail) {
      const n = queue[head++], x = n % width, y = Math.floor(n / width);
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      for (const next of [x > 0 ? n - 1 : -1, x + 1 < width ? n + 1 : -1,
        y > 0 ? n - width : -1, y + 1 < height ? n + width : -1]) {
        if (next >= 0 && mask[next] === 1) { mask[next] = 2; queue[tail++] = next; }
      }
    }
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    if (w >= width * 0.25 && h >= height * 0.08 && tail / (w * h) > 0.45) {
      panels.push([x0 / width * pageWidth, (height - y1 - 1) / height * pageHeight,
        (x1 + 1) / width * pageWidth, (height - y0) / height * pageHeight]);
    }
  }
  return panels;
}

function inside(item, box) {
  const b = itemBox(item), cx = (b[0] + b[2]) / 2, y = item.transform[5];
  return cx >= box[0] - 1 && cx <= box[2] + 1 && y >= box[1] - 1 && y <= box[3] + 1;
}

const ABSTRACT = /^(?:abstract|a\s*b\s*s\s*t\s*r\s*a\s*c\s*t)\s*$/iu;
const INTRO = /^(?:1\s*[.|]?\s*)?introduction\s*$/iu;
const ORG = /\b(?:department|university|institute|laboratory|e-mail|correspondence|corresponding|ORCID|copyright)\b|@|©/iu;
const PUBLICATION = /^(?:DOI\s*:|https?:\/\/doi\.|www\.|(?:received|revised|accepted|published|available\s+online)\s*(?::|\d))/iu;

/** Explicit labels are stronger evidence than a background color. Locate the
 * first long prose baseline below the label, then follow that column only until
 * its first substantial vertical gap. Labels can be letter-spaced PDF text.
 */
function labeledAbstract(items, label, pageWidth) {
  const y = label.transform[5], x = label.transform[4];
  const prose = items.filter(i => i.str.trim().length > 45 && i.height > 4
    && i.transform[5] < y - 2 && i.transform[5] > y - 90
    && i.transform[4] <= x + 20 && i.transform[4] + i.width > x + 50)
    .sort((a, b) => b.transform[5] - a.transform[5]);
  const first = prose[0];
  if (!first) return null;
  const left = first.transform[4] - 2;
  const nearby = prose.filter(i => first.transform[5] - i.transform[5] < 40 && Math.abs(i.transform[4] - first.transform[4]) < 12);
  const right = Math.min(pageWidth, Math.max(...nearby.map(i => i.transform[4] + i.width)) + 3);
  const candidates = items.filter(i => !ABSTRACT.test(i.str.trim()) && i.transform[5] < y - 2
    && i.transform[4] >= left && i.transform[4] + i.width <= right + 2)
    .sort((a, b) => b.transform[5] - a.transform[5]);
  let previous = first.transform[5], bottom = previous;
  for (const i of candidates) {
    const cy = i.transform[5];
    if (cy > first.transform[5] + first.height) continue;
    if (previous - cy > Math.max(first.height * 2.6, 18)) break;
    bottom = Math.min(bottom, cy - first.height * 0.4); previous = cy;
  }
  const box = [left, bottom, right, y + label.height + 2];
  const members = items.filter(i => inside(i, box));
  if (members.map(i => i.str).join(' ').length < 250) return null;
  return { box, members };
}

/** Identify independently supported front matter before merging ANY PDF text items.
 * Unmatched content stays body; uncertain content is not silently discarded.
 */
export function identifyPageRegions(rawItems, { page, width, height, panels = [] }) {
  const items = rawItems.map((item, i) => ({ ...item, sourceId: `p${page}-t${String(i + 1).padStart(5, '0')}` }));
  const meaningful = items.filter(i => i.str.trim());
  const horizontal = meaningful.filter(i => Math.abs(i.transform?.[1] || 0) < Math.abs(i.transform?.[0] || 1) * 0.5);
  const regions = [], claimed = new Set(), warnings = [];
  const add = (role, candidates, evidence, confidence = 'rule-supported') => {
    const members = candidates.filter(i => !claimed.has(i.sourceId));
    if (!members.length) return null;
    const id = `p${page}-r${regions.length + 1}`;
    for (const i of members) { claimed.add(i.sourceId); i.regionId = id; }
    const region = { id, role, evidence, confidence, bbox: unionBoxes(members.map(itemBox)),
      itemIds: members.map(i => i.sourceId) };
    regions.push(region); return region;
  };
  add('watermark', meaningful.filter(i => !horizontal.includes(i)), 'rotated-text');
  if (page === 1) {
    const long = horizontal.filter(i => i.str.length > 45 && i.height > 5).map(i => i.height).sort((a, b) => a - b);
    const bodySize = long[Math.floor(long.length / 2)] || 10;
    const abstractLabel = horizontal.find(i => ABSTRACT.test(i.str.trim()));
    const intro = horizontal.find(i => INTRO.test(i.str.trim()));
    let abstract = null;
    if (abstractLabel) {
      const labeled = labeledAbstract(horizontal, abstractLabel, width);
      if (labeled) {
        abstract = add('abstract', labeled.members, 'explicit-abstract-label+column+line-gaps');
        const articleLabel = horizontal.find(i => /^article(?:info)?$/u.test(i.str.replace(/\s/gu, '').toLowerCase())
          && Math.abs(i.transform[5] - abstractLabel.transform[5]) < 10 && i.transform[4] < labeled.box[0] - 30);
        if (articleLabel) add('article-info', horizontal.filter(i => i.transform[5] <= articleLabel.transform[5] + articleLabel.height
          && i.transform[5] >= labeled.box[1] && i.transform[4] + i.width < labeled.box[0] - 5),
        'article-info-label-beside-abstract');
      }
    }
    for (const box of abstract ? [] : panels) {
      const members = horizontal.filter(i => inside(i, box));
      const text = members.map(i => i.str).join(' ');
      const hasLabel = members.some(i => ABSTRACT.test(i.str.trim()));
      // A shaded figure/table is not an abstract. Require prose preceding/alongside
      // the Introduction and no section/table/caption numbering inside the panel.
      if (text.length < 500 || /\b(?:Figure|Table)\s+\d+\s*[.:]/u.test(text)
        || !hasLabel && (!intro || box[3] < intro.transform[5] - 35)
        || members.some(i => INTRO.test(i.str.trim()))) continue;
      abstract = add('abstract', members, hasLabel ? 'abstract-label+shaded-panel' : 'shaded-prose-before-introduction',
        hasLabel ? 'rule-supported' : 'inferred');
      if (abstract) break;
    }
    if (abstract && abstract.confidence === 'inferred') warnings.push('inferred-abstract: shaded first-page prose has no explicit Abstract label; review the overlay');
    if (!abstract && !abstractLabel && intro) {
      const sideProse = horizontal.filter(i => i.str.length > 45 && i.width > width * 0.33
        && i.transform[5] <= intro.transform[5] + 5 && i.transform[5] > intro.transform[5] - height * 0.45
        && i.transform[4] + i.width < intro.transform[4] - 5);
      if (sideProse.length >= 5) warnings.push('unresolved-side-prose: competing prose beside Introduction could not be classified; review before translation');
    }

    const contentTop = abstract ? abstract.bbox[3] : abstractLabel?.transform[5] ?? intro?.transform[5];
    if (contentTop) {
      const above = horizontal.filter(i => !claimed.has(i.sourceId) && i.transform[5] > contentTop + 5);
      const titleFonts = above.filter(i => i.height >= bodySize * 1.4).map(i => i.height)
        .filter(size => above.filter(i => Math.abs(i.height - size) < 0.2).reduce((n, i) => n + i.str.trim().length, 0) >= 35);
      const max = Math.max(0, ...titleFonts);
      const candidates = above.filter(i => i.height >= max * 0.92 && max >= bodySize * 1.4).sort((a, b) => b.transform[5] - a.transform[5]);
      const clusters = [];
      for (const i of candidates) {
        const last = clusters[clusters.length - 1];
        if (last && last[last.length - 1].transform[5] - i.transform[5] <= max * 2.2) last.push(i);
        else clusters.push([i]);
      }
      const title = clusters.filter(group => group.reduce((n, i) => n + i.str.trim().length, 0) >= 35)
        .sort((a, b) => b.reduce((n, i) => n + i.str.length, 0) - a.reduce((n, i) => n + i.str.length, 0))[0] || [];
      const titleRegion = add('title', title, 'largest-font-above-article');
      if (titleRegion) {
        add('front-matter', above.filter(i => i.transform[5] < titleRegion.bbox[1]
          && !PUBLICATION.test(i.str.trim())), 'between-title-and-article');
        add('publication', above.filter(i => !claimed.has(i.sourceId)), 'publisher-header-above-title');
      }
    }

    // Elsevier's correspondence/date/copyright band may sit above the conventional
    // 7.5% page footer. Expand it only when no normal-size body prose occupies it;
    // a Wiley affiliation block beside continuing body must NOT claim that band.
    const footerSeeds = horizontal.filter(i => i.transform[5] < height * 0.2 && i.height < bodySize * 0.96
      && (ORG.test(i.str) || PUBLICATION.test(i.str.trim())));
    const footerTop = Math.max(0, ...footerSeeds.map(i => i.transform[5] + i.height));
    const hasBodyInFooter = horizontal.some(i => !claimed.has(i.sourceId) && i.transform[5] <= footerTop
      && i.height >= bodySize * 0.98 && i.str.length > 45 && !PUBLICATION.test(i.str.trim()));
    if (footerTop && !hasBodyInFooter) add('publication', horizontal.filter(i => i.transform[5] <= footerTop),
      'isolated-small-font-correspondence-and-publication-band');

    // Affiliation blocks may sit halfway down page one. Follow their small-font
    // connected text, not the entire horizontal band (which also contains body).
    const small = horizontal.filter(i => !claimed.has(i.sourceId) && i.height < bodySize * 0.96
      && i.transform[5] < (contentTop || height * 0.75));
    const seeds = small.filter(i => ORG.test(i.str));
    const visited = new Set();
    for (const seed of seeds) {
      if (visited.has(seed.sourceId)) continue;
      const component = [seed]; visited.add(seed.sourceId);
      for (let cursor = 0; cursor < component.length; cursor++) {
        const m = component[cursor];
        for (const i of small) {
          if (visited.has(i.sourceId) || i.fontName !== m.fontName || Math.abs(i.height - m.height) >= 0.7
            || Math.abs(i.transform[5] - m.transform[5]) > Math.max(i.height, m.height) * 2.5
            || Math.abs(i.transform[4] - m.transform[4]) >= 30) continue;
          component.push(i); visited.add(i.sourceId);
        }
      }
      const affiliation = component.some(i => /\b(?:department|university|institute|laboratory|e-mail)\b|@/iu.test(i.str));
      add(affiliation ? 'affiliation' : 'publication', component, 'small-font-metadata-connected-component');
    }
    add('publication', horizontal.filter(i => !claimed.has(i.sourceId)
      && (PUBLICATION.test(i.str.trim()) || i.transform[5] < height * 0.15
        && /Elsevier.*(?:rights|reserved)|Wiley.*(?:rights|reserved)|©/iu.test(i.str))), 'explicit-publication-label');
  }
  // Do NOT claim body here: the extractor still needs to split columns, captions,
  // equations and width transitions. These objects retain stable source IDs.
  return { items, regions, warnings, abstract: regions.find(r => r.role === 'abstract') || null };
}

export function auditCoverage(items, regions, paragraphs) {
  const expected = new Set(items.filter(i => i.str.trim()).map(i => i.sourceId));
  const counts = new Map();
  for (const r of regions) for (const id of r.itemIds) counts.set(id, (counts.get(id) || 0) + 1);
  const missing = [...expected].filter(id => !counts.has(id));
  const duplicate = [...counts].filter(([, n]) => n > 1).map(([id]) => id);
  const unknown = [...counts.keys()].filter(id => !expected.has(id));
  const bodyIds = new Set(regions.filter(r => r.flow === 'article').flatMap(r => r.itemIds));
  const emitted = paragraphs.flatMap(p => p.sourceIds || []), outputCounts = new Map();
  for (const id of emitted) outputCounts.set(id, (outputCounts.get(id) || 0) + 1);
  const missingBody = [...bodyIds].filter(id => !outputCounts.has(id));
  const duplicateBody = [...outputCounts].filter(([, n]) => n > 1).map(([id]) => id);
  const unexpectedBody = [...outputCounts.keys()].filter(id => !bodyIds.has(id));
  return { ok: ![missing, duplicate, unknown, missingBody, duplicateBody, unexpectedBody].some(a => a.length),
    sourceItems: expected.size, missing, duplicate, unknown, missingBody, duplicateBody, unexpectedBody };
}
