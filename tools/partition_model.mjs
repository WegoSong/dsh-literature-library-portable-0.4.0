/** Shared, deterministic data contract. PDF points, bottom-left origin, unrotated page viewport. */
export const SCHEMA='paper-partition-lab/v1';
export const ROLES={body:'正文',abstract:'摘要',heading:'标题',formula:'公式',figure:'图片',table:'表格',caption:'题注',references:'参考文献',title:'论文题名','front-matter':'作者信息','article-info':'文章信息',affiliation:'作者单位',publication:'出版信息','running-matter':'页眉页脚',watermark:'忽略/水印',unknown:'待确认'};
export const META=new Set(['title','front-matter','article-info','affiliation','publication','running-matter','watermark']);
const clone=o=>structuredClone(o),same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export const ref=(page,id)=>`${page}:${id}`;
/** Identity is independent of display spelling; S1 and 1 must stay distinct. */
export function mediaKey(value){const m=/^\s*(fig(?:ure)?\.?|table|图|表)\s*([sS]?\d+)(?:\b|\s|[.:：|]|$)/iu.exec(String(value||''));return m?`${/^(?:tab|表)/iu.test(m[1])?'table':'figure'}:${m[2].toUpperCase()}`:null;}
export function reconcileMedia(regions,page){
 const out=clone(regions);for(const c of out.filter(r=>r.role==='caption'&&!r.captionFor)){const key=mediaKey(c.label);if(!key)continue;const targets=out.filter(r=>['figure','table'].includes(r.role)&&mediaKey(r.label)===key);if(targets.length===1)c.captionFor=ref(page,targets[0].id);}
 return out;
}
/** Never reuse a derived equation after its source geometry/type changes. Pure: history on disk is untouched. */
export function invalidateDerived(base,current){const byId=new Map(base.map(r=>[r.id,r]));return current.map(value=>{
 const r=clone(value),old=byId.get(r.id);if(!old)return r;
 if(!same(old.bbox,r.bbox)||old.role!==r.role){
  if((old.role==='formula'||r.role==='formula')&&(r.formula||r.latex)){
   if(!r.formula?.reasons?.includes('region-content-changed')){
    r.formulaHistory=[...(r.formulaHistory||[]),{bbox:old.bbox,latex:r.latex||r.formula?.latex||'',tag:r.formula?.tag??null}].slice(-3);
    if(r.latex===old.latex)r.latex='';
    r.formula={latex:'',reliable:false,reasons:['region-content-changed'],tag:null,format:'unverified-text'};
   }
  }
 }
 if(r.role!=='formula'){delete r.formula;r.latex='';}return r;
 });}
export function cleanRegion(r,page,index){
 if(!r||typeof r.id!=='string'||!/^[a-zA-Z0-9:_-]{1,140}$/u.test(r.id)||!Object.hasOwn(ROLES,r.role))throw Error('无效分区编号或类型');
 const b=r.bbox;if(!Array.isArray(b)||b.length!==4||!b.every(Number.isFinite)||b[0]<0||b[1]<0||b[2]>page.width+.05||b[3]>page.height+.05||b[2]-b[0]<.5||b[3]-b[1]<.5)throw Error('边界无效或超出页面');
 const text=(v,n)=>typeof v==='string'?v.slice(0,n):'';
 return{id:r.id,role:r.role,bbox:b.map(n=>Math.round(n*1000)/1000),order:index+1,label:text(r.label,160),captionFor:text(r.captionFor,180),note:text(r.note,4000),latex:text(r.latex,20000),...(r.formula?{formula:clone(r.formula)}:{}),...(Array.isArray(r.formulaHistory)?{formulaHistory:clone(r.formulaHistory.slice(-3))}:{}),itemIds:Array.isArray(r.itemIds)?r.itemIds.filter(x=>typeof x==='string'):[]};
}
export function validateRegions(page,regions){
 if(!Array.isArray(regions)||regions.length>256)throw Error('每页最多 256 个分区');
 const clean=regions.map((r,i)=>cleanRegion(r,page,i));if(new Set(clean.map(r=>r.id)).size!==clean.length)throw Error('分区编号重复');return clean;
}
function comparable(r){return{...Object.fromEntries(['role','bbox','label','captionFor','note','latex'].map(k=>[k,r[k]??''])),formula:r.formula?clone(r.formula):null,formulaHistory:r.formulaHistory?clone(r.formulaHistory):null};}
export function diffRegions(base,current){
 const before=new Map(base.map(r=>[r.id,r])),after=new Map(current.map(r=>[r.id,r])),ops=[];
 for(const r of base)if(!after.has(r.id))ops.push({op:'delete',id:r.id,intent:'explicit-delete'});
 for(const r of current){if(!before.has(r.id))ops.push({op:'add',region:clone(r)});else if(!same(comparable(before.get(r.id)),comparable(r)))ops.push({op:'update',id:r.id,changes:comparable(r)});}
 return{operations:ops,order:current.map(r=>r.id)};
}
export function applyPatch(base,patch){
 const map=new Map(base.map(r=>[r.id,clone(r)]));
 if(!patch||!Array.isArray(patch.operations)||patch.operations.length>768)throw Error('无效人工补丁');
 for(const op of patch.operations){
  if(op.op==='delete'){if(!map.has(op.id)||op.intent!=='explicit-delete')throw Error('删除必须明确指定已有分区');map.delete(op.id);}
  else if(op.op==='update'){if(!map.has(op.id))throw Error('修改对象不存在');map.set(op.id,{...map.get(op.id),...op.changes,id:op.id});}
  else if(op.op==='add'){if(map.has(op.region?.id))throw Error('新增编号重复');map.set(op.region.id,clone(op.region));}
  else throw Error('未知人工操作');
 }
 if(!Array.isArray(patch.order)||patch.order.length!==map.size||new Set(patch.order).size!==map.size||patch.order.some(id=>!map.has(id)))throw Error('阅读顺序必须完整且不重复');
 return patch.order.map((id,i)=>{const r={...map.get(id),order:i+1};if(!r.formula)delete r.formula;if(!r.formulaHistory)delete r.formulaHistory;return r;});
}
/** New/moved boxes take their geometric contents, while untouched source ownership remains stable. */
export function auditPage(page,regions,base=page.regions){
 const original=new Map(base.map(r=>[r.id,r])),ids=new Map(regions.map(r=>[r.id,[]])),uncovered=[],overlap=[];
 const moved=regions.filter(r=>!original.has(r.id)||!same(r.bbox,original.get(r.id).bbox));
 for(const item of page.items||[]){
  const [l,b,r,t]=item.bbox,x=(l+r)/2,y=(b+t)/2;
  let owners=moved.filter(a=>x>=a.bbox[0]&&x<=a.bbox[2]&&y>=a.bbox[1]&&y<=a.bbox[3]);
  if(!owners.length)owners=regions.filter(a=>!moved.includes(a)&&original.get(a.id)?.itemIds.includes(item.id));
  if(!owners.length)uncovered.push(item.id);else if(owners.length>1)overlap.push(item.id);else ids.get(owners[0].id).push(item.id);
 }
 const warnings=[];
 for(const r of regions)if(r.note?.includes('[AI关联待确认]'))warnings.push({id:r.id,code:'ai-association-review',message:'AI 原关联无效，分区已保留；请手动核对关联后清除待确认备注'});
 for(const r of regions){if(r.role==='caption'&&!r.captionFor)warnings.push({id:r.id,code:'unpaired-caption',message:'题注尚未关联图片/表格'});if(['figure','table'].includes(r.role)&&!mediaKey(r.label))warnings.push({id:r.id,code:'unlabelled-media',message:'图片/表格尚无有效图号或表号'});
  if(r.role==='formula'&&!r.latex)warnings.push({id:r.id,code:r.formula?.reasons?.includes('region-content-changed')?'stale-formula':'unverified-formula',message:r.formula?.reasons?.includes('region-content-changed')?'公式边界已变更，旧识别已停用，需重新核对':'公式区域已定位，LaTeX 尚未核对'});
  if(r.role==='unknown')warnings.push({id:r.id,code:'unknown-region',message:'此区类型待确认，不会静默丢弃'});
  if(r.captionFor?.startsWith(page.page+':')){const target=regions.find(a=>ref(page.page,a.id)===r.captionFor);if(!target||!['figure','table'].includes(target.role))warnings.push({id:r.id,code:'invalid-association',message:'题注目标不存在或不是图表'});else if(mediaKey(r.label)&&mediaKey(target.label)&&mediaKey(r.label)!==mediaKey(target.label))warnings.push({id:r.id,code:'association-number-mismatch',message:'题注和目标图表编号不一致'});}
 }
 for(const r of base.filter(r=>['figure','table'].includes(r.role)))if(!regions.some(a=>a.role===r.role&&(a.id===r.id||iou(a.bbox,r.bbox)>.5)))warnings.push({id:r.id,code:'removed-media',message:'机器图表未保留：请确认是有意删除，而非漏图'});
 for(const r of regions.filter(r=>['figure','table'].includes(r.role))){const key=mediaKey(r.label);if(key&&regions.filter(a=>['figure','table'].includes(a.role)&&mediaKey(a.label)===key).length>1)warnings.push({id:r.id,code:'duplicate-media-number',message:'本页图表编号重复，无法安全自动配对'});}
 const titles=regions.filter(r=>r.role==='title'),first=regions.findIndex(r=>['body','abstract','heading'].includes(r.role));if(first>=0&&titles.some(t=>regions.indexOf(t)>first))warnings.push({code:'title-order',message:'论文题名排在摘要或正文之后，请检查阅读顺序'});
 return{ok:!uncovered.length&&!overlap.length,sourceItems:(page.items||[]).length,uncovered,overlap,warnings,itemIds:Object.fromEntries(ids),checks:{coverage:!uncovered.length&&!overlap.length,associations:!warnings.some(w=>/caption|association|media/u.test(w.code)),classification:!warnings.some(w=>w.code==='unknown-region'),order:!warnings.some(w=>w.code==='title-order'),formulas:regions.some(r=>r.role==='formula')?!warnings.some(w=>/formula/u.test(w.code)):null,visualCompleteness:'requires-human-review'}};
}
export function iou(a,b){const w=Math.max(0,Math.min(a[2],b[2])-Math.max(a[0],b[0])),h=Math.max(0,Math.min(a[3],b[3])-Math.max(a[1],b[1])),i=w*h,u=(a[2]-a[0])*(a[3]-a[1])+(b[2]-b[0])*(b[3]-b[1])-i;return u>0?i/u:0;}
/** Area union, not summed pairwise overlap: duplicate boxes must not inflate coverage. */
function areaCovered(box,others){const clipped=others.map(b=>[Math.max(box[0],b[0]),Math.max(box[1],b[1]),Math.min(box[2],b[2]),Math.min(box[3],b[3])]).filter(b=>b[2]>b[0]&&b[3]>b[1]),xs=[...new Set(clipped.flatMap(b=>[b[0],b[2]]))].sort((a,b)=>a-b);let area=0;
 for(let i=1;i<xs.length;i++){const ranges=clipped.filter(b=>b[0]<=xs[i-1]&&b[2]>=xs[i]).map(b=>[b[1],b[3]]).sort((a,b)=>a[0]-b[0]);let length=0,last=-Infinity;for(const [lo,hi]of ranges){length+=Math.max(0,hi-Math.max(last,lo));last=Math.max(last,hi);}area+=(xs[i]-xs[i-1])*length;}return area/((box[2]-box[0])*(box[3]-box[1]));}
function granularityGroups(machine,human){const groups=[];for(const [kind,one,many]of [['split',human,machine],['merge',machine,human]])for(const r of one){const parts=many.filter(a=>a.role===r.role&&areaCovered(a.bbox,[r.bbox])>.85);if(parts.length>1&&areaCovered(r.bbox,parts.map(a=>a.bbox))>.8)groups.push({kind,role:r.role,one:r.id,many:parts.map(a=>a.id),coverage:areaCovered(r.bbox,parts.map(a=>a.bbox)),message:`${kind==='split'?'机器拆分':'机器合并'}：${ROLES[r.role]} 1 ↔ ${parts.length}，请核对是否只是粒度不同`});}return groups;}
/** Maximum-weight one-to-one geometry matching, not an order-dependent greedy count. */
function assignment(weights){
 const n=weights.length;if(!n)return[];const m=weights[0].length;if(!m)return[];const size=Math.max(n,m),u=Array(size+1).fill(0),v=[...u],p=[...u],way=[...u];
 for(let i=1;i<=size;i++){p[0]=i;let j0=0;const minv=Array(size+1).fill(Infinity),used=Array(size+1).fill(false);
  do{used[j0]=true;const i0=p[j0];let delta=Infinity,j1=0;for(let j=1;j<=size;j++)if(!used[j]){const cur=-(weights[i0-1]?.[j-1]||0)-u[i0]-v[j];if(cur<minv[j]){minv[j]=cur;way[j]=j0;}if(minv[j]<delta){delta=minv[j];j1=j;}}
   for(let j=0;j<=size;j++)if(used[j]){u[p[j]]+=delta;v[j]-=delta;}else minv[j]-=delta;j0=j1;
  }while(p[j0]!==0);
  do{const j1=way[j0];p[j0]=p[j1];j0=j1;}while(j0);
 }
 return p.slice(1).map((i,j)=>[i-1,j]).filter(([i,j])=>i<n&&j<m);
}
export function comparePage(machine,human,{reviewed=false}={}){
 const weights=machine.map(a=>human.map(b=>{const g=iou(a.bbox,b.bbox);return g>=.2?g:0;}));
 const pairs=assignment(weights).filter(([a,b])=>weights[a][b]>=.2).map(([a,b])=>({machine:machine[a].id,human:human[b].id,iou:weights[a][b],sameRole:machine[a].role===human[b].role,a,b}));
 const autoMatched=new Set(pairs.map(p=>p.machine)),humanMatched=new Set(pairs.map(p=>p.human)),map=new Map(pairs.map(p=>[p.machine,p.human])),differences=[];
 for(const b of human)if(!humanMatched.has(b.id))differences.push({kind:'missing',human:b.id,role:b.role,message:`漏检：${ROLES[b.role]} ${b.label||''}`});
 for(const a of machine)if(!autoMatched.has(a.id))differences.push({kind:'extra',machine:a.id,role:a.role,message:`多检：${ROLES[a.role]} ${a.label||''}`});
 for(const p of pairs){const a=machine[p.a],b=human[p.b];if(!p.sameRole)differences.push({kind:'role',machine:a.id,human:b.id,message:`类型：${ROLES[a.role]} → ${ROLES[b.role]}`});if(p.iou<.9)differences.push({kind:'boundary',machine:a.id,human:b.id,iou:p.iou,message:`边界差异：IoU ${(p.iou*100).toFixed(1)}%`});
  const translateRef=value=>{const sep=value.indexOf(':');return sep<0?value:value.slice(0,sep+1)+(map.get(value.slice(sep+1))||value.slice(sep+1));};
  if((a.captionFor||'')!==(b.captionFor||'')&&translateRef(a.captionFor||'')!==(b.captionFor||''))differences.push({kind:'association',machine:a.id,human:b.id,message:'题注关联不同'});
 }
 const flow=pairs.filter(p=>!META.has(machine[p.a].role)&&!META.has(human[p.b].role)).sort((a,b)=>a.a-b.a);let inversions=0;
 for(let i=0;i<flow.length;i++)for(let j=i+1;j<flow.length;j++)if(flow[i].b>flow[j].b)inversions++;
 if(inversions)differences.push({kind:'order',message:`阅读顺序存在 ${inversions} 对逆序`});
 const tp=pairs.filter(p=>p.sameRole&&p.iou>=.5).length,fp=machine.length-tp,fn=human.length-tp;
 const groups=granularityGroups(machine,human);for(const g of groups)differences.push({kind:'granularity',message:g.message,...(g.kind==='split'?{human:g.one}:{machine:g.one})});
 return{reviewed,thresholds:{matching:.2,correct:.5,boundary:.9},granularity:groups,pairs:pairs.map(({a,b,...p})=>p),differences,counts:{machine:machine.length,human:human.length,missing:human.filter(r=>!humanMatched.has(r.id)).length,extra:machine.filter(r=>!autoMatched.has(r.id)).length,inversions},metrics:reviewed?{tp,fp,fn,precision:machine.length?tp/machine.length:null,recall:human.length?tp/human.length:null,meanIoU:pairs.length?pairs.reduce((s,p)=>s+p.iou,0)/pairs.length:null}:null};
}

