/** DSH's documented provider-neutral seam; never reads account tokens/cookies. */
import {resolveMaxTokens} from './deepseek_translate.mjs';
export const ACCOUNT_ENDPOINT='https://dsh-account.invalid/chat/completions';
export const ACCOUNT_ROUTE='deepseek-account';
const fail=message=>Object.assign(Error(message),{status:422});
export function createDshAccountTransport({getLlm,getAttachments}){
 async function status(){try{const llm=getLlm();if(!llm?.stream||!llm?.listProviders)return{ready:false,models:[],message:'当前 DSH 未提供兼容的 LLM 服务，请升级 DSH 或使用 API Key'};
   if(!llm.listProviders().some(p=>p.id===ACCOUNT_ROUTE))return{ready:false,models:[],message:'请先在 DSH 设置中登录并启用 DeepSeek 账号提供方'};
   const models=await llm.listModels(ACCOUNT_ROUTE);return{ready:true,models:models.map(m=>({id:m.id,name:m.name||m.id,vision:m.inputModalities?.includes('image')===true})),message:'使用 DSH 管理的账号授权；实际有效性由提供方在请求时确认'};
  }catch{return{ready:false,models:[],message:'DSH 账号路由不可用；不会改用 API Key'};}}
 async function generate({model,system,user,content,reasoningEffort='none',maxTokens=8192,timeoutMs=600000,signal}){
  const s=await status();if(!s.ready)throw fail(s.message);const images=(content||[]).filter(c=>c.type==='image_url');
  if(images.length&&!s.models.some(m=>m.id===model&&m.vision))throw fail('账号路由没有声明此模型支持图片，未发送页面；请选择 DSH 目录中的视觉模型');
  const controller=new AbortController(),abort=()=>controller.abort(signal?.reason),timer=setTimeout(()=>controller.abort(Error('DSH 模型请求超时')),timeoutMs);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  let usage=null,finish=null,chars=0;const blocks=new Map(),assembled=new Map();
  try{const parts=[];
   for(const part of content||[{type:'text',text:user||''}]){
    controller.signal.throwIfAborted();
    if(part.type==='text'){parts.push({type:'text',text:part.text});continue;}
    if(part.type!=='image_url')throw fail('不支持的账号输入类型');
    const match=/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/u.exec(part.image_url?.url||'');if(!match)throw fail('账号分区只接受本地生成的图片，不读取外部 URL');
    const bytes=Buffer.from(match[2],'base64');if(bytes.length>12*1024*1024)throw fail('单页图片超过 12 MiB 预算');
    const attachments=getAttachments();if(!attachments?.saveImage)throw fail('此 DSH 未提供图片附件接口，不能调用账号视觉模型');
    const attachment=await attachments.saveImage({data:bytes,mediaType:match[1],name:'literature-page.png'});parts.push({type:'image',attachment});
   }
   const cap=resolveMaxTokens(maxTokens,{user:user||JSON.stringify(content),reasoningEffort});
   for await(const chunk of getLlm().stream({provider:ACCOUNT_ROUTE,model,system,messages:[{role:'user',content:parts}],tools:[],reasoningEffort:reasoningEffort==='none'||reasoningEffort==='disabled'?'off':reasoningEffort,maxTokens:cap,signal:controller.signal})){
    controller.signal.throwIfAborted();
    if(chunk.type==='text-delta'){chars+=chunk.text.length;if(chars>1_000_000)throw fail('账号模型输出超过本地预算');blocks.set(chunk.index,(blocks.get(chunk.index)||'')+chunk.text);}
    if(chunk.type==='block-end'&&chunk.block?.type==='text')assembled.set(chunk.index,chunk.block.text);
    if(chunk.type==='usage'){const u=chunk.usage;usage={input_tokens:u.inputTokens,output_tokens:u.outputTokens,...(Number.isFinite(u.cacheReadTokens)?{cache_read_input_tokens:u.cacheReadTokens}:{}),...(Number.isFinite(u.cacheWriteTokens)?{cache_creation_input_tokens:u.cacheWriteTokens}:{}),...(Number.isFinite(u.reasoningTokens)?{reasoning_tokens:u.reasoningTokens}:{})};}
    if(chunk.type==='finish')finish=chunk.reason?.kind;
    // Private reasoning and adapter replay state are deliberately not collected.
   }
   if(!['stop','max-tokens'].includes(finish))throw fail(finish==='aborted'?'DSH 账号请求已取消':'DSH 账号请求失败或授权失效，请检查 DSH 登录/余额；未切换到 API Key');
   const keys=[...new Set([...blocks.keys(),...assembled.keys()])].sort((a,b)=>a-b),text=keys.map(i=>assembled.get(i)??blocks.get(i)).join('');
   if(text.length>1_000_000)throw fail('账号模型输出超过本地预算');
   return{text,usage,truncated:finish==='max-tokens',maxTokens:cap};
  }catch(e){const error=fail(controller.signal.aborted?'DSH 账号调用已停止，已发送内容可能收费':e.status===422?e.message:'DSH 账号服务调用失败，请检查登录和余额；未读取或转发授权信息');error.usage=usage;throw error;}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
 }
 async function fetchChat(url,options){if(url!==ACCOUNT_ENDPOINT)throw fail('拒绝将 DSH 账号授权用于自定义接口');const b=JSON.parse(options.body),system=b.messages.find(m=>m.role==='system')?.content||'',content=b.messages.find(m=>m.role==='user')?.content||[];
  const stage=content.find(c=>c.type==='text')?.text;let kind='visual';try{kind=JSON.parse(stage).stage||kind;}catch{}
  let response;try{response=await generate({model:b.model,system,content,maxTokens:b.max_tokens,reasoningEffort:kind==='visual'?'none':b.thinking?.type==='disabled'?'none':b.reasoning_effort||'low',signal:options.signal});}catch(e){const u=e.usage;e.accountFailure=true;if(u)e.diagnosticUsage={prompt_tokens:(u.input_tokens??0)+(u.cache_read_input_tokens||0)+(u.cache_creation_input_tokens||0),completion_tokens:u.output_tokens,...(Number.isFinite(u.cache_read_input_tokens)?{prompt_cache_hit_tokens:u.cache_read_input_tokens}:{})};throw e;}
  const u=response.usage;return new Response(JSON.stringify({choices:[{finish_reason:response.truncated?'length':'stop',message:{content:response.text}}],...(u?{usage:{prompt_tokens:(u.input_tokens??0)+(u.cache_read_input_tokens||0)+(u.cache_creation_input_tokens||0),completion_tokens:u.output_tokens,...(Number.isFinite(u.cache_read_input_tokens)?{prompt_cache_hit_tokens:u.cache_read_input_tokens}:{})}}:{})}),{status:200,headers:{'content-type':'application/json'}});
 }
 return{status,generate,fetchChat};
}
