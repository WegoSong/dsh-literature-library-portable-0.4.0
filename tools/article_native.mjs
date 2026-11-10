/** Address native fragments without deciding semantic sections or cutting reading order. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {pageScope} from './page_scope.mjs';
import {DEFAULT_ARTICLE_LIMITS} from './article_limits.mjs';

export async function prepareArticle(pdf,scope,{signal,onProgress=()=>{},limits}={}){
 if(!scope||!['all','selected'].includes(scope.mode))throw Error('请明确选择整篇或指定 PDF 页码');
 const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
 const bytes=await readFile(pdf),sourceHash=createHash('sha256').update(bytes).digest('hex');
 const task=getDocument({data:new Uint8Array(bytes),useSystemFonts:false,isEvalSupported:false,verbosity:0});
 try{
  const doc=await task.promise,selected=pageScope.resolve(scope,doc.numPages),pages=[];
  if(limits)checkArticlePageCount(selected.length,limits.maxInputPages);
  for(const n of selected){
   signal?.throwIfAborted();onProgress({stage:'读取原文',page:n,total:doc.numPages});
   const page=await doc.getPage(n),v=page.getViewport({scale:1}),items=(await page.getTextContent()).items.filter(i=>typeof i.str==='string'&&i.str.trim());
   const fragments=[];let run=[];
   function finish(){
    if(!run.length)return;
    const boxes=run.map(i=>{const [a,b,c,d,x,y]=i.transform,bl=Math.hypot(a,b)||1,vl=Math.hypot(c,d)||1,u=[a/bl,b/bl],vv=[c/vl,d/vl],h=Math.abs(i.height),ps=[[-.25,0],[1,0],[-.25,1],[1,1]].map(([up,along])=>[x+u[0]*i.width*along+vv[0]*h*up,y+u[1]*i.width*along+vv[1]*h*up]);return[Math.min(...ps.map(p=>p[0])),Math.min(...ps.map(p=>p[1])),Math.max(...ps.map(p=>p[0])),Math.max(...ps.map(p=>p[1]))];});
    fragments.push({id:`p${String(n).padStart(2,'0')}.b${String(fragments.length+1).padStart(3,'0')}`,text:run.map(i=>i.str).join(' '),box:[Math.min(...boxes.map(b=>b[0])),Math.min(...boxes.map(b=>b[1])),Math.max(...boxes.map(b=>b[2])),Math.max(...boxes.map(b=>b[3]))].map(x=>Math.round(x*10)/10)});run=[];
   }
   for(const i of items){const prev=run.at(-1);if(prev&&(Math.abs(prev.transform[5]-i.transform[5])>1.2||Math.abs(i.transform[4]-(prev.transform[4]+prev.width))>45))finish();run.push(i);if(i.hasEOL)finish();}finish();
   pages.push({page:n,width:v.width,height:v.height,rotation:page.rotate||0,fragments});page.cleanup();
  }
  return{sourceHash,pageCount:doc.numPages,selection:{mode:scope.mode,pages:selected},input:{scope:{core_pages:selected,context_pages:[],not_full_article:selected.length!==doc.numPages},pages}};
 }finally{await task.destroy();}
}

/** Bounded sequential rasterization; no persistent canvas or PDF object per page. */
export async function renderArticleImages(pdf,input,out,{signal,onProgress=()=>{}}={}){
 const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
 const {createCanvas}=await import('@napi-rs/canvas');await mkdir(out,{recursive:true});
 const task=getDocument({data:new Uint8Array(await readFile(pdf)),disableFontFace:true,useSystemFonts:true,isEvalSupported:false,verbosity:0});
 const images=[];
 try{const doc=await task.promise;
  for(const p of input.pages){signal?.throwIfAborted();if(p.rotation)throw Error('旋转页面需要先检查坐标；未发送 AI');
   onProgress({stage:'准备页面图像',page:p.page,total:doc.numPages});const page=await doc.getPage(p.page),v=page.getViewport({scale:1}),scale=Math.min(2,2000/Math.max(v.width,v.height),Math.sqrt(2_000_000/(v.width*v.height))),view=page.getViewport({scale});
   const canvas=createCanvas(Math.ceil(view.width),Math.ceil(view.height));
   try{await page.render({canvasContext:canvas.getContext('2d'),viewport:view,background:'#fff'}).promise;const file=join(out,`page-${p.page}.png`);await writeFile(file,canvas.toBuffer('image/png'));images.push({page:p.page,file,width:canvas.width,height:canvas.height});}
   finally{canvas.width=0;canvas.height=0;page.cleanup();}
  }
 }finally{await task.destroy();}
 return images;
}

const budgetError=message=>Object.assign(Error(message+'；未调用模型，不会自动截断或拆单'),{status:422,code:'ARTICLE_INPUT_BUDGET'});
function checkArticlePageCount(count,limit){
 if(count>limit)throw budgetError(`选了 ${count} 页，超过单次输入预算 ${limit} 页。请缩小范围或调整「调用上限」`);
}
export function checkArticleBudget(input,{maxInputPages=DEFAULT_ARTICLE_LIMITS.maxInputPages,maxPageCharacters=DEFAULT_ARTICLE_LIMITS.maxPageCharacters}={}, {requireText=false}={}){
 checkArticlePageCount(input.pages.length,maxInputPages);
 for(const p of input.pages){
  let characters=0;
  for(const f of p.fragments)for(const _ of f.text)characters++;
  if(characters>maxPageCharacters)throw budgetError(`PDF 第 ${p.page} 页提取了 ${characters.toLocaleString()} 个字符，超过单页上限 ${maxPageCharacters.toLocaleString()}。请排除该页或调整「调用上限」`);
 }
 if(requireText&&input.pages.every(p=>!p.fragments.length))throw Object.assign(Error('所选范围没有可寻址原生文字；请先做 OCR 或人工提供带地址文本。未发送 AI，未将扫描页冒充已识别。'),{status:422});
 if(input.pages.some(p=>p.rotation))throw Object.assign(Error('所选范围含旋转页，请人工检查坐标；未调用 AI'),{status:422});
}
