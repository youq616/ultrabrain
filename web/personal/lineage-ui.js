/* Explicit current-record -> referenced-source inspection; never edit or call a model. */
'use strict';
let lineageEpoch=0,lineageController=null,lineageData=null,lineageWorking=false,lineageContractPromise=null;
function loadLineageContract(){return lineageContractPromise??=import('/lineage-contract.mjs').catch(e=>{lineageContractPromise=null;throw e;});}
function clearLineageResult(){
  lineageData=null;$('lineage-result').hidden=true;$('lineage-original').hidden=true;
  for(const id of ['lineage-status','lineage-memory','lineage-quote','lineage-metadata','lineage-original-text'])$(id).textContent='';
  $('lineage-status').dataset.state='';
  for(const id of ['lineage-show-source','lineage-open-source','lineage-open-memory'])$(id).disabled=true;
}
function lineageControls(){
  $('lineage-run').disabled=lineageWorking||busy||!!pending||!$('lineage-consent').checked;
}
function invalidateLineage(close=false){
  lineageEpoch++;lineageController?.abort();lineageController=null;lineageWorking=false;clearLineageResult();
  $('lineage-consent').checked=false;
  if(close){$('lineage-panel').hidden=true;$('lineage-id').value='';}
  lineageControls();
}
function requireLineage(){
  if(!lineageData)throw new Error('lineage_changed');
  lineageData.allowed();return lineageData;
}
function renderLineage(data){
  data.allowed();lineageData=data;
  const {memory,original,reference,verdict}=data;
  const explanations={matched:'本次读取的来源版本、内容指纹和指定位置引文均匹配；不是事实真实性证明。',
    changed:'来源版本或内容已变化。历史引用仍保留，不应把当前原文当成生成时的原文。',
    archived:'来源已归档。即使引文仍在，也不代表派生记忆仍可用于当前上下文。',
    quote_mismatch:'版本和指纹匹配，但指定位置的引文不匹配；来源证据未通过核对。',
    inconsistent:'来源观察与服务端派生有效性标志不一致；请重新读取，不确认有效。',
    unavailable:'来源记录不存在或当前身份不可见；没有取得原文，也不能推断其被删除。',
    unlinked:'这条记录没有结构化整理引用。来源说明是自述，不等于独立证据。',
    withheld:'当前身份未取得结构化来源引用；不推断这条共享记忆没有来源。'};
  $('lineage-status').textContent=explanations[verdict.state];$('lineage-status').dataset.state=verdict.state;
  $('lineage-memory').textContent=memory.content;
  $('lineage-quote').textContent=reference?.quote??'未取得结构化引文。';
  let text='记忆 '+memory.id+' · r'+memory.revision+' · '+memory.status;
  if(reference)text+='\n引用来源 '+reference.input_id+' · 生成时 r'+reference.input_revision+
    '\n原任务 '+reference.job_id+' · 引文区间 ['+reference.start+', '+reference.end+') UTF-16 code units'+
    '\n生成时原文 SHA-256：'+reference.input_hash;
  if(original)text+='\n本次来源 r'+original.revision+' · '+original.status+' · SHA-256：'+original.content_hash+
    '\n版本匹配：'+verdict.revision_matches+' · 指纹匹配：'+verdict.content_matches+' · 指定位置引文匹配：'+verdict.quote_matches;
  $('lineage-metadata').textContent=text;$('lineage-result').hidden=false;
  $('lineage-open-memory').disabled=false;$('lineage-show-source').disabled=!original;$('lineage-open-source').disabled=!original;
}
async function inspectLineage(){
  if(lineageWorking||busy||pending)return;
  lineageController?.abort();clearLineageResult();
  const epoch=++lineageEpoch,session=token,source=sourceId,navigation=loadVersion,selectedView=view,id=$('lineage-id').value;
  const controller=new AbortController();lineageController=controller;lineageWorking=true;lineageControls();
  const current=()=>epoch===lineageEpoch&&!!session&&token===session&&sourceId===source&&navigation===loadVersion&&view===selectedView&&
    !$('workspace').hidden&&!$('lineage-panel').hidden;
  const allowed=()=>{if(!current()||controller.signal.aborted||busy||pending||!$('lineage-consent').checked||$('lineage-id').value!==id)
    throw new Error('lineage_changed');};
  try{
    allowed();if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id))throw new Error('full_memory_uuid_required');
    const contract=await loadLineageContract();allowed();
    const read=async memoryId=>{
      allowed();const r=await api('memory_read',{memory_id:memoryId},controller.signal);allowed();
      await verifyLookup(r,memoryId,allowed);allowed();return r.memory;
    };
    message('正在核对记忆及其直接引用来源；仅发送记录 ID，不发送草稿或调用模型。');
    const memory=await read(id),reference=contract.lineageReference(memory);
    let original=null,verdict;
    if(reference){
      try{original=await read(reference.input_id);}
      catch(error){allowed();if(error.message!=='not_found')throw error;}
      // Do not present the first row's reference as if it survived a concurrent edit.
      const final=await read(id);allowed();
      if(!contract.sameLineageRecord(memory,final))throw new Error('lineage_selected_changed');
      verdict=original?contract.compareLineage(memory,original):{state:'unavailable',truth_verified:false};
    }else verdict={state:memory.owned_by_caller?'unlinked':'withheld',truth_verified:false};
    allowed();renderLineage({memory,original,reference,verdict,allowed});
    message('来源核对已返回；这是分别读取时的观察，不是原子快照或实时状态。没有修改记忆。');
  }catch(error){
    if(current()){
      clearLineageResult();
      const safe=new Set(['full_memory_uuid_required','lineage_changed','lineage_selected_changed','lineage_reference_invalid',
        'lineage_source_invalid','not_found','memory_read_contract_changed','network_unconfirmed','response_unconfirmed']);
      message('来源核对未完成：'+(safe.has(error.message)?error.message:'lineage_read_unconfirmed')+
        '。没有展示旧缓存或修改记忆；请核对后重新读取。',true);
    }
  }finally{if(epoch===lineageEpoch){lineageController=null;lineageWorking=false;lineageControls();}}
}
$('lineage-open').addEventListener('click',()=>{
  if(!token||$('workspace').hidden||busy||pending){message('请先连接管理台并处理未确认写入。',true);return;}
  invalidateLineage(true);$('lineage-panel').hidden=false;
  // Prefill only a current exact-read selector. Never follow a cached reference here.
  if(view==='lookup'&&current?.source_id===sourceId&&current.memory)$('lineage-id').value=current.memory.id;
  $('lineage-id').focus();
});
$('lineage-run').addEventListener('click',inspectLineage);
$('lineage-id').addEventListener('input',()=>invalidateLineage());
$('lineage-id').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();inspectLineage();}});
$('lineage-consent').addEventListener('change',()=>{if(!$('lineage-consent').checked)invalidateLineage();lineageControls();});
$('lineage-close').addEventListener('click',()=>{invalidateLineage(true);message('来源核对已清除；已经发出的只读查询无法撤回，没有删除原文。');});
$('lineage-clear-source').addEventListener('click',()=>{$('lineage-original').hidden=true;$('lineage-original-text').textContent='';});
$('lineage-show-source').addEventListener('click',()=>{
  try{const d=requireLineage();if(!d.original)throw new Error('lineage_changed');
    $('lineage-original-text').textContent=d.original.content;$('lineage-original').hidden=false;
  }catch{invalidateLineage();message('选择或授权已改变，未展示原文。',true);}
});
for(const [button,key]of [['lineage-open-memory','memory'],['lineage-open-source','original']])$(button).addEventListener('click',()=>{
  try{const d=requireLineage();if(!d[key])throw new Error('lineage_changed');const id=d[key].id;
    invalidateLineage(true);return openMemoryLookup(id); // Fresh read; existing editor/CAS rules remain separate.
  }catch{invalidateLineage();message('选择或授权已改变，未跳转或修改记录。',true);}
});
const lineageObserver=new MutationObserver(records=>{
  if(records.some(r=>r.target===$('view-title')||r.target===$('workspace'))||busy||pending)invalidateLineage(true);
});
lineageObserver.observe($('view-title'),{childList:true});
lineageObserver.observe($('workspace'),{attributes:true,attributeFilter:['hidden']});
lineageObserver.observe($('logout'),{attributes:true,attributeFilter:['disabled']});
document.addEventListener('submit',()=>invalidateLineage(true),true);
// Opening a nested snapshot workspace does not change view/loadVersion. Revoke
// here, before its own click handler, including already verified-file browsing.
document.addEventListener('click',event=>{
  if(event.target?.closest?.('[data-view],#refresh,#logout,#prev,#next,[data-write],#save,#retry,#snapshot-open,#inspector-open,#explorer-open'))invalidateLineage(true);
},true);
