/** Production semantic-index contract. Source ownership is separate from presentation references. */
export const SCHEMA='article-structure-sample/0.3';
const NARRATIVE=new Set(['heading','paragraph','abstract','formula']);
const CONTAINERS=new Set(['paragraph','abstract']);
const TYPES=new Set('heading paragraph abstract keywords title author affiliation journal date doi reference_list reference_item figure figure_caption table table_caption formula page_number running_journal download_notice unknown'.split(' '));
const PARTS=new Set(['body','front','back','document_info','running_matter']);
const plain=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
const exactKeys=(x,keys)=>plain(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));

export function validateStructure(index,input){
 const errors=[],warnings=[],add=(code,detail={})=>errors.push({code,...detail});
 const pages=new Map(),fragments=new Map(),positions=new Map();
 for(const p of input?.pages||[]){
  if(!Number.isInteger(p.page)||pages.has(p.page)||!Array.isArray(p.fragments)){add('invalid-input-page');continue;}
  pages.set(p.page,p);
  for(const [i,f] of p.fragments.entries()){
   if(typeof f.id!=='string'||fragments.has(f.id)){add('invalid-input-fragment');continue;}
   fragments.set(f.id,{...f,page:p.page});positions.set(f.id,i);
  }
 }
 if(!plain(index))return{ok:false,errors:[{code:'index-not-object'}],warnings};
 if(index.schema!==SCHEMA)add('schema-mismatch',{expected:SCHEMA,actual:index.schema});
 if(!exactKeys(index,['schema','objects','body_order','issues']))add('outer-keys');
 if(!Array.isArray(index.objects)||!Array.isArray(index.body_order)||!Array.isArray(index.issues))return{ok:false,errors:[...errors,{code:'root-arrays'}],warnings};
 const ids=new Map(),resolved=new Map(),owners=new Map([...fragments.keys()].map(id=>[id,[]]));
 for(const o of index.objects){
  if(!plain(o)||typeof o.id!=='string'||!/^[A-Za-z0-9_.:-]{1,160}$/u.test(o.id)||ids.has(o.id)){add('invalid-or-duplicate-id',{id:o?.id});continue;}
  ids.set(o.id,o);
  for(const key of Object.keys(o))if(!['id','part','type','parent','source','links','context','content_order'].includes(key))add('unexpected-object-field',{id:o.id,field:key});
  if(!TYPES.has(o.type)||!PARTS.has(o.part))add('classification',{id:o.id});
  if(Object.hasOwn(o,'context')&&typeof o.context!=='boolean')add('context-type',{id:o.id});
  if(!Array.isArray(o.source)||!o.source.length){add('source-container',{id:o.id});continue;}
  const fs=[];
  for(const [si,s] of o.source.entries()){
   const p=plain(s)?pages.get(s.page):null;
   if(!p){add('source-page',{id:o.id,source:si});continue;}
   if(Object.hasOwn(s,'box')){
    const b=s.box;
    if(!exactKeys(s,['page','box'])||!Array.isArray(b)||b.length!==4||!b.every(Number.isFinite)||b[0]<0||b[1]<0||b[2]>p.width||b[3]>p.height||b[0]>=b[2]||b[1]>=b[3])add('image-box',{id:o.id,source:si});
    if(NARRATIVE.has(o.type))add(o.type==='formula'?'formula-image-forbidden':'narrative-image-forbidden',{id:o.id});
   }else{
    const a=fragments.get(s.start),b=fragments.get(s.end),ai=positions.get(s.start),bi=positions.get(s.end);
    if(!exactKeys(s,['page','start','end'])||!a||!b||a.page!==s.page||b.page!==s.page||ai>bi){add('text-range',{id:o.id,source:si});continue;}
    for(const f of p.fragments.slice(ai,bi+1)){fs.push(f.id);owners.get(f.id).push(o.id);}
   }
  }
  resolved.set(o.id,fs);
 }
 const embedded=new Map();
 for(const o of ids.values()){
  if(['paragraph','abstract','formula'].includes(o.type)&&!Object.hasOwn(o,'parent'))add('parent-required',{id:o.id});
  const parentTypes=o.type==='reference_item'?['heading','reference_list']:['heading'];
  if(Object.hasOwn(o,'parent')&&o.parent!==null&&!parentTypes.includes(ids.get(o.parent)?.type))add('heading-parent',{id:o.id});
  if(['figure_caption','table_caption'].includes(o.type)&&o.links===undefined)add('caption-link-required',{id:o.id});
  if(o.links!==undefined){
   const target=ids.get(o.links?.caption_of),type=o.type==='figure_caption'?'figure':o.type==='table_caption'?'table':null;
   if(!exactKeys(o.links,['caption_of'])||!type||target?.type!==type)add('caption-link',{id:o.id});
  }
  if(!Object.hasOwn(o,'content_order'))continue;
  if(!CONTAINERS.has(o.type)||!Array.isArray(o.source)||!Array.isArray(o.content_order)||!o.content_order.length){add('content-order-container',{id:o.id});continue;}
  const used=new Set();
  for(const step of o.content_order){
   if(exactKeys(step,['source'])){
    const si=step.source;
    if(!Number.isInteger(si)||si<0||si>=(o.source?.length||0)){add('source-index',{id:o.id,index:si});continue;}
    if(used.has(si))add('duplicate-source-step',{id:o.id,index:si});used.add(si);
    if(!plain(o.source[si])){add('invalid-prose-locator',{id:o.id,index:si});continue;}
    if(Object.hasOwn(o.source[si],'box'))add('paragraph-image-step',{id:o.id,index:si});
   }else if(exactKeys(step,['object'])){
    const target=ids.get(step.object);
    if(!target||target.type!=='formula'){add('embedded-target',{id:o.id,target:step.object});continue;}
    if(embedded.has(target.id))add('duplicate-formula-placement',{id:o.id,target:target.id});
    else embedded.set(target.id,o.id);
    if(!!target.context!==!!o.context)add('embedded-context',{id:o.id,target:target.id});
    if(target.parent!==o.parent)add('embedded-heading-parent',{id:o.id,target:target.id});
   }else add('content-step-shape',{id:o.id});
  }
  if(used.size!==(o.source?.length||0))add('unplaced-prose-locator',{id:o.id});
 }
 for(const o of ids.values()){
  const seen=new Set([o.id]);let parent=o.parent;
  while(typeof parent==='string'&&ids.has(parent)){
   if(seen.has(parent)){add('heading-cycle',{id:o.id});break;}
   seen.add(parent);parent=ids.get(parent).parent;
  }
 }
 const core=new Set(input?.scope?.core_pages||[]),context=new Set(input?.scope?.context_pages||[]);
 for(const p of pages.values())if(!core.has(p.page)&&!context.has(p.page))add('undeclared-input-page',{page:p.page});
 for(const [id,who] of owners){
  const page=fragments.get(id).page;
  if(core.has(page)&&!who.length)add('missing-core-fragment',{fragment:id});
  if(who.length>1)add('duplicate-source-ownership',{fragment:id,objects:who});
 }
 for(const o of ids.values())if(o.context&&Array.isArray(o.source)&&o.source.some(s=>s&&core.has(s.page)))add('core-context-leak',{id:o.id});
 const required=new Set([...ids.values()].filter(o=>!o.context&&NARRATIVE.has(o.type)&&!embedded.has(o.id)).map(o=>o.id));
 const topSeen=new Set();
 for(const id of index.body_order){
  if(typeof id!=='string'||!ids.has(id)){add('body-target',{id});continue;}
  if(topSeen.has(id))add('duplicate-body-step',{id});topSeen.add(id);
  if(embedded.has(id))add('embedded-also-top-level',{id});
  else if(!required.has(id))add('non-narrative-body-step',{id});
 }
 for(const id of required)if(!topSeen.has(id))add('unplaced-narrative-object',{id});
 for(const issue of index.issues)if(!plain(issue)||!Array.isArray(issue.objects)||!issue.objects.length||issue.objects.some(id=>!ids.has(id))||!['classification','location','continuation','association'].includes(issue.kind)||typeof issue.message!=='string')add('issue-shape');
 for(const [id,f] of fragments)if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(f.text||''))warnings.push({code:'native-text-control-character',fragment:id});
 return{ok:!errors.length,errors,warnings,stats:{objects:ids.size,coreFragments:[...fragments.values()].filter(f=>core.has(f.page)).length,coreExactlyOnce:[...owners].filter(([id,who])=>core.has(fragments.get(id).page)&&who.length===1).length,embeddedFormulas:embedded.size,topLevelNarrative:required.size}};
}

export function resolveFlow(index,input){
 const check=validateStructure(index,input);
 if(!check.ok){const e=new Error('Structure rejected: '+check.errors.map(e=>e.code).join(', '));e.validation=check;throw e;}
 const ids=new Map(index.objects.map(o=>[o.id,o])),pages=new Map(input.pages.map(p=>[p.page,p]));
 const events=[];
 function emitSources(o,indices,paragraph,eventId){
  const sources=indices.map(si=>{
   const s=o.source[si],p=pages.get(s.page),a=p.fragments.findIndex(f=>f.id===s.start),b=p.fragments.findIndex(f=>f.id===s.end),fs=p.fragments.slice(a,b+1);
   return{sourceIndex:si,source:s,fragmentIds:fs.map(f=>f.id),text:fs.map(f=>f.text).join(' ')};
  });
  events.push({eventId,objectId:o.id,paragraphId:paragraph,part:o.part,type:o.type,sources,fragmentIds:sources.flatMap(s=>s.fragmentIds),text:sources.map(s=>s.text).join(' ')});
 }
 function emit(o,paragraph=null){
  if(o.content_order){for(const step of o.content_order)if(Object.hasOwn(step,'source'))emitSources(o,[step.source],o.id,`${o.id}:source:${step.source}`);else emit(ids.get(step.object),o.id);}
  else emitSources(o,o.source.map((s,i)=>i),CONTAINERS.has(o.type)?o.id:paragraph,o.id);
 }
 for(const id of index.body_order)emit(ids.get(id));
 return{schema:SCHEMA,events,validation:check};
}
