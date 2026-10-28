/** Packaged bridge for the lab's shared AI pipeline. No access to lab data or human answers. */
import {readFile,writeFile,mkdir,readdir,rename} from 'node:fs/promises';
import {join,dirname} from 'node:path';import {createHash,randomUUID} from 'node:crypto';
import {AIService} from './partition_ai_service.mjs';
import {renderPageImage,validateProvider} from './partition_ai_layout.mjs';
import {validatePricing,priceUsage,sumCosts} from './partition_ai_cost.mjs';
import {validatePageRegions} from './manual_regions.mjs';
const json=async file=>JSON.parse(await readFile(file,'utf8'));
const optional=async file=>{try{return await json(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const hash=s=>createHash('sha256').update(s).digest('hex');
async function atomic(file,value){await mkdir(dirname(file),{recursive:true});const t=file+'.'+randomUUID()+'.tmp';await writeFile(t,JSON.stringify(value));await rename(t,file);}
const article=new Set(['body','abstract','heading','caption','formula','figure','table','references']);
const unknownCost=currency=>({currency,amount:null,low:null,high:null,known:false});
export function createPartitionIntegration({root,credentials,fetchImpl,render=renderPageImage}){
 const file=join(root,'ai-settings.json');
 async function settings(){const saved=await optional(file)||{},c=await credentials(),base=new URL(c.baseUrl),official=base.origin==='https://api.deepseek.com';
  const endpoint=saved.endpoint||(official?'https://api.deepseek.com/chat/completions':'');
  return{...saved,endpoint,model:saved.model||c.model||'deepseek-flash',maxTokens:saved.maxTokens||8192,semanticThinking:saved.semanticThinking||'low',pricing:validatePricing(saved.pricing),translationPricing:validatePricing(saved.translationPricing||saved.pricing),translationModel:c.model||'deepseek-flash',qualityPricing:validatePricing(saved.qualityPricing),ready:!!c.key&&!!endpoint,sharedKey:true,hasKey:!!c.key};
 }
 async function configure(input){if(input.apiKey!==undefined)throw Error('分区使用统一翻译 API 密钥；请在原有 API 配置中设置，不在这里另存密钥');
  const c=await credentials(),provider=validateProvider({...input,apiKey:''});if(new URL(provider.endpoint).origin!==new URL(c.baseUrl).origin)throw Error('共享密钥仅允许发往翻译服务的同一来源；如需其他服务，请先配置对应翻译服务，不能将现有密钥转发到另一域名');
  await atomic(file,{endpoint:provider.endpoint,model:provider.model,maxTokens:provider.maxTokens,semanticThinking:provider.semanticThinking,pricing:provider.pricing,translationPricing:validatePricing(input.translationPricing||input.pricing),qualityPricing:validatePricing(input.qualityPricing)});return settings();
 }
 function directory(slug){if(!slug||/[\\/:*?"<>|]|^\.+$/u.test(slug))throw Error('无效文献编号');return join(root,slug,'ai');}
 async function service(slug,{pdf,layout,sourceHash}={}){
  const dir=directory(slug);await mkdir(join(dir,'runs'),{recursive:true});
  const documentHash=hash(sourceHash||layout?.sourceHash||slug),baseId='run-'+hash(JSON.stringify([sourceHash,layout?.pages?.map(p=>({page:p.page,items:p.items,width:p.width,height:p.height}))])).slice(0,8)+'-1111-4111-8111-'+hash(sourceHash||slug).slice(0,12);
  const runFile=id=>{if(!/^run-[a-f0-9-]{36}$/u.test(id))throw Error('机器版本号无效');return join(dir,'runs',id+'.json');};
  if(layout){const prior=await optional(runFile(baseId));if(!prior){
   // Seed candidate metadata must not contain manual classifications/notes.
   const pages=layout.pages.map(p=>({page:p.page,width:p.width,height:p.height,rotation:p.rotation||0,items:p.items,regions:p.items.length?[{id:'native-page-'+p.page,role:'body',bbox:[0,0,p.width,p.height],itemIds:p.items.map(i=>i.id),label:'原生文字候选，未审查'}]:[]}));
   await atomic(runFile(baseId),{id:baseId,documentHash,pages,createdAt:new Date().toISOString()});
  }}
  const store={docDir:id=>{if(id!==documentHash)throw Error('PDF 来源不匹配');return dir;},document:async()=>({id:documentHash}),run:async(id,runId)=>{store.docDir(id);return json(runFile(runId));},createCandidateRun:async(id,parent,updates,provenance)=>{
   const base=await store.run(id,parent),byPage=new Map(updates.map(p=>[p.page,p])),run={...base,id:'run-'+randomUUID(),parentRunId:parent,createdAt:new Date().toISOString(),ai:provenance,pages:base.pages.map(p=>byPage.get(p.page)||p)};await atomic(runFile(run.id),run);return run;
  }};
  const ai=new AIService(store,{render:(_unused,n)=>render(pdf,n),...(fetchImpl?{fetchImpl}:{})});return{ai,documentHash,baseId,dir};
 }
 async function partition({slug,pdf,layout,sourceHash,onProgress=()=>{},consent=false,force=false,signal}){
  if(consent!==true)throw Error('AI 分区需要确认上传页面图像、相邻页原文及费用');const options=await settings(),c=await credentials();
  if(!options.endpoint||!c.key)throw Error('请先配置统一翻译 API 密钥与视觉模型');if(new URL(options.endpoint).origin!==new URL(c.baseUrl).origin)throw Error('分区与翻译服务来源不一致，拒绝共享密钥');
  const session=await service(slug,{pdf,layout,sourceHash}),{ai,documentHash,baseId}=session;ai.configure({...options,apiKey:c.key});
  const overrides={},pending=[],pages=[],errors=[],crossHolds=[];let activeBaseId=baseId,providerStopped=false;
  await atomic(join(session.dir,'latest.json'),{sourceHash,documentHash,baseId,pages:[],pending:[],phase:'running'});
  for(const p of layout.pages){
   signal?.throwIfAborted();
   onProgress({page:p.page,total:layout.pages.length,stage:'visual'});
   try{if(providerStopped)throw Error('服务鉴权、余额或配置失败，已停止后续页面请求；请修正配置后重试');const input={baseRunId:activeBaseId,pages:[p.page],workflow:'semantic-v1',consent:true,force},quote=await ai.estimate(documentHash,input),run=await ai.run(documentHash,{...input,quoteHash:quote.quoteHash},{signal,progress:progress=>onProgress({...progress,total:layout.pages.length})});activeBaseId=run.id;
    const corrected=run.pages.find(x=>x.page===p.page),issues=corrected.ai.pipeline,byId=new Map(),flag=(id,reason)=>{if(id)byId.set(id,[...(byId.get(id)||[]),reason]);};
    for(const r of corrected.regions)if(r.role==='unknown'||r.note||r.role==='formula'&&!r.formula?.reliable)flag(r.id,r.note||'公式或区域需人工核对');
    for(const issue of issues.review.issues){if(issue.page!==p.page){crossHolds.push(issue);continue;}if(issue.region)flag(issue.region,issue.message);else corrected.regions.forEach(r=>article.has(r.role)&&flag(r.id,issue.message));}
    if(issues.scopedIssues?.length){for(const issue of issues.scopedIssues){if(!issue.regions?.length)corrected.regions.filter(r=>article.has(r.role)).forEach(r=>flag(r.id,issue.message));else for(const id of issue.regions)flag(id,issue.message);}}
    else if(issues.issues?.length)corrected.regions.filter(r=>article.has(r.role)).forEach(r=>flag(r.id,issues.issues.join('；')));
    for(const link of issues.review.links)for(const end of [link.from,link.to]){if(end.page===p.page)flag(end.id,'跨页关联待确认：'+link.reason);else crossHolds.push({page:end.page,region:end.id,message:'跨页关联待确认：'+link.reason});}
    const drafts=corrected.regions.map(r=>({id:r.id,role:byId.has(r.id)||r.role==='unknown'?'pending':r.role,bbox:r.bbox}));
    // Strict native ownership validation: a geometrically invalid page is held, not silently dropped.
    overrides[p.page]=validatePageRegions(p,drafts).map(r=>({...r,confidence:r.role==='pending'?'review-required':'ai-candidate',evidence:'three-stage-ai'}));
    for(const r of corrected.regions)if(byId.has(r.id)||r.role==='unknown')pending.push({page:p.page,id:r.id,originalRole:r.role,reason:(byId.get(r.id)||['未分类区域']).join('；')});
    pages.push({page:p.page,runId:run.id,pipeline:issues});
   }catch(e){
    if(signal?.aborted)throw Error('AI 分区已停止，已发送请求可能收费；成功阶段缓存与用量已保留');
    if([400,401,402,403,404].includes(e.diagnostic?.httpStatus))providerStopped=true;
    overrides[p.page]=validatePageRegions(p,[{id:'ai-pending-page-'+p.page,role:'pending',bbox:[0,0,p.width,p.height]}]);pending.push({page:p.page,id:'ai-pending-page-'+p.page,originalRole:'unknown',reason:'AI 阶段失败或覆盖冲突，请人工分区'});errors.push({page:p.page,message:String(e.message).slice(0,2000)});
   }
  }
  for(const issue of crossHolds){const affected=overrides[issue.page]||[],exact=affected.some(r=>r.id===issue.region);for(const r of affected){if(r.role==='pending')continue;if(!article.has(r.role)||exact&&r.id!==issue.region)continue;pending.push({page:issue.page,id:r.id,originalRole:r.role,reason:issue.message});r.role='pending';r.confidence='review-required';}}
  const result={version:'plugin-ai-partition-v1',sourceHash,baseId,documentHash,pages,pending,errors,completedAt:new Date().toISOString()};await atomic(join(session.dir,'latest.json'),result);return{...result,overrides};
 }
 async function partitionCosts(slug){const last=await optional(join(directory(slug),'latest.json'));if(!last)return{pages:[],totals:[],note:'未调用 AI 分区，本地规则分区无 API 费用'};
  const {ai}=await service(slug,{sourceHash:last.sourceHash});const data=await ai.costs(last.documentHash),currencies=[...new Set(data.pages.flatMap(p=>p.totals.map(t=>t.currency)))];return{...data,totals:currencies.map(c=>sumCosts(data.pages.flatMap(p=>p.attempts.filter(a=>a.cost.currency===c).map(a=>a.cost)),c))};
 }
 async function finishTranslation(slug,job){const options=job.billingSettings||await settings(),rows=(job.usages||[]).map(u=>{
   const tariff=u.model===options.translationModel?options.translationPricing:u.model===options.qualityModel?options.qualityPricing:null;
   const anthropic=Number.isFinite(u.cache_read_input_tokens),total=u.prompt_tokens??(anthropic?(u.input_tokens??0)+u.cache_read_input_tokens+(u.cache_creation_input_tokens||0):u.input_tokens);
   const usage={prompt_tokens:total,completion_tokens:u.output_tokens??u.completion_tokens,prompt_cache_hit_tokens:anthropic?u.cache_read_input_tokens:u.prompt_cache_hit_tokens,prompt_cache_miss_tokens:anthropic?(u.input_tokens??0)+(u.cache_creation_input_tokens||0):u.prompt_cache_miss_tokens};
   return{model:u.model,at:u.requestedAt,usage,cost:tariff?priceUsage(usage,tariff):unknownCost(options.translationPricing.currency)};
  });
  const unknownRequests=Math.max(0,(job.apiChunks||0)-rows.length);if(unknownRequests)rows.push({unknownRequests,cost:unknownCost(options.translationPricing.currency)});
  const billingDir=join(directory(slug),'billing');await mkdir(billingDir,{recursive:true});if(!/^[A-Za-z0-9_-]+$/u.test(job.id))throw Error('无效计费任务号');
  await atomic(join(billingDir,job.id+'.json'),{jobId:job.id,phase:job.phase,at:new Date().toISOString(),pending:job.pendingRegions||[],rows,tariffs:{partition:options.pricing,translation:options.translationPricing,quality:options.qualityPricing},models:{translation:options.translationModel,quality:options.qualityModel}});
  const result=await report(slug,job);await atomic(join(directory(slug),'cost-report.json'),result);return result;
 }
 async function report(slug,job={}){const partition=await partitionCosts(slug),rows=[];let names=[];try{names=await readdir(join(directory(slug),'billing'));}catch(e){if(e.code!=='ENOENT')throw e;}
  for(const name of names.filter(n=>/^[A-Za-z0-9_-]+\.json$/u.test(n))){const b=await json(join(directory(slug),'billing',name));rows.push(...b.rows);}
  const currencies=[...new Set([...partition.totals.map(c=>c.currency),...rows.map(r=>r.cost.currency)])],translation=currencies.map(c=>sumCosts(rows.filter(r=>r.cost.currency===c).map(r=>r.cost),c)),totals=currencies.map(c=>sumCosts([...partition.totals.filter(p=>p.currency===c),...translation.filter(t=>t.currency===c)],c));
  const last=job.phase?null:await optional(join(directory(slug),'cost-report.json'));
  const result={version:'paper-cost-report/v1',settledAt:job.phase?new Date().toISOString():last?.settledAt||null,phase:job.phase||last?.phase||'snapshot',partial:job.phase?!!job.pendingRegions?.length:!!last?.partial,pendingCount:job.phase?job.pendingRegions?.length||0:last?.pendingCount||0,partition:{totals:partition.totals,pages:partition.pages},translation:{totals:translation,requests:rows.reduce((n,r)=>n+(r.unknownRequests||1),0)},totals,note:'分区与翻译分别累计历史调用；失败请求在内，本地复用不重复收费。按当时单价及接口用量折算，不是服务商账单；未知金额不按零计算。'};return result;
 }
 return{settings,configure,partition,partitionCosts,finishTranslation,report};
}
