/** Local, reversible bibliography intervals. A heading is evidence, not an EOF command. */
export const DOCUMENT_VERSION = 'document-blocks-v1';
const YEAR = /\b(?:18|19|20)\d{2}\b/u;
const REF_TITLE = /^(?:#{1,6}\s*)?(?:\d+\.?\s*)?(?:references?|bibliography|literature\s+cited|参考文献)\s*$/iu;
const ENTRY = /\[\d{1,3}[a-z]?\]|(?:^|\n)[ \t]*\d{1,3}[.)]?[ \t]+(?=[A-Z\u3400-\u9FFF])/gmu;
const AUTHOR = /^\s*(?:(?:[A-Z]\.)(?:-[A-Z]\.)?\s*){1,4}[\p{L}][\p{L}'’\-]+/u;
const CITE_DATA = /\b(?:19|20)\d{2}\s*[,;]\s*(?:\d+|e\d+|n\/a)|\((?:19|20)\d{2}\)\s*\d|10\.\d{4,9}\//iu;
const END_SECTION = /^(?:#{1,6}\s*)?(?:\d+(?:\.\d+)*\.?\s*)?(?:appendi(?:x|ces)\b|author\s+(?:biograph|information|contribution)|biograph|acknowledge?ments?\b|supporting\s+information\b|supplementary\b|conclusions?\b|results?\b|discussion\b|methods?\b|introduction\b|附录|作者简介|致谢|结论|讨论|方法)/iu;
const clean = value => value.replace(/===SEC:[A-Z_]+===|===LAYOUT:COLUMNS\s+\d+===|===PAGE\s+\d+===/gu,'').replace(/\n{3,}/gu,'\n\n').trim();
function entries(text) {
 const marks=[...text.matchAll(ENTRY)];
 return marks.map((m,i)=>{const tail=text.slice(m.index+m[0].length,marks[i+1]?.index??text.length);
  return {index:m.index,number:Number(/\d+/u.exec(m[0])[0]),author:AUTHOR.test(tail),year:YEAR.test(tail),citation:CITE_DATA.test(tail),line:!text.slice(text.lastIndexOf('\n',m.index)+1,m.index).trim()};});
}
function sectionEnd(text,start) {
 let offset=start;
 for(const line of text.slice(start).split(/(?<=\n)/u)){
  const t=line.trim();
  if(offset>start && (END_SECTION.test(t)||/^#{1,6}\s+\S/u.test(t)&&!REF_TITLE.test(t)
   ||/^===SEC:(?!REFERENCES)[A-Z_]+===$/u.test(t)))return offset;
  offset+=line.length;
 }
 return text.length;
}
export function referenceSections(value) {
 const text=String(value??'').replace(/\r\n?/gu,'\n'), candidates=[];
 // Both an explicit parser marker and a visual heading need nearby entry evidence.
 const heading=/===SEC:REFERENCES===|^(?:#{1,6}\s*)?(?:\d+\.?\s*)?(?:references?|bibliography|literature\s+cited|参考文献)\s*$/gimu;
 for(const m of text.matchAll(heading)){
  const start=m.index, end=sectionEnd(text,start+m[0].length), local=text.slice(start+m[0].length,Math.min(end,start+7000));
  const e=entries(local),near=e.filter(x=>x.index<2000),use=e.slice(0,6);
  if(!near.length||e.length<2)continue;
  const marker=m[0].includes('===SEC:'),years=use.filter(x=>x.year).length;
  // Numbered bibliography-looking rows are allowed without years (some styles omit them).
  // Inline citations in body prose are not such rows, even if later references have years.
  if(!(years>=Math.min(2,use.length)&&use.filter(x=>x.line||x.author&&x.citation).length>=Math.min(2,use.length)
      ||use.length>=3&&use.every(x=>x.line)))continue;
  candidates.push({start,end,reason:marker?'section-marker':'standalone-heading',evidence:{nearbyEntries:use.length,years}});
 }
 // Untitled bibliographies: require a dense ascending list with local author/year evidence.
 const marks=entries(text);
 for(let i=0;i<marks.length;i++){
  const first=marks[i];if(first.index<text.length*.35||first.number>3)continue;
  // A dense real bibliography later must not lend its evidence backwards to a
  // random body citation. The very first entry needs its own local evidence.
  if(!(first.line&&first.year||first.author&&first.year&&first.citation))continue;
  const end=sectionEnd(text,first.index),run=[first];let last=first;
  for(let j=i+1;j<marks.length&&marks[j].index<end;j++){
   const n=marks[j];if(n.index-last.index>3000)break;if(n.number<=last.number)continue;if(n.number-last.number>8)break;
   run.push(n);last=n;
  }
  if(run.length<12||run.filter(x=>x.year).length/run.length<.5)continue;
  if(run.filter(x=>x.line).length/run.length<.25&&!(run.filter(x=>x.author).length/run.length>=.75&&run.filter(x=>x.citation).length/run.length>=.6))continue;
  candidates.push({start:first.index,end,reason:'numbered-list',evidence:{nearbyEntries:run.length,years:run.filter(x=>x.year).length}});break;
 }
 const sections=[];
 for(const c of candidates.sort((a,b)=>a.start-b.start||a.reason.localeCompare(b.reason))){
  if(sections.some(s=>c.start>=s.start&&c.start<s.end))continue;
  const start=c.start,raw=clean(text.slice(start,c.end));if(!raw)continue;
  sections.push({...c,raw,id:`reference-${sections.length+1}`});
 }
 return sections;
}
export function splitReferenceSections(value) {
 const text=String(value??'').replace(/\r\n?/gu,'\n'), sections=referenceSections(text);
 let body='',at=0;for(const s of sections){body+=text.slice(at,s.start);at=s.end;}body+=text.slice(at);
 return {body:body.trimEnd(),references:sections.map(s=>s.raw).join('\n\n'),reason:sections[0]?.reason??null,sections};
}
/** Shared provenance model; classification does not delete source text. */
export function buildDocumentModel(pages,sourceHash,coverage) {
 return {version:DOCUMENT_VERSION,sourceHash,coverage,blocks:pages.flatMap(page=>page.paragraphs.map((p,i)=>({
  id:`p${page.page}-b${i+1}`,page:page.page,sourcePages:p.sourcePages||[page.page],sourceIds:p.sourceIds||[],
  role:p.type,text:p.text,flow:p.flowId||null,formula:p.formula||null,
  disposition:p.type==='pending'?'deferred-review':p.type==='references'?'original-reference':p.omitted?'original-caption-only':p.formula&&!p.formula.reliable?'review':'translate',
 }))) };
}
