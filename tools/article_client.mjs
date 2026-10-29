/** Mechanically embedded into the existing DSH client; no new framework/runtime. */
export function createArticleLimitsDialog(React,{h,route,postJson}){
 return function ArticleLimitsDialog({onClose}){
  const [config,setConfig]=React.useState(null),[values,setValues]=React.useState(null),[busy,setBusy]=React.useState(false),[message,setMessage]=React.useState(''),[error,setError]=React.useState(''),ref=React.useRef(null);
  React.useEffect(()=>{let live=true;const prior=document.activeElement;fetch(route+'/article-settings').then(async r=>{const d=await r.json();if(!r.ok)throw Error(d.message||'读取调用上限失败');if(live){setConfig(d);setValues(d.limits);}}).catch(e=>live&&setError(e.message));return()=>{live=false;prior?.focus?.();};},[]);
  React.useEffect(()=>{if(values)ref.current?.querySelector('input')?.focus();},[!!values]);
  const close=()=>{if(!busy)onClose();};
  const keydown=e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close();}if(e.key==='Tab'){const nodes=[...ref.current.querySelectorAll('input,button,select')].filter(n=>!n.disabled&&n.getBoundingClientRect().height),first=nodes[0],last=nodes.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}};
  const field=(key,label)=>h('label',{key},[h('span',{key:'label'},label),h('input',{key:'input',type:'number',inputMode:'numeric',min:config.outputRange.min,max:config.outputRange.max,step:1,required:true,list:'ll-limit-'+key,'aria-label':label,'aria-describedby':'ll-output-limit-help',disabled:busy,value:values[key],onChange:e=>{setValues(v=>({...v,[key]:e.target.value===''?'':Number(e.target.value)}));setMessage('');}}),h('datalist',{key:'presets',id:'ll-limit-'+key},[16384,32768,65536,131072,262144].map(n=>h('option',{key:n,value:n},n.toLocaleString()+' token')))]);
  return h('div',{className:'ll-modal-bg ll-article-limits-bg',onClick:e=>{if(e.target===e.currentTarget)close();}},h('section',{ref,className:'ll-modal ll-article-limits-dialog',role:'dialog','aria-modal':true,'aria-labelledby':'ll-output-limit-title',onKeyDown:keydown},[
   h('div',{key:'head',className:'ll-modal-head'},[h('h2',{key:'title',id:'ll-output-limit-title'},'调用上限'),h('span',{key:'space',className:'ll-spacer'}),h('button',{key:'close',type:'button',className:'ll-btn',onClick:close,disabled:busy,'aria-label':'关闭调用上限'},'关闭')]),
   h('form',{key:'form',className:'ll-modal-body ll-article-limits-form',onSubmit:async e=>{e.preventDefault();setBusy(true);setError('');try{const d=await postJson('/article-settings',{mode:config.mode,limits:values});setConfig(d);setValues(d.limits);setMessage('已保存；下次手动提交时生效，没有启动或重试任务。');window.dispatchEvent(new Event('ll-article-limits-changed'));}catch(e){setError(e.message);}finally{setBusy(false);}}},[
    config?h('p',{key:'provider'},`当前调用：${config.mode==='account'?'DSH 登录账号':'API Key'} / ${config.model}`):h('p',{key:'load'},error?'无法读取设置，请关闭后重试。':'读取已保存上限…'),
    config&&values?h('div',{key:'fields',className:'ll-article-limit-fields'},[field('structureMaxTokens','结构识别输出上限（token）'),field('translationMaxTokens','翻译输出上限（token）')]):null,
    h('p',{key:'help',id:'ll-output-limit-help'},'上限包含思考与正文，不是保证输出长度。实际支持长度以上游模型为准；超出支持范围可能被拒绝，不会自动下调重发。'),
    config?h('p',{key:'range'},`本插件允许 ${config.outputRange.min.toLocaleString()}–${config.outputRange.max.toLocaleString()} token；默认结构 16,384、翻译 32,768。提高上限可能增加耗时、内存和费用。`):null,
    h('p',{key:'scope'},'这里不改变 32 页/240,000 字符的输入范围限制，不修改已排队或已发出的请求。截断后可手动重试或缩小页码范围；旧响应和费用记录保留。'),
    error?h('p',{key:'error',className:'ll-article-error',role:'alert'},error):null,message?h('p',{key:'message',role:'status'},message):null,
    config?h('div',{key:'actions',className:'ll-article-row'},[h('button',{key:'reset',className:'ll-btn',type:'button',disabled:busy,onClick:()=>{setValues({structureMaxTokens:16384,translationMaxTokens:32768});setMessage('已填入默认值，点击保存后生效。');}},'填入默认值'),h('span',{key:'space',className:'ll-spacer'}),h('button',{key:'save',className:'ll-btn ll-primary',type:'submit',disabled:busy},busy?'保存中…':'保存上限')]):null,
   ]),
  ]));
 };
}

export function createArticleWorkbench(React,{h,route,postJson,LimitsDialog}){
 const names={heading:'章节标题',paragraph:'正文段落',abstract:'摘要',keywords:'关键词',title:'文章题名',author:'作者',affiliation:'单位',journal:'期刊',date:'日期',doi:'DOI',reference_list:'参考文献目录',reference_item:'参考文献条目',figure:'图片',figure_caption:'图片题注',table:'表格',table_caption:'表格题注',formula:'公式',page_number:'页码',running_journal:'页眉刊名',download_notice:'下载声明',unknown:'未分类'};
 const parts={body:'正文',front:'前置信息',back:'后置信息',document_info:'文档信息',running_matter:'页眉页脚'};
 const busyPhases=['queued','running','stopping'];
 const remember=(key,value)=>{try{localStorage.setItem('dsh-literature-library/article/'+key,JSON.stringify(value));}catch{}};
 const recall=(key,fallback)=>{try{return JSON.parse(localStorage.getItem('dsh-literature-library/article/'+key))??fallback;}catch{return fallback;}};
 return function ArticleWorkbench({slug,title,page,total,onSettings,onFinished,onOverlay,onNavigate,onDirty}){
  const [data,setData]=React.useState(null),[draft,setDraft]=React.useState(null),[dirty,setDirty]=React.useState(false),[working,setWorking]=React.useState(false),[message,setMessage]=React.useState(''),[error,setError]=React.useState('');
  const [scope,setScopeState]=React.useState(()=>recall('scope/'+slug,{mode:'all',pages:''})),[mode,setModeState]=React.useState(()=>recall('mode','semi')),[media,setMediaState]=React.useState(()=>recall('media',{figures:false,tables:false,formulaFallback:false}));
  const [schedule,setScheduleState]=React.useState(()=>recall('schedule','now'));
  const [limitsOpen,setLimitsOpen]=React.useState(false);
  const [selected,setSelected]=React.useState(''),[filter,setFilter]=React.useState('all'),[json,setJson]=React.useState(''),[editor,setEditor]=React.useState(false),[rootEditor,setRootEditor]=React.useState(false),[pending,setPending]=React.useState([]),[approved,setApproved]=React.useState([]),[show,setShowState]=React.useState(()=>recall('overlay',true)),[count,setCount]=React.useState(60),[costs,setCosts]=React.useState(null);
  const [adding,setAdding]=React.useState(false),[newType,setNewType]=React.useState('paragraph'),[newPart,setNewPart]=React.useState('body'),[from,setFrom]=React.useState(''),[to,setTo]=React.useState('');
  const alive=React.useRef(true),notified=React.useRef(''),state=data?.state,busy=working||busyPhases.includes(state?.phase),input=data?.input;
  const setScope=v=>{setScopeState(v);remember('scope/'+slug,v);},setMode=v=>{setModeState(v);remember('mode',v);},setMedia=v=>{setMediaState(v);remember('media',v);},setShow=v=>{setShowState(v);remember('overlay',v);};
  const displayDraft=d=>{try{return safeDraft(d);}catch{return null;}};
  async function fetchData(){const r=await fetch(route+'/article?slug='+encodeURIComponent(slug)),next=await r.json();if(!r.ok)throw Error(next.message||'读取文章工作稿失败');if(!alive.current)return;setData(next);if(!dirty){setDraft(displayDraft(next.state?.structure));setPending(next.state?.pendingIds||[]);setApproved(next.state?.approvedMediaIds||[]);}if(next.state?.latestExport?.id&&notified.current!==next.state.latestExport.id){notified.current=next.state.latestExport.id;onFinished?.();}return next;}
  React.useEffect(()=>{alive.current=true;fetchData().catch(e=>setError(e.message));return()=>{alive.current=false;};},[slug]);
  React.useEffect(()=>{onDirty?.(dirty?slug:null);const warn=e=>{e.preventDefault();e.returnValue='';};if(dirty)window.addEventListener('beforeunload',warn);return()=>{window.removeEventListener('beforeunload',warn);onDirty?.(null);};},[dirty,slug]);
  React.useEffect(()=>{if(!busyPhases.includes(state?.phase))return;const timer=setInterval(()=>fetchData().catch(e=>alive.current&&setError(e.message)),1200);return()=>clearInterval(timer);},[state?.phase,slug]);
  React.useEffect(()=>{if(!input||!draft||!show){onOverlay?.(null);return;}
   const native=input.pages.find(p=>p.page===page);if(!native){onOverlay?.(null);return;}
   const regions=[];
   for(const o of draft.objects||[])for(const [si,s] of (o.source||[]).entries())if(s.page===page){const a=native.fragments.findIndex(f=>f.id===s.start),b=native.fragments.findIndex(f=>f.id===s.end),fs=s.box?[]:native.fragments.slice(a,b+1),box=s.box||(fs.length?[Math.min(...fs.map(f=>f.box[0])),Math.min(...fs.map(f=>f.box[1])),Math.max(...fs.map(f=>f.box[2])),Math.max(...fs.map(f=>f.box[3]))]:null);if(box)regions.push({id:o.id+':'+si,label:o.id+' · '+(names[o.type]||o.type),role:o.type==='paragraph'?'body':o.type.endsWith('_caption')?'caption':o.part==='running_matter'?'publication':o.type,bbox:box,itemIds:[]});}
   const selectedObject=draft.objects.find(o=>o.id===selected),selectedSource=selectedObject?.source?.findIndex(s=>s.page===page&&s.box);
   onOverlay?.({semantic:true,dirty,editing:false,showInfo:false,showLabels:false,selected:selected?selected+':'+(selectedSource>=0?selectedSource:0):null,page:{page,width:native.width,height:native.height,regions}});
  },[input,draft,page,selected,show,dirty]);
  async function act(action,extra={}){setWorking(true);setError('');setMessage('');try{const r=await postJson('/article',{action,slug,revision:state?.revision,schedule,...extra});if(alive.current){setData(r);if(r.state?.structure)setDraft(displayDraft(r.state.structure));setDirty(false);await fetchData();}return r;}catch(e){if(alive.current)setError(e.message);throw e;}finally{if(alive.current)setWorking(false);}}
  const quietly=fn=>Promise.resolve().then(fn).catch(e=>{if(alive.current)setError(e.message);});
  async function currentLimits(){const r=await fetch(route+'/article-settings'),d=await r.json();if(!r.ok)throw Error(d.message||'读取调用上限失败');return d.limits;}
  async function analyze(){if(dirty&&!window.confirm('尚有未保存的清单修改。放弃草稿并重新识别？'))return;
   const limits=await currentLimits();
   if(!window.confirm(`发送 PDF 第 ${state?.selection?.pages?.join(', ')} 页的完整图像和编号文本，${mode==='auto'?'最多一次结构请求和一次翻译请求':'最多一次结构请求'}。\n结构输出上限 ${limits.structureMaxTokens} token，低思考；翻译上限 ${limits.translationMaxTokens} token（含思考）。费用以实际用量及已配置单价核算，未知不是免费。\n失败不自动重试或提额。${state?.structure?'旧工作稿保留为历史版本，当前稿将换成新识别结果。':''}继续？`))return;
   await act('analyze',{consent:true,limits,auto:mode==='auto',replace:!!state?.structure});
  }
  async function save(confirm=false){return act('save-structure',{structure:draft,pendingIds:pending,approvedMediaIds:approved,media,confirm});}
  async function translate(){if(!draft)return;const limits=await currentLimits();if(!window.confirm(`将所选范围作为完整上下文，按段落连续翻译，并按段内顺序还原 Markdown。\n暂缓 ${pending.length} 个对象；图表主体${media.figures||media.tables?'按选项处理':'默认跳过，只翻译题注'}。\n翻译输出上限 ${limits.translationMaxTokens} token（含思考）。使用当前统一账号/API Key，最多一次请求，不自动重试。继续？`))return;await save(true);await act('translate',{consent:true,limits});}
  function select(o){setSelected(o.id);setJson(JSON.stringify(o,null,2));setEditor(false);setRootEditor(false);onNavigate?.(o.source?.[0]?.page);}
  function safeDraft(d){if(!d||!Array.isArray(d.objects)||!Array.isArray(d.body_order)||!Array.isArray(d.issues)||d.objects.some(o=>!o||typeof o.id!=='string'||typeof o.type!=='string'||!Array.isArray(o.source)||o.source.some(s=>!s||!Number.isInteger(s.page))))throw Error('清单至少需要 objects/body_order/issues 数组及有效对象；详细所有权检查在保存时执行');return d;}
  function updateObject(o){safeDraft({objects:[o],body_order:[],issues:[]});setDraft(d=>({...d,objects:d.objects.map(old=>old.id===o.id?o:old)}));setDirty(true);setApproved(v=>v.filter(id=>id!==o.id));}
  const nativePage=input?.pages?.find(p=>p.page===page)||input?.pages?.[0];
  function beginAdd(){if(!nativePage?.fragments.length){setError('本页没有可寻址文字，请先切换所选范围中的页面');return;}setFrom(nativePage.fragments[0].id);setTo(nativePage.fragments.at(-1).id);setAdding(true);}
  function addObject(){const a=nativePage.fragments.findIndex(f=>f.id===from),b=nativePage.fragments.findIndex(f=>f.id===to);if(a<0||b<a){setError('源范围无效，结束片段应在开始片段之后');return;}const id='manual-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,7),base=draft||{schema:'article-structure-sample/0.3',objects:[],body_order:[],issues:[]},o={id,part:newPart,type:newType,source:[{page:nativePage.page,start:from,end:to}]};if(['heading','paragraph','abstract','formula'].includes(newType))o.parent=[...base.objects].reverse().find(o=>o.type==='heading')?.id||null;setDraft({...base,objects:[...base.objects,o],body_order:['heading','paragraph','abstract','formula'].includes(newType)?[...base.body_order,id]:base.body_order});setSelected(id);setDirty(true);setAdding(false);setError('');}
  const object=draft?.objects?.find(o=>o.id===selected),rows=(draft?.objects||[]).filter(o=>filter==='all'||o.part===filter||filter==='formula'&&o.type==='formula'||filter==='media'&&['figure','figure_caption','table','table_caption'].includes(o.type));
  const button=(key,label,fn,disabled=false,primary=false)=>h('button',{key,className:'ll-btn'+(primary?' ll-primary':''),disabled:busy||disabled,onClick:()=>quietly(fn)},label);
  const tokenSum=(rows,key)=>rows.some(a=>!Number.isFinite(a.usage?.[key]))?'未知':rows.reduce((n,a)=>n+a.usage[key],0).toLocaleString();
  const stageCost=rows=>!rows.length?'尚未调用':rows.every(a=>a.cost?.known&&a.cost.currency===rows[0].cost.currency)?`${rows[0].cost.currency} ${rows.reduce((n,a)=>n+a.cost.amount,0).toFixed(6)}`:'金额未知';
  const status=state?.stage||'选择范围，准备原文后再决定是否调用 AI';
  return h('section',{className:'ll-article-workbench','aria-label':'文章结构与翻译'},[
   h('div',{key:'header',className:'ll-article-head'},[h('h3',{key:'h'},'文章结构与翻译'),h('span',{key:'stage',className:'ll-article-status',role:'status'},status),h('button',{key:'limits',className:'ll-btn',onClick:()=>setLimitsOpen(true)},'调用上限'),h('button',{key:'settings',className:'ll-btn',onClick:onSettings},'模型设置')]),
   h('div',{key:'scope',className:'ll-article-row'},[
    h('label',{key:'range'},['文章范围',h('select',{'aria-label':'文章范围',value:scope.mode,disabled:busy,onChange:e=>setScope({...scope,mode:e.target.value})},[h('option',{key:'all',value:'all'},'整篇'),h('option',{key:'selected',value:'selected'},'指定页码')])]),
    scope.mode==='selected'?h('label',{key:'pages'},['PDF 页码',h('input',{'aria-label':'文章页码',value:scope.pages,placeholder:'1-5,8,12',disabled:busy,onChange:e=>setScope({...scope,pages:e.target.value})})]):null,
    h('label',{key:'mode'},['操作流程',h('select',{'aria-label':'文章操作流程',value:mode,disabled:busy,onChange:e=>setMode(e.target.value)},[h('option',{key:'semi',value:'semi'},'识别后人工检查'),h('option',{key:'auto',value:'auto'},'自检后自动翻译'),h('option',{key:'manual',value:'manual'},'人工编辑清单')])]),
    h('label',{key:'schedule'},['翻译时机',h('select',{'aria-label':'文章翻译时机',value:schedule,disabled:busy,onChange:e=>{setScheduleState(e.target.value);remember('schedule',e.target.value);}},[h('option',{key:'now',value:'now'},'立即'),h('option',{key:'offpeak',value:'offpeak'},'闲时')])]),
    button('prepare','准备原文（本地）',()=>{if((dirty||state?.structure)&&!window.confirm('建立新的范围工作稿？未保存修改将放弃，已保存清单和译文保留在旧版本目录。'))return;return act('prepare',{scope,media});}),
   ]),
   h('div',{key:'actions',className:'ll-article-row'},[
    mode!=='manual'?button('analyze',state?.structure?'重新识别':'AI 识别文章结构',analyze,!state||state.selection.pages.length>32,!draft):button('manual','编辑/导入清单',()=>{setRootEditor(true);setEditor(true);setJson(JSON.stringify(draft||state?.structure||{schema:'article-structure-sample/0.3',objects:[],body_order:[],issues:[]},null,2));},!state),
    button('check','保存并确认',()=>save(true),!draft||!dirty&&state?.reviewed),
    button('translate','翻译可用内容',translate,!draft||!state,!busy&&!(!draft)),
    busyPhases.includes(state?.phase)?h('button',{key:'stop',className:'ll-btn',onClick:()=>quietly(()=>act('stop'))},'停止任务'):null,
    state?.phase==='queued'&&state?.schedule==='offpeak'?h('button',{key:'start-now',className:'ll-btn',onClick:()=>quietly(()=>act('start-now'))},'改为立即翻译'):null,
    h('label',{key:'overlay',className:'ll-article-check'},[h('input',{type:'checkbox',checked:show,onChange:e=>setShow(e.target.checked)}),'显示结构标注']),
    h('details',{key:'options',className:'ll-article-options'},[h('summary',{key:'s'},'导出选项'),h('div',{key:'body'},[['figures','插入图片（须核对图框）'],['tables','翻译表格主体'],['formulaFallback','不确定公式允许原文截图']].map(([key,label])=>h('label',{key,className:'ll-article-check'},[h('input',{type:'checkbox',checked:media[key]===true,disabled:busy,onChange:e=>{setMedia({...media,[key]:e.target.checked});setDirty(true);}}),label])))]),
    state?button('add','新增对象',beginAdd):null,
    dirty?button('discard','放弃未保存修改',()=>{if(!window.confirm('放弃未保存的对象与顺序修改，恢复上次保存稿？'))return;setDraft(state?.structure||null);setPending(state?.pendingIds||[]);setApproved(state?.approvedMediaIds||[]);setDirty(false);}):null,
    h('details',{key:'costs',className:'ll-article-options',onToggle:e=>{if(e.currentTarget.open)fetch(route+'/article-costs?slug='+encodeURIComponent(slug)).then(r=>r.json()).then(setCosts).catch(()=>{});}},[h('summary',{key:'s'},'费用'),h('div',{key:'b'},costs?[h('dl',{key:'stages'},['structure','translation'].map((k,i)=>h('div',{key:k},[h('dt',null,i?'翻译':'结构识别'),h('dd',null,`${stageCost(costs[k]||[])}；${costs[k]?.length||0} 次；输入 ${tokenSum(costs[k]||[],'prompt_tokens')} / 输出 ${tokenSum(costs[k]||[],'completion_tokens')} token`)]))),h('p',{key:'total'},costs.total?.known?`总计 ${costs.total.currency} ${costs.total.amount.toFixed(6)}（按提供方用量估算）`:'总金额未知：单价或用量不完整，不代表免费。')]: '读取费用中…')]),
   ]),
   state?.selection?.pages?.length>32?h('p',{key:'budget',className:'ll-article-warning'},'当前范围超过单次本地预算。请明确选择不超过 32 页的范围；不会自动拆分或收费重试。'):null,
   error||state?.error?h('p',{key:'error',className:'ll-article-error',role:'alert'},error||state.error):null,
   dirty?h('p',{key:'dirty',className:'ll-article-warning'},'清单或选项尚未保存；旧确认不会用于这份草稿。'):null,
   state?.checks?.errors?.length?h('details',{key:'errors',open:true},[h('summary',{key:'s'},`结构错误 ${state.checks.errors.length} 项`),h('ul',{key:'list'},state.checks.errors.slice(0,20).map((e,i)=>h('li',{key:i},`${e.id||e.fragment||''} ${e.code}`)))]):null,
   state?.checks?.warnings?.length?h('details',{key:'warnings'},[h('summary',{key:'s'},`检查提示 ${state.checks.warnings.length} 项（不是整篇阻断）`),h('ul',{key:'list'},state.checks.warnings.slice(0,20).map((e,i)=>h('li',{key:i},`${e.id||e.fragment||''} ${e.message||e.code}`)))]):null,
   draft?h('details',{key:'inspector',className:'ll-article-inspector'},[
    h('summary',{key:'s'},`检查与纠错 · ${draft.objects?.length||0} 个对象 · 暂缓 ${pending.length}`),
    h('div',{key:'filters',className:'ll-article-row'},[h('select',{'aria-label':'结构类别筛选',value:filter,onChange:e=>{setFilter(e.target.value);setCount(60);}},Object.entries({all:'全部',...parts,formula:'公式',media:'图表'}).map(([value,label])=>h('option',{key:value,value},label))),button('json','完整清单 JSON',()=>{setRootEditor(true);setEditor(true);setJson(JSON.stringify(draft,null,2));})]),
    h('div',{key:'rows',className:'ll-article-object-list'},rows.slice(0,count).map(o=>h('button',{key:o.id,className:'ll-article-object'+(selected===o.id?' is-selected':''),onClick:()=>select(o)},[h('code',{key:'id'},o.id),h('span',{key:'type'},names[o.type]||o.type),h('span',{key:'page'},`PDF ${[...new Set(o.source.map(s=>s.page))].join(',')}`),pending.includes(o.id)?h('span',{key:'hold'},'暂缓'):null]))),
    rows.length>count?button('more',`再显示 60 项（共 ${rows.length}）`,()=>setCount(n=>n+60)):null,
    object?h('div',{key:'edit',className:'ll-article-object-editor'},[
     h('strong',{key:'title'},object.id),
     h('label',{key:'type'},['类型',h('select',{'aria-label':'对象类型',value:object.type,onChange:e=>updateObject({...object,type:e.target.value})},Object.entries(names).map(([v,label])=>h('option',{key:v,value:v},label)))]),
     h('label',{key:'part'},['分类',h('select',{'aria-label':'对象分类',value:object.part,onChange:e=>updateObject({...object,part:e.target.value})},Object.entries(parts).map(([v,label])=>h('option',{key:v,value:v},label)))]),
     h('label',{key:'hold',className:'ll-article-check'},[h('input',{type:'checkbox',checked:pending.includes(object.id),onChange:e=>{setPending(v=>e.target.checked?[...new Set([...v,object.id])]:v.filter(id=>id!==object.id));setDirty(true);}}),'此对象暂缓翻译']),
     object.type==='figure'?h('label',{key:'approve-media',className:'ll-article-check'},[h('input',{type:'checkbox',checked:approved.includes(object.id),onChange:e=>{setApproved(v=>e.target.checked?[...new Set([...v,object.id])]:v.filter(id=>id!==object.id));setDirty(true);}}),'已对照 PDF 核对整图外缘，可按此框截图']):null,
     button('edit-object','编辑源范围/公式顺序/图框',()=>{setRootEditor(false);setEditor(true);setJson(JSON.stringify(object,null,2));}),
    ]):null,
   ]):null,
   adding?h('div',{key:'add-form',className:'ll-article-object-editor'},[
    h('strong',{key:'h'},`新增 PDF 第 ${nativePage?.page} 页对象`),
    h('label',{key:'type'},['类型',h('select',{'aria-label':'新增对象类型',value:newType,onChange:e=>setNewType(e.target.value)},Object.entries(names).map(([v,l])=>h('option',{key:v,value:v},l)))]),
    h('label',{key:'part'},['分类',h('select',{'aria-label':'新增对象分类',value:newPart,onChange:e=>setNewPart(e.target.value)},Object.entries(parts).map(([v,l])=>h('option',{key:v,value:v},l)))]),
    ...[['from','开始片段',from,setFrom],['to','结束片段',to,setTo]].map(([key,label,value,set])=>h('label',{key},[label,h('select',{'aria-label':label,value,onChange:e=>set(e.target.value)},(nativePage?.fragments||[]).map(f=>h('option',{key:f.id,value:f.id},f.id+' '+f.text.slice(0,35))))])),
    h('p',{key:'hint'},'源片段只允许一个对象拥有。新增或拆分后，请保存检查遗漏/重复；公式顺序与图框可在对象编辑中调整。'),button('add-confirm','添加到草稿',addObject),button('add-cancel','取消新增',()=>setAdding(false)),
   ]):null,
   editor?h('div',{key:'json',className:'ll-article-json-editor'},[
    h('label',{key:'l'},[rootEditor?'完整结构清单 JSON':'对象 JSON（保留原编号）',h('textarea',{'aria-label':'结构 JSON 编辑',value:json,spellCheck:false,onChange:e=>setJson(e.target.value)})]),
    button('apply-json','应用到草稿（不调用 AI）',()=>{try{const parsed=JSON.parse(json);if(rootEditor)setDraft(safeDraft(parsed));else{if(parsed.id!==selected)throw Error('不能修改对象编号；请在完整清单中显式维护引用');updateObject(parsed);}setDirty(true);setEditor(false);setError('');}catch(e){setError(e.message);}}),button('cancel-json','取消编辑',()=>setEditor(false)),
   ]):null,
   state?.latestExport?h('p',{key:'done',className:'ll-article-result'},state.latestExport.partial?'部分/范围译稿已保存；旧译文保留在历史记录中。':'译稿已保存；旧译文保留在历史记录中。'):null,
   limitsOpen?h(LimitsDialog,{key:'limits-dialog',onClose:()=>setLimitsOpen(false)}):null,
  ]);
 };
}

export function createArticlePricing(React,{h,route,postJson}){
 return function ArticlePricing(){
  const [settings,setSettings]=React.useState(null),[message,setMessage]=React.useState(''),[busy,setBusy]=React.useState(false);
  React.useEffect(()=>{let alive=true;const refresh=()=>{setSettings(null);fetch(route+'/article-settings').then(r=>r.json()).then(s=>alive&&setSettings(s)).catch(e=>alive&&setMessage(e.message));};refresh();window.addEventListener('ll-model-provider-changed',refresh);return()=>{alive=false;window.removeEventListener('ll-model-provider-changed',refresh);};},[]);
  if(!settings)return h('p',null,message||'读取费用设置…');
  const field=(stage,key,label)=>h('label',{key:stage+key},[label,h('input',{type:'number',min:0,step:'any',value:settings[stage]?.[key]??'',placeholder:'未知留空','aria-label':(stage==='pricing'?'结构':'翻译')+label,onChange:e=>setSettings(s=>({...s,[stage]:{...s[stage],[key]:e.target.value===''?null:Number(e.target.value)}}))})]);
  return h('form',{className:'ll-article-price-form',onSubmit:async e=>{e.preventDefault();setBusy(true);try{setSettings(await postJson('/article-settings',{mode:settings.mode,pricing:settings.pricing,translationPricing:settings.translationPricing}));setMessage('已保存；没有调用 AI，也没有另存密钥。');}catch(e){setMessage(e.message);}finally{setBusy(false);}}},[
   h('p',{key:'route'},`当前调用：${settings.mode==='account'?'DSH 登录账号':'统一 API Key'} / ${settings.model}`),
   ...[['pricing','结构识别单价'],['translationPricing','翻译单价']].map(([key,label])=>h('fieldset',{key},[h('legend',{key:'l'},label),h('label',{key:'currency'},['币种',h('select',{value:settings[key]?.currency||'CNY',onChange:e=>setSettings(s=>({...s,[key]:{...s[key],currency:e.target.value}}))},['CNY','USD','EUR'].map(v=>h('option',{key:v,value:v},v)))]),field(key,'inputPerMillion','输入/百万 token'),field(key,'cacheHitPerMillion','缓存命中/百万 token'),field(key,'outputPerMillion','输出/百万 token')])),
   h('p',{key:'hint'},'以任务完成、失败或停止后的服务端用量估算。单价未知留空，不按免费处理；账号价格与 API 价格请自行核对。'),h('button',{key:'save',className:'ll-btn',disabled:busy,type:'submit'},busy?'保存中…':'保存单价'),message?h('p',{key:'message',role:'status'},message):null,
  ]);
 };
}

export function createArticleBatchDialog(React,{h,route,postJson,LimitsDialog}){
 return function ArticleBatchDialog({papers,onClose,onSelect}){
  const candidates=papers.filter(p=>p.source),[chosen,setChosen]=React.useState(()=>new Set(candidates.filter(p=>!p.translation).map(p=>p.slug))),[states,setStates]=React.useState([]),[busy,setBusy]=React.useState(false),[message,setMessage]=React.useState(''),[scope,setScope]=React.useState(()=>{try{return JSON.parse(localStorage.getItem('dsh-literature-library/article/batch-scope'))||{mode:'all',pages:''};}catch{return{mode:'all',pages:''};}});
  React.useEffect(()=>{try{localStorage.setItem('dsh-literature-library/article/batch-scope',JSON.stringify(scope));}catch{}},[scope]);
  const [limitsOpen,setLimitsOpen]=React.useState(false);
  async function refresh(){const r=await fetch(route+'/article-list'),d=await r.json();if(r.ok)setStates(d.states||[]);}
  React.useEffect(()=>{refresh().catch(()=>{});const t=setInterval(()=>refresh().catch(()=>{}),2000);return()=>clearInterval(t);},[]);
  const bySlug=new Map(states.map(s=>[s.slug,s]));
  async function run(action){if(!chosen.size)return;
   setBusy(true);try{let limits;if(['analyze','translate'].includes(action)){const r=await fetch(route+'/article-settings'),d=await r.json();if(!r.ok)throw Error(d.message||'读取调用上限失败');limits=d.limits;if(!window.confirm(`所选 ${chosen.size} 篇，${action==='analyze'?'每篇至多一次结构请求，完成后等待人工检查':'只翻译已经明确确认的工作稿，每篇至多一次请求'}。\n结构上限 ${limits.structureMaxTokens}、翻译上限 ${limits.translationMaxTokens} token（含思考）。\n已有工作稿使用已准备页码；新文献使用当前范围。未确认稿不自动翻译。\n任务串行，失败不重试；连续失败保护停止。费用未知不代表免费。继续？`))return;}const result=await postJson('/article-batch',{action,slugs:[...chosen],scope,limits,consent:['analyze','translate'].includes(action),media:{figures:false,tables:false,formulaFallback:false}});setMessage(result.results.map(r=>r.error||r.message||`${r.slug}：已提交`).join('；'));await refresh();}catch(e){setMessage(e.message);}finally{setBusy(false);}
  }
  return h('div',{className:'ll-modal-bg',onClick:e=>{if(e.target===e.currentTarget)onClose();}},h('div',{className:'ll-modal',role:'dialog','aria-label':'批量文章结构与翻译'},[
   h('div',{key:'h',className:'ll-modal-head'},['批量文章结构与翻译',h('span',{key:'sp',className:'ll-spacer'}),h('button',{key:'x',className:'ll-btn',onClick:onClose},'关闭')]),
   h('div',{key:'body',className:'ll-modal-body'},[
    h('p',{key:'hint'},'可以批量识别后逐篇检查、逐篇翻译，也可以全部检查后一次提交翻译。旧稿不自动覆盖。'),
    h('div',{key:'actions',className:'ll-article-row'},[
     h('button',{key:'limits',className:'ll-btn',onClick:()=>setLimitsOpen(true)},'调用上限'),
     h('label',{key:'scope'},['新稿范围',h('select',{value:scope.mode,'aria-label':'批量新稿范围',onChange:e=>setScope(s=>({...s,mode:e.target.value}))},[h('option',{key:'all',value:'all'},'整篇'),h('option',{key:'selected',value:'selected'},'指定页码')])]),
     scope.mode==='selected'?h('input',{key:'pages',value:scope.pages,'aria-label':'批量文章页码',placeholder:'1-5,8',onChange:e=>setScope(s=>({...s,pages:e.target.value}))}):null,
     ...[['prepare','本地准备'],['analyze','识别所选'],['translate','翻译已确认稿'],['stop','停止所选任务']].map(([action,label])=>h('button',{key:action,className:'ll-btn',disabled:busy||!chosen.size,onClick:()=>run(action)},label)),
    ]),
    message?h('p',{key:'message',role:'status'},message):null,
    limitsOpen?h(LimitsDialog,{key:'limits-dialog',onClose:()=>setLimitsOpen(false)}):null,
    ...candidates.map(p=>{const s=bySlug.get(p.slug);return h('div',{key:p.slug,className:'ll-layout-queue-row'},[
     h('input',{key:'choose',type:'checkbox','aria-label':'选择 '+p.title,checked:chosen.has(p.slug),onChange:e=>setChosen(v=>{const next=new Set(v);e.target.checked?next.add(p.slug):next.delete(p.slug);return next;})}),
     h('div',{key:'title',className:'ll-layout-queue-title'},[h('strong',{key:'name'},p.title||p.slug),h('span',{key:'state'},s?`${s.stage} · PDF ${s.selection.pages.join(', ')}${s.reviewed?' · 已确认':''}`:'尚未准备')]),
     h('button',{key:'open',className:'ll-btn',onClick:()=>onSelect(p.slug)},'打开检查'),
    ]);}),
   ]),
  ]));
 };
}
