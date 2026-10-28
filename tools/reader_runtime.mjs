/** Pure reader infrastructure, embedded by build_client.mjs for DSH's single-file client loader. */
export function createReaderRuntime() {
  function createPreferences(storage) {
    const key='dsh-literature-library/preferences-v1';
    const valid=(name,value)=>{
      if(['readerSurface','mdMode','partitionEngine'].includes(name))return ({readerSurface:['split','translation','pdf'],mdMode:['preview','source','edit'],partitionEngine:['local','ai']})[name].includes(value);
      if(name==='scanDir')return typeof value==='string'&&value.length<=2048;
      return ['focusMode','detailsOpen','showHidden','regionInfo','regionLabels','regionVisible','layoutTools','comparisonEnabled'].includes(name)&&typeof value==='boolean';
    };
    const all=()=>{try{const x=JSON.parse(storage().getItem(key)||'{}');return x&&typeof x==='object'&&!Array.isArray(x)?x:{};}catch{return {};}};
    return {read(name,fallback,scope='global'){const value=all()[scope]?.[name];return valid(name,value)?value:fallback;},
      write(name,value,scope='global'){if(!valid(name,value)||typeof scope!=='string'||scope==='__proto__'||scope==='constructor')return false;try{const current=all();current[scope]={...(current[scope]||{}),[name]:value};storage().setItem(key,JSON.stringify(current));return true;}catch{return false;}},
      // A narrow viewport changes only presentation, never the remembered choice.
      surface(value,width){return value==='split'&&width<1000?'translation':value;}};
  }
  function createRenderQueue(limit=1) {
    let running=0,sequence=0;const pending=[];
    const cancelled=()=>Object.assign(new Error('Render request cancelled'),{name:'AbortException'});
    const pump=()=>{
      pending.sort((a,b)=>a.priority-b.priority||a.order-b.order);
      while(running<limit&&pending.length){
        const job=pending.shift();if(job.cancelled)continue;
        running++;job.started=true;
        Promise.resolve().then(()=>job.cancelled?Promise.reject(cancelled()):job.work())
          .then(job.resolve,job.reject).finally(()=>{running--;pump();});
      }
    };
    return {
      schedule(work,priority=0){
        const job={work,priority,order:sequence++,started:false,cancelled:false};
        const promise=new Promise((resolve,reject)=>Object.assign(job,{resolve,reject}));
        pending.push(job);pump();
        return {promise,cancel(){job.cancelled=true;if(!job.started){const i=pending.indexOf(job);if(i>=0)pending.splice(i,1);job.reject(cancelled());}}};
      },
      stats:()=>({running,pending:pending.length,limit}),
    };
  }
  function bindMenuDismissal({window:win,document:doc,element,close}) {
    const inside=event=>{
      const node=element();if(!node)return false;
      if(event?.composedPath?.().includes(node))return true;
      try{return !!event?.target&&node.contains(event.target);}catch{return false;}
    };
    const outside=e=>{if(!inside(e))close();},always=()=>close();
    // Window capture also sees non-bubbling blur from every descendant control.
    // Internal focus changes must finish their click before any dismissal occurs.
    const windowBlur=e=>{if(e.target===win)close();};
    const key=e=>{if(e.key==='Escape'){e.preventDefault?.();close();}};
    const visibility=()=>{if(doc?.visibilityState==='hidden')close();};
    const bindings=[['pointerdown',outside],['mousedown',outside],['contextmenu',outside],['wheel',outside],
      ['scroll',outside],['resize',always],['blur',windowBlur],['pagehide',always],['keydown',key]];
    const capture={capture:true};
    for(const [name,fn]of bindings)win.addEventListener(name,fn,capture);
    doc?.addEventListener?.('visibilitychange',visibility);
    return()=>{for(const [name,fn]of bindings)win.removeEventListener(name,fn,capture);doc?.removeEventListener?.('visibilitychange',visibility);};
  }
  function readingZoomShortcut(event,root) {
    if(!(event.ctrlKey||event.metaKey)||event.altKey||event.isComposing)return null;
    const values={'+':10,'=':10,'-':-10,'_':-10,'0':0};
    if(!Object.prototype.hasOwnProperty.call(values,event.key))return null;
    if(!root?.contains?.(event.target))return null;
    const target=event.target;
    // Consume the combination in coordinate/forms so neither this plugin nor
    // the host/global browser zoom can turn editing into a persistent font change.
    if(target.closest?.('input,select,textarea,[contenteditable="true"],.ll-layout-controls,.ll-modal,.ll-menu'))return {delta:null};
    if(!target.closest?.('.ll-pane-translation'))return null;
    return {delta:values[event.key]};
  }
  return {createRenderQueue,bindMenuDismissal,readingZoomShortcut,createPreferences};
}
