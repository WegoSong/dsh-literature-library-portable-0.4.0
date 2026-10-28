import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {digest,makeContext,renderPageImage,normalizeAI,validateProvider,callVision,REQUEST_PROMPT as SYSTEM_PROMPT,AI_SCHEMA,PROMPT_VERSION,requestPolicy} from './partition_ai_layout.mjs';
import {WORKFLOW,runPipeline,estimatePipeline} from './partition_ai_pipeline.mjs';
import {sumCosts,priceUsage} from './partition_ai_cost.mjs';
const optional=async file=>{try{return JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}};
/** Provider secrets live only in this process. No DSH config, browser storage or label access. */
export class AIService{
 constructor(store,{render=renderPageImage,fetchImpl=fetch}={}){this.store=store;this.render=render;this.fetchImpl=fetchImpl;this.config=null;this.configRevision=randomUUID();}
 settings(){const c=this.config;return c?{configured:true,endpoint:c.endpoint,model:c.model,maxTokens:c.maxTokens,semanticThinking:c.semanticThinking,pricing:c.pricing,hasKey:!!c.apiKey,providerHash:this.configRevision,policy:requestPolicy(c)}:{configured:false,endpoint:'',model:'',maxTokens:8192,semanticThinking:'low',pricing:null,hasKey:false};}
 configure(input){if(input.clear===true){this.config=null;this.configRevision=randomUUID();return this.settings();}const next={...input};if(next.apiKey===undefined)next.apiKey=this.config?.apiKey||'';this.config=validateProvider(next);this.configRevision=randomUUID();return this.settings();}
 async prepare(id,baseRunId,pageNumber){
  const base=await this.store.run(id,baseRunId),page=base.pages.find(p=>p.page===pageNumber);if(!page)throw Error('AI 识别页码不存在');
  const context=makeContext(page,id),image=await this.render(join(this.store.docDir(id),'source.pdf'),pageNumber);
  const requestHash=digest({promptVersion:PROMPT_VERSION,prompt:SYSTEM_PROMPT,context,imageHash:digest(image.dataUrl)});
  return{schema:'paper-layout-ai-request/v1',requestHash,documentHash:id,baseRunId,page:pageNumber,promptVersion:PROMPT_VERSION,systemPrompt:SYSTEM_PROMPT,context,image,outputSchema:AI_SCHEMA};
 }
 async importResult(id,input){
  const bundle=await this.prepare(id,input.baseRunId,input.page);
  if(input.requestHash!==bundle.requestHash)throw Error('识别请求哈希不一致，请重新导出本页任务；未采用旧结果');
  const base=await this.store.run(id,input.baseRunId),page=base.pages.find(p=>p.page===input.page),normalized=normalizeAI(page,input.result);
  normalized.ai={...normalized.ai,source:'external-import',requestHash:bundle.requestHash,model:'外部导入（模型未验证）'};
  return this.store.createCandidateRun(id,input.baseRunId,[normalized],{source:'external-import',promptVersion:PROMPT_VERSION});
 }
 async attempts(id,page){
  await this.store.document(id);let names;try{names=await readdir(join(this.store.docDir(id),'ai-attempts'));}catch(e){if(e.code==='ENOENT')return[];throw e;}
  const records=[];for(const name of names.filter(n=>/^attempt-[a-f0-9-]{36}\.json$/u.test(n))){const r=await optional(join(this.store.docDir(id),'ai-attempts',name));if(r&&(!page||r.page===page))records.push(r);}
  return records.sort((a,b)=>b.at.localeCompare(a.at)).slice(0,20);
 }
 async recordAttempt(id,record){const folder=join(this.store.docDir(id),'ai-attempts'),name='attempt-'+randomUUID()+'.json';await mkdir(folder,{recursive:true});const entry={schema:'paper-layout-ai-attempt/v1',id:name.slice(0,-5),at:new Date().toISOString(),...record};await writeFile(join(folder,name),JSON.stringify(entry,null,2),{flag:'wx'});return entry.id;}
 async estimate(id,input){return estimatePipeline(this,id,input);}
 async trace(id,runId,page){const run=await this.store.run(id,runId),p=run.pages.find(p=>p.page===page);if(!p?.ai?.pipeline)throw Error('该页没有三阶段记录');const stages=[];
  for(const s of p.ai.pipeline.stages){if(!/^[a-f0-9]{64}\.json\.response\.json$/u.test(s.responseRef))throw Error('阶段记录来源无效');const raw=await optional(join(this.store.docDir(id),'pipeline-cache',s.responseRef));stages.push({stage:s.stage,result:raw?.response?.result||null,usage:s.usage,cost:s.cost});}
  return{page,runId,stages,review:p.ai.pipeline.review,note:'各阶段机器证据，非人工基准；坐标系见各阶段结果'};
 }
 async costs(id){
  await this.store.document(id);let names=[];try{names=await readdir(join(this.store.docDir(id),'ai-attempts'));}catch(e){if(e.code!=='ENOENT')throw e;}
  const rows=new Map();for(const name of names.filter(n=>/^attempt-[a-f0-9-]{36}\.json$/u.test(n))){const r=await optional(join(this.store.docDir(id),'ai-attempts',name));if(!r)continue;
   const cost=r.cost||{...priceUsage(r.diagnostic?.usage,{}),note:'旧版本调用没有当时单价，不能恢复历史金额'},entry={id:r.id,at:r.at,page:r.page,stage:r.stage||'legacy-visual',status:r.status,networkRequested:r.networkRequested??null,usage:r.diagnostic?.usage||{},cost};
   if(!rows.has(r.page))rows.set(r.page,[]);rows.get(r.page).push(entry);
  }
  return{pages:[...rows].sort((a,b)=>a[0]-b[0]).map(([page,attempts])=>{attempts.sort((a,b)=>b.at.localeCompare(a.at));const currencies=[...new Set(attempts.map(a=>a.cost.currency))];return{page,attempts,totals:currencies.map(c=>sumCosts(attempts.filter(a=>a.cost.currency===c).map(a=>a.cost),c)),note:'包含失败及历史调用；本地复用不重复累计；缺失用量不记为零'};}),note:'按每次调用保存的用户单价折算，非服务商账单；不同币种不相加'};
 }
 async run(id,input,{signal,progress=()=>{},configSnapshot}={}){
  if(input.workflow===WORKFLOW)return runPipeline(this,id,input,{signal,progress,configSnapshot});
  if(input.consent!==true)throw Error('需明确确认向指定服务发送页面图像和原文，可能产生费用');
  if(!configSnapshot&&!this.config)throw Error('尚未配置视觉接口；可先使用离线导出/导入');
  const config={...(configSnapshot||this.config)},base=await this.store.run(id,input.baseRunId),pages=input.pages;
  if(!Array.isArray(pages)||!pages.length||pages.length>5||new Set(pages).size!==pages.length||pages.some(n=>!Number.isInteger(n)||!base.pages.some(p=>p.page===n)))throw Error('每次选择 1—5 个有效且不重复的页码');
  const updates=[],folder=join(this.store.docDir(id),'ai-cache');await mkdir(folder,{recursive:true});
  for(const [index,n]of pages.entries()){
   signal?.throwIfAborted();progress({page:n,current:index+1,total:pages.length});
   const bundle=await this.prepare(id,input.baseRunId,n),policy=requestPolicy(config),key=digest({request:bundle.requestHash,endpoint:config.endpoint,model:config.model,maxTokens:config.maxTokens,policy}),file=join(folder,key+'.json');
   let saved=input.force===true?null:await optional(file),cached=!!saved;
   if(!saved){let response,reused=false;const responseFile=file+'.response.json',responseRef=key+'.json.response.json';
    try{const previous=input.force===true?null:await optional(responseFile);
     if(previous){if(previous.requestHash!==bundle.requestHash)throw Error('本地响应来源不匹配，拒绝复用');response=previous.response;reused=true;cached=true;}
     else{response=await callVision(config,bundle.context,bundle.image,{signal,fetchImpl:this.fetchImpl});
      // Keep final structured output BEFORE validation, never the request/image or reasoning text.
      const value=JSON.stringify({schema:'paper-layout-ai-response/v1',requestHash:bundle.requestHash,baseRunId:input.baseRunId,page:n,receivedAt:new Date().toISOString(),response});
      await writeFile(responseFile,config.apiKey?value.split(config.apiKey).join('[redacted]'):value);
     }
     // Validate before marking a success. A bad response is not a fake rule fallback.
     normalizeAI(base.pages.find(p=>p.page===n),response.result);
     const attemptId=await this.recordAttempt(id,{page:n,requestHash:bundle.requestHash,model:config.model,status:'success',reusedResponse:reused,responseRef,diagnostic:response.diagnostic});
     saved={result:response.result,usage:response.usage,diagnostic:response.diagnostic,attemptId,responseRef,reusedResponse:reused,receivedAt:new Date().toISOString()};await writeFile(file,JSON.stringify(saved));
    }catch(e){const diagnostic=e.diagnostic||{...(response?.diagnostic||{}),kind:response?'layout-validation':'local-error',policy,maxTokens:config.maxTokens};
     const message=String(e.message||'识别失败').split(config.apiKey||'\u0000').join('[redacted]').slice(0,2000);
     try{const attemptId=await this.recordAttempt(id,{page:n,requestHash:bundle.requestHash,model:config.model,status:'failed',diagnostic,message,reusedResponse:reused,...(response?{responseRef}:{})});e.diagnostic={...diagnostic,page:n,attemptId};e.message=message+(reused?' 本次未调用模型，复用的结构仍需纠正；请勿盲目忽略缓存。':'')+' 本地已保留用量诊断'+(response?'和最终结构结果':'')+'，未自动重试。';}catch{e.message=message+' 本地诊断写入失败；未自动重试。';}throw e;
    }
   }
   signal?.throwIfAborted();const normalized=normalizeAI(base.pages.find(p=>p.page===n),saved.result);
   normalized.ai={...normalized.ai,source:'vision-api',requestHash:bundle.requestHash,model:config.model,endpoint:config.endpoint,cached,usage:saved.usage,diagnostic:saved.diagnostic,attemptId:saved.attemptId,receivedAt:saved.receivedAt};updates.push(normalized);
  }
  signal?.throwIfAborted();return this.store.createCandidateRun(id,input.baseRunId,updates,{source:'vision-api',model:config.model,endpoint:config.endpoint,promptVersion:PROMPT_VERSION});
 }
}

