/* No HTML rendering of memory text, no browser token persistence, no automatic model calls. */
'use strict';
const $=id=>document.getElementById(id);
const labels={identity:'身份',preference:'偏好',environment:'环境',project:'项目',decision:'决策',skill:'技能',error:'错误经验',goal:'目标',experience:'经验'};
const views={candidate:'待确认记忆',active:'当前记忆',archived:'已归档',profile:'个人偏好',documents:'导入文档',agents:'已登记 Agent',jobs:'整理任务'};
let sourceId='',token='',view='candidate',offset=0,nextOffset=null,current=null,editing=null,pending=null,busy=false,loadVersion=0,documentOriginal=null,documentEpoch=0;
function message(text,error=false){$('message').textContent=text;$('message').dataset.error=String(error);}
function element(tag,text,cls){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;return node;}
function controls(){
  for(const b of document.querySelectorAll('[data-write],#save,#cancel-edit'))b.disabled=busy||!!pending;
  $('queue-personal').disabled=busy||!!pending||!!editing;$('retry').disabled=busy;$('pending-panel').hidden=!pending;$('logout').disabled=busy||!!pending;
  $('pending-id').textContent=pending?'事件编号：'+(pending.input.event_id??pending.input.job_id??''):'';
}
async function api(operation,input={}){
  let response;try{response=await fetch('/api/call',{method:'POST',credentials:'omit',cache:'no-store',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify({operation,input}),signal:AbortSignal.timeout(operation==='consolidate'?150000:20000)});}
  catch{throw Object.assign(new Error('network_unconfirmed'),{unknown:true});}
  let result;try{result=await response.json();}catch{throw Object.assign(new Error('response_unconfirmed'),{unknown:true});}
  if(!response.ok||!result.ok)throw Object.assign(new Error(typeof result.error==='string'?result.error:'request_failed'),{unknown:result.delivery==='unconfirmed'||response.status>=500});
  return result.result;
}
function download(value,name){const u=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)+'\n'],{type:'application/json'}));const link=element('a');link.href=u;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(u),1000);}
function resetEditor(){editing=null;$('editor-title').textContent='新建候选记忆';$('memory-form').reset();$('provenance').value='用户在个人管理台明确输入';$('cancel-edit').hidden=true;}
function edit(row){if(pending||busy)return;editing=row;$('editor-title').textContent='修改记忆 · r'+row.revision;for(const [field,value]of Object.entries({type:row.type,content:row.content,importance:row.importance,visibility:row.visibility,provenance:row.provenance,project:row.project_id??''}))$(field).value=value;$('consent').checked=false;$('cancel-edit').hidden=false;$('content').focus();controls();}
function memoryAuthorization(){
  const session=token,source=sourceId;
  const selection=()=>JSON.stringify([editing?.id??null,editing?.revision??null,...['type','content','importance','visibility','provenance','project'].map(id=>$(id).value)]);
  const snapshot=selection();
  return ()=>{
    if(!token||token!==session||sourceId!==source||!$('consent').checked||selection()!==snapshot)
      throw new Error('memory_consent_or_selection_changed');
  };
}
async function submitPending(){
  if(!pending||busy)return;busy=true;controls();
  try{
    pending.authorize?.();
    if(['commit','capture','document_import'].includes(pending.operation))await api('register',{agent_id:'personal-console',agent_type:'general_agent',capabilities:[]});
    pending.authorize?.();
    const operation=pending.operation;const result=await api(operation,pending.input);pending=null;resetEditor();message((operation==='consolidate'?'整理请求已返回，请在整理任务中查看实际状态。':'操作已确认。')+(result.state==='needs_model'?'尚未配置个人整理模型，未发送原文。':'')+(result.review_required?'该记忆需要明确确认后才进入当前上下文。':''));await load();
  }catch(e){
    if(e.unknown){pending.delivery_unconfirmed=true;message('尚未取得可靠确认：'+e.message+'。请重试同一请求，不要更换事件编号。',true);}
    else if(pending.delivery_unconfirmed)message('本次重试已停止：'+e.message+'。此前提交仍未确认；待确认请求和事件编号已保留。重新核对原内容与授权后才可重试。',true);
    else {pending=null;message('请求被拒绝：'+e.message+'。版本冲突时请刷新并重新核对；不要覆盖他人的更改。',true);}
  }finally{busy=false;controls();}
}
function mutate(operation,input,authorize){if(busy||pending){message('请先处理尚未确认的请求。',true);return;}authorize?.();pending={operation,authorize,input:{...input,...(['commit','capture','update','review','document_import','document_queue','document_archive'].includes(operation)?{event_id:crypto.randomUUID()}: {})}};submitPending();}
const formatSize=n=>n<1024?n+' B':(n/1024).toFixed(1)+' KiB';
const sha16=v=>v?String(v).slice(0,16)+'…':'';
function base64ToBytes(value){const raw=atob(value);const bytes=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);return bytes;}
function bytesToBase64(bytes){let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(binary);}
async function sha256Hex(bytes){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(b=>b.toString(16).padStart(2,'0')).join('');}
async function fetchDocumentOriginal(documentId){
  const session=token,epoch=documentEpoch;
  const result=await api('document_read',{document_id:documentId});
  const bytes=base64ToBytes(result.content_base64);
  const digest=await sha256Hex(bytes);
  if(digest!==result.content_sha256)throw Object.assign(new Error('fingerprint_mismatch_after_download'),{unknown:false});
  if(!token||token!==session||epoch!==documentEpoch)throw new Error('document_view_changed');
  documentOriginal={document:result,bytes};
  return {result,bytes};
}
function downloadDocument(){ // Only runs from an explicit download click.
  if(!documentOriginal)return;
  const url=URL.createObjectURL(new Blob([documentOriginal.bytes],{type:'text/plain'}));
  const link=element('a');link.href=url;link.download=documentOriginal.document.label;link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function renderDocuments(result){
  current=result;$('results').replaceChildren();
  const rows=result.documents;
  if(!rows?.length)$('results').append(element('p','还没有导入文档。在下方选择一个 UTF-8 文本文件并明确同意后导入。','note'));
  for(const row of rows??[]){
    const card=element('article');
    card.append(element('strong',row.label),element('span',row.status==='active'?'使用中':'已归档','badge'),
      element('p',row.format.toUpperCase()+' · '+formatSize(row.byte_size)+' · SHA-256 '+sha16(row.content_sha256)+(row.has_bom?' · 含 BOM':''),'meta'),
      element('p',(row.project_id??'全局')+' · 片段 '+row.fragments+' · r'+row.revision+' · 导入于 '+row.created_at,'meta'));
    if(row.status==='active'){
      const actions=element('div',undefined,'row card-actions');
      const viewButton=element('button','查看原文');
      viewButton.addEventListener('click',async()=>{
        try{
          const {result:read,bytes}=await fetchDocumentOriginal(row.document_id);
          $('document-original-title').textContent='原文 · '+row.label+'（纯文本预览，不执行内容）';
          $('document-original-text').textContent=new TextDecoder('utf-8').decode(bytes);
          $('document-original').hidden=false;
          message('已按纯文本显示原文，指纹校验通过。下载需点击“下载原文”。');
        }catch(e){message('读取失败：'+e.message,true);}
      });
      const download=element('button','下载原文');
      download.addEventListener('click',async()=>{
        try{
          if(!documentOriginal||documentOriginal.document.document_id!==row.document_id)await fetchDocumentOriginal(row.document_id);
          downloadDocument();
        }catch(e){message('下载失败：'+e.message,true);}
      });
      const queue=element('button','排队整理（之后才会调用模型）');queue.dataset.write='true';
      queue.addEventListener('click',()=>{
        // Immutable original is split server-side at UTF-8 boundaries, not by naive browser byte steps.
        if(!confirm('将把 '+row.label+' 按 UTF-8 字符边界划分为 ≤32 KiB 的片段排队整理。排队只保存候选，不调用模型；之后在“整理任务”里逐条明确运行模型并核对结果。继续？'))return;
        mutate('document_queue',{document_id:row.document_id});
      });
      const archive=element('button','归档文档');archive.dataset.write='true';
      archive.addEventListener('click',()=>{if(confirm('归档会使相关片段退出当前使用范围、使派生记忆失效并阻止未完成任务写回。原始文件字节保留可下载，这不是物理擦除。继续？'))mutate('document_archive',{document_id:row.document_id});});
      actions.append(viewButton,download,queue,archive);card.append(actions);
    }else{
      const actions=element('div',undefined,'row card-actions');
      const viewButton=element('button','查看原文');
      viewButton.addEventListener('click',async()=>{
        try{
          const {result:read,bytes}=await fetchDocumentOriginal(row.document_id);
          $('document-original-title').textContent='原文 · '+row.label+'（已归档，仍可下载核对）';
          $('document-original-text').textContent=new TextDecoder('utf-8').decode(bytes);
          $('document-original').hidden=false;
        }catch(e){message('读取失败：'+e.message,true);}
      });
      const download=element('button','下载原文');
      download.addEventListener('click',async()=>{
        try{
          if(!documentOriginal||documentOriginal.document.document_id!==row.document_id)await fetchDocumentOriginal(row.document_id);
          downloadDocument();
        }catch(e){message('下载失败：'+e.message,true);}
      });
      actions.append(viewButton,download);card.append(actions);
    }
    $('results').append(card);
  }
  nextOffset=Number.isInteger(result.next_offset)?result.next_offset:null;
  $('prev').disabled=offset===0;$('next').disabled=nextOffset===null;
  $('coverage').textContent='只展示当前身份导入的文档元数据；原文不会自动展示或下载。';
  controls();
}
async function importSelectedDocument(){
  if(busy||pending)return;
  const file=$('document-file').files?.[0],session=token,project=$('project').value||null;
  if(!file){message('请先选择一个文件。',true);return;}
  const authorize=()=>{
    if(!token||token!==session||!$('document-consent').checked||$('document-file').files?.[0]!==file||($('project').value||null)!==project)
      throw new Error('document_consent_or_selection_changed');
  };
  try{
    authorize();
    if(file.size<1||file.size>131072)throw new Error('file_size_out_of_range');
    const bytes=new Uint8Array(await file.arrayBuffer());
    new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
    const digest=await sha256Hex(bytes);authorize();
    mutate('document_import',{agent_id:'personal-console',consent:true,label:file.name,content_base64:bytesToBase64(bytes),content_sha256:digest,project_id:project},authorize);
  }catch(e){message('导入被拒绝：'+e.message+'。请重新选择并确认；未提交此文件。',true);}
}

function render(result){
  current=result;$('results').replaceChildren();
  const rows=view==='jobs'?result.jobs:view==='agents'?result.agents:result.memories;
  if(!rows?.length)$('results').append(element('p','这个窗口没有可见记录。新建记忆默认在“待确认”中。','note'));
  for(const row of rows??[]){
    const card=element('article');
    if(view==='jobs') {
      card.append(element('strong','状态：'+row.state),element('p','尝试次数：'+row.attempts+' · '+(row.error??''),'meta'),element('p','任务：'+row.job_id,'meta'));
      if(row.result)card.append(element('p','生成候选：'+row.result.entries.length+'；需要逐条核对，不代表模型已证明真实性。','note'));
      if(['queued','failed','processing'].includes(row.state)) {
        const run=element('button',row.state==='queued'?'整理此条（调用模型）':'恢复／重试（可能再次计费）');run.dataset.write='true';
        run.addEventListener('click',()=>{if(confirm('只处理这一个任务。原文将发送给服务器已配置的个人整理模型，可能产生费用；失败或中断恢复可能再次计费。继续？'))mutate('consolidate',{expected_source:sourceId,job_id:row.job_id,limit:1,allow_model_call:true,retry:row.state!=='queued'});});
        const cancel=element('button','取消整理，保留原文');cancel.dataset.write='true';cancel.addEventListener('click',()=>{if(confirm('取消只阻止结果提交，不删除原文，也不能撤销已发送的模型请求或费用。'))mutate('cancel_job',{job_id:row.job_id});});card.append(run,cancel);
      }
    }else if(view==='agents'){
      card.append(element('strong',row.agent_id),element('p',row.agent_type+' · r'+row.revision,'meta'),element('p',(row.capabilities??[]).join(' / ')||'未声明能力','meta'),element('p','名称和能力是客户端自述，不是软件身份认证。','note'));
    }else{
      card.append(element('span',labels[row.type]??row.type,'badge'),element('span',row.owned_by_caller?'自己拥有':'同源共享','badge'),element('p',row.content,'memory-content'));
      card.append(element('p','r'+row.revision+' · '+(row.project_id??'全局')+' · '+row.visibility+' · 可信度估计：'+(row.confidence??'未知'),'meta'),element('p','来源：'+row.provenance,'meta'));
      if(row.derivation)card.append(element('p','原文引用：'+row.derivation.quote,'memory-content'),element('p',row.derivation_current?'来源版本仍匹配；引用不代表真实性证明。':'来源已修改或归档；重新核对前不能激活。','note'));
      if(row.owned_by_caller&&row.origin_kind!=='document_fragment'){
        const actions=element('div',undefined,'row card-actions');
        for(const [name,handler]of [['编辑',()=>edit(row)],...(row.status!=='active'?[['确认启用',()=>{if(confirm('确认启用这条记忆？这表示你认可本次内容，不是系统已证明其真实性。'))mutate('review',{memory_id:row.id,expected_revision:row.revision,status:'active'});}]]:[]),...(row.status!=='archived'?[['归档',()=>{if(confirm('归档后不再用于当前上下文。原始内容仍保留，不会物理擦除。'))mutate('review',{memory_id:row.id,expected_revision:row.revision,status:'archived'});}]]:[])]){const b=element('button',name);b.dataset.write='true';b.addEventListener('click',handler);actions.append(b);}card.append(actions);
      }
    }$('results').append(card);
  }
  nextOffset=Number.isInteger(result.next_offset)?result.next_offset:null;
  $('prev').disabled=offset===0||view==='profile';$('next').disabled=nextOffset===null||view==='profile';$('export').disabled=false;
  $('coverage').textContent='当前源和身份下的有限窗口；可能随并发修改变化。'+(result.dropped?'有 '+result.dropped+' 条因大小或数量限制未展示。':'')+(view==='profile'?'这里只展示已启用的全局身份、偏好、环境和目标。':'');
  controls();
}
async function load(){
  const request=++loadVersion;current=null;$('export').disabled=true;for(const b of document.querySelectorAll('[data-view]'))b.setAttribute('aria-current',b.dataset.view===view?'page':'false');
  $('view-title').textContent=views[view];$('search-form').hidden=['profile','agents','documents','jobs'].includes(view);
  documentEpoch++;$('document-panel').hidden=view!=='documents';$('document-original').hidden=true;documentOriginal=null;
  try{
    if(view==='documents'){
      const data=await api('document_list',{status:'any',limit:20,offset});
      if(request===loadVersion&&token)renderDocuments(data);
    }else{
      const data=await api(view==='jobs'?'jobs':view==='agents'?'agents':view==='profile'?'profile':'search',['agents','jobs'].includes(view)?{limit:20,offset}:view==='profile'?{limit:50,budget_bytes:131072}:{status:view,query:$('query').value,limit:20,offset,budget_bytes:131072});
      if(request===loadVersion&&token)render(data);
    }
  }
  catch(e){if(request===loadVersion)message('读取失败：'+e.message,true);}
}
$('login-form').addEventListener('submit',async e=>{e.preventDefault();token=$('token').value.trim();$('token').value='';try{const info=await api('info');sourceId=info.source_id;$('scope').textContent='数据源：'+info.source_id+' · Linux 本机所有者（与同账号 stdio 共享）';$('login').hidden=true;$('workspace').hidden=false;$('logout').hidden=false;message('已连接。');await load();}catch(e){token='';message('连接失败：'+e.message,true);}});
$('logout').addEventListener('click',()=>{if(pending||busy)return;token='';sourceId='';documentEpoch++;documentOriginal=null;$('document-original-text').textContent='';$('document-original').hidden=true;$('document-file').value='';$('document-consent').checked=false;loadVersion++;current=null;editing=null;$('content').value='';$('results').replaceChildren();$('workspace').hidden=true;$('login').hidden=false;$('logout').hidden=true;message('管理台已锁定。');});
for(const b of document.querySelectorAll('[data-view]'))b.addEventListener('click',()=>{view=b.dataset.view;offset=0;load();});
$('refresh').addEventListener('click',()=>load());$('search-form').addEventListener('submit',e=>{e.preventDefault();offset=0;load();});
$('prev').addEventListener('click',()=>{offset=Math.max(0,offset-20);load();});$('next').addEventListener('click',()=>{if(nextOffset!==null){offset=nextOffset;load();}});
$('export').addEventListener('click',()=>{if(current)download({format:1,exported_at:new Date().toISOString(),scope:'visible page only, not a full backup',complete:false,view,result:current},'ultrabrain-personal-page.json');});
$('cancel-edit').addEventListener('click',()=>{resetEditor();controls();});
$('queue-personal').addEventListener('click',()=>{if(editing||busy||pending)return;if(!$('consent').checked){message('排队前必须明确同意保存原文。',true);return;}if(!$('content').value.trim()){message('请填写要整理的原文。',true);return;}mutate('capture',{agent_id:'personal-console',transcript:$('content').value,project_id:$('project').value||null,consent:true},memoryAuthorization());});
$('document-file').addEventListener('change',()=>{
  $('document-consent').checked=false;
  const file=$('document-file').files?.[0];
  $('document-file-info').textContent=file?(file.name+' · '+formatSize(file.size)+(file.size>131072?' · 超过 128 KiB 上限，将被整体拒绝':'')):'尚未选择文件。';
});
$('document-import').addEventListener('click',importSelectedDocument);
$('memory-form').addEventListener('submit',e=>{
  e.preventDefault();if(!$('consent').checked){message('保存前必须明确同意采集。',true);return;}
  const memory={type:$('type').value,content:$('content').value,importance:$('importance').value,visibility:$('visibility').value,provenance:$('provenance').value,project_id:$('project').value||null,confidence:editing?.confidence??null};
  if(memory.visibility==='source'&&!confirm('激活后，同一数据源其他身份可读取这条内容。确认选择共享？'))return;
  if(editing)mutate('update',{memory_id:editing.id,expected_revision:editing.revision,event_id:crypto.randomUUID(),memory},memoryAuthorization());
  else mutate('commit',{agent_id:'personal-console',consent:true,memories:[memory]},memoryAuthorization());
});
$('retry').addEventListener('click',submitPending);$('save-pending').addEventListener('click',()=>{if(pending)download({format:1,warning:'Contains consented memory text; protect this local file. The request is not confirmed.',...pending},'ultrabrain-unconfirmed-request.json');});
window.addEventListener('beforeunload',e=>{if(pending){e.preventDefault();e.returnValue='';}});
