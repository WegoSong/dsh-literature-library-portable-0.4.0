/** Versioned semantic workflow. Local preparation/review never calls a provider. */
import {readFile,writeFile,mkdir,access} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {writeJsonAtomic} from './atomic_json.mjs';
import {prepareArticle,renderArticleImages,checkArticleBudget} from './article_native.mjs';
import {SCHEMA,validateStructure} from './article_structure_contract.mjs';
import {ARTICLE_STRUCTURE_PROMPT,ARTICLE_AUDIT_RULES} from './article_structure_prompt.mjs';
import {TRANSLATION_PROMPT,translationTargets,validateArticleTranslation,renderArticleMarkdown,articleMedia,textForObject} from './article_translation.mjs';
import {priceUsage,sumCosts} from './partition_ai_cost.mjs';
import {isPeakShanghai,nextOffpeakTime} from './translation_pipeline.mjs';
import {validateArticleLimits,DEFAULT_ARTICLE_LIMITS} from './article_limits.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
const read=async p=>JSON.parse(await readFile(p,'utf8'));
const fail=(message,status=422)=>Object.assign(Error(message),{status});
const cleanError=e=>String(e?.message||e).replace(/(?:sk-|dsh_)[A-Za-z0-9_-]{12,}/gu,'[REDACTED]').slice(0,1500);
const parseJSON=s=>JSON.parse(String(s).trim().replace(/^```(?:json)?\s*/u,'').replace(/\s*```$/u,''));
export function normalizeArticleAccountUsage(u){return u?{prompt_tokens:Number.isFinite(u.input_tokens)?u.input_tokens+(u.cache_read_input_tokens||0)+(u.cache_creation_input_tokens||0):undefined,completion_tokens:u.output_tokens,...(Number.isFinite(u.cache_read_input_tokens)?{prompt_cache_hit_tokens:u.cache_read_input_tokens}:{}),...(Number.isFinite(u.reasoning_tokens)?{reasoning_tokens:u.reasoning_tokens}:{})}:null;}
export function reviewArticle(index,input){
 const validation=validateStructure(index,input),warnings=[...validation.warnings],objects=new Map((Array.isArray(index?.objects)?index.objects:[]).filter(o=>o&&typeof o.id==='string').map(o=>[o.id,o]));
 if(validation.ok){
  for(const issue of index.issues)for(const id of issue.objects)warnings.push({code:'ai-'+issue.kind,id,message:issue.message});
  for(const o of index.objects){
   const text=textForObject(o,input).join(' ');
   if(o.type==='heading'&&/^\s*(?:appendix|appendices|附录)\b/iu.test(text)&&o.part!=='back')warnings.push({code:'appendix-category',id:o.id,message:'附录标题应归入后置信息，请检查所属对象类别'});
   let parent=objects.get(o.parent),seen=new Set();
   while(parent&&!seen.has(parent.id)){seen.add(parent.id);if(/^\s*(?:appendix|appendices|附录)\b/iu.test(textForObject(parent,input).join(' '))&&o.part!=='back')warnings.push({code:'appendix-child-category',id:o.id,message:'附录所属对象类别需要核对'});parent=objects.get(parent.parent);}
   if(o.type==='figure')warnings.push({code:'media-box-review',id:o.id,message:'插入图像前需核对整图外缘；原生文字完整不代表图框完整'});
   if(o.type==='unknown')warnings.push({code:'unclassified-object',id:o.id,message:'此对象尚未分类，不自动进入翻译'});
  }
 }
 return{...validation,warnings};
}
export function createArticleWorkflow({root,findPaper,generate,settings,publish,assetUrl=file=>file,prepare=prepareArticle,render=renderArticleImages,now=()=>new Date()}){
 const active=new Map(),waiting=new Map();let queue=Promise.resolve(),consecutiveFailures=0;
 function folder(slug){if(typeof slug!=='string'||!slug||/[\\/:*?"<>|]|^\.+$/u.test(slug))throw fail('无效文献编号');return join(root,slug);}
 const stateFile=slug=>join(folder(slug),'state.json');
 async function load(slug){try{return await read(stateFile(slug));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
 async function save(s){s.updatedAt=new Date().toISOString();await writeJsonAtomic(join(folder(s.slug),s.revision,'state.json'),s);await writeJsonAtomic(stateFile(s.slug),s);}
 async function get(slug){await paperFor(slug);const s=await load(slug);if(!s)return{state:null};if(active.has(slug)&&!['queued','running','stopping'].includes(s.phase))return{state:{...s,phase:'running',stage:'正在保存结果与费用'}};if(['queued','running','stopping'].includes(s.phase)&&!active.has(slug)){s.phase='interrupted';s.stage='上次任务已中断；不会自动重发收费请求';await save(s);}return{state:s};}
 async function paperFor(slug){folder(slug);const p=await findPaper(slug);if(!p?.pdfAbs)throw fail('文献不存在或没有原始 PDF',404);return p;}
 async function assertSource(s){const p=await paperFor(s.slug);if(hash(await readFile(p.pdfAbs))!==s.sourceHash)throw fail('原始 PDF 已变化，请重新准备；未继续使用旧地址');return p;}
 async function inputFor(s){return read(join(folder(s.slug),s.revision,'input.json'));}
 async function record(s,stage,callback,maxTokens){
  const config=await settings(),pricing=stage==='structure'?config.pricing:config.translationPricing;
  const attempt={id:randomUUID(),stage,maxTokens,provider:config.mode,model:stage==='structure'?config.model:config.translationModel||config.model,at:new Date().toISOString(),status:'started',usage:null,cost:priceUsage(null,pricing)};s.costs.push(attempt);await save(s);
  try{const response=await callback(config);await writeFile(join(folder(s.slug),s.revision,attempt.id+'-response.txt'),response.text||'',{flag:'wx'});attempt.usage=response.usage||null;attempt.cost=priceUsage(attempt.usage,pricing);attempt.status=response.truncated?'truncated':'done';attempt.finishedAt=new Date().toISOString();await save(s);if(response.truncated)throw fail(`输出达到上限（本次请求 ${maxTokens} token，含思考）；请在「调用上限」调整后手动重试，或缩小页码范围。原响应和用量已保存，未自动重试或提高预算`);return response;}
  catch(e){attempt.usage=e.usage||attempt.usage;attempt.cost=priceUsage(attempt.usage,pricing);attempt.status=attempt.status==='truncated'?'truncated':'failed';attempt.error=cleanError(e);await save(s);throw e;}
 }
 async function contentFor(s,input,signal){
  const dir=join(folder(s.slug),s.revision),manifestFile=join(dir,'images.json');let images;
  try{images=await read(manifestFile);}catch(e){if(e.code!=='ENOENT')throw e;const p=await assertSource(s);images=await render(p.pdfAbs,input,join(dir,'images'),{signal,onProgress:progress=>{s.stage=progress.stage+' '+progress.page;}});await writeJsonAtomic(manifestFile,images);}
  const content=[];for(const image of images){signal.throwIfAborted();content.push({type:'text',text:'PDF page '+image.page},{type:'image_url',image_url:{url:'data:image/png;base64,'+(await readFile(image.file)).toString('base64')}});}return content;
 }
 async function analyze(s,body,signal){
  const input=await inputFor(s);checkArticleBudget(input);await assertSource(s);s.structureAttempted=true;s.phase='running';s.stage='AI 阅读文章并建立结构清单';await save(s);
  const content=[{type:'text',text:JSON.stringify(input)},...await contentFor(s,input,signal)];
  const cap=body.limits.structureMaxTokens;
  const response=await record(s,'structure',config=>generate({stage:'structure',providerMode:config.mode,model:config.model,system:ARTICLE_STRUCTURE_PROMPT+'\n'+ARTICLE_AUDIT_RULES,content,reasoningEffort:'low',maxTokens:cap,signal}),cap);
  await writeFile(join(folder(s.slug),s.revision,'structure-response.txt'),response.text,{flag:'wx'});
  try{s.structure=parseJSON(response.text);}catch{throw fail('AI 返回不是完整 JSON；原响应保留，未修复或重试');}
  s.checks=reviewArticle(s.structure,input);s.pendingIds=s.checks.ok?[...new Set(s.checks.warnings.filter(w=>['appendix-category','appendix-child-category','unclassified-object','ai-classification'].includes(w.code)&&w.id).map(w=>w.id))]:[];s.reviewed=false;s.phase='review';s.stage=s.checks.ok?'结构清单待检查':'结构校验未通过，请纠错';await save(s);
  if(body.auto===true&&s.checks.ok&&translationTargets(s.structure,input,s.media,s.pendingIds).length){s.reviewed=true;s.autoTranslationReady=true;s.stage='可用内容自检通过，疑点对象暂缓，等待已授权翻译';await save(s);}
 }
 async function translate(s,body,signal){
  const input=await inputFor(s);await assertSource(s);s.checks=reviewArticle(s.structure,input);
  if(!s.checks.ok)throw fail('清单结构不合法，不能安全展开；请先纠错，未调用翻译');
  if(!s.reviewed)throw fail('请先检查并确认结构清单；未调用翻译');
  const pending=[...new Set([...(s.pendingIds||[]),...s.structure.objects.filter(o=>o.type==='unknown'&&o.part!=='running_matter').map(o=>o.id)])],targets=translationTargets(s.structure,input,s.media,pending);
  if(!targets.length)throw fail('没有可翻译对象；未调用模型');
  const payload={scope:input.scope,structure:s.structure,targets};checkArticleBudget(input);if(JSON.stringify(payload).length>500000)throw fail('翻译输入超过本地预算，请明确缩小范围；未截断或自动拆分');
  s.phase='running';s.stage='阅读全文并连续翻译';await save(s);
  const cap=body.limits.translationMaxTokens;
  const response=await record(s,'translation',async config=>generate({stage:'translation',providerMode:config.mode,model:config.translationModel||config.model,system:TRANSLATION_PROMPT,content:[{type:'text',text:JSON.stringify(payload)},...await contentFor(s,input,signal)],reasoningEffort:'low',maxTokens:cap,signal}),cap);
  const runId=randomUUID(),runDir=join(folder(s.slug),s.revision,'translations',runId);await mkdir(runDir,{recursive:true});await writeFile(join(runDir,'response.txt'),response.text,{flag:'wx'});
  let translated;try{translated=parseJSON(response.text);}catch{throw fail('翻译返回不是完整 JSON；原响应保留，未自动重试');}
  const check=await validateArticleTranslation(translated,targets);await writeJsonAtomic(join(runDir,'validation.json'),check);
  if(!check.ok){s.translationValidation=check;throw fail('译文对象或片段数量不完整；已保留诊断，未发布为完成译稿');}
  const held=[...pending.map(id=>({id,reason:'人工暂缓'})),...check.pending],partial=input.scope.not_full_article||held.length>0;
  // Figure crops require explicit approval; unsafe AI boxes never silently produce an image.
  const assets={};
  async function crop(o){
   const imageManifest=await read(join(folder(s.slug),s.revision,'images.json')),first=o.source[0],page=input.pages.find(p=>p.page===first.page),image=imageManifest.find(p=>p.page===first.page);
   if(!page||!image)return null;
   const boxes=o.source.filter(s=>s.page===first.page).flatMap(s=>s.box?[s.box]:page.fragments.slice(page.fragments.findIndex(f=>f.id===s.start),page.fragments.findIndex(f=>f.id===s.end)+1).map(f=>f.box));if(!boxes.length)return null;
   const b=[Math.max(0,Math.min(...boxes.map(b=>b[0]))-3),Math.max(0,Math.min(...boxes.map(b=>b[1]))-3),Math.min(page.width,Math.max(...boxes.map(b=>b[2]))+3),Math.min(page.height,Math.max(...boxes.map(b=>b[3]))+3)];
   const {createCanvas,loadImage}=await import('@napi-rs/canvas'),source=await loadImage(image.file),sx=source.width/page.width,sy=source.height/page.height,x=Math.floor(b[0]*sx),y=Math.floor((page.height-b[3])*sy),w=Math.ceil((b[2]-b[0])*sx),h=Math.ceil((b[3]-b[1])*sy),canvas=createCanvas(w,h);
   try{canvas.getContext('2d').drawImage(source,x,y,w,h,0,0,w,h);const path=join(runDir,'asset-'+hash(o.id).slice(0,16)+'.png');await writeFile(path,canvas.toBuffer('image/png'),{flag:'wx'});return assetUrl(path);}finally{canvas.width=0;canvas.height=0;}
  }
  if(s.media.figures)for(const o of s.structure.objects.filter(o=>o.type==='figure')){if((s.approvedMediaIds||[]).includes(o.id))assets[o.id]=await crop(o);else held.push({id:o.id,reason:'图像插入需核对图框；本稿保留图注，图像暂缓'});}
  if(s.media.formulaFallback)for(const p of check.pending){const o=s.structure.objects.find(o=>o.id===p.id);if(o?.type==='formula')assets[o.id]=await crop(o);}
  const output=renderArticleMarkdown({index:s.structure,input,translation:translated,targets,pending:held,title:s.title,partial:partial||held.length>0,media:s.media,assets});
  const markdown=join(runDir,'translation.md');await writeFile(markdown,output.markdown,{flag:'wx'});await writeJsonAtomic(join(runDir,'source-map.json'),{schema:'article-source-map/v1',sourceHash:s.sourceHash,selection:s.selection,entries:output.mapping});
  s.exports??=[];const entry={id:runId,at:new Date().toISOString(),path:markdown,pages:s.selection.pages,partial:partial||held.length>0,pending:held};s.exports.push(entry);s.latestExport=entry;s.phase=entry.partial?'partial':'done';s.stage=entry.partial?'范围译稿已保存，部分内容待核对':'译稿已保存';await publish?.(s,entry);await save(s);
 }
 function launch(s,body,operation){
  if(active.has(s.slug))throw fail('此文献已有任务，未重复提交',409);
  const controller=new AbortController();active.set(s.slug,controller);s.phase='queued';s.stage='等待串行队列';s.schedule=operation===translate&&body.schedule==='offpeak'?'offpeak':'now';s.notBefore=(s.schedule==='offpeak'?nextOffpeakTime(now()):now()).toISOString();
  const work=async()=>{try{controller.signal.throwIfAborted();await operation(s,body,controller.signal);consecutiveFailures=0;}catch(e){s.phase=controller.signal.aborted?'stopped':'failed';s.stage=controller.signal.aborted?'任务已停止；已发送请求可能收费':'任务未完成';s.error=cleanError(e);if(!controller.signal.aborted){consecutiveFailures++;if(consecutiveFailures>=2||[401,402,403].includes(e.status)||/账号服务调用失败|授权失效|余额/u.test(e.message))for(const[slug,c]of active)if(slug!==s.slug){c.abort();const delayed=waiting.get(slug);if(delayed){clearTimeout(delayed.timer);waiting.delete(slug);delayed.state.phase='stopped';delayed.state.stage='连续失败保护已取消闲时等待，未发送该翻译请求';await save(delayed.state);active.delete(slug);}}}}finally{const next=s.autoTranslationReady&&!controller.signal.aborted&&!['failed','stopped'].includes(s.phase);s.autoTranslationReady=false;await save(s);active.delete(s.slug);if(next)await launch(s,{...body,auto:false,consent:true},translate);}};
  // Do not let one failed task poison the serial queue.
  const start=()=>{waiting.delete(s.slug);queue=queue.then(work,work);};
  const delay=new Date(s.notBefore).getTime()-now().getTime();
  if(s.schedule==='offpeak'&&isPeakShanghai(now())&&delay>0){s.stage='等待闲时 '+new Date(s.notBefore).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'});const timer=setTimeout(start,Math.min(delay,2_147_000_000));timer.unref?.();waiting.set(s.slug,{timer,start,controller,state:s});}
  else start();return save(s);
 }
 async function command(body){
  const slug=body.slug,p=await paperFor(slug);let s=await load(slug);
  if(body.action==='stop'){if(active.has(slug)){active.get(slug).abort();const delayed=waiting.get(slug);if(delayed){clearTimeout(delayed.timer);waiting.delete(slug);}s.phase=delayed?'stopped':'stopping';s.stage=delayed?'闲时等待已取消，未发送该翻译请求':'正在停止；已发送请求可能收费';await save(s);if(delayed)active.delete(slug);}return get(slug);}
  if(body.action==='start-now'){const delayed=waiting.get(slug);if(!delayed)throw fail('没有等待闲时的任务，未新建翻译');clearTimeout(delayed.timer);s=delayed.state;s.schedule='now';s.notBefore=now().toISOString();s.stage='已改为立即翻译，等待队列';await save(s);delayed.start();return get(slug);}
  if(active.has(slug))throw fail('任务执行中，不能修改清单或重复调用',409);
  if(body.action==='prepare'){
   if(s)await save(s); // Keep the last manual draft under its immutable revision folder.
   const prepared=await prepare(p.pdfAbs,body.scope);const revision='r-'+randomUUID(),dir=join(folder(slug),revision);await mkdir(dir,{recursive:true});await writeJsonAtomic(join(dir,'input.json'),prepared.input);
   s={schema:'article-workflow/v1',slug,title:p.title||slug,revision,sourceHash:prepared.sourceHash,pageCount:prepared.pageCount,selection:prepared.selection,phase:'prepared',stage:'原文已准备，未调用 AI',structure:null,checks:null,reviewed:false,pendingIds:[],media:articleMedia(body.media),exports:s?.exports||[],costs:s?.costs||[],createdAt:new Date().toISOString()};await save(s);return{state:s};
  }
  if(!s)throw fail('请先选择范围并准备原文');
  if(body.revision!==s.revision)throw fail('工作稿已变化，请刷新；未操作旧版本',409);
  if(body.action==='save-structure'){
   if(s.structure)await writeJsonAtomic(join(folder(slug),s.revision,'review-before-'+randomUUID()+'.json'),{structure:s.structure,pendingIds:s.pendingIds,approvedMediaIds:s.approvedMediaIds,reviewed:s.reviewed,at:new Date().toISOString()});
   const input=await inputFor(s);s.structure=body.structure;s.checks=reviewArticle(s.structure,input);s.pendingIds=Array.isArray(body.pendingIds)?body.pendingIds.filter(id=>Array.isArray(s.structure?.objects)&&s.structure.objects.some(o=>o?.id===id)):[];s.approvedMediaIds=Array.isArray(body.approvedMediaIds)?body.approvedMediaIds.filter(id=>Array.isArray(s.structure?.objects)&&s.structure.objects.some(o=>o?.id===id&&o.type==='figure')):[];s.reviewed=body.confirm===true&&s.checks.ok;s.phase='review';s.stage=s.reviewed?'结构已确认，可翻译':'清单已保存，等待检查';s.media=articleMedia(body.media??s.media);await save(s);return{state:s};
  }
  if(body.action==='analyze'||body.action==='translate'){
   if(body.consent!==true)throw fail('必须明确确认发送所选范围图文与模型费用');
   const config=await settings(),limits=validateArticleLimits(config.limits);
   const agreed=body.limits===undefined?DEFAULT_ARTICLE_LIMITS:validateArticleLimits(body.limits);
   if(Object.keys(limits).some(k=>limits[k]!==agreed[k]))throw fail('调用上限已变化，请刷新并重新确认预算；未发送请求',409);
   body={...body,limits};s.requestLimits=limits;
   if(body.action==='analyze'&&s.structure&&!body.replace)throw fail('已有结构清单；重新识别需明确确认保留旧稿并替换当前稿');
   if(body.action==='analyze'&&(body.replace||s.structureAttempted)){await save(s);const next='r-'+randomUUID(),dir=join(folder(slug),next),input=await inputFor(s);await mkdir(dir,{recursive:true});await writeJsonAtomic(join(dir,'input.json'),input);s.revision=next;s.structure=null;s.structureAttempted=false;s.reviewed=false;}
   s.error=null;await launch(s,body,body.action==='analyze'?analyze:translate);return{state:s};
  }
  throw fail('不支持的文章工作流操作');
 }
 async function detail(slug){const result=await get(slug);if(!result.state)return result;return{...result,input:await inputFor(result.state)};}
 async function costs(slug){const s=await load(slug),items=s?.costs||[],currency=items[0]?.cost?.currency||'CNY';return{structure:items.filter(i=>i.stage==='structure'),translation:items.filter(i=>i.stage==='translation'),total:items.length?sumCosts(items.map(i=>i.cost),currency):{currency,amount:0,known:true},note:'按服务端实际用量与用户单价估算，非账单；失败和停止可能收费'};}
 function close(){for(const w of waiting.values())clearTimeout(w.timer);waiting.clear();for(const c of active.values())c.abort();}
 return{get,detail,command,costs,active,close};
}
