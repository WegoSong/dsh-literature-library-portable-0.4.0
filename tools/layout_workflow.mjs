import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { validatePageRegions } from './manual_regions.mjs';
import { MEDIA_POLICY, mediaOptions } from './media_regions.mjs';
import {writeJsonAtomic} from './atomic_json.mjs';
import {pageScope} from './page_scope.mjs';

const digest = data => createHash('sha256').update(data).digest('hex');
const fail = (message, status = 409) => { throw Object.assign(new Error(message), { status }); };
const MODES = ['auto', 'semi', 'manual'];
/** Persisted preparation queue. Local extraction plus explicitly consented AI adapter. */
export function createLayoutWorkflow({ root, findPaper, extract, translate, isBusy, partitionAI }) {
  let tail = Promise.resolve();
  const locks = new Map(), pending = new Set(),aiControllers=new Map();
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
    await writeJsonAtomic(file,s);
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
    translationJobId: s.translationJobId || null, ai:s.ai===true,aiProgress:s.aiProgress||null,aiStopped:s.aiStopped===true,pageEngines:s.pageEngines||{},lastPageTask:s.lastPageTask||null,aiWarnings:s.aiWarnings||[],protectedStop:s.protectedStop===true,translationSelection:s.translationSelection||{mode:'all'},pendingCount:s.pendingRegions?.length||0,
    pendingRegions:s.pendingRegions||[],canTranslate:!!(s.ai&&s.coverage?.ok&&!s.hardWarnings?.length&&s.preparedRevision===s.revision&&s.mdHash&&s.eligibleRegions>0&&['review','approved'].includes(s.phase)) });
  function enqueue(slug, revision, raw = false) {
    pending.add(slug);
    // Register before local extraction/queue wait, so an early Stop is not lost.
    const aiController=new AbortController();aiControllers.set(slug,aiController);
    tail = tail.catch(() => {}).then(() => serial(slug, async () => {
      const s = await read(slug);
      if (!s || s.revision !== revision) return;
      try {
        await current(s);
        s.phase = 'partitioning'; await save(s);
        let result = await extract((await paperFor(slug)).pdfAbs, slug, undefined, {
          outputRoot: join(dir(slug), `r${revision}`), overrides: s.overrides, sourceHash: s.sourceHash,
          rawLayout: raw||s.aiRequested||!!s.pageRequest, allowReview: true, media:mediaOptions(s.media),
        });
        if(s.pageRequest){
          const native=JSON.parse(await readFile(result.layoutPath,'utf8'));
          const target=pageScope.resolve(s.pageRequest.scope,native.pages.length),targetSet=new Set(target);
          const exclusions=s.pageRequest.localExclusions?.length?pageScope.parse(s.pageRequest.localExclusions,native.pages.length):[];
          if(s.pageRequest.engine==='ai'&&exclusions.some(n=>targetSet.has(n)))fail('AI 页码与本地保护页重叠，拒绝调用模型',422);
          s.lastPageTask={engine:s.pageRequest.engine,pages:target,localExclusions:exclusions,requestedAt:new Date().toISOString()};await save(s);
          const previous=s.previousLayoutPath?JSON.parse(await readFile(s.previousLayoutPath,'utf8')):null;
          const overrides={},engines={...(s.pageEngines||{})};
          for(const p of native.pages){
            const old=previous?.pages.find(x=>x.page===p.page);
            overrides[p.page]=old?old.regions:validatePageRegions(p,[{id:'unassigned-page-'+p.page,role:'pending',bbox:[0,0,p.width,p.height]}]);
            if(!engines[p.page])engines[p.page]=old?(s.previousAI?'ai':'local'):'pending';
          }
          let identified={pending:[],overrides:{}};
          if(s.pageRequest.engine==='ai'){
            if(!partitionAI)throw Error('AI 分区模块不可用');
            const controller=aiController;let progressTail=Promise.resolve();
            try{identified=await partitionAI.partition({slug,pdf:(await paperFor(slug)).pdfAbs,layout:native,sourceHash:s.sourceHash,selectedPages:target,consent:s.aiConsent,signal:controller.signal,onProgress:p=>{s.aiProgress=p;progressTail=progressTail.then(()=>save(s));}});}
            finally{await progressTail;aiControllers.delete(slug);}
            Object.assign(overrides,identified.overrides);s.aiStopped=identified.stopped===true;s.aiWarnings=identified.warnings||[];s.protectedStop=identified.protectedStop===true;
            for(const n of target)engines[n]=identified.overrides[n]?.every(r=>r.role==='pending')?'pending':'ai';
          }else{
            let local;
            try{const r=await extract((await paperFor(slug)).pdfAbs,slug,undefined,{outputRoot:join(dir(slug),`r${revision}`,'local-pages'),pages:target,sourceHash:s.sourceHash,allowReview:true,media:mediaOptions(s.media)});local=JSON.parse(await readFile(r.layoutPath,'utf8'));}
            catch(e){if(!e.recoveryLayoutPath)throw e;local=JSON.parse(await readFile(e.recoveryLayoutPath,'utf8'));if(local.recovery!==true||local.sourceHash!==s.sourceHash)throw e;}
            for(const p of local.pages){
              if(!targetSet.has(p.page))throw Error('本地抽取返回范围外页面');
              try{if(!local.coverage?.ok||local.blockingWarnings?.some(w=>w.page===p.page))throw Error('本地分区需人工纠错');overrides[p.page]=validatePageRegions(p,p.regions);engines[p.page]='local';}
              catch{const np=native.pages.find(x=>x.page===p.page);overrides[p.page]=validatePageRegions(np,[{id:'local-pending-page-'+p.page,role:'pending',bbox:[0,0,np.width,np.height]}]);engines[p.page]='pending';}
            }
            s.aiStopped=false;
          }
          s.aiPendingEvidence=[...(s.aiPendingEvidence||[]).filter(r=>!targetSet.has(r.page)),...(identified.pending||[])];
          s.checkedPages=s.checkedPages.filter(n=>!targetSet.has(n));s.overrides=overrides;s.pageEngines=engines;s.ai=Object.values(engines).includes('ai')||s.pageRequest.engine==='ai';
          s.aiRequested=false;s.aiProgress=null;s.pageRequest=null;s.previousLayoutPath=null;
          result=await extract((await paperFor(slug)).pdfAbs,slug,undefined,{outputRoot:join(dir(slug),`r${revision}`,'mixed-final'),overrides,sourceHash:s.sourceHash,allowReview:true,media:mediaOptions(s.media)});
        }
        if(s.aiRequested){
          if(!partitionAI)throw Error('AI 分区模块不可用');
          const native=JSON.parse(await readFile(result.layoutPath,'utf8'));
          let progressTail=Promise.resolve(),identified;const controller=aiController;
          try{identified=await partitionAI.partition({slug,pdf:(await paperFor(slug)).pdfAbs,layout:native,sourceHash:s.sourceHash,consent:s.aiConsent,signal:controller.signal,
            onProgress:p=>{s.aiProgress=p;progressTail=progressTail.then(()=>save(s));}});}finally{await progressTail;aiControllers.delete(slug);}
          s.aiPendingEvidence=identified.pending;s.pendingRegions=identified.pending;s.aiErrors=identified.errors;s.aiRequested=false;s.aiProgress=null;s.aiStopped=identified.stopped===true;s.aiWarnings=identified.warnings||[];s.protectedStop=identified.protectedStop===true;
          // Explicit user edits win over automatic candidates and are never AI input.
          s.overrides={...identified.overrides,...(s.overrides||{})};
          result=await extract((await paperFor(slug)).pdfAbs,slug,undefined,{outputRoot:join(dir(slug),`r${revision}`,'ai-final'),overrides:s.overrides,sourceHash:s.sourceHash,allowReview:true,media:mediaOptions(s.media)});
        }
        await current(s);
        s.layoutPath = result.layoutPath; s.mdPath = result.mdPath;
        s.mdHash = raw ? null : digest(result.md);
        s.preparedRevision = revision;
        s.preparationPolicy = MEDIA_POLICY;
        const l = await layout(s);
        const deferred=l.pages.flatMap(p=>p.regions.filter(r=>r.role==='pending').map(r=>({page:p.page,id:r.id,...(s.aiPendingEvidence||[]).find(x=>x.page===p.page&&x.id===r.id)})));s.pendingRegions=deferred;
        s.eligibleRegions=l.pages.reduce((n,p)=>n+p.regions.filter(r=>['body','abstract','heading','caption','table','formula'].includes(r.role)&&r.itemIds?.length).length,0);
        s.pageCount = l.pages.length; s.warnings = l.warnings; s.coverage = l.coverage;
        s.pageEngines=Object.fromEntries(l.pages.map(p=>[p.page,s.pageEngines?.[p.page]||(p.regions.every(r=>r.role==='pending')?'pending':s.ai?'ai':s.mode==='manual'?'manual':'local')]));
        s.hardWarnings = l.blockingWarnings || [];
        s.pagesReady=l.pages.every(p=>p.items.length||s.ai&&p.regions.some(r=>r.role==='pending'));
        const safe = l.coverage?.ok && !s.hardWarnings.length && s.pagesReady;
        s.phase = (s.mode === 'auto'||s.aiApprovalRequested) && safe && !s.pendingRegions?.length ? 'approved' : 'review';
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
      if(aiControllers.get(slug)===aiController)aiControllers.delete(slug);
      const s = await read(slug);
      if (s?.revision === revision && s.mode === 'auto' && !s.aiStopped && !s.protectedStop && (s.phase === 'approved'||summary(s).canTranslate)) {
        try {
          const job = await translate({ slug, schedule: s.schedule });
          await serial(slug, async () => { const latest = await read(slug); latest.translationJobId = job.jobId; await save(latest); });
        }
        catch (err) { await serial(slug, async () => { const latest = await read(slug); latest.error = `分区已完成，启动翻译失败：${err.message}`; await save(latest); }); }
      }
    }).catch(() => { pending.delete(slug);if(aiControllers.get(slug)===aiController)aiControllers.delete(slug); });
  }
  async function startOne(slug, mode, schedule, force, media, ai=false,aiConsent=false,pageRequest=null) {
    return serial(slug, async () => {
      const p = await paperFor(slug), old = await read(slug);
      if (pending.has(slug) || isBusy(slug)) fail('此文献已有任务，请等待完成');
      const sameSource=old?.sourceHash === await sourceHash(slug), sameMedia=JSON.stringify(mediaOptions(old?.media))===JSON.stringify(mediaOptions(media));
      if(pageRequest&&sameSource&&old?.pageCount)pageScope.resolve(pageRequest.scope,old.pageCount);
      if(ai&&(!partitionAI||aiConsent!==true))fail('AI 分区需确认发送与费用',400);
      if(ai&&mode==='manual')fail('手动模式不调用 AI，请选择自动或半自动',400);
      if (old && !pageRequest && !force && sameSource && sameMedia && old.preparationPolicy===MEDIA_POLICY) return summary(old);
      const s = { slug, title: p.title || slug, mode, schedule: schedule === 'offpeak' ? 'offpeak' : 'now',
        phase: 'queued', revision: (old?.revision || 0) + 1, sourceHash: await sourceHash(slug),
        media:mediaOptions(media),overrides:!force&&sameSource ? old?.overrides||{} : {}, checkedPages: pageRequest&&sameSource?old?.checkedPages||[]:[],ai:ai||!!(pageRequest&&sameSource&&old?.ai),aiRequested:ai&&!pageRequest,aiConsent:ai&&aiConsent,
        ...(pageRequest?{pageRequest,previousAI:sameSource&&old?.ai,previousLayoutPath:sameSource?old?.layoutPath:null,pageEngines:sameSource?old?.pageEngines||{}:{},aiPendingEvidence:sameSource?old?.aiPendingEvidence||[]:[],translationSelection:sameSource?old?.translationSelection:null}:{}), };
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
    if(body.action==='cancel-ai'){await paperFor(body.slug);const controller=aiControllers.get(body.slug);controller?.abort();return{cancelRequested:!!controller};}
    if(body.action==='partition-pages'){
      if(!['local','ai'].includes(body.engine))fail('分区引擎无效',400);
      if(!body.scope||!['all','selected'].includes(body.scope.mode))fail('请选择全部或指定页数',400);
      if(body.scope.mode==='selected')pageScope.parse(body.scope.pages,100000);
      const localExclusions=body.localExclusions?.length?pageScope.parse(body.localExclusions,100000):[];
      if(body.engine==='ai'&&localExclusions.length){const excluded=new Set(localExclusions);if(body.scope.mode==='all'||pageScope.parse(body.scope.pages,100000).some(n=>excluded.has(n)))fail('AI 页码与本地保护页重叠，拒绝调用模型；请调整到不重叠范围',422);}
      return{state:await startOne(body.slug,'semi',body.schedule,false,body.media,body.engine==='ai',body.aiConsent===true,{engine:body.engine,scope:body.scope,localExclusions})};
    }
    if (body.action === 'start') {
      if (!MODES.includes(body.mode)) fail('分区模式无效', 400);
      if(body.engine==='ai'&&(!body.scope||!['all','selected'].includes(body.scope.mode)))fail('AI 分区必须明确选择全部或指定页数；旧整篇入口已禁用，请从 PDF 页码下的页面任务启动',422);
      const slugs = [...new Set(body.slugs || [body.slug])];
      if (!slugs.length || slugs.length > 200) fail('每批请选择 1–200 篇', 400);
      const results = [];
      for (const slug of slugs) {
        try { results.push({ state: await startOne(slug, body.mode, body.schedule, body.force === true, body.media,body.engine==='ai',body.aiConsent===true,body.engine==='ai'?{engine:'ai',scope:body.scope}:null) }); }
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
      if(body.action==='recheck-ai-cache'){
        if(!partitionAI?.replay)fail('当前服务尚未加载离线自检，请更新后重启 DSH',422);
        const replay=await partitionAI.replay({slug:s.slug,layout:l,sourceHash:s.sourceHash}),applied=[];
        s.overrides||={};
        for(const n of replay.replayed){
          const engine=s.pageEngines?.[n],manual=s.overrides[n]?.some(r=>r.evidence==='manual-page-replacement');
          if(['manual','local'].includes(engine)||s.checkedPages.includes(n)||manual)continue;
          s.overrides[n]=replay.overrides[n];s.pageEngines={...s.pageEngines,[n]:replay.overrides[n].every(r=>r.role==='pending')?'pending':'ai'};applied.push(n);
        }
        if(!applied.length)fail('没有可自动更新的 AI 缓存页；人工、本地或已确认页保持不变，未调用 AI',422);
        const appliedSet=new Set(applied);s.aiPendingEvidence=[...(s.aiPendingEvidence||[]).filter(r=>!appliedSet.has(r.page)),...replay.pending.filter(r=>appliedSet.has(r.page))];
        s.aiWarnings=replay.warnings;s.aiRequested=false;s.aiProgress=null;s.revision++;s.phase='queued';s.mode='semi';s.translationJobId=null;s.error=null;
        s.lastPageTask={engine:'cache-recheck',pages:applied,networkRequests:0,requestedAt:new Date().toISOString()};
        await save(s);enqueue(s.slug,s.revision);return{state:summary(s),replayedPages:applied,networkRequests:0};
      }
      if(body.action==='translate'&&body.scope){
        const pages=pageScope.resolve(body.scope,s.pageCount);
        if(body.scope.mode==='selected'){
          if(body.confirmPages!==true)fail('请确认已检查指定页的分区',422);
          if(!l.pages.some(p=>pages.includes(p.page)&&p.regions.some(r=>['body','abstract','heading','caption','table','formula'].includes(r.role)&&r.itemIds?.length)))fail('所选页面没有可翻译区域，请先分区或纠错',422);
          s.translationSelection={mode:'selected',pages};s.checkedPages=[...new Set([...s.checkedPages,...pages])];await save(s);
          const job=await translate({slug:s.slug,schedule:body.schedule||s.schedule});return{state:summary(s),job};
        }
        s.translationSelection={mode:'all'};
        if(body.confirmPages===true&&l.coverage?.ok&&!s.hardWarnings?.length&&s.mdHash&&s.preparedRevision===s.revision){s.checkedPages=l.pages.map(p=>p.page);s.phase='approved';}
        await save(s);
      }
      if(s.ai&&(body.action==='check-page'||body.action==='approve')&&s.pendingRegions?.length){
        const targets=body.action==='approve'&&body.confirmAll===true?l.pages.map(p=>p.page):[body.page];
        const pending=(s.pendingRegions||[]).filter(r=>targets.includes(r.page));
        if(pending.some(r=>!r.originalRole||r.originalRole==='unknown'))fail('仍有未分类或识别失败区域，请先手动纠错并保存，不能仅点击确认',422);
        if(pending.length){for(const n of targets){const p=l.pages.find(p=>p.page===n);if(!p)continue;const restored=p.regions.map(r=>({...r,role:pending.find(x=>x.page===n&&x.id===r.id)?.originalRole||r.role}));s.overrides[n]=validatePageRegions(p,restored);}
          s.checkedPages=[...new Set([...s.checkedPages,...targets])];s.revision++;s.phase='queued';s.aiApprovalRequested=body.action==='approve';s.mode='semi';s.translationJobId=null;s.error=null;
          await save(s);enqueue(s.slug,s.revision);return{state:summary(s)};
        }
      }
      if (body.action === 'save-page') {
        const p = l.pages.find(p => p.page === body.page);
        if (!p) fail('页码无效', 400);
        if (/unresolved-page-(rotation|origin)/u.test((l.blockingWarnings || []).filter(w => w.page === body.page).map(w => w.message).join(' ')))
          fail('此页包含旋转或裁剪坐标，当前版本暂不支持人工覆盖', 422);
        s.overrides[p.page] = validatePageRegions(p, body.regions);
        s.pageEngines={...s.pageEngines,[p.page]:'manual'};
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
        if (!l.coverage?.ok || s.hardWarnings?.length || !l.pages.every(p=>p.items.length||s.ai&&p.regions.some(r=>r.role==='pending'))) fail('自检未通过，仍有遗漏文字或复杂页，请先修正。扫描件须先 OCR。', 422);
        if (body.action === 'approve') {
          if (s.mode === 'manual' && l.pages.some(p => !s.overrides[p.page])) fail('手动模式须保存每页分区');
          if (body.confirmAll === true) s.checkedPages = l.pages.map(p => p.page);
          if (s.checkedPages.length !== s.pageCount) fail('请逐页检查，或明确确认已检查整篇');
          s.phase = 'approved'; s.error = null; await save(s);
        }
        if (body.action === 'translate' && s.phase !== 'approved'&&!summary(s).canTranslate) fail('请先确认整篇分区');
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
    if(s.translationSelection?.mode==='selected'){
      if(pending.has(slug))fail('分区正在进行，请先停止或等待完成');
      if(!s.layoutPath)fail('请先生成可检查的分区');
      const pages=pageScope.parse(s.translationSelection.pages,s.pageCount);
      if(pages.some(n=>!s.checkedPages.includes(n)))fail('指定页分区已修改，请重新检查并从页面任务提交翻译');
      return s;
    }
    if (pending.has(slug) || s.phase !== 'approved'&&!summary(s).canTranslate) fail('请先完成分区预览与确认，再翻译');
    if((s.ai||s.pendingRegions?.length)&&!s.eligibleRegions)fail('所有可译区域仍待确认，请先纠错或确认至少一个区域，未调用翻译 API');
    if (s.preparedRevision !== s.revision) fail('分区与抽取稿版本不一致，请重新检查');
    if (!s.mdHash) fail('分区尚未生成可翻译文本');
    return s;
  }
  async function prepared(slug) {
    const s = await guard(slug);
    if (!s) return null;
    if(s.translationSelection?.mode==='selected'){
      const pages=pageScope.parse(s.translationSelection.pages,s.pageCount),selected=new Set(pages),original=await layout(s);
      const overrides=Object.fromEntries(original.pages.filter(p=>selected.has(p.page)).map(p=>[p.page,p.regions]));
      const r=await extract((await paperFor(slug)).pdfAbs,slug,undefined,{outputRoot:join(dir(slug),`r${s.revision}`,'translations',digest(pages.join(',')).slice(0,12)),pages,overrides,sourceHash:s.sourceHash,allowReview:false,media:mediaOptions(s.media)});
      const l=JSON.parse(await readFile(r.layoutPath,'utf8'));
      if(!l.coverage?.ok||l.blockingWarnings?.length||l.pages.length!==pages.length||l.pages.some(p=>!selected.has(p.page)||!p.items.length))fail('指定页抽取自检未通过，未调用翻译模型',422);
      const holds=l.pages.flatMap(p=>p.regions.filter(r=>r.role==='pending').map(r=>({page:p.page,id:r.id})));
      return{md:`<!-- 仅翻译 PDF 页 ${pageScope.format(pages)}；不是全文译文 -->\n`+r.md,mdPath:r.mdPath,warning:`仅翻译 PDF 第 ${pageScope.format(pages)} 页；其他页不发送给翻译模型。`,layout:{version:l.version,coverage:l.coverage.sourceItems,reviewPages:[...new Set((l.warnings||[]).map(w=>w.page))],revision:s.revision,ai:s.ai,pendingRegions:holds,selectedPages:pages}};
    }
    const md = await readFile(s.mdPath, 'utf8');
    if (digest(md) !== s.mdHash) fail('抽取稿已变化，请重新分区并确认');
    return { md, mdPath: s.mdPath, warning: `${s.ai?'按 AI 自检可用分区翻译；'+(s.pendingRegions?.length||0)+' 个待确认区域已跳过，纠错后补译。':'按已确认分区翻译；'}公式优先 LaTeX，${mediaOptions(s.media).formulaFallback?'不确定时原图兜底':'不确定时保留待核对候选文本，不使用图片'}。`,
      layout: { version: (await layout(s)).version, coverage: s.coverage.sourceItems,
        reviewPages: [...new Set((s.warnings || []).map(w => w.page))], revision: s.revision,ai:s.ai===true,pendingRegions:s.pendingRegions||[] } };
  }
  return { command, get, guard, prepared, summary, read, idle: () => tail };
}
