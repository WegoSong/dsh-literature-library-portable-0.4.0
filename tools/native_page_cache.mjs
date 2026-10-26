import {readFile,writeFile,mkdir,rename,stat,unlink} from 'node:fs/promises';
import {join} from 'node:path';
export const NATIVE_CACHE_VERSION='native-glyph-pages-v1';
const MAX_BYTES=8*1024*1024;
export function nativePageCache(root,sourceHash,pdfjsVersion){
 if(!root||!/^\w{12,64}$/u.test(sourceHash))return {read:async()=>null,write:async()=>false};
 const file=page=>{if(!Number.isInteger(page)||page<1)throw Error('Invalid cache page');return join(root,`${sourceHash}-p${page}.json`);};
 return {
  async read(page){try{
   const path=file(page);if((await stat(path)).size>MAX_BYTES)return null;
   const data=JSON.parse(await readFile(path,'utf8'));
   if(data.version!==NATIVE_CACHE_VERSION||data.sourceHash!==sourceHash||data.pdfjsVersion!==pdfjsVersion||data.page!==page)return null;
   if(!Array.isArray(data.items)||!Array.isArray(data.mathGlyphs)||!data.graphics||!Array.isArray(data.panels))return null;
   return data;
  }catch{return null;}},
  async write(page,value){
   let tmp;
   try{
    const text=JSON.stringify({...value,version:NATIVE_CACHE_VERSION,sourceHash,pdfjsVersion,page});if(Buffer.byteLength(text)>MAX_BYTES)return false;
    await mkdir(root,{recursive:true});const path=file(page);tmp=`${path}.tmp-${process.pid}`;
    await writeFile(tmp,text,'utf8');await rename(tmp,path);tmp=null;return true;
   }catch{return false;/* Optional disk cache must never block extraction. */}
   finally{if(tmp)await unlink(tmp).catch(()=>{});}
  },
 };
}
