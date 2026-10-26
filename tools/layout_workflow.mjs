import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { validatePageRegions } from './manual_regions.mjs';
import { MEDIA_POLICY, mediaOptions } from './media_regions.mjs';

const digest = data => createHash('sha256').update(data).digest('hex');
const fail = (message, status = 409) => { throw Object.assign(new Error(message), { status }); };
const MODES = ['auto', 'semi', 'manual'];
/** Persisted local-only preparation queue. No credentials and no model calls here. */
export function createLayoutWorkflow({ root, findPaper, extract, translate, isBusy }) {
  let tail = Promise.resolve();
  const locks = new Map(), pending = new Set();
  // UI polling must not repeatedly load/hash a whole PDF and parse every page.
  const hashes = new Map(), layouts = new Map();
  const stamp = s => `${s.size}/${s.mtimeMs}/${s.ctimeMs}/${s.ino}`;
  const retain = (cache,key,value,max) => { cache.delete(key);cache.set(key,value);while(cache.size>max)cache.delete(cache.keys().next().value);return value; };
  const dir = slug => join(root, slug);
  async function paperFor(slug) {
    // Never use an unvalidated client slug as a filesystem path.
    if (typeof slug !== 'string' || !slug || /[\\/:*?"<>|]|^\.+$/u.test(slug)) fail('文献编号无效', 400);
    const paper = await findPaper(slug);
    if (!paper) fail('文献不存在或没有 PDF', 404);
    return paper;
  }
  async function read(slug) {
    await paperFor(slug);
    try { return JSON.parse(await readFile(join(dir(slug), 'state.json'), 'utf8')); }
    catch (err) { if (err.code === 'ENOENT') return null; throw err; }
  }
  async function save(s) {
    await mkdir(dir(s.slug), { recursive: true });
    s.updatedAt = new Date().toISOString();
    const file = join(dir(s.slug), 'state.json');
    await writeFile(`${file}.tmp`, JSON.stringify(s), 'utf8');
    await rename(`${file}.tmp`, file);
    return s;
  }
  function serial(slug, fn) {
    const next = (locks.get(slug) || Promise.resolve()).catch(() => {}).then(fn);
    locks.set(slug, next);
    return next.finally(() => { if (locks.get(slug) === next) locks.delete(slug); });
  }
  async function sourceHash(slug) {
    const p = await paperFor(slug);
    const key=stamp(await stat(p.pdfAbs)),cached=hashes.get(p.pdfAbs);
    if(cached?.key===key)return cached.value;
    const hash=createHash('sha256');for await(const chunk of createReadStream(p.pdfAbs))hash.update(chunk);
    return retain(hashes,p.pdfAbs,{key,value:hash.digest('hex').slice(0,12)},8).value;
  }
  async function current(s, revision) {
    if (!s) fail('请先分区');
    if (revision !== undefined && revision !== s.revision) fail('分区已更新，请刷新后再操作');
    if (s.sourceHash !== await sourceHash(s.slug)) fail('PDF 已更改，请重新分区');
  }
  async function layout(s) {
    const key=stamp(await stat(s.layoutPath)),cached=layouts.get(s.layoutPath);
    if(cached?.key===key)return cached.value;
    return retain(layouts,s.layoutPath,{key,value:JSON.parse(await readFile(s.layoutPath,'utf8'))},2).value;
  }
  const summary = s => s && ({ slug: s.slug, title: s.title, mode: s.mode, phase: s.phase, revision: s.revision,
    media:mediaOptions(s.media), needsRefresh:s.preparationPolicy!==MEDIA_POLICY,
    sourceHash: s.sourceHash, pageCount: s.pageCount || 0, checkedPages: s.checkedPages || [],
    error: s.error || null, updatedAt: s.updatedAt, warnings: s.warnings || [], coverage: s.coverage || null,
    translationJobId: s.translationJobId || null });
  function enqueue(slug, revision, raw = false) {
    pending.add(slug);
    tail = tail.catch(() => {}).then(() => serial(slug, async () => {
      const s = await read(slug);
      if (!s || s.revision !== revision) return;
      try {
        await current(s);
        s.phase = 'partitioning'; await save(s);
        const result = await extract((await paperFor(slug)).pdfAbs, slug, undefined, {
          outputRoot: join(dir(slug), `r${revision}`), overrides: s.overrides, sourceHash: s.sourceHash,
          rawLayout: raw, allowReview: true, media:mediaOptions(s.media),
        });
        await current(s);
        s.layoutPath = result.layoutPath; s.mdPath = result.mdPath;
        s.mdHash = raw ? null : digest(result.md);
        s.preparedRevision = revision;
        s.preparationPolicy = MEDIA_POLICY;
        const l = await layout(s);
        s.pageCount = l.pages.length; s.warnings = l.warnings; s.coverage = l.coverage;
        s.hardWarnings = l.blockingWarnings || [];
        const safe = l.coverage?.ok && !s.hardWarnings.length && l.pages.every(p => p.items.length);
        s.phase = s.mode === 'auto' && safe ? 'approved' : 'review';
        if (s.mode === 'auto' && !safe) s.error = '自动自检未通过，已暂停。请检查分区后确认。';
        await save(s);
      } catch (err) {
        s.phase = 'failed'; s.error = String(err.message || err);
        if(err.recoveryLayoutPath){
          try{
            const l=JSON.parse(await readFile(err.recoveryLayoutPath,'utf8'));
            if(l.recovery===true&&l.sourceHash===s.sourceHash){
              s.layoutPath=err.recoveryLayoutPath;s.mdPath=null;s.mdHash=null;s.preparedRevision=null;
              s.pageCount=l.pages.length;s.coverage=l.coverage;s.warnings=l.warnings||[];s.hardWarnings=l.blockingWarnings||[];
              s.preparationPolicy=MEDIA_POLICY;s.phase='review';
              s.error='抽取自检发现内容归属问题，已保留原生文字与分区。请纠正待处理页；通过自检前不会启动翻译。';
            }
          }catch{/* An unreadable recovery file never authorizes translation. */}
        }
        await save(s);
      }
    })).then(async () => {
      pending.delete(slug);
      const s = await read(slug);
      if (s?.revision === revision && s.mode === 'auto' && s.phase === 'approved') {
        try {
          const job = await translate({ slug, schedule: s.schedule });
          await serial(slug, async () => { const latest = await read(slug); latest.translationJobId = job.jobId; await save(latest); });
        }
        catch (err) { await serial(slug, async () => { const latest = await read(slug); latest.error = `分区已完成，启动翻译失败：${err.message}`; await save(latest); }); }
      }
    }).catch(() => { pending.delete(slug); });
  }
  async function startOne(slug, mode, schedule, force, media) {
    return serial(slug, async () => {
      const p = await paperFor(slug), old = await read(slug);
      if (pending.has(slug) || isBusy(slug)) fail('此文献已有任务，请等待完成');
      const sameSource=old?.sourceHash === await sourceHash(slug), sameMedia=JSON.stringify(mediaOptions(old?.media))===JSON.stringify(mediaOptions(media));
      if (old && !force && sameSource && sameMedia && old.preparationPolicy===MEDIA_POLICY) return summary(old);
      const s = { slug, title: p.title || slug, mode, schedule: schedule === 'offpeak' ? 'offpeak' : 'now',
        phase: 'queued', revision: (old?.revision || 0) + 1, sourceHash: await sourceHash(slug),
        media:mediaOptions(media),overrides:!force&&sameSource ? old.overrides||{} : {}, checkedPages: [] };
      // Keep old revision files recoverable; new preparation never overwrites them.
      await save(s); enqueue(slug, s.revision, mode === 'manual'); return summary(s);
    });
  }
  async function get(slug, pageNumber) {
    const s = await read(slug);
    if (!s) return { state: null, page: null };
    if (['queued','partitioning'].includes(s.phase) && !pending.has(slug)) {
      s.phase = 'failed'; s.error = '上次分区被中断，请重新分区'; await serial(slug, () => save(s));
    }
    const result = { state: summary(s), page: null };
    if (s.layoutPath && !pending.has(slug)) {
      const l = await layout(s);
      result.page = l.pages.find(p => p.page === Number(pageNumber || 1)) || null;
      result.manualPages = Object.keys(s.overrides || {}).map(Number);
      result.blockingWarnings = l.blockingWarnings || [];
      result.stale = s.sourceHash !== await sourceHash(slug);
    }
    return result;
  }
  async function command(body) {
    if (body.action === 'start') {
      if (!MODES.includes(body.mode)) fail('分区模式无效', 400);
      const slugs = [...new Set(body.slugs || [body.slug])];
      if (!slugs.length || slugs.length > 200) fail('每批请选择 1–200 篇', 400);
      const results = [];
      for (const slug of slugs) {
        try { results.push({ state: await startOne(slug, body.mode, body.schedule, body.force === true, body.media) }); }
        catch (err) { results.push({ slug, error: err.message }); }
      }
      return { results };
    }
    return serial(body.slug, async () => {
      if (!Number.isInteger(body.revision)) fail('缺少当前分区版本号，请刷新', 400);
      const s = await read(body.slug); await current(s, body.revision);
      if (pending.has(body.slug) || isBusy(body.slug)) fail('分区或翻译进行中，暂时不能修改');
      if(body.action==='set-media'){
        s.media=mediaOptions(body.media);s.revision++;s.phase='queued';s.mode=s.mode==='auto'?'semi':s.mode;
        s.checkedPages=[];s.translationJobId=null;s.error=null;
        await save(s);enqueue(s.slug,s.revision,s.mode==='manual'&&Object.keys(s.overrides||{}).length!==s.pageCount);return {state:summary(s)};
      }
      const l = await layout(s);
      if (body.action === 'save-page') {
        const p = l.pages.find(p => p.page === body.page);
        if (!p) fail('页码无效', 400);
        if (/unresolved-page-(rotation|origin)/u.test((l.blockingWarnings || []).filter(w => w.page === body.page).map(w => w.message).join(' ')))
          fail('此页包含旋转或裁剪坐标，当前版本暂不支持人工覆盖', 422);
        s.overrides[p.page] = validatePageRegions(p, body.regions);
        s.revision++; s.phase = 'queued'; s.mode = s.mode === 'auto' ? 'semi' : s.mode; s.translationJobId = null;
        s.checkedPages = s.checkedPages.filter(n => n !== p.page); s.error = null;
        await save(s); enqueue(s.slug, s.revision); return { state: summary(s) };
      }
      if (body.action === 'check-page') {
        const p = l.pages.find(p => p.page === body.page);
        if (!p || !p.items.length) fail('此页没有可用文字层，需要先 OCR，不能仅靠画框翻译', 422);
        if (s.mode === 'manual' && !s.overrides[p.page]) fail('手动模式请先保存此页分区');
        s.checkedPages = [...new Set([...s.checkedPages, p.page])];
        await save(s); return { state: summary(s) };
      }
      if (body.action === 'approve' || body.action === 'translate') {
        if(s.preparationPolicy!==MEDIA_POLICY)fail('图表处理已升级，请应用图表选项重新抽取并检查；保留已有人工框。');
        if (s.preparedRevision !== s.revision || !s.mdHash) fail('当前分区版本尚未通过抽取自检，请先修正失败页面', 422);
        if (!l.coverage?.ok || s.hardWarnings?.length || !l.pages.every(p => p.items.length)) fail('自检未通过，仍有遗漏文字或复杂页，请先修正。扫描件须先 OCR。', 422);
        if (body.action === 'approve') {
          if (s.mode === 'manual' && l.pages.some(p => !s.overrides[p.page])) fail('手动模式须保存每页分区');
          if (body.confirmAll === true) s.checkedPages = l.pages.map(p => p.page);
          if (s.checkedPages.length !== s.pageCount) fail('请逐页检查，或明确确认已检查整篇');
          s.phase = 'approved'; s.error = null; await save(s);
        }
        if (body.action === 'translate' && s.phase !== 'approved') fail('请先确认整篇分区');
        if (body.action === 'translate' || body.translate === true) {
          const job = await translate({ slug: s.slug, schedule: body.schedule || s.schedule });
          return { state: summary(s), job };
        }
        return { state: summary(s) };
      }
      fail('不支持的分区操作', 400);
    });
  }
  async function guard(slug) {
    const s = await read(slug);
    if (!s) return null; // Legacy callers retain the automatic preflight below.
    await current(s);
    if(s.preparationPolicy!==MEDIA_POLICY)fail('公式/图表处理已升级，请先应用输出选项重新抽取并确认；不会自动重新付费翻译。');
    if (pending.has(slug) || s.phase !== 'approved') fail('请先完成分区预览与确认，再翻译');
    if (s.preparedRevision !== s.revision) fail('分区与抽取稿版本不一致，请重新检查');
    if (!s.mdHash) fail('分区尚未生成可翻译文本');
    return s;
  }
  async function prepared(slug) {
    const s = await guard(slug);
    if (!s) return null;
    const md = await readFile(s.mdPath, 'utf8');
    if (digest(md) !== s.mdHash) fail('抽取稿已变化，请重新分区并确认');
    return { md, mdPath: s.mdPath, warning: `按已确认分区翻译；公式优先 LaTeX，${mediaOptions(s.media).formulaFallback?'不确定时原图兜底':'不确定时保留待核对候选文本，不使用图片'}。`,
      layout: { version: (await layout(s)).version, coverage: s.coverage.sourceItems,
        reviewPages: [...new Set((s.warnings || []).map(w => w.page))], revision: s.revision } };
  }
  return { command, get, guard, prepared, summary, read, idle: () => tail };
}
