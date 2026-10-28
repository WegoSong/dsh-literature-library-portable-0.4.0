/** User-supplied tariffs only. Missing telemetry is unknown, never zero. */
export function validatePricing(input={}){
 const currency=String(input.currency||'CNY').toUpperCase();if(!['CNY','USD','EUR'].includes(currency))throw Error('费用币种请选择 CNY、USD 或 EUR');
 const out={currency};
 for(const name of ['inputPerMillion','cacheHitPerMillion','outputPerMillion']){
  const value=input[name];out[name]=value===null||value===undefined||value===''?null:Number(value);
  if(out[name]!==null&&(!Number.isFinite(out[name])||out[name]<0||out[name]>1e7))throw Error('单价必须为非负数字；未知请留空');
 }
 const image=Number(input.imageTokensPerPage??2048);if(!Number.isFinite(image)||image<0||image>200000)throw Error('图片 token 粗估值须在 0—200000 之间');out.imageTokensPerPage=image;
 return out;
}
export function priceUsage(usage,pricing,{noRequest=false}={}){
 const p=validatePricing(pricing),base={currency:p.currency,tariff:p,basis:'provider-usage-estimate-not-invoice'};
 if(noRequest)return{...base,amount:0,low:0,high:0,known:true,note:'本次复用本地结果，未调用接口；历史调用仍可能收费'};
 if(!Number.isFinite(usage?.prompt_tokens)||!Number.isFinite(usage?.completion_tokens))return{...base,amount:null,low:null,high:null,known:false,note:'服务商用量不完整，费用未知；不代表免费'};
 if(p.inputPerMillion===null||p.outputPerMillion===null)return{...base,amount:null,low:null,high:null,known:false,note:'单价未设置，保留 token 用量；金额未知'};
 const total=usage.prompt_tokens,output=usage.completion_tokens*p.outputPerMillion/1e6;
 let hit=Number.isFinite(usage.prompt_cache_hit_tokens)?usage.prompt_cache_hit_tokens:Number.isFinite(usage.prompt_cache_miss_tokens)?total-usage.prompt_cache_miss_tokens:null;
 if(hit!==null&&(hit<0||hit>total))hit=null;
 if(hit===0)return{...base,amount:total*p.inputPerMillion/1e6+output,low:total*p.inputPerMillion/1e6+output,high:total*p.inputPerMillion/1e6+output,known:true};
 const hitRate=p.cacheHitPerMillion;
 if(hit!==null&&hitRate!==null){const amount=((total-hit)*p.inputPerMillion+hit*hitRate)/1e6+output;return{...base,amount,low:amount,high:amount,known:true};}
 if(hitRate===null)return{...base,amount:null,low:null,high:null,known:false,note:'存在或可能存在缓存命中，但命中单价未知，无法折算完整金额'};
 const low=(total-(hit??total))*p.inputPerMillion/1e6+output+(hit??total)*Math.min(hitRate??0,p.inputPerMillion)/1e6;
 const high=(total-(hit??total))*p.inputPerMillion/1e6+output+(hit??total)*Math.max(hitRate??p.inputPerMillion,p.inputPerMillion)/1e6;
 return{...base,amount:low===high?low:null,low,high,known:low===high,note:'缓存命中用量或命中单价缺失，仅能给出区间'};
}
export function estimateStage(context,prompt,pricing,{image=false,maxTokens=8192,cached=false}={}){
 const p=validatePricing(pricing),chars=JSON.stringify(context).length+prompt.length;
 // A heuristic, NOT a provider tokenizer; vision billing varies by provider and resolution.
 const input=Math.ceil(chars/3.3)+(image?p.imageTokensPerPage:0),expectedOutput=Math.min(maxTokens,Math.max(600,Math.ceil(chars*.07)));
 if(cached)return{inputTokens:input,outputTokens:expectedOutput,outputLimit:maxTokens,cached:true,cost:priceUsage({},p,{noRequest:true})};
 const a=priceUsage({prompt_tokens:Math.ceil(input*.6),completion_tokens:Math.ceil(expectedOutput*.5),prompt_cache_hit_tokens:0},p);
 const b=priceUsage({prompt_tokens:Math.ceil(input*1.8),completion_tokens:Math.min(maxTokens,expectedOutput*2),prompt_cache_hit_tokens:0},p);
 return{inputTokens:input,outputTokens:expectedOutput,outputLimit:maxTokens,cached:false,cost:{currency:p.currency,low:a.amount,high:b.amount,amount:null,known:false,basis:'rough-heuristic',note:'字符和图片 token 粗估，非账单或费用上限；思考 token 计入生成预算'},outputBudgetCost:p.outputPerMillion===null?null:maxTokens*p.outputPerMillion/1e6};
}
export function sumCosts(costs,currency='CNY'){
 const same=costs.every(c=>c?.currency===currency),unknown=!same||costs.some(c=>c?.low===null||c?.low===undefined||c?.high===null||c?.high===undefined);
 if(unknown)return{currency,amount:null,low:null,high:null,known:false,note:'部分阶段金额未知，不能计算完整总费用'};
 const low=costs.reduce((s,c)=>s+c.low,0),high=costs.reduce((s,c)=>s+c.high,0);return{currency,amount:low===high?low:null,low,high,known:low===high};
}

