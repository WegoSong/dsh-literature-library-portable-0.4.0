/** Restore the baseline information getTextContent sometimes flattens inside a word. */
const bag=s=>[...String(s).normalize('NFKC').replace(/[\s\u00ad\u200b-\u200f]/gu,'')].sort().join('');
export function unicodeScripts(value){
 const sub='₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎',sup='⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾',plain='0123456789+-=()';
 return String(value).replace(/[₀-₉₊₋₌₍₎]+/gu,s=>'_{'+[...s].map(c=>plain[sub.indexOf(c)]).join('')+'}')
  .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾]+/gu,s=>'^{'+[...s].map(c=>plain[sup.indexOf(c)]).join('')+'}');
}
export function attachNativeScripts(items,glyphs){
 // Bucket by x so dense pages do not turn into items*all-glyphs scans.
 const buckets=new Map(),cell=32;
 for(const g of glyphs){const key=Math.floor((g.x+g.w/2)/cell);if(!buckets.has(key))buckets.set(key,[]);buckets.get(key).push(g);}
 let recovered=0;
 for(const item of items){
  if(!item.str?.trim()||item.str.length>180||Math.abs(item.transform[1])>.02||Math.abs(item.transform[2])>.02)continue;
  const [,,,,x,y]=item.transform,size=Math.abs(item.transform[3])||item.height,w=item.width||0;
  const candidates=[];
  for(let k=Math.floor((x-.8)/cell);k<=Math.floor((x+w+.8)/cell);k++){
   for(const g of buckets.get(k)||[])if(!g.unsupported&&!g.accent&&g.x+g.w/2>=x-.5&&g.x+g.w/2<=x+w+.5&&Math.abs(g.y-y)<size*.8)candidates.push(g);
  }
  if(!candidates.length||bag(candidates.map(g=>g.text).join(''))!==bag(item.str))continue;
  const max=Math.max(...candidates.map(g=>g.size));
  if(!candidates.some(g=>g.size<max*.86&&Math.abs(g.y-y)>max*.1))continue;
  const groups=[];let current=null;
  for(const g of candidates.sort((a,b)=>a.x-b.x||b.y-a.y)){
   if(current&&Math.abs(g.y-current.y)<max*.08&&Math.abs(g.size-current.size)<max*.08){
    if(g.x-current.x1>max*.24)current.str+=' ';
    current.str+=g.text;current.x1=Math.max(current.x1,g.x+g.w);
   }else{current={str:g.text,x:g.x,x1:g.x+g.w,y:g.y,size:g.size};groups.push(current);}
  }
  item.nativeRuns=groups.map(g=>({str:g.str,width:g.x1-g.x,height:g.size,transform:[g.size,0,0,g.size,g.x,g.y],sourceId:item.sourceId}));
  recovered++;
 }
 return recovered;
}
