/** Local admission rules. A review suggestion is not a content-deletion instruction. */
import {validatePageRegions} from './manual_regions.mjs';
export const REVIEW_POLICY='scoped-evidence-v2';
export function reviewCandidate(native,candidate,pipeline=candidate.ai?.pipeline||{}) {
 const ids=new Set(candidate.regions.map(r=>r.id)),items=new Set(native.items.map(i=>i.id)),held=new Map(),warnings=[];
 const hold=(id,message)=>{if(ids.has(id))held.set(id,[...(held.get(id)||[]),message]);};
 const warn=(message,regions=[])=>{if(message)warnings.push({page:native.page,regions,message:String(message).slice(0,1600)});};
 for(const r of candidate.regions){
  if(r.role==='unknown')hold(r.id,'未分类或未覆盖的原生文字');
  // AI literal LaTeX is never certified here. The native formula extractor
  // checks glyphs independently; a generic no-image note must not hide prose.
  if(r.note)warn(r.note,[r.id]);
 }
 function issue(value,regions){
  const evidence=(value.evidence||[]).filter(e=>typeof e==='string'?items.has(e):e?.page===native.page&&items.has(e.itemId));
  const targets=regions.filter(id=>ids.has(id));
  if(value.severity==='blocking'&&['layout','transcription'].includes(value.kind)&&evidence.length&&targets.length){for(const id of targets){const owned=new Set(candidate.regions.find(r=>r.id===id).itemIds||[]);if(evidence.some(e=>owned.has(typeof e==='string'?e:e.itemId)))hold(id,value.message);else warn(value.message,[id]);}}
  else warn(value.message,targets);
 }
 for(const value of pipeline.scopedIssues||[])issue(value,value.regions||[]);
 if(!pipeline.scopedIssues?.length)for(const value of pipeline.issues||[])warn(typeof value==='string'?value:value.message);
 for(const value of pipeline.review?.issues||[])if(value.page===native.page)issue(value,value.region?[value.region]:value.regions||[]);else warn(value.message);
 for(const link of pipeline.review?.links||[])warn('跨页关联仅供核对，未自动合段：'+link.reason);
 const drafts=candidate.regions.map(r=>({id:r.id,role:held.has(r.id)?'pending':r.role,bbox:r.bbox}));
 // Missing/duplicate ownership still throws; warnings cannot waive this audit.
 const overrides=validatePageRegions(native,drafts).map(r=>({...r,confidence:r.role==='pending'?'review-required':'ai-candidate',evidence:'three-stage-ai',reviewPolicy:REVIEW_POLICY}));
 const pending=candidate.regions.filter(r=>held.has(r.id)).map(r=>({page:native.page,id:r.id,originalRole:r.role,reason:held.get(r.id).join('；')}));
 return{overrides,pending,warnings,reviewPolicy:REVIEW_POLICY};
}
