/* Explicit local snapshot inspection. File bytes never enter api()/fetch or browser storage. */
'use strict';
let inspectorEpoch=0,inspectorWorking=false,inspectorData=null,inspectorReport=null,inspectorOffset=0;
const inspectorKinds={left_only:'仅左侧存在',right_only:'仅右侧存在',changed:'字段不同'};
function clearInspectorDetails(){
  $('inspector-details').hidden=true;$('inspector-detail-left').textContent='';$('inspector-detail-right').textContent='';
}
function clearInspectorComparison(){
  inspectorReport=null;inspectorOffset=0;$('inspector-differences').replaceChildren();clearInspectorDetails();
  $('inspector-diff-summary').textContent='';$('inspector-prev').disabled=true;$('inspector-next').disabled=true;$('inspector-export').disabled=true;
}
function inspectorControls(){
  $('inspector-run').disabled=busy||!!pending||inspectorWorking||!$('inspector-consent').checked;
  $('inspector-compare').disabled=busy||!!pending||inspectorWorking||!inspectorData?.right||!$('inspector-compare-consent').checked;
}
function invalidateInspector(close=false){
  inspectorEpoch++;inspectorWorking=false;inspectorData=null;
  clearInspectorComparison();$('inspector-summary').textContent='';$('inspector-consent').checked=false;$('inspector-compare-consent').checked=false;
  if(close){$('inspector-panel').hidden=true;$('inspector-left').value='';$('inspector-right').value='';}
  inspectorControls();
}
function requireInspectorData(){
  if(!inspectorData)throw new Error('snapshot_inspection_changed');
  inspectorData.allowed();return inspectorData;
}
async function inspectSelectedSnapshots(){
  if(inspectorWorking||busy||pending)return;
  const session=token,source=sourceId,navigation=loadVersion,selectedView=view;
  const left=$('inspector-left').files?.[0],right=$('inspector-right').files?.[0],epoch=++inspectorEpoch;
  inspectorData=null;clearInspectorComparison();$('inspector-summary').textContent='';$('inspector-compare-consent').checked=false;
  const current=()=>epoch===inspectorEpoch&&!!session&&token===session&&sourceId===source&&
    loadVersion===navigation&&view===selectedView&&!$('workspace').hidden&&!$('inspector-panel').hidden;
  const allowed=()=>{
    if(!current()||busy||pending||!$('inspector-consent').checked||$('inspector-left').files?.[0]!==left||
      $('inspector-right').files?.[0]!==right)throw new Error('snapshot_inspection_changed');
  };
  inspectorWorking=true;inspectorControls();
  try{
    allowed();if(!left)throw new Error('snapshot_file_required');
    message('正在本机核验所选文件；文件内容不上传，不读取当前数据库。');
    const contract=await loadSnapshotContract();allowed();
    const read=async file=>{
      if(!Number.isSafeInteger(file.size)||file.size<1||file.size>contract.SNAPSHOT_FILE_MAX_BYTES)throw new Error('snapshot_file_size');
      const buffer=await file.arrayBuffer();allowed();
      if(buffer.byteLength!==file.size)throw new Error('snapshot_file_size');
      return contract.inspectMemorySnapshotFile(new Uint8Array(buffer),text=>sha256Hex(new TextEncoder().encode(text)),allowed);
    };
    const a=await read(left);allowed();const b=right?await read(right):null;allowed();
    inspectorData={left:a,right:b,contract,allowed};
    const summary=(name,data)=>name+'：'+data.snapshot.record_count+' 条 · 文件自述来源 '+data.snapshot.source_id+
      ' · 快照时间 '+data.snapshot.snapshot_at+'\n文件 SHA-256：'+data.file_sha256;
    $('inspector-summary').textContent=summary('左侧',a)+(b?'\n\n'+summary('右侧',b):'');
    message('所选文件内部一致性核验通过，内容未上传。未验证签名、导出主体或数据库当前状态；正文尚未展示。');
  }catch(error){
    if(current()){
      inspectorData=null;clearInspectorComparison();$('inspector-summary').textContent='';
      const safe=new Set(['snapshot_file_required','snapshot_file_size','snapshot_file_invalid_utf8','snapshot_file_invalid_json',
        'snapshot_file_duplicate_key','snapshot_file_too_deep','memory_snapshot_unconfirmed','snapshot_inspection_changed']);
      message('本地快照核验未完成：'+(safe.has(error.message)?error.message:'snapshot_file_read_failed')+'。没有上传、恢复或写入记忆。',true);
    }
  }finally{if(epoch===inspectorEpoch){inspectorWorking=false;inspectorControls();}}
}
function renderInspectorDifferences(){
  const data=requireInspectorData(),report=inspectorReport;
  if(!report||!$('inspector-compare-consent').checked)throw new Error('snapshot_comparison_consent_required');
  clearInspectorDetails();$('inspector-differences').replaceChildren();
  const selectedReport=report;
  for(const difference of report.differences.slice(inspectorOffset,inspectorOffset+20)){
    const card=element('article');
    card.append(element('strong',inspectorKinds[difference.kind]),element('p','记忆 ID：'+difference.id,'meta'),
      element('p',difference.fields.length?'不同字段：'+difference.fields.join('、'):'不推断新增、删除或归属变更。','meta'));
    const show=element('button','查看所选条目的两侧内容');
    show.addEventListener('click',()=>{
      try{
        if(requireInspectorData()!==data||inspectorReport!==selectedReport||!$('inspector-compare-consent').checked)
          throw new Error('snapshot_inspection_changed');
        const a=data.left.snapshot.memories.find(r=>r.id===difference.id),b=data.right.snapshot.memories.find(r=>r.id===difference.id);
        $('inspector-detail-left').textContent=a?JSON.stringify(a,null,2):'左侧文件中无此条目。';
        $('inspector-detail-right').textContent=b?JSON.stringify(b,null,2):'右侧文件中无此条目。';
        $('inspector-details').hidden=false;
      }catch{invalidateInspector();message('选择或授权已改变，未展示文件正文。',true);}
    });
    card.append(show);$('inspector-differences').append(card);
  }
  const n=report.counts;
  $('inspector-diff-summary').textContent='仅左侧 '+n.left_only+' · 仅右侧 '+n.right_only+' · 字段不同 '+n.changed+' · 完全相同 '+n.unchanged+
    '。本页 '+Math.min(20,Math.max(0,report.differences.length-inspectorOffset))+' 条差异；仅比较文件，不查询当前数据库。';
  $('inspector-prev').disabled=inspectorOffset===0;$('inspector-next').disabled=inspectorOffset+20>=report.differences.length;
  $('inspector-export').disabled=false;
}
$('inspector-open').addEventListener('click',()=>{
  if(!token||$('workspace').hidden||busy||pending){message('请先连接管理台并处理未确认写入。',true);return;}
  invalidateSnapshot();invalidateInspector(true);$('inspector-panel').hidden=false;
});
$('inspector-run').addEventListener('click',inspectSelectedSnapshots);
for(const id of ['inspector-left','inspector-right'])$(id).addEventListener('change',()=>invalidateInspector());
$('inspector-consent').addEventListener('change',()=>{if(!$('inspector-consent').checked)invalidateInspector();inspectorControls();});
$('inspector-compare-consent').addEventListener('change',()=>{if(!$('inspector-compare-consent').checked)clearInspectorComparison();inspectorControls();});
$('inspector-cancel').addEventListener('click',()=>{invalidateInspector(true);message('本地核验内容已清除。没有删除文件、取消服务器任务或修改记忆。');});
$('inspector-detail-clear').addEventListener('click',clearInspectorDetails);
$('inspector-compare').addEventListener('click',()=>{
  try{
    const data=requireInspectorData();if(!$('inspector-compare-consent').checked)throw new Error('snapshot_comparison_consent_required');
    clearInspectorComparison();inspectorReport=data.contract.compareMemorySnapshots(data.left,data.right);renderInspectorDifferences();
  }catch(error){
    clearInspectorComparison();message(error.message==='snapshot_source_mismatch'?'两个文件自述来源不同，拒绝对照。':'选择或授权已改变，未执行对照。',true);
  }
});
for(const [id,delta]of [['inspector-prev',-20],['inspector-next',20]])$(id).addEventListener('click',()=>{
  try{
    requireInspectorData();const next=inspectorOffset+delta;
    if(!inspectorReport||next<0||next>=inspectorReport.differences.length)return;
    inspectorOffset=next;renderInspectorDifferences();
  }catch{invalidateInspector();}
});
$('inspector-export').addEventListener('click',()=>{
  try{
    requireInspectorData();if(!inspectorReport||!$('inspector-compare-consent').checked)throw new Error('snapshot_inspection_changed');
    download(inspectorReport,'ultrabrain-snapshot-comparison.json');
    message('已发起差异清单下载：包含私有 ID、字段名和指纹，不包含记忆正文；不是恢复计划。');
  }catch{invalidateInspector();message('授权已改变，未导出差异。',true);}
});
const inspectorObserver=new MutationObserver(records=>{
  if(records.some(r=>r.target===$('view-title')||r.target===$('workspace'))||busy||pending)invalidateInspector(true);
});
inspectorObserver.observe($('view-title'),{childList:true});
inspectorObserver.observe($('workspace'),{attributes:true,attributeFilter:['hidden']});
inspectorObserver.observe($('logout'),{attributes:true,attributeFilter:['disabled']});
document.addEventListener('submit',()=>invalidateInspector(true),true);
document.addEventListener('click',event=>{
  if(event.target?.closest?.('[data-view],#refresh,#logout,#prev,#next,[data-write],#save,#retry,#snapshot-open'))invalidateInspector(true);
},true);
