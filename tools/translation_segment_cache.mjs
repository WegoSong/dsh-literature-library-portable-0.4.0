/** Reusable accepted paragraphs independent of temporary placeholder numbering. */
import {createHash} from 'node:crypto';
const token=/@@DSH_([A-Z]+)_\d{6}@@/gu;
export function canonicalSegment(source,placeholders,scope=''){
 const definitions=new Map(placeholders.map(p=>[p.placeholder,p])),forward=new Map(),reverse=new Map(),values=[],counts=new Map();
 const text=String(source).replace(token,id=>{if(!forward.has(id)){const p=definitions.get(id);if(!p)throw Error('段落缓存包含未知保护标记');const kind=id.split('_')[1],n=(counts.get(kind)||0)+1;counts.set(kind,n);const canonical=`@@DSH_${kind}_${String(n).padStart(6,'0')}@@`;forward.set(id,canonical);reverse.set(canonical,id);values.push([canonical,p.type,p.type==='block'?'':p.value||'']);}return forward.get(id);});
 const key=createHash('sha256').update(JSON.stringify({version:'accepted-segment-v1',scope,text,values})).digest('hex');
 return{key,encode:translated=>String(translated).replace(token,id=>{if(!forward.has(id))throw Error('译文缓存包含额外标记');return forward.get(id);}),decode:translated=>String(translated).replace(token,id=>{if(!reverse.has(id))throw Error('段落缓存标记不匹配');return reverse.get(id);})};
}
