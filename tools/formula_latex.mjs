/** Local, evidence-driven math reconstruction. No model calls or guessed symbols. */
const mul=(m,n)=>[m[0]*n[0]+m[2]*n[1],m[1]*n[0]+m[3]*n[1],m[0]*n[2]+m[2]*n[3],m[1]*n[2]+m[3]*n[3],m[0]*n[4]+m[2]*n[5]+m[4],m[1]*n[4]+m[3]*n[5]+m[5]];
const identity=()=>[1,0,0,1,0,0];
const median=a=>{const s=[...a].sort((a,b)=>a-b);return s[Math.floor(s.length/2)]||0;};
const norm=s=>String(s??'').normalize('NFKC').replace(/[\s\u00ad\u200b-\u200f]/gu,'');
// NFKC alone folds phi/epsilon variants and even h-bar into different symbols.
// Preserve the variants carried by native glyphs instead of silently replacing them.
function mathUnicode(value){return [...String(value)].map(c=>{
 if('ϕϵϑϰϱϖℏ'.includes(c))return c;
 const code=c.codePointAt(0),starts=[0x1d6dc,0x1d716,0x1d750,0x1d78a,0x1d7c4];
 for(const start of starts)if(code>=start&&code<start+6)return [...'ϵϑϰϕϱϖ'][code-start];
 return c.normalize('NFKC');
}).join('');}
const bag=s=>[...norm(s)].sort().join('');
const inCrop=(g,c)=>g.x+g.w/2>=c.left-.5&&g.x+g.w/2<=c.right+.5&&g.y>=c.bottom-.5&&g.y<=c.top+.5;

/** getTextContent can merge a subscript into a full-size word (Rin instead of
 * R_in). Read unmerged glyph positions from the same PDF drawing operators. */
export async function readMathGlyphs(page,OPS,crops){
 const op=await page.getOperatorList(),out=[],stack=[];
 let s={cm:identity(),tm:identity(),x:0,y:0,lx:0,ly:0,fontSize:1,font:null,char:0,word:0,hs:1,rise:0,leading:0};
 const move=(x,y)=>{s.x=s.lx+=x;s.y=s.ly+=y;};
 for(let i=0;i<op.fnArray.length;i++){
  const f=op.fnArray[i],a=op.argsArray[i]||[];
  if(f===OPS.save)stack.push({...s,cm:[...s.cm],tm:[...s.tm]});
  else if(f===OPS.restore)s=stack.pop()||s;
  else if(f===OPS.transform)s.cm=mul(s.cm,a);
  else if(f===OPS.paintFormXObjectBegin){stack.push({...s,cm:[...s.cm],tm:[...s.tm]});if(a[0])s.cm=mul(s.cm,a[0]);}
  else if(f===OPS.paintFormXObjectEnd)s=stack.pop()||s;
  else if(f===OPS.beginText){s.tm=identity();s.x=s.y=s.lx=s.ly=0;}
  else if(f===OPS.setTextMatrix){s.tm=Array.from(a[0]);s.x=s.y=s.lx=s.ly=0;}
  else if(f===OPS.setFont){s.font=a[0];s.fontSize=a[1];}
  else if(f===OPS.setCharSpacing)s.char=a[0];
  else if(f===OPS.setWordSpacing)s.word=a[0];
  else if(f===OPS.setHScale)s.hs=a[0]/100;
  else if(f===OPS.setTextRise)s.rise=a[0];
  else if(f===OPS.setLeading)s.leading=-a[0];
  else if(f===OPS.moveText)move(a[0],a[1]);
  else if(f===OPS.setLeadingMoveText){s.leading=-a[1];move(a[0],a[1]);}
  else if(f===OPS.nextLine)move(0,s.leading);
  else if([OPS.showText,OPS.nextLineShowText,OPS.nextLineSetSpacingShowText].includes(f)){
   let glyphs=a[0];
   if(f===OPS.nextLineShowText)move(0,s.leading);
   if(f===OPS.nextLineSetSpacingShowText){s.word=a[0];s.char=a[1];move(0,s.leading);glyphs=a[2];}
   if(!Array.isArray(glyphs))continue;
   let font;try{font=page.commonObjs.get(s.font);}catch{}
   const fm=font?.fontMatrix?.[0]??.001, m=mul(s.cm,s.tm);
   const unsupported=font?.vertical||font?.isType3Font||s.fontSize<=0||Math.abs(m[1])>.02||Math.abs(m[2])>.02||m[0]<=0||m[3]<=0||Math.abs(fm-.001)>.000001;
   let advance=0;
   for(const g of glyphs){
    if(typeof g==='number'){advance-=g*s.fontSize*.001;continue;}
    if(!g)continue;
    const w=(g.width||0)*s.fontSize*fm;
    const x=m[0]*(s.x+advance*s.hs)+m[2]*(s.y+s.rise)+m[4], y=m[1]*(s.x+advance*s.hs)+m[3]*(s.y+s.rise)+m[5];
    const item={text:g.unicode||'\ufffd',x,y,w:Math.abs(w*s.hs*m[0]),size:Math.abs(s.fontSize*m[3]),unsupported:!!unsupported,accent:!!g.accent,bold:!!(font?.bold||font?.black)};
    if(item.text.trim()&&crops.some(c=>inCrop(item,c)))out.push(item);
    advance+=w+s.char+(g.isSpace?s.word:0);
   }
   s.x+=advance*s.hs;
  }
 }
 return out;
}

const symbols={
 'α':'alpha','β':'beta','γ':'gamma','δ':'delta','ε':'varepsilon','ϵ':'epsilon','ζ':'zeta','η':'eta','θ':'theta','ϑ':'vartheta','ι':'iota','κ':'kappa','λ':'lambda','μ':'mu','ν':'nu','ξ':'xi','π':'pi','ρ':'rho','ϱ':'varrho','σ':'sigma','ς':'varsigma','τ':'tau','υ':'upsilon','φ':'varphi','ϕ':'phi','χ':'chi','ψ':'psi','ω':'omega',
 'Γ':'Gamma','Δ':'Delta','Θ':'Theta','Λ':'Lambda','Ξ':'Xi','Π':'Pi','Σ':'Sigma','Υ':'Upsilon','Φ':'Phi','Ψ':'Psi','Ω':'Omega','ϰ':'varkappa','ϖ':'varpi',
 '×':'times','÷':'div','±':'pm','∓':'mp','≈':'approx','≠':'neq','≤':'leq','≥':'geq','∞':'infty','∂':'partial','∇':'nabla','∫':'int','∑':'sum','∏':'prod','⋅':'cdot','·':'cdot','→':'to','∝':'propto','∈':'in','∉':'notin','∪':'cup','∩':'cap','∧':'land','∨':'lor','⊗':'otimes','⊥':'perp','ℏ':'hbar','ℓ':'ell','°':'circ',
};
function tex(value,reasons){
 let result='';
 for(const c of mathUnicode(value)){
  if(/\s/u.test(c))continue;
  if(symbols[c])result+=`\\${symbols[c]} `;
  else if(c==='−'||c==='–')result+='-';
  else if(c==='∕'||c==='⁄')result+='/';
  else if(/[A-Za-z0-9=+\-*/().,;:!\[\]|<>]/u.test(c))result+=c;
  else if(c==='{')result+='\\{';else if(c==='}')result+='\\}';
  else {reasons.add('unknown-glyph');result+='\\boxed{?}';}
 }
 return result;
}
const extent=nodes=>({x:Math.min(...nodes.map(n=>n.x)),x1:Math.max(...nodes.map(n=>n.x+n.w))});
const chars=g=>g.map(n=>n.text||'').join('');

export function reconstructFormula({glyphs=[],items=[],paths=[],crop}){
 const reasons=new Set(),native=items.map(i=>i.str).join(''),selected=glyphs.filter(g=>inCrop(g,crop));
 if(!selected.length)return {latex:'',reliable:false,reasons:['no-native-formula-glyphs']};
 if(bag(chars(selected))!==bag(native))reasons.add('glyph-coverage-mismatch');
 if(selected.some(g=>g.unsupported||g.accent))reasons.add('unsupported-font-or-transform');
 const base=median(selected.map(g=>g.size).filter(s=>s>=Math.max(...selected.map(g=>g.size))*.8))||9;
 let nodes=selected.map((g,i)=>({...g,id:i,text:mathUnicode(g.text),latex:null}));
 // Keep equation numbers out of the expression; only a far-right isolated label.
 const xs=[...nodes].sort((a,b)=>a.x-b.x),tail=[];let tag='';
 for(let i=xs.length-1;i>=0;i--){tail.unshift(xs[i]);const t=chars(tail);if(/^\(\d+[a-z]?\)$/u.test(t)){
   const left=xs[i-1];if(left&&xs[i].x-(left.x+left.w)>base*3){tag=t.slice(1,-1);const ids=new Set(tail.map(g=>g.id));nodes=nodes.filter(n=>!ids.has(n.id));}break;
  }if(t.length>8)break;}
 const bars=paths.filter(b=>b[0]>=crop.left-.5&&b[2]<=crop.right+.5&&b[1]>=crop.bottom&&b[3]<=crop.top&&b[2]-b[0]>2&&b[3]-b[1]<1.4)
  .filter((b,i,a)=>a.findIndex(c=>c.every((v,j)=>Math.abs(v-b[j])<.2))===i);
 const used=new Set();
 const render=(input,localBars,depth=0)=>{
  if(depth>6){reasons.add('nested-layout-limit');return input.map(n=>tex(n.text,reasons)).join('');}
  let work=[...input];
  for(const b of [...localBars].sort((a,b)=>(b[2]-b[0])-(a[2]-a[0]))){
   if(used.has(b))continue;
   const mid=(b[1]+b[3])/2;
   const here=work.filter(n=>n.x+n.w/2>=b[0]-.6&&n.x+n.w/2<=b[2]+.6&&Math.abs(n.y-mid)<base*3.5);
   const up=here.filter(n=>n.y>mid+.6),down=here.filter(n=>n.y<mid-.6);
   // Radical overbars cannot be fractions: their root sign starts to the left
   // and close to the line. Partition outer fractions before descending.
   const radical=work.some(n=>n.text==='√'&&Math.abs(n.y-mid)<base*.2&&Math.abs(n.x+n.w-b[0])<base*.4);
   if(radical||!up.length||!down.length)continue;
   used.add(b);const bounds=extent(here), set=new Set(here);
   const relevant=localBars.filter(c=>c!==b&&c[0]>=b[0]-.7&&c[2]<=b[2]+.7);
   const latex=`\\frac{${render(up,relevant,depth+1)}}{${render(down,relevant,depth+1)}}`;
   work=work.filter(n=>!set.has(n));work.push({x:bounds.x,w:bounds.x1-bounds.x,y:mid-base*.25,size:base,latex,text:'',fraction:true});
  }
  for(const root of [...work].filter(n=>n.text==='√')){
   const bar=localBars.filter(b=>!used.has(b)&&Math.abs(b[1]-root.y)<base*.25&&Math.abs(b[0]-(root.x+root.w))<base*.45).sort((a,b)=>Math.abs(a[1]-root.y)-Math.abs(b[1]-root.y))[0];
   if(!bar){reasons.add('unresolved-radical');root.latex='\\sqrt{\\boxed{?}}';continue;}
   const arg=work.filter(n=>n!==root&&n.x+n.w/2>=bar[0]-.5&&n.x+n.w/2<=bar[2]+.5&&n.y<=bar[1]+.5&&n.y>bar[1]-base*2);
   if(!arg.length){reasons.add('unresolved-radical');continue;}
   used.add(bar);const set=new Set(arg);work=work.filter(n=>!set.has(n));
   root.latex=`\\sqrt{${render(arg,localBars.filter(b=>b!==bar&&b[0]>=bar[0]-.5&&b[2]<=bar[2]+.5),depth+1)}}`;
   root.y=median(arg.filter(a=>a.size>=base*.85).map(a=>a.y));root.w=bar[2]-root.x;
  }
  if(!work.length)return '';
  const localSize=Math.max(...work.map(n=>n.size)),main=work.filter(n=>n.size>=localSize*.85),small=work.filter(n=>!main.includes(n));
  const baseline=median(main.filter(n=>!/[()[\]{}]/u.test(n.text||'')).map(n=>n.y))||median(main.map(n=>n.y));
  for(const n of main){
   if(/^[()[\]{}]$/u.test(n.text)&&Math.abs(n.y-baseline)<base*1.1)n.y=baseline;
   else if(Math.abs(n.y-baseline)>localSize*.55)reasons.add('unresolved-multiline');
  }
  const scripts=new Map();
  for(const n of small){
   const host=main.filter(p=>p.x<n.x+.6&&n.x-(p.x+p.w)<localSize*2.5&&Math.abs(n.y-p.y)>localSize*.1&&Math.abs(n.y-p.y)<localSize*1.1)
    .sort((a,b)=>Math.abs(n.x-(a.x+a.w))-Math.abs(n.x-(b.x+b.w)))[0];
   if(!host){reasons.add('unattached-script');main.push(n);continue;}
   const sides=scripts.get(host)||{up:[],down:[]};sides[n.y>host.y?'up':'down'].push(n);scripts.set(host,sides);
  }
  const ordered=main.sort((a,b)=>a.x-b.x),result=[];
  let previous=null;
  for(const n of ordered){
   let value=n.latex??tex(n.text,reasons);if(n.bold&&!n.latex&&/\p{L}/u.test(n.text))value=`\\boldsymbol{${value}}`;const script=scripts.get(n);
   if(script){if(script.down.length)value+=`_{${render(script.down,[],depth+1)}}`;if(script.up.length)value+=`^{${render(script.up,[],depth+1)}}`;}
   if(previous&&/^[A-Za-z0-9.]$/u.test(n.text)&&/^[A-Za-z0-9.]$/u.test(previous.text)&&n.x-(previous.x+previous.w)<localSize*.8)result[result.length-1]+=value;
   else result.push(value);
   previous=n;
  }
  return result.join(' ').replace(/\s+/gu,' ').trim();
 };
 let latex=render(nodes,bars).replace(/\b(log|ln|sin|cos|tan|exp)\s*(?=\()/gu,'\\$1 ');
 if(bars.some(b=>!used.has(b)))reasons.add('unresolved-math-line');
 if(!/[=<>]|\\(?:approx|leq|geq|neq)/u.test(latex)&&!/[\p{L}\p{N}].*(?:[_^]\{|\\(?:frac|sqrt|int|sum|prod)\b)/u.test(latex))reasons.add('no-math-relation');
 if((chars(selected).match(/[\p{L}\p{N}]/gu)||[]).length<2)reasons.add('incomplete-expression');
 let parentheses=0,brackets=0;
 for(const c of latex.replace(/\\[{}]/gu,'')){if(c==='(')parentheses++;if(c===')')parentheses--;if(c==='[')brackets++;if(c===']')brackets--;if(parentheses<0||brackets<0)reasons.add('unbalanced-delimiters');}
 if(parentheses||brackets)reasons.add('unbalanced-delimiters');
 if(tag)latex+=` \\tag{${tag}}`;
 return {latex,reliable:!reasons.size,reasons:[...reasons],tag:tag||null};
}
