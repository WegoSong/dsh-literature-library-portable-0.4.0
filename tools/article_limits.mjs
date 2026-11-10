/** Application guardrails, not a claim about any provider's supported output length. */
export const DEFAULT_ARTICLE_LIMITS=Object.freeze({maxInputPages:32,maxPageCharacters:20000,structureMaxTokens:16384,translationMaxTokens:32768});
export const ARTICLE_OUTPUT_RANGE=Object.freeze({min:1024,max:262144});
export const ARTICLE_INPUT_RANGES=Object.freeze({
 maxInputPages:Object.freeze({min:1,max:128}),
 maxPageCharacters:Object.freeze({min:1,max:100000}),
});
export function validateArticleLimits(value={},base=DEFAULT_ARTICLE_LIMITS){
 if(!value||typeof value!=='object'||Array.isArray(value))throw Object.assign(Error('调用上限必须是设置对象'),{status:400});
 const result={...DEFAULT_ARTICLE_LIMITS,...base};
 for(const key of Object.keys(value)){
  if(!Object.hasOwn(DEFAULT_ARTICLE_LIMITS,key))throw Object.assign(Error('未知的调用上限字段：'+key),{status:400});
  const {min,max}=ARTICLE_INPUT_RANGES[key]||ARTICLE_OUTPUT_RANGE;
  const label=key==='maxInputPages'?'单次输入页数':key==='maxPageCharacters'?'单页输入字符上限':'输出 token 上限';
  const n=value[key];if(!Number.isInteger(n)||n<min||n>max)throw Object.assign(Error(`${label}须为 ${min}–${max} 之间的整数，不能留空`),{status:400});
  result[key]=n;
 }
 return result;
}
