/* Explicit review of one verified local snapshot. Never merges or writes records. */
'use strict';
let duplicateEpoch=0,duplicateWorking=false,duplicateReport=null,duplicateBinding=null;
let duplicateGroupOffset=0,duplicateMemberOffset=0,duplicateGroup=null,duplicatePage=0,duplicateGroupPage=0;
let duplicateA=null,duplicateB=null;
const duplicateLabels={candidate:'待确认',active:'已启用',archived:'已归档',agent:'Agent记录',document_fragment:'文档片段',private:'私有',source:'同源共享'};
function clearDuplicateDetails(){
 $('duplicates-detail').hidden=true;$('duplicates-detail-a').textContent='';$('duplicates-detail-b').textContent='';
 $('duplicates-detail-consent').checked=false;$('duplicates-compare').disabled=true;
}
function clearDuplicateMembers(){
 duplicatePage++;duplicateGroup=null;duplicateMemberOffset=0;duplicateA=null;duplicateB=null;clearDuplicateDetails();
 $('duplicates-members').replaceChildren();$('duplicates-member-summary').textContent='';
 $('duplicates-a-id').textContent='';$('duplicates-b-id').textContent='';
 $('duplicates-member-prev').disabled=true;$('duplicates-member-next').disabled=true;
}
function clearDuplicateResults(){
 duplicateEpoch++;duplicateGroupPage++;duplicateWorking=false;duplicateReport=null;duplicateBinding=null;duplicateGroupOffset=0;
 clearDuplicateMembers();$('duplicates-groups').replaceChildren();$('duplicates-summary').textContent='';
 $('duplicates-group-prev').disabled=true;$('duplicates-group-next').disabled=true;
}
function invalidateDuplicateReview(close=false){
 clearDuplicateResults();$('duplicates-consent').checked=false;
 if(close){$('duplicates-panel').hidden=true;$('duplicates-side').value='left';}
}
function duplicateReady(){try{return !!requireInspectorData()&&!busy&&!pending&&!inspectorWorking;}catch{return false;}}
function duplicateControls(){
 const ready=duplicateReady();$('duplicates-open').disabled=!ready;
 $('duplicates-side-right').disabled=!inspectorData?.right;
 $('duplicates-run').disabled=!ready||duplicateWorking||!$('duplicates-consent').checked||$('duplicates-panel').hidden;
 $('duplicates-compare').disabled=!ready||duplicateWorking||!duplicateGroup||!duplicateA||!duplicateB||duplicateA===duplicateB||!$('duplicates-detail-consent').checked;
}
function requireDuplicateBinding(){
 const binding=duplicateBinding;
 if(!binding||!duplicateReport||duplicateWorking||!duplicateReady()||$('duplicates-panel').hidden||!$('duplicates-consent').checked||
   requireInspectorData()!==binding.data||$('duplicates-side').value!==binding.side||binding.data[binding.side]!==binding.file)
  throw new Error('snapshot_duplicate_review_changed');
 return binding;
}
function duplicateFailure(){
 invalidateDuplicateReview();duplicateControls();
 message('文件、范围或授权已改变，重复审阅已清除。没有上传、删除或合并记忆。',true);
}
function renderDuplicateGroups(){
 const binding=requireDuplicateBinding(),report=duplicateReport,epoch=duplicateEpoch;
 clearDuplicateMembers();$('duplicates-groups').replaceChildren();
 // Capture the post-clear page token, which also invalidates detached controls.
 const generation=++duplicateGroupPage;
 for(const group of report.groups.slice(duplicateGroupOffset,duplicateGroupOffset+10)){
  const card=element('article');
  card.append(element('strong',group.member_count+' 条原文完全相同的记录'),
   element('p','内容 SHA-256：'+group.content_sha256,'meta'),
   element('p','原文 '+group.content_bytes+' UTF-8字节 · 待确认 '+group.status_counts.candidate+' · 已启用 '+group.status_counts.active+' · 已归档 '+group.status_counts.archived,'meta'),
   element('p','不同字段：'+(group.differing_fields.join('、')||'所检查的元数据字段相同；不是安全合并证明'),'meta'));
  const select=element('button','审阅本组记录');select.type='button';
  select.addEventListener('click',()=>{
   try{
    if(requireDuplicateBinding()!==binding||duplicateEpoch!==epoch||duplicateReport!==report||duplicateGroupPage!==generation)
     throw new Error('snapshot_duplicate_review_changed');
    clearDuplicateMembers();duplicateGroup=group;renderDuplicateMembers();duplicateControls();
   }catch{duplicateFailure();}
  });
  card.append(select);$('duplicates-groups').append(card);
 }
 const counts=report.counts;
 $('duplicates-summary').textContent=(binding.side==='left'?'左侧':'右侧')+'已核验文件：扫描 '+report.scanned_records+' 条；'+counts.groups+' 个同文组，'+
  counts.records_in_groups+' 条属于同文组，额外出现 '+counts.additional_occurrences+' 次。额外出现次数不是可删除数量。'+
  ' 本页 '+Math.min(10,Math.max(0,counts.groups-duplicateGroupOffset))+' 组；仅本地观察，不读取当前数据库。';
 if(!counts.groups)$('duplicates-groups').append(element('p','扫描完成：所选文件中没有原文完全相同的记录组。','note'));
 $('duplicates-group-prev').disabled=duplicateGroupOffset===0;
 $('duplicates-group-next').disabled=duplicateGroupOffset+10>=report.groups.length;
}
function renderDuplicateMembers(){
 const binding=requireDuplicateBinding(),group=duplicateGroup,epoch=duplicateEpoch,generation=++duplicatePage;
 if(!group||!duplicateReport.groups.includes(group))throw new Error('snapshot_duplicate_review_changed');
 clearDuplicateDetails();$('duplicates-members').replaceChildren();
 for(const member of group.members.slice(duplicateMemberOffset,duplicateMemberOffset+20)){
  const card=element('article');card.append(element('strong',member.id),
   element('p',member.type+' · '+duplicateLabels[member.status]+' · '+duplicateLabels[member.visibility],'meta'),
   element('p','项目：'+(member.project_id??'全局')+' · '+duplicateLabels[member.origin_kind]+' · 版本 '+member.revision,'meta'));
  for(const [slot,label]of [['a','选为 A'],['b','选为 B']]){
   const select=element('button',label);select.type='button';select.setAttribute('aria-label',label+' '+member.id);
   select.addEventListener('click',()=>{
    try{
     if(requireDuplicateBinding()!==binding||duplicateEpoch!==epoch||duplicateGroup!==group||duplicatePage!==generation)
      throw new Error('snapshot_duplicate_review_changed');
     clearDuplicateDetails();if(slot==='a')duplicateA=member.id;else duplicateB=member.id;
     $('duplicates-a-id').textContent=duplicateA??'';$('duplicates-b-id').textContent=duplicateB??'';duplicateControls();
    }catch{duplicateFailure();}
   });card.append(select);
  }
  $('duplicates-members').append(card);
 }
 $('duplicates-member-summary').textContent='本组 '+group.member_count+' 条；第 '+(duplicateMemberOffset+1)+'–'+
  Math.min(duplicateMemberOffset+20,group.member_count)+' 条。可跨页选择 A、B；更换组会清除选择。';
 $('duplicates-member-prev').disabled=duplicateMemberOffset===0;
 $('duplicates-member-next').disabled=duplicateMemberOffset+20>=group.members.length;
}
async function scanDuplicateSnapshot(){
 if(duplicateWorking||busy||pending)return;
 clearDuplicateResults();const epoch=duplicateEpoch;
 let binding;
 try{
  const data=requireInspectorData(),side=$('duplicates-side').value;
  if($('duplicates-panel').hidden||!$('duplicates-consent').checked||!['left','right'].includes(side)||!data[side])
   throw new Error('snapshot_duplicate_review_changed');
  const file=data[side];binding={data,side,file};
  const allowed=()=>{
   if(epoch!==duplicateEpoch||!duplicateReady()||requireInspectorData()!==data||data[side]!==file||$('duplicates-side').value!==side||
    $('duplicates-panel').hidden||!$('duplicates-consent').checked)throw new Error('snapshot_duplicate_review_changed');
  };
  allowed();duplicateWorking=true;duplicateControls();$('duplicates-summary').textContent='正在本机扫描整份已核验快照；未完成不显示部分统计。';
  const report=await data.contract.inspectMemorySnapshotDuplicates(file,allowed);allowed();
  duplicateWorking=false;duplicateBinding=binding;duplicateReport=report;renderDuplicateGroups();
  message('重复审阅扫描完成。正文尚未展示，没有上传、修改、删除或自动合并记录。');
 }catch{
  if(epoch===duplicateEpoch){
   clearDuplicateResults();$('duplicates-summary').textContent='扫描未完成或授权已改变，不能解释为没有重复记录。';
   message('重复审阅未完成。请核验文件并明确同意读取；没有自动重试。',true);
  }
 }finally{if(epoch===duplicateEpoch)duplicateWorking=false;duplicateControls();}
}
$('duplicates-open').addEventListener('click',()=>{
 try{
  if(!duplicateReady())throw new Error();requireInspectorData();
  invalidateDuplicateReview(true);clearInspectorComparison();$('inspector-compare-consent').checked=false;
  if(typeof invalidateExplorer==='function')invalidateExplorer();
  $('duplicates-panel').hidden=false;inspectorControls();
 }catch{duplicateFailure();}
});
$('duplicates-run').addEventListener('click',scanDuplicateSnapshot);
$('duplicates-close').addEventListener('click',()=>{invalidateDuplicateReview(true);duplicateControls();});
$('duplicates-side').addEventListener('change',()=>{invalidateDuplicateReview();duplicateControls();});
$('duplicates-consent').addEventListener('change',()=>{if(!$('duplicates-consent').checked)clearDuplicateResults();duplicateControls();});
$('duplicates-detail-consent').addEventListener('change',()=>{if(!$('duplicates-detail-consent').checked)clearDuplicateDetails();duplicateControls();});
$('duplicates-detail-clear').addEventListener('click',()=>{clearDuplicateDetails();duplicateControls();});
$('duplicates-compare').addEventListener('click',()=>{
 try{
  const binding=requireDuplicateBinding(),group=duplicateGroup,a=duplicateA,b=duplicateB;
  if(!group||!a||!b||a===b||!$('duplicates-detail-consent').checked||![a,b].every(id=>group.members.some(m=>m.id===id)))
   {clearDuplicateDetails();duplicateControls();message('请选定本组内不同的 A、B 两条记录，并明确同意显示正文。',true);return;}
  const left=binding.data.contract.readMemorySnapshotRecord(binding.file,a),right=binding.data.contract.readMemorySnapshotRecord(binding.file,b);
  if(requireDuplicateBinding()!==binding||left.content!==right.content)throw new Error('snapshot_duplicate_review_changed');
  // Only text nodes, never HTML or navigable links supplied by a snapshot.
  $('duplicates-detail-a').textContent=JSON.stringify(left,null,2);$('duplicates-detail-b').textContent=JSON.stringify(right,null,2);
  $('duplicates-detail').hidden=false;
 }catch{duplicateFailure();}
});
for(const [id,delta]of [['duplicates-group-prev',-10],['duplicates-group-next',10]])$(id).addEventListener('click',()=>{
 try{requireDuplicateBinding();const next=duplicateGroupOffset+delta;if(next<0||next>=duplicateReport.groups.length)return;
  duplicateGroupOffset=next;renderDuplicateGroups();duplicateControls();}catch{duplicateFailure();}
});
for(const [id,delta]of [['duplicates-member-prev',-20],['duplicates-member-next',20]])$(id).addEventListener('click',()=>{
 try{requireDuplicateBinding();const next=duplicateMemberOffset+delta;if(!duplicateGroup||next<0||next>=duplicateGroup.members.length)return;
  duplicateMemberOffset=next;renderDuplicateMembers();duplicateControls();}catch{duplicateFailure();}
});
// Compose rather than replace the existing explorer lifecycle. Inspector changes
// clear both panels synchronously; action guards remain authoritative as well.
const duplicatePriorHooks=inspectorBrowserHooks;
inspectorBrowserHooks={reset(){duplicatePriorHooks.reset();invalidateDuplicateReview(true);},
 sync(){duplicatePriorHooks.sync();duplicateControls();}};
document.addEventListener('click',event=>{
 if(event.target?.closest?.('#explorer-open,#inspector-compare')){invalidateDuplicateReview(true);duplicateControls();}
},true);
invalidateDuplicateReview(true);duplicateControls();
