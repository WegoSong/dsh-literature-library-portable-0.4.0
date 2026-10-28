/** Strict PDF physical-page selection. Never silently turn a bad range into all pages. */
export function createPageScope() {
  function parse(value,total) {
    if(!Number.isInteger(total)||total<1||total>100000)throw Error('PDF 总页数无效');
    if(Array.isArray(value)) {
      if(!value.length||value.length>total||value.some(n=>!Number.isInteger(n)||n<1||n>total))throw Error('指定页码为空或超出 PDF 范围');
      return [...new Set(value)].sort((a,b)=>a-b);
    }
    if(typeof value!=='string'||!value.trim()||value.length>4096)throw Error('请填写页码，例如 1-5,8,12-20');
    const pages=new Set();
    for(const part of value.trim().replace(/[，、；;]/gu,',').replace(/[–—~～]/gu,'-').split(',')) {
      const match=/^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/u.exec(part);
      if(!match)throw Error('页码格式无效，请使用 1-5,8,12-20');
      const a=Number(match[1]),b=Number(match[2]||match[1]);
      if(a<1||b<a||b>total)throw Error(`页码必须在 1-${total} 内，范围起点不能大于终点`);
      for(let n=a;n<=b;n++)pages.add(n);
    }
    return [...pages].sort((a,b)=>a-b);
  }
  function resolve(scope,total) {
    if(!scope||scope.mode==='all')return Array.from({length:total},(_,i)=>i+1);
    if(scope.mode!=='selected')throw Error('页数模式无效');
    return parse(scope.pages,total);
  }
  function format(pages) {
    const sorted=[...new Set(pages)].sort((a,b)=>a-b),parts=[];
    for(let i=0;i<sorted.length;i++){let end=sorted[i],start=end;while(sorted[i+1]===end+1)end=sorted[++i];parts.push(start===end?String(start):`${start}-${end}`);}
    return parts.join(',');
  }
  return {parse,resolve,format};
}
export const pageScope=createPageScope();
