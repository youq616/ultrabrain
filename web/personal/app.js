/* No HTML rendering of memory text, no browser token persistence, no automatic model calls. */
'use strict';
const $=id=>document.getElementById(id);
const labels={identity:'身份',preference:'偏好',environment:'环境',project:'项目',decision:'决策',skill:'技能',error:'错误经验',goal:'目标',experience:'经验'};
const views={candidate:'待确认记忆',active:'当前记忆',archived:'已归档',profile:'个人偏好',recall:'任务召回预览',lookup:'按 ID 核对',documents:'导入文档',agents:'已登记 Agent',jobs:'整理任务'};
let sourceId='',token='',view='candidate',offset=0,nextOffset=null,current=null,editing=null,pending=null,busy=false,loadVersion=0,documentEpoch=0;
let documentReadEpoch=0,documentReadController=null;
let recallEpoch=0,recallController=null;
let lookupEpoch=0,lookupController=null;
let draftConfidence=null,comparison=null,comparisonEpoch=0,comparisonController=null;
let jobReadController=null;
function message(text,error=false){$('message').textContent=text;$('message').dataset.error=String(error);}
function element(tag,text,cls){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;return node;}
function controls(){
  for(const b of document.querySelectorAll('[data-write],#save,#cancel-edit'))b.disabled=busy||!!pending;
  $('queue-personal').disabled=busy||!!pending||!!editing;$('retry').disabled=busy;$('pending-panel').hidden=!pending;$('logout').disabled=busy||!!pending;
  $('pending-id').textContent=pending?'事件编号：'+(pending.input.event_id??pending.input.job_id??''):'';
  $('compare-current').disabled=busy||!!pending||!!comparisonController||!editableMemory(editing)||view==='recall';
  $('comparison-adopt').disabled=busy||!!pending||!comparison?.canAdopt||!$('comparison-consent').checked;
  $('comparison-cancel').disabled=!comparison&&!comparisonController;
}
async function api(operation,input={},signal){
  let response;try{response=await fetch('/api/call',{method:'POST',credentials:'omit',cache:'no-store',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify({operation,input}),signal:AbortSignal.any([AbortSignal.timeout(operation==='consolidate'?150000:20000),signal].filter(Boolean))});}
  catch{throw Object.assign(new Error('network_unconfirmed'),{unknown:true});}
  let result;try{result=await response.json();}catch{throw Object.assign(new Error('response_unconfirmed'),{unknown:true});}
  if(!result||typeof result!=='object'||Array.isArray(result)||typeof result.ok!=='boolean')
    throw Object.assign(new Error('response_unconfirmed'),{unknown:true});
  if(result.ok===false){
    if(response.ok||typeof result.error!=='string'||!['rejected','unconfirmed'].includes(result.delivery))
      throw Object.assign(new Error('response_unconfirmed'),{unknown:true});
    throw Object.assign(new Error(result.error),{unknown:result.delivery==='unconfirmed'||response.status>=500});
  }
  if(!response.ok)throw Object.assign(new Error('response_unconfirmed'),{unknown:true});
  if(!result.result||typeof result.result!=='object'||Array.isArray(result.result))
    throw Object.assign(new Error('response_unconfirmed'),{unknown:true});
  return result.result;
}
function download(value,name){const u=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)+'\n'],{type:'application/json'}));const link=element('a');link.href=u;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(u),1000);}
function resetEditor(){invalidateComparison();editing=null;draftConfidence=null;$('editor-title').textContent='新建候选记忆';$('memory-form').reset();$('provenance').value='用户在个人管理台明确输入';$('cancel-edit').hidden=true;}
function edit(row){if(pending||busy)return;invalidateComparison();editing=row;draftConfidence=row.confidence??null;$('editor-title').textContent='修改记忆 · r'+row.revision;for(const [field,value]of Object.entries({type:row.type,content:row.content,importance:row.importance,visibility:row.visibility,provenance:row.provenance,project:row.project_id??''}))$(field).value=value;$('consent').checked=false;$('cancel-edit').hidden=false;$('content').focus();controls();}
function memoryAuthorization(){
  const session=token,source=sourceId;
  const selection=()=>JSON.stringify([editing?.id??null,editing?.revision??null,draftConfidence,...['type','content','importance','visibility','provenance','project'].map(id=>$(id).value)]);
  const snapshot=selection();
  return ()=>{
    if(!token||token!==session||sourceId!==source||!$('consent').checked||selection()!==snapshot)
      throw new Error('memory_consent_or_selection_changed');
  };
}
// Validate the EXISTING server contract; a 2xx response alone is not acknowledgement.
// Update/review currently return no event ID or source: match their ID/revision/status,
// keep the session boundary, and do not claim cryptographic or full-content attestation.
const EDITOR_WRITES=new Set(['commit','capture','update']);
function verifyWriteReceipt(operation,input,result,source,documentSelection){
  if(operation==='cancel_job'){
    const matches=result&&typeof result==='object'&&!Array.isArray(result)&&result.dry_run!==true&&
      result.id===input.job_id&&result.state==='stale'&&
      (!Object.hasOwn(result,'source_id')||result.source_id===source);
    if(!matches)throw Object.assign(new Error('console_receipt_unconfirmed'),{unknown:true});
    return; // Existing cancellation has no event/replay receipt; do not invent one.
  }
  if(['document_import','document_queue','document_archive'].includes(operation))
    return verifyDocumentWriteReceipt(operation,input,result,source,documentSelection);
  if(!['register','commit','capture','update','review'].includes(operation))return;
  const valid=c=>{if(!c)throw Object.assign(new Error('console_receipt_unconfirmed'),{unknown:true});};
  const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
  const revision=v=>Number.isSafeInteger(v)&&v>=1&&v<=2147483647;
  valid(result&&typeof result==='object'&&!Array.isArray(result)&&result.dry_run!==true&&typeof result.replayed==='boolean');
  if(operation==='register'){
    valid(result.source_id===source&&result.agent_id===input.agent_id&&revision(result.revision)&&
      typeof result.actor_key==='string'&&/^[a-f0-9]{64}$/.test(result.actor_key));return;
  }
  if(['commit','capture'].includes(operation)){
    valid(result.source_id===source&&result.event_id===input.event_id&&result.model_calls===0&&result.review_required===true);
    if(operation==='commit'){
      const count=Array.isArray(input.memories)?input.memories.length:typeof input.summary==='string'?1:0;
      valid(count>=1&&count<=16&&result.storage==='stored'&&result.state==='candidate'&&Array.isArray(result.entries)&&result.entries.length===count);
      const seen=new Set();for(const row of result.entries){
        valid(row&&uuid(row.id)&&!seen.has(row.id)&&row.revision===1&&row.status==='candidate');seen.add(row.id);
      }
    }else valid(result.storage==='journaled'&&result.state==='queued'&&uuid(result.input_id)&&result.input_revision===1&&uuid(result.job_id));
    return;
  }
  valid(uuid(input.memory_id)&&result.id===input.memory_id&&revision(result.revision)&&result.revision===input.expected_revision+1&&
    result.status===(operation==='update'?'candidate':input.status));
  if(operation==='update')valid(result.review_required===true);
  // Optional future binding fields must not contradict this request.
  if(Object.hasOwn(result,'source_id'))valid(result.source_id===source);
  if(Object.hasOwn(result,'event_id'))valid(result.event_id===input.event_id);
}
function editorReceiptSelection(){
  return JSON.stringify([editing?.id??null,editing?.revision??null,memoryDraft(),$('consent').checked]);
}
async function submitPending(){
  if(!pending||busy)return;const request=pending;let submitted=false,acknowledged=false;busy=true;controls();
  const contextCurrent=()=>{
    if(pending!==request||!request.sessionCurrent())throw Object.assign(new Error('console_session_changed'),{unknown:true});
  };
  try{
    contextCurrent();request.authorize?.();
    if(['commit','capture','document_import'].includes(request.operation)){
      const registration={agent_id:'personal-console',agent_type:'general_agent',capabilities:[]};
      const registered=await api('register',registration);contextCurrent();
      verifyWriteReceipt('register',registration,registered,request.source_id);
    }
    request.authorize?.();contextCurrent();
    // Use the same frozen request for sending, validation and every explicit retry.
    submitted=true;const result=await api(request.operation,request.input);contextCurrent();
    verifyWriteReceipt(request.operation,request.input,result,request.source_id,request.receipt_context);
    const clearEditor=EDITOR_WRITES.has(request.operation)&&request.editorUnchanged();
    acknowledged=true;pending=null;
    if(clearEditor)resetEditor();
    else if(EDITOR_WRITES.has(request.operation))$('consent').checked=false;
    message((request.operation==='consolidate'?'整理请求已返回，请在整理任务中查看实际状态。':'操作已确认。')+
      (result.state==='needs_model'?'尚未配置个人整理模型，未发送原文。':'')+
      (result.review_required?'该记忆需要明确确认后才进入当前上下文。':'')+
      (result.replayed===true?'重放确认的是原事件，不代表记录仍处于该版本；当前状态请重新读取。':'')+
      (EDITOR_WRITES.has(request.operation)&&!clearEditor?'提交后修改的草稿已保留，尚未保存；原请求已确认，不代表当前草稿已保存。请重新核对版本和保存同意。':''));
    await load();
  }catch(e){
    // Never turn a later UI/rendering error into a request replay after a verified ack.
    if(acknowledged){message('操作已取得确认，但页面刷新失败。请重新读取记录，不要重复提交。',true);}
    else if(pending!==request){message('请求状态已变化，无法确认原提交。请保留原事件并核对，不要重复提交。',true);}
    else if(e.unknown){
      if(submitted)request.delivery_unconfirmed=true;
      message((request.delivery_unconfirmed?'尚未取得可靠确认：':'准备阶段未取得可靠确认，尚未发送本次目标写入：')+e.message+
        '。原请求和事件编号已保留；请核对后重试同一请求，不要更换事件编号。',true);
    }
    else if(request.delivery_unconfirmed)message('本次重试已停止：'+e.message+'。此前提交仍未确认；待确认请求和事件编号已保留。重新核对原内容与授权后才可重试。',true);
    else {pending=null;message('请求被拒绝：'+e.message+'。草稿已保留；版本冲突时可点击“读取当前版本对照”，不要直接覆盖他人的更改。',true);}
  }finally{busy=false;controls();}
}
function mutate(operation,input,authorize,receiptContext){
  if(busy||pending){message('请先处理尚未确认的请求。',true);return;}
  authorize?.();invalidateComparison();invalidateDocumentRead();
  const session=token,source=sourceId,editorSnapshot=editorReceiptSelection();
  const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
  const snapshot=freeze(JSON.parse(JSON.stringify({...input,...(['commit','capture','update','review','document_import','document_queue','document_archive'].includes(operation)?{event_id:crypto.randomUUID()}:{})})));
  pending={operation,authorize,input:snapshot,source_id:source,
    receipt_context:receiptContext===undefined?null:freeze(JSON.parse(JSON.stringify(receiptContext))),
    sessionCurrent:()=>!!session&&token===session&&sourceId===source,
    editorUnchanged:()=>editorReceiptSelection()===editorSnapshot};
  submitPending();
}
// Bind document writes to the frozen import bytes or the explicitly selected card.
// Queue checks cover the full-file UI contract; fragment hashes have no local byte
// preimage here, so their shape is checked, not claimed as a content attestation.
// One canonical timestamp rule for list metadata, original reads AND write receipts.
// Date.parse alone normalizes invalid dates; shape plus exact round trip is required.
function canonicalDocumentTimestamp(value){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))return false;
  const time=Date.parse(value);return Number.isFinite(time)&&new Date(time).toISOString()===value;
}
function documentReceiptSelection(row){
  return {document_id:row.document_id,byte_size:row.byte_size,revision:row.revision};
}
function verifyDocumentWriteReceipt(operation,input,result,source,selected){
  const valid=c=>{if(!c)throw Object.assign(new Error('console_receipt_unconfirmed'),{unknown:true});};
  const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
  const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
  const count=v=>Number.isSafeInteger(v)&&v>=0;
  const revision=v=>Number.isSafeInteger(v)&&v>=1&&v<=2147483647;
  const date=canonicalDocumentTimestamp;
  valid(result&&typeof result==='object'&&!Array.isArray(result)&&result.dry_run!==true&&
    typeof result.replayed==='boolean'&&result.source_id===source&&result.event_id===input.event_id&&result.model_calls===0&&
    uuid(result.document_id));
  if(operation==='document_import'){
    // Input is the exact bounded snapshot sent by importSelectedDocument, not a
    // re-read of the file picker, which may now contain a different selection.
    valid(typeof input.content_base64==='string'&&input.content_base64.length<=174764&&digest(input.content_sha256));
    let bytes;try{bytes=base64ToBytes(input.content_base64);}catch{valid(false);}
    valid(bytes.length>=1&&bytes.length<=131072&&bytesToBase64(bytes)===input.content_base64);
    const format=/\.([A-Za-z0-9]{1,16})$/.exec(input.label)?.[1].toLowerCase();
    const bom=bytes.length>=3&&bytes[0]===0xef&&bytes[1]===0xbb&&bytes[2]===0xbf;
    valid(['txt','md','json','csv','log'].includes(format)&&result.format===format&&result.label===input.label&&
      result.byte_size===bytes.length&&result.content_sha256===input.content_sha256&&result.has_bom===bom&&
      result.agent_id===input.agent_id&&result.project_id===(input.project_id??null)&&result.status==='active'&&result.revision===1&&
      result.storage==='stored'&&typeof result.already_imported==='boolean'&&date(result.created_at));
    return;
  }
  valid(selected&&selected.document_id===input.document_id&&result.document_id===input.document_id&&
    count(selected.byte_size)&&selected.byte_size>=1&&selected.byte_size<=131072&&revision(selected.revision));
  if(operation==='document_queue'){
    valid(input.fragments===undefined&&result.storage==='journaled'&&result.review_required===true&&
      Array.isArray(result.fragments)&&result.fragments.length>=1&&result.fragments.length<=16);
    const memories=new Set(),jobs=new Set();let end=0;
    for(const f of result.fragments){
      valid(f&&uuid(f.memory_id)&&uuid(f.job_id)&&!memories.has(f.memory_id)&&!jobs.has(f.job_id)&&
        f.state==='queued'&&f.offset_unit==='utf8-bytes'&&digest(f.fragment_sha256)&&
        count(f.byte_start)&&count(f.byte_end)&&f.byte_start===end&&f.byte_end>f.byte_start&&
        f.byte_end-f.byte_start<=32768&&f.byte_end<=selected.byte_size&&
        (f.byte_end===selected.byte_size||f.byte_end-f.byte_start>=32765));
      memories.add(f.memory_id);jobs.add(f.job_id);end=f.byte_end;
    }
    valid(end===selected.byte_size);return;
  }
  valid(operation==='document_archive'&&result.status==='archived'&&revision(result.revision)&&
    result.revision===selected.revision+1&&date(result.archived_at)&&result.original_retained===true&&
    count(result.archived_fragments)&&count(result.fenced_jobs)&&count(result.derived_entries_invalidated));
}
const formatSize=n=>n<1024?n+' B':(n/1024).toFixed(1)+' KiB';
const sha16=v=>v?String(v).slice(0,16)+'…':'';
function base64ToBytes(value){const raw=atob(value);const bytes=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);return bytes;}
function bytesToBase64(bytes){let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(binary);}
async function sha256Hex(bytes){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(b=>b.toString(16).padStart(2,'0')).join('');}
// Document reads are explicit, latest-selection-only operations. No download cache:
// even after a preview, downloading rechecks the server's current visibility.
function invalidateDocumentRead(){
  documentReadEpoch++;documentReadController?.abort();documentReadController=null;
  $('document-original').hidden=true;$('document-original-title').textContent='';$('document-original-text').textContent='';
  $('document-read-cancel').disabled=true;
}
function documentReadSelection(row){
  return Object.freeze(Object.fromEntries(['document_id','label','format','byte_size','content_sha256','has_bom',
    'agent_id','project_id','created_at','status','revision','archived_at'].map(key=>[key,row[key]])));
}
function verifyDocumentMetadata(row){
  const valid=c=>{if(!c)throw new Error('document_read_unconfirmed');};
  const date=canonicalDocumentTimestamp;
  valid(row&&typeof row==='object'&&!Array.isArray(row)&&
    typeof row.document_id==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(row.document_id));
  valid(typeof row.label==='string'&&row.label.isWellFormed()&&new TextEncoder().encode(row.label).length<=256&&
    !/[\\/\x00-\x1f\x7f<>:"|?*]/.test(row.label)&&
    ['txt','md','json','csv','log'].includes(row.format)&&/\.([A-Za-z0-9]{1,16})$/.exec(row.label)?.[1].toLowerCase()===row.format);
  valid(Number.isSafeInteger(row.byte_size)&&row.byte_size>=1&&row.byte_size<=131072&&
    typeof row.content_sha256==='string'&&/^[a-f0-9]{64}$/.test(row.content_sha256)&&typeof row.has_bom==='boolean'&&
    typeof row.agent_id==='string'&&/^[A-Za-z0-9_-]{1,96}$/.test(row.agent_id)&&
    (row.project_id===null||typeof row.project_id==='string'&&/^[A-Za-z0-9_-]{1,96}$/.test(row.project_id))&&
    Number.isSafeInteger(row.revision)&&row.revision>=1&&row.revision<=2147483647&&date(row.created_at)&&
    (row.status==='active'&&row.archived_at===null||row.status==='archived'&&date(row.archived_at)));
}
async function verifyDocumentRead(result,selected,source,allowed){
  const valid=c=>{if(!c)throw new Error('document_read_unconfirmed');};
  allowed();verifyDocumentMetadata(result);
  valid(result.source_id===source&&result.dry_run!==true&&result.fragments===null);
  for(const key of ['document_id','label','format','byte_size','content_sha256','has_bom','agent_id','project_id','created_at'])
    valid(result[key]===selected[key]);
  // Archival can happen after rendering a card. Preserve immutable identity/content,
  // but display the returned lifecycle state, never the stale card's active label.
  valid(result.revision>=selected.revision&&
    (result.revision!==selected.revision||result.status===selected.status&&result.archived_at===selected.archived_at)&&
    (selected.status!=='archived'||result.status==='archived'));
  const encoded=result.content_base64;
  valid(typeof encoded==='string'&&encoded.length===4*Math.ceil(selected.byte_size/3)&&/^[A-Za-z0-9+/]+={0,2}$/.test(encoded));
  let bytes,text;
  try{
    bytes=base64ToBytes(encoded);valid(bytes.length===selected.byte_size&&bytesToBase64(bytes)===encoded);
    // NUL, whitespace, a literal replacement character and BOM-only are legal originals.
    // A preview omits the leading BOM; the download always uses the original bytes.
    text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  }catch{throw new Error('document_read_unconfirmed');}
  valid((bytes.length>=3&&bytes[0]===0xef&&bytes[1]===0xbb&&bytes[2]===0xbf)===selected.has_bom);
  const digest=await sha256Hex(bytes);allowed();
  if(digest!==selected.content_sha256)throw new Error('fingerprint_mismatch_after_download');
  return {document:documentReadSelection(result),bytes,text};
}
function downloadDocument(original){ // Only called by the current explicit download action.
  const url=URL.createObjectURL(new Blob([original.bytes],{type:'text/plain'}));
  const link=element('a');link.href=url;link.download=original.document.label;link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
async function readDocument(row,download=false){
  invalidateDocumentRead();
  const session=token,source=sourceId,navigation=documentEpoch,epoch=documentReadEpoch,controller=new AbortController();
  const current=()=>!!session&&token===session&&sourceId===source&&view==='documents'&&navigation===documentEpoch&&
    epoch===documentReadEpoch&&!controller.signal.aborted;
  const allowed=()=>{if(!current())throw new Error('document_view_changed');};
  documentReadController=controller;
  try{
    allowed();const selected=documentReadSelection(row);verifyDocumentMetadata(selected);
    $('document-read-cancel').disabled=false;
    message('正在核对所选文档原文；不写入记忆、不调用模型。');
    const result=await api('document_read',{document_id:selected.document_id},controller.signal);allowed();
    const original=await verifyDocumentRead(result,selected,source,allowed);allowed();
    if(download){downloadDocument(original);message('已核对所选文档并发起原文下载。');}
    else{
      $('document-original-title').textContent='原文 · '+original.document.label+
        (original.document.status==='archived'?'（已归档，仍可下载核对）':'（纯文本预览，不执行内容）');
      $('document-original-text').textContent=original.text;$('document-original').hidden=false;
      message('已按纯文本显示所选原文，身份、元数据和指纹核对通过。下载需点击“下载原文”。');
    }
  }catch(error){
    // Old errors, including an ignored abort, cannot overwrite a newer screen/message.
    if(current())message((download?'下载':'读取')+'未确认：'+error.message+'。原文未展示或下载；未请求写入或模型调用。',true);
  }finally{if(epoch===documentReadEpoch)documentReadController=null;}
}
function documentReadActions(row){
  // Capture scalar metadata, not the mutable list result or a shared byte cache.
  const selected=documentReadSelection(row),actions=element('div',undefined,'row card-actions');
  const preview=element('button','查看原文'),download=element('button','下载原文');
  preview.addEventListener('click',()=>readDocument(selected));
  download.addEventListener('click',()=>readDocument(selected,true));
  actions.append(preview,download);return actions;
}
// Metadata-only pages form the document workspace's selection boundary. Validate the
// entire page before rendering any card; a partial/foreign page is not an empty library.
function documentListQuery(){
  const status=$('document-status').value||'any';
  if(!['any','active','archived'].includes(status))throw new Error('invalid_document_filter');
  return {status,limit:20,offset};
}
function validateDocumentPage(result,input,source){
  const valid=c=>{if(!c)throw new Error('document_list_unconfirmed');};
  valid(result&&typeof result==='object'&&!Array.isArray(result)&&result.source_id===source&&
    Object.keys(result).every(k=>['source_id','documents','next_offset'].includes(k))&&
    Array.isArray(result.documents)&&result.documents.length<=input.limit&&
    new TextEncoder().encode(JSON.stringify(result)).length<=131072);
  valid(Number.isSafeInteger(input.offset)&&input.offset>=0&&input.offset<=1000000&&input.limit===20&&
    ['any','active','archived'].includes(input.status)&&
    result.next_offset===(result.documents.length===input.limit?input.offset+input.limit:null));
  const fields=new Set(['document_id','label','format','byte_size','content_sha256','has_bom','agent_id','project_id',
    'created_at','status','revision','archived_at','fragments','assurance']);
  const ids=new Set(),documents=[];
  for(const row of result.documents){
    verifyDocumentMetadata(row);
    valid(Object.keys(row).every(k=>fields.has(k))&&!ids.has(row.document_id)&&
      (input.status==='any'||row.status===input.status)&&Number.isSafeInteger(row.fragments)&&row.fragments>=0&&
      (row.assurance===undefined||typeof row.assurance==='string'&&row.assurance.length<=512));
    ids.add(row.document_id);
    // Every value in this public projection is scalar. Keep later mutation of a
    // decoded result from changing the identity captured by read AND write buttons.
    documents.push(Object.freeze({...row}));
  }
  return Object.freeze({source_id:source,documents:Object.freeze(documents),next_offset:result.next_offset});
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
      const actions=documentReadActions(row);
      const queue=element('button','排队整理（之后才会调用模型）');queue.dataset.write='true';
      queue.addEventListener('click',()=>{
        // Immutable original is split server-side at UTF-8 boundaries, not by naive browser byte steps.
        if(!confirm('将把 '+row.label+' 按 UTF-8 字符边界划分为 ≤32 KiB 的片段排队整理。排队只保存候选，不调用模型；之后在“整理任务”里逐条明确运行模型并核对结果。继续？'))return;
        mutate('document_queue',{document_id:row.document_id},undefined,documentReceiptSelection(row));
      });
      const archive=element('button','归档文档');archive.dataset.write='true';
      archive.addEventListener('click',()=>{if(confirm('归档会使相关片段退出当前使用范围、使派生记忆失效并阻止未完成任务写回。原始文件字节保留可下载，这不是物理擦除。继续？'))mutate('document_archive',{document_id:row.document_id},undefined,documentReceiptSelection(row));});
      actions.append(queue,archive);card.append(actions);
    }else card.append(documentReadActions(row));
    $('results').append(card);
  }
  nextOffset=Number.isInteger(result.next_offset)?result.next_offset:null;
  $('prev').disabled=offset===0;$('next').disabled=nextOffset===null;
  $('coverage').textContent='已核对当前身份的文档列表 · '+({any:'全部',active:'使用中',archived:'已归档'}[$('document-status').value||'any'])+' · 本页 '+rows.length+' 条。列表是实时分页，不是完整备份；原文仅在明确点击后读取。';
  $('export').disabled=false;
  if(nextOffset>1000000){$('next').disabled=true;$('coverage').textContent+=' 已达列表偏移上限。';}
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

// Preview is an explicit read, never an automatic task hook or a write authority.
function invalidateRecall(clearInputs=false){
  recallEpoch++;recallController?.abort();recallController=null;
  $('recall-consent').checked=false;$('recall-submit').disabled=false;$('recall-cancel').disabled=true;
  if(clearInputs){$('recall-task').value='';$('recall-project').value='';}
  if(view==='recall'){
    current=null;nextOffset=null;$('results').replaceChildren();$('export').disabled=true;
    $('prev').disabled=true;$('next').disabled=true;
    $('coverage').textContent='尚无本次预览结果。提交前需明确同意发送任务到当前本机记忆服务。';
  }
}
function recallSelection(){
  return JSON.stringify(['recall-task','recall-project','recall-limit','recall-budget'].map(id=>$(id).value));
}
function recallRequest(){
  const task=$('recall-task').value,project=$('recall-project').value;
  if(!task.trim()||!task.isWellFormed()||task.includes('\0')||new TextEncoder().encode(task).length>4096)
    throw new Error('task_requires_1_to_4096_utf8_bytes');
  if(project&&!/^[A-Za-z0-9_-]{1,96}$/.test(project))throw new Error('invalid_project');
  if(!['5','10','20'].includes($('recall-limit').value)||!['2048','6000','8192'].includes($('recall-budget').value))
    throw new Error('invalid_preview_budget');
  return {task,project_id:project||null,limit:Number($('recall-limit').value),budget_bytes:Number($('recall-budget').value)};
}
async function verifyRecall(result,input,allowed){
  const valid=condition=>{if(!condition)throw new Error('recall_contract_changed');};
  const fields=new Set(['source_id','memories','trust','selection','confidence_semantics','exhaustive','dropped','budget_bytes','recall']);
  valid(result&&Object.keys(result).every(key=>fields.has(key)));
  valid(result?.source_id===sourceId&&result.trust==='untrusted-memory-data'&&result.exhaustive===false&&
    result.selection==='bounded-literal-and-importance-v2'&&result.budget_bytes===input.budget_bytes&&
    Number.isSafeInteger(result.dropped)&&result.dropped>=0&&Array.isArray(result.memories)&&result.memories.length<=input.limit&&
    new TextEncoder().encode(JSON.stringify(result)).length<=input.budget_bytes);
  const ids=new Set();
  for(const row of result.memories){
    valid(row&&typeof row.id==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(row.id)&&!ids.has(row.id)&&
      Object.hasOwn(labels,row.type)&&row.status==='active'&&row.derivation_current!==false&&Number.isSafeInteger(row.revision)&&row.revision>0&&
      (row.project_id==null||row.project_id===input.project_id)&&(row.owned_by_caller===true||row.visibility==='source')&&
      typeof row.content==='string'&&row.content.isWellFormed()&&typeof row.provenance==='string'&&
      typeof row.content_hash==='string'&&/^[a-f0-9]{64}$/.test(row.content_hash));
    ids.add(row.id);allowed();
    const digest=await sha256Hex(new TextEncoder().encode(row.content));allowed();valid(digest===row.content_hash);
  }
  return result;
}
async function previewRecall(){
  if(busy||pending){message('请先处理尚未确认的写入请求，再预览召回。',true);return;}
  const epoch=++recallEpoch,session=token,source=sourceId,selection=recallSelection();
  recallController?.abort();const controller=new AbortController();recallController=controller;
  current=null;nextOffset=null;$('results').replaceChildren();$('export').disabled=true;
  $('prev').disabled=true;$('next').disabled=true;$('recall-submit').disabled=true;$('recall-cancel').disabled=false;
  $('coverage').textContent='本次预览尚未确认，旧结果已清除。';
  let submitted=false;
  const allowed=()=>{
    if(controller.signal.aborted||epoch!==recallEpoch||view!=='recall'||!session||token!==session||sourceId!==source||
      !$('recall-consent').checked||selection!==recallSelection())throw new Error('recall_authorization_changed');
  };
  try{
    allowed();const input=recallRequest();allowed();submitted=true;
    message('正在查询已启用的记忆；不新增记忆、不调用模型。');
    const result=await api('context',input,controller.signal);allowed();
    await verifyRecall(result,input,allowed);allowed();render(result);
    $('coverage').textContent='本机所有者视角 · 返回 '+result.memories.length+' / '+input.limit+' 条 · 响应 '+
      new TextEncoder().encode(JSON.stringify(result)).length+' / '+input.budget_bytes+' UTF-8 字节（不是 token） · 已取候选窗口内舍弃 '+
      result.dropped+' 条。先排序取最多 100 条候选，再按数量和字节预算保留整条；未统计窗口外遗漏。排序是字面匹配加重要性，不是真实性或语义准确率。';
    message('本次只读预览已返回。它不是其他 MCP 身份的上下文，也不是模型回答或完整记忆备份。');
  }catch(error){
    if(epoch===recallEpoch&&view==='recall'&&session===token){
      current=null;$('results').replaceChildren();$('export').disabled=true;
      message(submitted?'预览未确认：'+error.message+'。查询可能已到达服务器；没有请求写入记忆或调用模型。':'未发送预览：'+error.message+'。请核对任务、范围及授权。',true);
    }
  }finally{
    if(epoch===recallEpoch){recallController=null;$('recall-submit').disabled=false;$('recall-cancel').disabled=current===null;}
  }
}

// A comparison never changes an expected revision on its own. Adoption is a second,
// explicit local decision, followed by the existing separate consented CAS save.
function editableMemory(row){return row?.owned_by_caller===true&&row.origin_kind==='agent';}
function memoryDraft(){
  return {type:$('type').value,content:$('content').value,importance:$('importance').value,visibility:$('visibility').value,
    provenance:$('provenance').value,project_id:$('project').value||null,confidence:editing?draftConfidence:null};
}
function comparisonFields(row){
  return {memory_id:row.id,revision:row.revision,status:row.status,type:row.type,content:row.content,
    importance:row.importance,visibility:row.visibility,project_id:row.project_id??null,
    provenance:row.provenance,confidence:row.confidence??null,derivation_current:row.derivation_current};
}
function invalidateComparison(){
  comparisonEpoch++;comparisonController?.abort();comparisonController=null;comparison=null;
  $('comparison-panel').hidden=true;$('comparison-consent').checked=false;
  $('comparison-adopt').disabled=true;$('comparison-cancel').disabled=true;
  for(const id of ['comparison-original','comparison-latest','comparison-draft','comparison-note'])$(id).textContent='';
}
async function compareCurrentMemory(){
  if(busy||pending||!editableMemory(editing)||view==='recall'){
    message('只有当前拥有的普通记忆可对照。请先处理尚未确认的提交；对照不代替原事件重试。',true);return;
  }
  invalidateComparison();
  const epoch=comparisonEpoch,session=token,source=sourceId,base=editing,baseJSON=JSON.stringify(base),navigation=loadVersion,selectedView=view;
  const draft=memoryDraft(),draftJSON=JSON.stringify(draft),controller=new AbortController();
  comparisonController=controller;$('consent').checked=false;$('comparison-panel').hidden=false;controls();
  const allowed=()=>{
    if(!session||token!==session||sourceId!==source||epoch!==comparisonEpoch||controller.signal.aborted||busy||pending||
      selectedView!==view||navigation!==loadVersion||editing!==base||JSON.stringify(editing)!==baseJSON||JSON.stringify(memoryDraft())!==draftJSON)
      throw new Error('memory_comparison_changed');
  };
  try{
    allowed();
    if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(base.id)||!Number.isSafeInteger(base.revision)||base.revision<1||
      new TextEncoder().encode(draftJSON).length>524288)throw new Error('invalid_comparison_input');
    message('正在只读核对当前版本；仅发送记忆 ID，不发送草稿、不保存或调用模型。');
    const result=await api('memory_read',{memory_id:base.id},controller.signal);allowed();
    await verifyLookup(result,base.id,allowed);allowed();
    const latest=result.memory;
    if(!editableMemory(latest))throw new Error('memory_not_editable');
    if(latest.revision<base.revision)throw new Error('memory_revision_regressed');
    if(latest.revision===base.revision&&JSON.stringify(comparisonFields(latest))!==JSON.stringify(comparisonFields(base)))
      throw new Error('memory_same_revision_changed');
    comparison={latest,draft,allowed,canAdopt:latest.revision>base.revision&&latest.revision<2147483647};
    // Plain text only. Include ALL editable metadata, not just content, so preserving
    // a draft's visibility/project/confidence cannot silently overwrite unseen changes.
    $('comparison-original').textContent=JSON.stringify(comparisonFields(base),null,2);
    $('comparison-latest').textContent=JSON.stringify(comparisonFields(latest),null,2);
    $('comparison-draft').textContent=JSON.stringify(draft,null,2);
    $('comparison-note').textContent=(latest.revision===base.revision?'读取时版本未变化；没有可采用的新版本。':
      comparison.canAdopt?'新版本为 r'+latest.revision+'。采用仅更新本地保存基准，不保存、不合并正文；草稿中所有字段均保留。':
      '当前版本已达可编辑上限，不能采用后保存。')+
      (latest.status==='archived'?' 这条记忆已归档；以后明确保存会回到候选，不会自动启用。':'')+
      ' 读取之后仍可能变化；最终保存继续检查版本。';
    message('对照已返回。先核对三个区域的内容、项目、可见性、来源和可信度估计，再决定是否采用新版本；没有请求写入。');
  }catch(error){
    if(epoch===comparisonEpoch){invalidateComparison();message('未能完成对照：'+error.message+'。原编辑基准与草稿未被替换；没有请求写入。',true);}
  }finally{if(epoch===comparisonEpoch)comparisonController=null;controls();}
}
function adoptComparedVersion(){
  const selected=comparison;
  try{
    if(!selected?.canAdopt||!$('comparison-consent').checked)throw new Error('comparison_confirmation_required');
    selected.allowed();
    if(!confirm('保留草稿的全部字段，并将保存基准改为本次核对的 r'+selected.latest.revision+'？不会自动合并他人的内容。仍需重新同意保存，之后才能写入候选。'))return;
    selected.allowed();
    if(!$('comparison-consent').checked)throw new Error('comparison_confirmation_required');
    editing=selected.latest;draftConfidence=selected.draft.confidence;
    $('editor-title').textContent='修改记忆 · r'+editing.revision;$('consent').checked=false;
    invalidateComparison();controls();
    message('已采用本次核对版本作为本地保存基准，草稿内容和元数据均保留。尚未保存；请再次核对并明确同意后保存候选。');
  }catch(error){invalidateComparison();controls();message('未采用新版本：'+error.message+'。原基准与草稿未被替换。',true);}
}

// An explicit exact read bridges a recall citation to the existing CAS editor.
// Never edit the cached preview row; read again under the current server identity.
function invalidateLookup(clearInput=false){
  lookupEpoch++;lookupController?.abort();lookupController=null;
  $('lookup-submit').disabled=false;$('lookup-cancel').disabled=true;
  if(clearInput)$('lookup-id').value='';
  if(view==='lookup'){
    current=null;nextOffset=null;$('results').replaceChildren();$('export').disabled=true;
    $('prev').disabled=true;$('next').disabled=true;
    $('coverage').textContent='尚未核对记录。请明确读取 ID；标识符不赋予读取或修改权限。';
  }
}
async function verifyLookup(result,id,allowed){
  const valid=c=>{if(!c)throw new Error('memory_read_contract_changed');};
  valid(result&&Object.keys(result).every(k=>['source_id','memory','trust','read_only','coverage'].includes(k))&&
    result.source_id===sourceId&&result.trust==='untrusted-memory-data'&&result.read_only===true&&
    new TextEncoder().encode(JSON.stringify(result)).length<=1048576);
  const row=result.memory;
  valid(row&&row.id===id&&Object.hasOwn(labels,row.type)&&['agent','document_fragment'].includes(row.origin_kind)&&
    ['active','candidate','archived'].includes(row.status)&&Number.isSafeInteger(row.revision)&&row.revision>0&&
    typeof row.owned_by_caller==='boolean'&&['private','source'].includes(row.visibility)&&
    (row.owned_by_caller||(row.visibility==='source'&&row.status==='active'&&row.derivation_current===true))&&
    typeof row.derivation_current==='boolean'&&['low','normal','high'].includes(row.importance)&&
    (row.confidence===null||typeof row.confidence==='number'&&Number.isFinite(row.confidence)&&row.confidence>=0&&row.confidence<=1)&&
    (row.project_id==null||typeof row.project_id==='string'&&/^[A-Za-z0-9_-]{1,96}$/.test(row.project_id))&&
    typeof row.content==='string'&&row.content.isWellFormed()&&!row.content.includes('\0')&&
    row.content.trim()&&new TextEncoder().encode(row.content).length<=65536&&
    typeof row.provenance==='string'&&row.provenance.isWellFormed()&&new TextEncoder().encode(row.provenance).length<=2048&&
    typeof row.content_hash==='string'&&/^[a-f0-9]{64}$/.test(row.content_hash));
  allowed();const hash=await sha256Hex(new TextEncoder().encode(row.content));allowed();valid(hash===row.content_hash);
}
async function lookupMemory(){
  if(busy||pending){message('请先处理尚未确认的写入，再核对记录。',true);return;}
  const id=$('lookup-id').value,session=token,source=sourceId,epoch=++lookupEpoch;
  lookupController?.abort();const controller=new AbortController();lookupController=controller;
  current=null;nextOffset=null;$('results').replaceChildren();$('export').disabled=true;
  $('prev').disabled=true;$('next').disabled=true;$('lookup-submit').disabled=true;$('lookup-cancel').disabled=false;
  const allowed=()=>{
    if(!session||session!==token||source!==sourceId||view!=='lookup'||epoch!==lookupEpoch||controller.signal.aborted||$('lookup-id').value!==id)
      throw new Error('memory_lookup_changed');
  };
  try{
    allowed();if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id))throw new Error('full_memory_uuid_required');
    message('正在按 ID 读取当前可见版本；没有请求修改记忆。');
    const result=await api('memory_read',{memory_id:id},controller.signal);allowed();
    await verifyLookup(result,id,allowed);allowed();render({memories:[result.memory]});current=result;
    $('coverage').textContent='本次读取版本 r'+result.memory.revision+' · '+result.memory.status+' · 项目 '+(result.memory.project_id??'全局')+
      '。这是读取时的记录，不保证此后未改变；保存仍按版本检查，不自动覆盖。';
    message('记录已核对。编辑会填入本次读取版本，保存后回到待确认；共享或文件片段不能在这里修改。');
  }catch(error){
    if(epoch===lookupEpoch&&view==='lookup'&&session===token){
      current=null;$('results').replaceChildren();$('export').disabled=true;
      message('未能核对记录：'+error.message+'。记录不存在或当前不可见时，不显示缓存内容；未请求写入。',true);
    }
  }finally{
    if(epoch===lookupEpoch){lookupController=null;$('lookup-submit').disabled=false;$('lookup-cancel').disabled=current===null;}
  }
}
async function openMemoryLookup(id){
  if(busy||pending){message('请先处理尚未确认的写入，再核对记录。',true);return;}
  view='lookup';offset=0;$('lookup-id').value=id;await load();
  return lookupMemory();
}

// Task metadata never authorizes a memory read or certifies a model claim.
// Follow a source/candidate only after an explicit click and the existing exact-ID read.
const JOB_STATES=Object.freeze({queued:'等待整理',processing:'处理中',failed:'处理失败',completed:'已整理',stale:'已取消或来源失效'});
function jobSelection(){return JSON.stringify([$('job-state').value,$('job-id').value]);}
function jobListQuery(){
  const id=$('job-id').value,state=$('job-state').value;
  if(id){
    if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id))throw new Error('full_job_uuid_required');
    return {job_id:id}; // Exact reads intentionally disregard the list filter.
  }
  if(state!=='any'&&!Object.hasOwn(JOB_STATES,state))throw new Error('invalid_job_state');
  if(!Number.isSafeInteger(offset)||offset<0||offset>1000000)throw new Error('invalid_job_page');
  return {state,limit:20,offset};
}
function invalidateJobPage(clearInputs=false){
  jobReadController?.abort();jobReadController=null;
  if(clearInputs){$('job-id').value='';$('job-state').value='any';}
  if(view==='jobs'){
    loadVersion++;current=null;nextOffset=null;$('results').replaceChildren();
    $('export').disabled=true;$('prev').disabled=true;$('next').disabled=true;
    $('coverage').textContent='尚无本次任务读取结果。输入 ID 不会自动发送查询。';
  }
}
function validateJobPage(result,input,source){
  const valid=c=>{if(!c)throw new Error('job_page_unconfirmed');};
  const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
  const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
  const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
  const count=v=>Number.isSafeInteger(v)&&v>=0;
  const date=canonicalDocumentTimestamp;
  const keys=['job_id','input_id','input_revision','state','attempts','retryable','error','lease_until','result','created_at','updated_at','assurance'];
  const limit=input.job_id?1:(input.limit??20),offset=input.offset??0;
  valid(object(result)&&Object.keys(result).every(k=>['source_id','jobs','next_offset'].includes(k))&&
    result.source_id===source&&Array.isArray(result.jobs)&&result.jobs.length<=limit&&
    new TextEncoder().encode(JSON.stringify(result)).length<=1048576);
  if(input.job_id)valid(result.jobs.length===1);
  const next=!input.job_id&&result.jobs.length===limit&&offset+result.jobs.length<=1000000?offset+result.jobs.length:null;
  valid(result.next_offset===next);
  const seen=new Set();let latest=Infinity;
  for(const row of result.jobs){
    valid(object(row)&&Object.keys(row).every(k=>keys.includes(k))&&keys.every(k=>Object.hasOwn(row,k))&&
      uuid(row.job_id)&&!seen.has(row.job_id)&&uuid(row.input_id)&&
      Number.isSafeInteger(row.input_revision)&&row.input_revision>=1&&row.input_revision<=2147483647&&
      Object.hasOwn(JOB_STATES,row.state)&&count(row.attempts)&&row.attempts<=3&&
      row.retryable===(row.attempts<3&&['failed','processing'].includes(row.state))&&
      (row.error===null||typeof row.error==='string'&&/^[a-z_]{1,96}$/.test(row.error))&&
      date(row.created_at)&&date(row.updated_at)&&Date.parse(row.updated_at)>=Date.parse(row.created_at)&&
      (row.lease_until===null||date(row.lease_until))&&typeof row.assurance==='string'&&row.assurance.length<=2048);
    valid(row.state==='processing'?row.lease_until!==null:row.lease_until===null);
    valid(!input.job_id||row.job_id===input.job_id);
    valid(!input.state||input.state==='any'||row.state===input.state);
    const created=Date.parse(row.created_at);valid(created<=latest);latest=created;seen.add(row.job_id);
    if(row.state!=='completed'){valid(row.result===null);continue;}
    const r=row.result;
    valid(row.attempts>=1&&object(r)&&Object.keys(r).every(k=>['entries','gateway_invocations','usage','profile_hash','input_hash','review_required','source_retained','truth_verified'].includes(k))&&
      Array.isArray(r.entries)&&r.entries.length<=16&&r.gateway_invocations===1&&digest(r.profile_hash)&&digest(r.input_hash)&&
      r.review_required===true&&r.source_retained===true&&r.truth_verified===false&&object(r.usage)&&
      Object.keys(r.usage).every(k=>['input_tokens','output_tokens'].includes(k)));
    for(const k of ['input_tokens','output_tokens'])valid(r.usage[k]===null||count(r.usage[k]));
    const ids=new Set();
    for(const e of r.entries){
      valid(object(e)&&Object.keys(e).every(k=>['id','revision','status','exact_duplicate_hints'].includes(k))&&
        uuid(e.id)&&!ids.has(e.id)&&e.revision===1&&e.status==='candidate'&&Array.isArray(e.exact_duplicate_hints)&&
        e.exact_duplicate_hints.length<=3&&e.exact_duplicate_hints.every(uuid)&&new Set(e.exact_duplicate_hints).size===e.exact_duplicate_hints.length);
      ids.add(e.id);
    }
  }
  return result;
}
function renderJobs(result){
  const input=jobListQuery(),session=token,source=sourceId,selection=jobSelection(),generation=loadVersion;
  const allowed=()=>!!session&&token===session&&sourceId===source&&view==='jobs'&&generation===loadVersion&&
    current===result&&jobSelection()===selection&&!pending&&!busy;
  const action=(name,fn,{write=false,prompt}={})=>{
    const b=element('button',name);b.dataset[write?'write':'read']='true';
    b.addEventListener('click',()=>{
      if(!allowed()){message('任务视图已改变或有未确认提交，请重新核对后操作。',true);return;}
      if(prompt&&!confirm(prompt))return;
      if(!allowed()){message('任务选择已改变，未发送操作。',true);return;}
      return fn();
    });return b;
  };
  current=result;$('results').replaceChildren();
  if(!result.jobs.length)$('results').append(element('p','当前筛选窗口没有任务，不代表整个任务库为空。','note'));
  for(const row of result.jobs){
    const card=element('article');card.dataset.jobId=row.job_id;
    card.append(element('strong','状态：'+row.state+' · '+JOB_STATES[row.state]),
      element('p','任务 ID：'+row.job_id,'meta'),element('p','原文记录：'+row.input_id+' · 排队时 r'+row.input_revision,'meta'),
      element('p','尝试次数：'+row.attempts+' / 3 · 错误：'+(row.error??'无'),'meta'),
      element('p','创建：'+row.created_at+' · 更新：'+row.updated_at,'meta'));
    if(row.lease_until)card.append(element('p','租约期限：'+row.lease_until+'。是否允许恢复以服务器时间与租约为准，不以此页面时钟判断。','note'));
    card.append(action('核对原文记录',()=>openMemoryLookup(row.input_id)));
    if(row.result){
      card.append(element('p','当时生成 '+row.result.entries.length+' 条候选；结果不是事实认证，也不保证这些记录现在仍为候选。','note'));
      for(const [i,e]of row.result.entries.entries()){
        card.append(action('核对候选 #'+(i+1),()=>openMemoryLookup(e.id)));
        if(e.exact_duplicate_hints.length)card.append(element('p','该候选有 '+e.exact_duplicate_hints.length+' 条精确重复提示；没有自动合并或覆盖。','note'));
      }
    }
    if(['queued','failed','processing'].includes(row.state)){
      if(row.attempts<3)card.append(action(row.state==='queued'?'整理此条（调用模型）':'恢复／重试（可能再次计费）',
        ()=>mutate('consolidate',{expected_source:sourceId,job_id:row.job_id,limit:1,allow_model_call:true,retry:row.state!=='queued'}),
        {write:true,prompt:'只处理这一个任务。原文将发送给服务器已配置的个人整理模型，可能产生费用；失败或中断恢复可能再次计费。继续？'}));
      card.append(action('取消整理，保留原文',()=>mutate('cancel_job',{job_id:row.job_id}),
        {write:true,prompt:'取消只阻止这一个未完成任务的结果提交，保留原文；不能撤销已经发出的模型请求或费用。继续？'}));
    }
    $('results').append(card);
  }
  nextOffset=result.next_offset;$('prev').disabled=!!input.job_id||offset===0;$('next').disabled=nextOffset===null;$('export').disabled=false;
  $('coverage').textContent=(input.job_id?'按 ID 核对，不受列表状态筛选影响。':'当前状态筛选下的有限实时页，每页最多20条，不是完整快照。')+
    ' 当前只展示任务元数据；原文和候选必须另行点击核对，读取的是当时的当前版本。取消不是删除或撤销费用。';
  controls();
}

function render(result){
  if(view==='jobs')return renderJobs(validateJobPage(result,jobListQuery(),sourceId));
  current=result;$('results').replaceChildren();
  const rows=view==='agents'?result.agents:result.memories;
  if(!rows?.length)$('results').append(element('p',view==='recall'?'本次有限召回窗口为空，不代表记忆库为空或模型应当弃答。':'这个窗口没有可见记录。新建记忆默认在“待确认”中。','note'));
  for(const row of rows??[]){
    const card=element('article');
    if(view==='agents'){
      card.append(element('strong',row.agent_id),element('p',row.agent_type+' · r'+row.revision,'meta'),element('p',(row.capabilities??[]).join(' / ')||'未声明能力','meta'),element('p','名称和能力是客户端自述，不是软件身份认证。','note'));
    }else{
      if(view==='recall'){
        card.append(element('strong','召回顺序 #'+(result.memories.indexOf(row)+1)));
        const inspect=element('button','核对最新记录');inspect.dataset.read='true';
        inspect.addEventListener('click',()=>openMemoryLookup(row.id));card.append(inspect);
      }
      if(view==='lookup')card.append(element('strong','当前状态：'+row.status));
      card.append(element('p','记忆 ID：'+row.id+(['recall','lookup'].includes(view)?' · 内容 SHA-256：'+row.content_hash:''),'meta'));
      card.append(element('span',labels[row.type]??row.type,'badge'),element('span',row.owned_by_caller?'自己拥有':'同源共享','badge'),element('p',row.content,'memory-content'));
      card.append(element('p','r'+row.revision+' · '+(row.project_id??'全局')+' · '+row.visibility+' · 可信度估计：'+(row.confidence??'未知'),'meta'),element('p','来源：'+row.provenance,'meta'));
      if(row.derivation)card.append(element('p','原文引用：'+row.derivation.quote,'memory-content'),element('p',row.derivation_current?'来源版本仍匹配；引用不代表真实性证明。':'来源已修改或归档；重新核对前不能激活。','note'));
      if(view!=='recall'&&row.owned_by_caller&&row.origin_kind!=='document_fragment'){
        const actions=element('div',undefined,'row card-actions');
        for(const [name,handler]of [['编辑',()=>edit(row)],...(row.status!=='active'?[['确认启用',()=>{if(confirm('确认启用这条记忆？这表示你认可本次内容，不是系统已证明其真实性。'))mutate('review',{memory_id:row.id,expected_revision:row.revision,status:'active'});}]]:[]),...(row.status!=='archived'?[['归档',()=>{if(confirm('归档后不再用于当前上下文。原始内容仍保留，不会物理擦除。'))mutate('review',{memory_id:row.id,expected_revision:row.revision,status:'archived'});}]]:[])]){const b=element('button',name);b.dataset.write='true';b.addEventListener('click',handler);actions.append(b);}card.append(actions);
      }
    }$('results').append(card);
  }
  nextOffset=Number.isInteger(result.next_offset)?result.next_offset:null;
  $('prev').disabled=offset===0||['profile','recall','lookup'].includes(view);$('next').disabled=nextOffset===null||['profile','recall','lookup'].includes(view);$('export').disabled=false;
  $('coverage').textContent='当前源和身份下的有限窗口；可能随并发修改变化。'+(result.dropped?'有 '+result.dropped+' 条因大小或数量限制未展示。':'')+(view==='profile'?'这里只展示已启用的全局身份、偏好、环境和目标。':'');
  controls();
}
async function load(){
  const session=token,source=sourceId,selectedView=view,selectedOffset=offset,selectedStatus=$('document-status').value,selectedJobs=jobSelection();
  const activePage=()=>!!session&&token===session&&sourceId===source&&view===selectedView&&offset===selectedOffset&&
    (selectedView!=='documents'||$('document-status').value===selectedStatus)&&
    (selectedView!=='jobs'||jobSelection()===selectedJobs);
  jobReadController?.abort();jobReadController=null;
  nextOffset=null;$('prev').disabled=true;$('next').disabled=true;
  const request=++loadVersion;invalidateRecall();invalidateLookup();invalidateComparison();controls();current=null;$('results').replaceChildren();$('export').disabled=true;for(const b of document.querySelectorAll('[data-view]'))b.setAttribute('aria-current',b.dataset.view===view?'page':'false');
  $('job-panel').hidden=view!=='jobs';
  $('view-title').textContent=views[view];$('search-form').hidden=['profile','recall','lookup','agents','documents','jobs'].includes(view);
  documentEpoch++;invalidateDocumentRead();$('document-panel').hidden=view!=='documents';
  $('workspace').dataset.preview=String(view==='recall');
  $('recall-panel').hidden=view!=='recall';$('lookup-panel').hidden=view!=='lookup';$('memory-panel').hidden=view==='recall';
  if(['recall','lookup'].includes(view))return; // Navigation/refresh never starts these explicit reads.
  try{
    if(view==='jobs'){
      const input=jobListQuery(),controller=new AbortController();jobReadController=controller;
      $('coverage').textContent='正在核对整理任务元数据；不会读取原文或调用模型。';
      try{
        const data=await api('jobs',input,controller.signal);
        if(request===loadVersion&&activePage()&&!controller.signal.aborted)renderJobs(validateJobPage(data,input,source));
      }finally{if(jobReadController===controller)jobReadController=null;}
    }else if(view==='documents'){
      const input=documentListQuery();
      $('coverage').textContent='正在核对文档列表；未读取任何原文。';
      const data=await api('document_list',input);
      if(request===loadVersion&&activePage())renderDocuments(validateDocumentPage(data,input,source));
    }else{
      const data=await api(view==='jobs'?'jobs':view==='agents'?'agents':view==='profile'?'profile':'search',['agents','jobs'].includes(view)?{limit:20,offset}:view==='profile'?{limit:50,budget_bytes:131072}:{status:view,query:$('query').value,limit:20,offset,budget_bytes:131072});
      if(request===loadVersion&&activePage())render(data);
    }
  }
  catch(e){if(request===loadVersion&&activePage()){
    if(selectedView==='jobs')$('coverage').textContent='本次任务列表未确认，不代表没有任务。请重新读取。';
    if(selectedView==='documents')$('coverage').textContent='本次文档列表未确认，不代表没有文档。请重新读取。';
    message('读取失败：'+e.message,true);
  }}
}
$('login-form').addEventListener('submit',async e=>{e.preventDefault();token=$('token').value.trim();$('token').value='';try{const info=await api('info');sourceId=info.source_id;$('scope').textContent='数据源：'+info.source_id+' · Linux 本机所有者（与同账号 stdio 共享）';$('login').hidden=true;$('workspace').hidden=false;$('logout').hidden=false;message('已连接。');await load();}catch(e){token='';message('连接失败：'+e.message,true);}});
$('logout').addEventListener('click',()=>{if(pending||busy)return;invalidateJobPage(true);invalidateRecall(true);invalidateLookup(true);invalidateComparison();draftConfidence=null;token='';sourceId='';documentEpoch++;invalidateDocumentRead();$('document-file').value='';$('document-consent').checked=false;loadVersion++;current=null;editing=null;$('content').value='';$('results').replaceChildren();$('workspace').hidden=true;$('login').hidden=false;$('logout').hidden=true;message('管理台已锁定。');});
for(const b of document.querySelectorAll('[data-view]'))b.addEventListener('click',()=>{view=b.dataset.view;offset=0;load();});
$('refresh').addEventListener('click',()=>load());$('search-form').addEventListener('submit',e=>{e.preventDefault();offset=0;load();});
$('prev').addEventListener('click',()=>{offset=Math.max(0,offset-20);load();});$('next').addEventListener('click',()=>{if(nextOffset!==null){offset=nextOffset;load();}});
$('export').addEventListener('click',()=>{if(current)download({format:1,exported_at:new Date().toISOString(),scope:view==='recall'?'local-owner recall preview only; task text omitted; not a full backup':'visible page only, not a full backup',complete:false,view,result:current},'ultrabrain-personal-page.json');});
$('cancel-edit').addEventListener('click',()=>{resetEditor();controls();});
$('queue-personal').addEventListener('click',()=>{if(editing||busy||pending)return;if(!$('consent').checked){message('排队前必须明确同意保存原文。',true);return;}if(!$('content').value.trim()){message('请填写要整理的原文。',true);return;}mutate('capture',{agent_id:'personal-console',transcript:$('content').value,project_id:$('project').value||null,consent:true},memoryAuthorization());});
$('document-file').addEventListener('change',()=>{
  $('document-consent').checked=false;
  const file=$('document-file').files?.[0];
  $('document-file-info').textContent=file?(file.name+' · '+formatSize(file.size)+(file.size>131072?' · 超过 128 KiB 上限，将被整体拒绝':'')):'尚未选择文件。';
});
$('document-import').addEventListener('click',importSelectedDocument);
$('job-form').addEventListener('submit',e=>{e.preventDefault();offset=0;return load();});
$('job-state').addEventListener('change',()=>{offset=0;return load();});
$('job-id').addEventListener('input',()=>invalidateJobPage());
$('job-clear').addEventListener('click',()=>{invalidateJobPage();message('任务结果已清除；没有取消服务器任务，也没有删除原文。');});
$('document-status').addEventListener('change',()=>{offset=0;return load();});
$('document-read-cancel').addEventListener('click',()=>{invalidateDocumentRead();message('本地原文已清除，尚未完成的读取不会展示或下载。已发送的只读查询无法撤回；没有删除服务器文档。');});
$('memory-form').addEventListener('submit',e=>{
  e.preventDefault();if(!$('consent').checked){message('保存前必须明确同意采集。',true);return;}
  const memory=memoryDraft();
  if(memory.visibility==='source'&&!confirm('激活后，同一数据源其他身份可读取这条内容。确认选择共享？'))return;
  if(editing)mutate('update',{memory_id:editing.id,expected_revision:editing.revision,event_id:crypto.randomUUID(),memory},memoryAuthorization());
  else mutate('commit',{agent_id:'personal-console',consent:true,memories:[memory]},memoryAuthorization());
});
$('compare-current').addEventListener('click',compareCurrentMemory);
$('comparison-adopt').addEventListener('click',adoptComparedVersion);
$('comparison-consent').addEventListener('change',controls);
$('comparison-cancel').addEventListener('click',()=>{invalidateComparison();controls();message('对照已清除，原编辑基准与草稿仍保留；已发送的只读查询不能撤回。');});
for(const event of ['input','change'])$('memory-form').addEventListener(event,()=>{invalidateComparison();controls();});
$('lookup-form').addEventListener('submit',e=>{e.preventDefault();return lookupMemory();});
$('lookup-id').addEventListener('input',()=>invalidateLookup());
$('lookup-cancel').addEventListener('click',()=>{invalidateLookup();message('本地核对结果已清除；没有删除记录或撤回已发送的查询。');});
$('recall-form').addEventListener('submit',e=>{e.preventDefault();return previewRecall();});
for(const id of ['recall-task','recall-project','recall-limit','recall-budget'])$(id).addEventListener('input',()=>invalidateRecall());
$('recall-consent').addEventListener('change',()=>{if(!$('recall-consent').checked)invalidateRecall();});
$('recall-cancel').addEventListener('click',()=>{invalidateRecall();message('预览已取消，结果不会继续显示。已发送的查询无法撤回；未请求记忆写入或模型调用。');});
$('retry').addEventListener('click',()=>{
  if(pending?.operation==='consolidate'&&!confirm('这不是幂等事件重放：再次尝试可能调用模型并再次计费。请先核对任务状态；确认仍要重试原任务？'))return;
  return submitPending();
});$('save-pending').addEventListener('click',()=>{if(pending)download({format:1,warning:'Contains consented memory text; protect this local file. The request is not confirmed.',...pending},'ultrabrain-unconfirmed-request.json');});
window.addEventListener('beforeunload',e=>{if(pending){e.preventDefault();e.returnValue='';}});
