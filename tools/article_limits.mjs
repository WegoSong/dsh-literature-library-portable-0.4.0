/** Application guardrails, not a claim about any provider's supported output length. */
export const DEFAULT_ARTICLE_LIMITS=Object.freeze({structureMaxTokens:16384,translationMaxTokens:32768});
export const ARTICLE_OUTPUT_RANGE=Object.freeze({min:1024,max:262144});
export function validateArticleLimits(value={},base=DEFAULT_ARTICLE_LIMITS){
 if(!value||typeof value!=='object'||Array.isArray(value))throw Object.assign(Error('调用上限必须是设置对象'),{status:400});
 const result={...DEFAULT_ARTICLE_LIMITS,...base};
 for(const key of Object.keys(value)){
  if(!Object.hasOwn(DEFAULT_ARTICLE_LIMITS,key))throw Object.assign(Error('未知的调用上限字段：'+key),{status:400});
  const n=value[key];if(typeof n!=='number'||!Number.isInteger(n)||n<ARTICLE_OUTPUT_RANGE.min||n>ARTICLE_OUTPUT_RANGE.max)throw Object.assign(Error('输出上限须为 1024–262144 之间的整数 token，不能留空'),{status:400});
  result[key]=n;
 }
 return result;
}
