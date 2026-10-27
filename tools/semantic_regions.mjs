import {createHash} from 'node:crypto';
import {itemBox,unionBoxes} from './page_regions.mjs';
const SPECIAL=new Map([['formula-source','formula'],['formula','formula'],['caption','caption'],['heading','heading'],['table','table'],['figure','figure']]);
/** The preview and manual editor must expose the SAME special blocks sent to Markdown.
 * Refine only body containers; preserve explicit human special roles and source ownership. */
export function refineSemanticRegions(pc,paragraphs){
 const items=new Map(pc.rawItems.filter(i=>i.str.trim()).map(i=>[i.sourceId,i]));
 const blockOrder=new Map();paragraphs.forEach((p,index)=>p.sourceIds?.forEach(id=>{if(items.has(id))blockOrder.set(id,index);}));
 const refined=[];
 for(const parent of pc.regions){
  if(parent.role!=='body'){refined.push(parent);continue;}
  const owned=new Set(parent.itemIds),parts=paragraphs.map(p=>({p,ids:(p.sourceIds||[]).filter(id=>owned.has(id))})).filter(b=>b.ids.length);
  if(!parts.some(b=>SPECIAL.has(b.p.type))){refined.push(parent);continue;}
  const assigned=new Set();
  for(const {p,ids}of parts){
   const unique=ids.filter(id=>!assigned.has(id));if(!unique.length)continue;unique.forEach(id=>assigned.add(id));
   const role=SPECIAL.get(p.type)||'body',bbox=unionBoxes(unique.map(id=>itemBox(items.get(id))));
   const suffix=createHash('sha1').update(unique.join('\n')).digest('hex').slice(0,10);
   refined.push({id:`p${pc.p}-semantic-${suffix}`,role,bbox,itemIds:unique,flow:'article',order:0,
    parentId:parent.id,evidence:pc.manual?'native-block-inside-human-body':'native-block-classification',confidence:p.formula&&!p.formula.reliable?'review-required':'rule-supported',
    ...(role==='formula'?{formula:p.formula,formulaCrop:p.crop}:{}),...(role==='caption'?{captionText:p.text}:{}),
   });
  }
  const remaining=parent.itemIds.filter(id=>!assigned.has(id));
  if(remaining.length)refined.push({...parent,bbox:unionBoxes(remaining.map(id=>itemBox(items.get(id)))),itemIds:remaining});
 }
 // Preserve the source flow, not the incidental order in which classifiers ran.
 const first=r=>Math.min(...r.itemIds.map(id=>blockOrder.get(id)??Number.MAX_SAFE_INTEGER));
 const article=refined.filter(r=>r.flow==='article').sort((a,b)=>first(a)-first(b));article.forEach((r,i)=>r.order=i+1);
 pc.regions=[...refined.filter(r=>r.flow!=='article'),...article];
 return pc.regions;
}
