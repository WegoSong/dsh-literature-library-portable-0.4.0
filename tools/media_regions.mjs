/** Native PDF objects stay out of the prose stream, even when inclusion is off. */
import { itemBox, unionBoxes } from './page_regions.mjs';
export const MEDIA_POLICY = 'document-v4-semantic-preview';
export const mediaOptions = value => ({ figures: value?.figures === true, tables: value?.tables === true, formulaFallback:value?.formulaFallback!==false });
const inside = (i,b) => {const a=itemBox(i),x=(a[0]+a[2])/2,y=(a[1]+a[3])/2;return x>=b[0]&&x<=b[2]&&y>=b[1]&&y<=b[3];};
const mult=(m,n)=>[m[0]*n[0]+m[2]*n[1],m[1]*n[0]+m[3]*n[1],m[0]*n[2]+m[2]*n[3],m[1]*n[2]+m[3]*n[3],m[0]*n[4]+m[2]*n[5]+m[4],m[1]*n[4]+m[3]*n[5]+m[5]];
const box=(b,m)=>unionBoxes([[b[0],b[1]],[b[0],b[3]],[b[2],b[1]],[b[2],b[3]]].map(([x,y])=>{const a=m[0]*x+m[2]*y+m[4],c=m[1]*x+m[3]*y+m[5];return[a,c,a,c];}));
export async function pageGraphics(page, OPS) {
 const op=await page.getOperatorList(), rules=[], images=[], paths=[], stack=[];let m=[1,0,0,1,0,0];
 for(let i=0;i<op.fnArray.length;i++){
  const f=op.fnArray[i],a=op.argsArray[i];
  if(f===OPS.save) stack.push([...m]);
  else if(f===OPS.restore) m=stack.pop()||m;
  else if(f===OPS.transform) m=mult(m,a);
  else if(f===OPS.paintFormXObjectBegin){stack.push([...m]);if(a[0])m=mult(m,a[0]);}
  else if(f===OPS.paintFormXObjectEnd)m=stack.pop()||m;
  else if(f===OPS.constructPath&&a[2]){const b=box(Array.from(a[2]),m);paths.push(b);if(b[2]-b[0]>30&&b[3]-b[1]<2)rules.push(b);}
  else if([OPS.paintImageXObject,OPS.paintInlineImageXObject,OPS.paintImageMaskXObject].includes(f)) {const b=box([0,0,1,1],m);if(b[2]-b[0]>30&&b[3]-b[1]>25)images.push(b);}
 }
 return {rules,images,paths};
}
function nativeLines(items){
 const rows=[];
 for(const i of [...items].sort((a,b)=>b.transform[5]-a.transform[5]||a.transform[4]-b.transform[4])){
  let r=rows.find(r=>Math.abs(r.y-i.transform[5])<1.8);if(!r){r={y:i.transform[5],items:[]};rows.push(r);}r.items.push(i);
 }
 return rows.map(r=>({...r,items:r.items.sort((a,b)=>a.transform[4]-b.transform[4]),text:r.items.map(i=>i.str).join(' ')}));
}
/** Human table boxes often include their title. Split that title only when a
 * native TABLE label and a matching top table rule both support the boundary. */
export function separateManualTableCaptions(regions,items,graphics){
 const result=[];
 for(const region of regions){
  if(region.role!=='table'){result.push(region);continue;}
  const owned=new Set(region.itemIds),members=items.filter(i=>owned.has(i.sourceId)),lines=nativeLines(members);
  const label=lines.find(l=>/^(?:TABLE|Table)\s*\d+\b/u.test(l.text.trim()));
  const top=label&&graphics.rules.filter(b=>b[3]<label.y&&label.y-b[3]<40&&Math.abs(b[0]-region.bbox[0])<14&&Math.abs(b[2]-region.bbox[2])<14).sort((a,b)=>b[3]-a[3])[0];
  if(!top){result.push(region);continue;}
  const cap=members.filter(i=>i.transform[5]>top[3]+.5&&i.height<=label.items[0].height*1.1),ids=new Set(cap.map(i=>i.sourceId));
  if(!cap.length){result.push(region);continue;}
  const title=/^(?:Table)\s*\d+/iu.exec(label.text.trim())?.[0];
  result.push({id:region.id+'-caption',role:'caption',bbox:unionBoxes(cap.map(itemBox)),itemIds:[...ids],flow:'article',order:region.order,evidence:'native-table-title-inside-human-box',confidence:'rule-supported'});
  result.push({...region,label:title||region.label,bbox:[region.bbox[0],region.bbox[1],region.bbox[2],Math.min(region.bbox[3],top[3]+1)],itemIds:region.itemIds.filter(id=>!ids.has(id))});
 }
 return result;
}
export function identifyMedia(semantic,{page,width,height,graphics,previousTables=[]}){
 const items=semantic.items.filter(i=>i.str.trim()&&!i.regionId), lines=nativeLines(items), objects=[];
 const claim=(role,bbox,evidence)=>{
  const members=items.filter(i=>!i.regionId&&inside(i,bbox));
  const r={id:`p${page}-media-${objects.length+1}`,role,bbox,itemIds:members.map(i=>i.sourceId),flow:'article',order:100+objects.length,evidence,confidence:'rule-supported'};
  for(const i of members)i.regionId=r.id;semantic.regions.push(r);objects.push(r);return r;
 };
 const rotated=items.filter(i=>Math.abs(i.transform[1])>Math.abs(i.transform[0])*2);
 const rotatedLabel=rotated.find(i=>/^Table\s*\d+\.?$/iu.test(i.str.trim()));
 if(rotatedLabel&&rotated.length>20){
   const first=rotated.indexOf(rotatedLabel), cap=rotated.slice(first,first+2);
   const c=claim('caption',unionBoxes(cap.map(itemBox)),'rotated-table-caption');c.captionText=cap.map(i=>i.str).join(' ');
   const r=claim('table',unionBoxes(rotated.filter(i=>!i.regionId).map(itemBox)),'rotated-native-table');r.label=rotatedLabel.str;r.rotation=90;
 }
 // A bare label is unambiguous. A sentence such as "Table 1 presents ..." is not.
 const normalSizes=items.filter(i=>i.height>4&&i.str.trim().length>2).map(i=>i.height).sort((a,b)=>a-b),normalSize=normalSizes[Math.floor(normalSizes.length/2)]||10;
 const seeds=lines.filter(l=>/^(?:Table|Fig(?:ure)?\.?)\s*\d+\b/iu.test(l.text.trim())&&!l.items.some(i=>i.regionId)
   && (/^(?:Table|Fig(?:ure)?\.?)\s*\d+\s*(?:[.:]|$)/iu.test(l.text.trim())
    ||/^(?:TABLE|FIGURE)\s*\d+\b/u.test(l.text.trim())||l.items[0].height<normalSize*.95));
 for(const seed of seeds){
  const table=/^Table/iu.test(seed.text), sb=unionBoxes(seed.items.map(itemBox));
  const near=graphics.rules.filter(b=>b[3]<sb[1]+3&&sb[1]-b[3]<45&&b[0]<=sb[0]+12&&b[2]>sb[0]+80).sort((a,b)=>b[3]-a[3]);
  let bounds;
  if(table&&near.length){
   const top=near[0], bottoms=graphics.rules.filter(b=>b[3]<top[1]-25&&Math.abs(b[0]-top[0])<5&&Math.abs(b[2]-top[2])<5).sort((a,b)=>a[1]-b[1]);
   if(bottoms.length)bounds=[top[0]-1,bottoms[0][1]-1,top[2]+1,top[3]+1];
  }
  if(!table){
   let pics=graphics.images.filter(b=>b[1]>=sb[3]-4&&b[1]-sb[3]<height*.65&&b[0]<sb[2]+width*.4&&b[2]>sb[0]-10);
   // Vector plots have no embedded bitmap. A bounded native drawing can seed a
   // crop too; manual figure boxes always support arbitrary PDF drawing content.
   if(!pics.length)pics=graphics.paths.filter(b=>b[2]-b[0]>60&&b[3]-b[1]>35&&b[1]>=sb[3]-3&&b[1]-sb[3]<45&&b[0]>=sb[0]-12);
   if(pics.length){
    const closest=pics.sort((a,b)=>a[1]-b[1])[0];
    const group=pics.filter(b=>b[1]<=closest[3]+8&&b[3]>=closest[1]-8);
    bounds=unionBoxes(group);bounds=[Math.max(0,bounds[0]-2),Math.max(sb[3],bounds[1]-2),Math.min(width,bounds[2]+2),Math.min(height,bounds[3]+2)];
   }
  }
  if(!bounds){
   // A label at the start of a sentence in a body paragraph isn't a caption.
   const bare=/^(?:Table|Fig(?:ure)?\.?)\s*\d+\s*[.:]?$/iu.test(seed.text.trim());
   if(bare)semantic.warnings.push(`unresolved-media-layout: ${seed.text.slice(0,40)} needs a separate table/figure box`);
   continue;
  }
  const capWidth=table?bounds[2]-bounds[0]:Math.max(bounds[2]-bounds[0],sb[2]-sb[0]);
  const following=lines.map(l=>({...l,items:l.items.filter(i=>i.transform[4]>=sb[0]-2&&i.transform[4]+i.width<=sb[0]+capWidth+3)}))
    .filter(l=>l.items.length&&l.y<=seed.y&&seed.y-l.y<240
    &&l.items.every(i=>i.height<=seed.items[0].height*1.1));
  const caption=[];
  for(const l of following){if(caption.length&&caption.at(-1).y-l.y>seed.items[0].height*1.8)break;
   if(table&&l.y<bounds[3])break;caption.push(l);}
  claim('caption',unionBoxes(caption.flatMap(l=>l.items).map(itemBox)),'native-media-caption');
  const r=claim(table?'table':'figure',bounds,table?'caption+matching-table-rules':'caption+native-image-bounds');
  r.label=/^(?:Table|Fig(?:ure)?\.?)\s*\d+/iu.exec(seed.text.trim())?.[0]||seed.text.trim();
 }
 // Repeated headers/outer rules on the next page: keep a continued table isolated.
 if(!objects.some(r=>r.role==='table'))for(const prev of previousTables){
  const rs=graphics.rules.filter(b=>Math.abs(b[0]-prev.bbox[0])<6&&Math.abs(b[2]-prev.bbox[2])<6).sort((a,b)=>b[3]-a[3]);
  if(rs.length<2||rs[0][3]<height*.7)continue;
  const b=[rs[0][0]-1,rs.at(-1)[1]-1,rs[0][2]+1,rs[0][3]+1];
  const members=items.filter(i=>inside(i,b));
  if(members.length>15){const r=claim('table',b,'continued-table+matching-outer-rules');r.label=prev.label;r.continued=true;}
 }
 return objects;
}
/** Reconstruct a plain rectangular grid. Never synthesize values for merged cells. */
export function tableGrid(items,bbox,graphics={rules:[]},renderCell){
 if(items.some(i=>/[\u0000\ufffd]/u.test(i.str)))return null;
 if(items.length&&items.filter(i=>Math.abs(i.transform[1])>Math.abs(i.transform[0])*2).length>items.length*.8){
   // Centred headers and fragmented superscripts in sideways tables do not give
   // trustworthy column boundaries. Recognise/omit them safely, but never ship a
   // plausible-looking grid with values silently shifted into neighbouring cells.
   return null;
 }
 const lines=nativeLines(items);if(lines.length<2)return null;
 const top=lines[0], starts=[];
 for(const i of top.items){const x=i.transform[4];const last=starts.at(-1);if(last===undefined||x-last>18)starts.push(x);}
 if(starts.length<2||starts.length>16)return null;
 const columns=starts.map((x,i)=>i?x-3:bbox[0]), n=columns.length;
 // Header separator rules are stronger evidence than a change in prose baseline.
 const headerRule=graphics.rules.filter(b=>b[1]<top.y&&top.y-b[1]<40&&b[2]-b[0]>bbox[2]*.04).sort((a,b)=>b[3]-a[3])[0];
 const headerBottom=headerRule?.[1]??top.y-2;
 const dateRows=lines.filter(l=>l.y<headerBottom&&l.items.some(i=>Math.abs(i.transform[4]-starts[0])<4&&/^(?:19|20)\d{2}/u.test(i.str.trim())));
 const mechanismRows=lines.filter(l=>l.y<headerBottom&&l.items.some(i=>Math.abs(i.transform[4]-starts[1])<3&&/^[A-Z\d(]/u.test(i.str.trim())));
 const rowStarts=(dateRows.length>=3?dateRows:mechanismRows).map(l=>l.y);
 if(!rowStarts.length)return null;
 const rows=Array.from({length:rowStarts.length+1},()=>Array.from({length:n},()=>[]));
 const sizes=items.map(i=>i.height).sort((a,b)=>a-b),baseSize=sizes[Math.floor(sizes.length/2)]||7;
 for(const l of lines)for(const i of l.items){
  let y=i.transform[5];const x=i.transform[4];let r=0;
  if(i.height<baseSize*.88){
    const host=items.filter(j=>j.height>=baseSize*.9&&Math.abs(j.transform[5]-y)<baseSize*.85
      &&Math.max(x-j.transform[4]-j.width,j.transform[4]-x-i.width,0)<baseSize)
      .sort((a,b)=>(Math.abs(a.transform[5]-y)+Math.abs(a.transform[4]+a.width-x))-(Math.abs(b.transform[5]-y)+Math.abs(b.transform[4]+b.width-x)))[0];
    if(host)y=host.transform[5];
  }
  if(y<headerBottom)r=1+Math.max(0,rowStarts.findLastIndex(s=>y<=s+2));
  let c=columns.findLastIndex(s=>x>=s);c=Math.max(0,c);
  rows[r][c].push(i);
 }
 return rows.map(row=>row.map(cell=>renderCell?renderCell(cell):nativeLines(cell).map(l=>l.text).join(' ').trim()));
}
export const markdownTable=rows=>rows.map((r,i)=>`| ${r.map(v=>String(v).replace(/\|/gu,'&#124;').replace(/\r?\n/gu,' ')).join(' | ')} |${i===0?'\n| '+r.map(()=>'---').join(' | ')+' |':''}`).join('\n');
