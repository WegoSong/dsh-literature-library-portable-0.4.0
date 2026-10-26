import {translationBlocks} from './translation_pipeline.mjs';
export const BLOCK_PROTOCOL='dsh-blocks-v1';
const token=/@@DSH_[A-Z]+_\d{6}@@/gu;
const local=b=>!b.body.replace(token,'').replace(/[\s*#>|-]/gu,'');
const id=(b,i)=>b.marker?b.marker.match(/(\d{6})@@$/u)[1]:`prefix-${i}`;
export function blockPayload(source){
 return {format:BLOCK_PROTOCOL,blocks:translationBlocks(source).flatMap((b,i)=>local(b)?[]:[{id:id(b,i),text:b.body}])};
}
/** IDs identify slots, not display order. Rebuild boundaries and local-only
 * objects/formulas ourselves; a model never owns the document tree. */
export function decodeBlockResponse(source,response){
 const raw=String(response??'').trim(),blocks=translationBlocks(source),expected=blockPayload(source).blocks;
 let parsed;
 try{parsed=JSON.parse(raw.replace(/^```(?:json)?\s*/iu,'').replace(/\s*```$/u,''));}
 catch{return {text:raw,protocol:'legacy',errors:[]};}
 const list=Array.isArray(parsed)?parsed:parsed?.blocks;
 if(!Array.isArray(list))return {text:raw,protocol:BLOCK_PROTOCOL,errors:['invalid-block-response']};
 const values=new Map(),allowed=new Set(expected.map(b=>b.id)),errors=[];
 for(const item of list){
  if(!item||typeof item.id!=='string'||typeof item.text!=='string'){errors.push('invalid-block-item');continue;}
  if(!allowed.has(item.id)){errors.push(`unknown-block:${item.id}`);continue;}
  if(values.has(item.id)){errors.push(`duplicate-block:${item.id}`);continue;}
  values.set(item.id,item.text);
 }
 for(const b of expected)if(!values.has(b.id))errors.push(`missing-block:${b.id}`);
 if(errors.length)return {text:raw,protocol:BLOCK_PROTOCOL,errors};
 return {text:blocks.map((b,i)=>local(b)?b.source:`${b.marker}${b.marker?'\n':''}${values.get(id(b,i))}`).join('\n\n'),protocol:BLOCK_PROTOCOL,errors:[]};
}
