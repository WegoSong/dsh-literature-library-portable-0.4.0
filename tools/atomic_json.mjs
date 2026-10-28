/** Atomic settings/state replacement; Windows readers/AV may briefly lock a target. */
import {mkdir,writeFile,rename,unlink} from 'node:fs/promises';import {dirname} from 'node:path';import {randomUUID} from 'node:crypto';
export async function replaceWithRetry(from,to,{replace=rename,wait=ms=>new Promise(r=>setTimeout(r,ms))}={}){
 for(let attempt=0;;attempt++){try{await replace(from,to);return;}catch(e){if(!['EPERM','EACCES','EBUSY'].includes(e.code)||attempt>=5)throw e;await wait(25*2**attempt);}}
}
export async function writeJsonAtomic(file,value){const serialized=JSON.stringify(value),temp=file+'.'+randomUUID()+'.tmp';await mkdir(dirname(file),{recursive:true});
 try{await writeFile(temp,serialized,{encoding:'utf8',flag:'wx'});await replaceWithRetry(temp,file);}catch(e){await unlink(temp).catch(()=>{});throw e;}
}
