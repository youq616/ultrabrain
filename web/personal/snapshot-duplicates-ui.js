/* Local review of one previously verified file. No API, write, download or storage. */
'use strict';
let duplicateEpoch=0,duplicateWorking=false,duplicateReport=null,duplicateBinding=null;
let duplicateGroupOffset=0,duplicateMemberOffset=0,duplicateSelected=null,duplicateGroupsVersion=0,duplicateMembersVersion=0;
const duplicatePageSize=20;
const duplicateState={candidate:'待确认',active:'已启用',archived:'已归档',private:'私有',source:'同源共享',agent:'Agent记录',document_fragment:'文档片段'};
const duplicateFields={type:'类型',origin_kind:'来源类型',project_id:'项目',status:'状态',visibility:'可见性',importance:'重要性',
 confidence:'调用方估计',agent_id:'Agent标签',revision:'版本',created_at:'创建时间',updated_at:'更新时间',last_confirmed:'最后确认',
 provenance:'来源说明',derivation_current:'直接来源有效标记'};
const duplicateFieldNames=group=>group.differing_fields.map(key=>duplicateFields[key]??key).join('、');
function clearDuplicateDetail(){
 $('duplicates-detail').hidden=true;$('duplicates-detail-text').textContent='';$('duplicates-detail-id').textContent='';
}
function clearDuplicateGroup(){
 duplicateMembersVersion++;duplicateSelected=null;duplicateMemberOffset=0;clearDuplicateDetail();
 $('duplicates-group').hidden=true;$('duplicates-members').replaceChildren();$('duplicates-group-summary').textContent='';
 $('duplicates-text-consent').checked=false;$('duplicates-members-prev').disabled=true;$('duplicates-members-next').disabled=true;
}
function clearDuplicateResults(){
 duplicateEpoch++;duplicateGroupsVersion++;duplicateWorking=false;duplicateReport=null;duplicateBinding=null;duplicateGroupOffset=0;
 clearDuplicateGroup();$('duplicates-groups').replaceChildren();$('duplicates-summary').textContent='尚未扫描；空白不表示没有重复记录。';
 $('duplicates-prev').disabled=true;$('duplicates-next').disabled=true;
}
function invalidateDuplicates(){
 clearDuplicateResults();$('duplicates-panel').hidden=true;$('duplicates-consent').checked=false;$('duplicates-side').value='left';
 duplicateControls();
}
function duplicateControls(){
 let ready=false;try{ready=!!requireInspectorData();}catch{}
 $('duplicates-open').disabled=!ready||inspectorWorking||duplicateWorking;
 $('duplicates-run').disabled=!ready||inspectorWorking||duplicateWorking||!$('duplicates-consent').checked||$('duplicates-panel').hidden;
 $('duplicates-side-right').disabled=!inspectorData?.right;
}
function requireDuplicateBinding(){
 const binding=duplicateBinding;
 if(!binding||!duplicateReport||duplicateWorking)throw new Error('snapshot_duplicates_changed');
 binding.allowed();return binding;
}
function duplicateFailure(){
 clearDuplicateResults();duplicateControls();$('duplicates-summary').textContent='审阅未确认。文件、视图或同意已经改变，请重新明确扫描。';
 message('重复审阅未确认。没有上传、合并、删除或修改记忆。',true);
}
function renderDuplicateMembers(){
 const binding=requireDuplicateBinding(),report=duplicateReport,group=duplicateSelected;
 if(!group||!report.groups.includes(group))throw new Error('snapshot_duplicates_changed');
 const version=++duplicateMembersVersion;clearDuplicateDetail();$('duplicates-text-consent').checked=false;
 $('duplicates-members').replaceChildren();$('duplicates-group').hidden=false;
 const start=duplicateMemberOffset;
 for(const member of group.members.slice(start,start+duplicatePageSize)){
  const card=element('article');card.dataset.memoryId=member.id;
  card.append(element('strong',member.type+' · '+duplicateState[member.status]),element('p','记忆 ID：'+member.id,'meta'),
   element('p','项目：'+(member.project_id??'全局')+' · 可见性：'+duplicateState[member.visibility]+' · 来源类型：'+duplicateState[member.origin_kind]+' · 版本：'+member.revision,'meta'));
  const show=element('button','查看此条本地全文');show.type='button';show.disabled=true;
  show.addEventListener('click',()=>{
   // Detached controls from older pages must neither disclose nor erase a new view.
   if(duplicateReport!==report||duplicateSelected!==group||duplicateMembersVersion!==version)return;
   try{
    if(requireDuplicateBinding()!==binding)throw new Error('snapshot_duplicates_changed');
    if(!$('duplicates-text-consent').checked)return;
    const record=binding.data.contract.readMemorySnapshotRecord(binding.file,member.id);
    binding.allowed();
    $('duplicates-detail-id').textContent=(binding.side==='left'?'左侧':'右侧')+'本地快照 · '+member.id;
    $('duplicates-detail-text').textContent=JSON.stringify(record,null,2);$('duplicates-detail').hidden=false;
   }catch{duplicateFailure();}
  });
  card.append(show);$('duplicates-members').append(card);
 }
 $('duplicates-group-summary').textContent='组内共 '+group.member_count+' 条；本页第 '+(start+1)+'–'+Math.min(start+duplicatePageSize,group.member_count)+
  ' 条。候选 '+group.status_counts.candidate+'／启用 '+group.status_counts.active+'／归档 '+group.status_counts.archived+
  '。不同字段：'+(duplicateFieldNames(group)||'所比较的字段没有差异；不等于安全合并')+'。未比较完整引用含义。';
 $('duplicates-members-prev').disabled=start===0;$('duplicates-members-next').disabled=start+duplicatePageSize>=group.member_count;
}
function renderDuplicateGroups(){
 const binding=requireDuplicateBinding(),report=duplicateReport,version=++duplicateGroupsVersion;
 clearDuplicateGroup();$('duplicates-groups').replaceChildren();
 const start=duplicateGroupOffset;
 for(const group of report.groups.slice(start,start+duplicatePageSize)){
  const card=element('article');card.dataset.groupId=group.members[0].id;
  card.append(element('strong',group.member_count+' 条正文完全相同的记录'),
   element('p','正文 SHA-256：'+group.content_sha256,'meta'),
   element('p','正文长度：'+group.content_bytes+' UTF-8 字节 · 额外出现 '+(group.member_count-1)+' 次（不是删除建议）','note'),
   element('p','不同字段：'+(duplicateFieldNames(group)||'所比较的字段没有差异；不等于安全合并'),'meta'));
  const select=element('button','审阅本组记录');select.type='button';
  select.addEventListener('click',()=>{
   if(duplicateReport!==report||duplicateGroupsVersion!==version)return;
   try{
    if(requireDuplicateBinding()!==binding)throw new Error('snapshot_duplicates_changed');
    duplicateSelected=group;duplicateMemberOffset=0;renderDuplicateMembers();
   }catch{duplicateFailure();}
  });
  card.append(select);$('duplicates-groups').append(card);
 }
 const c=report.counts;
 $('duplicates-summary').textContent=(binding.side==='left'?'左侧':'右侧')+'快照扫描 '+report.scanned_records+' 条；发现 '+c.groups+' 组，组内 '+c.records_in_groups+
  ' 条，未分组 '+c.records_outside_groups+' 条；额外出现次数 '+c.additional_occurrences+'。本页 '+Math.min(duplicatePageSize,Math.max(0,c.groups-start))+
  ' 组。仅同一文件的全部项目／状态；不代表当前数据库、身份认证或删除授权。';
 $('duplicates-prev').disabled=start===0;$('duplicates-next').disabled=start+duplicatePageSize>=report.groups.length;
}
async function scanDuplicateSnapshot(){
 if(duplicateWorking||inspectorWorking||busy||pending)return;
 clearDuplicateResults();const epoch=duplicateEpoch;
 try{
  const data=requireInspectorData(),side=$('duplicates-side').value,file=data[side];
  if(!['left','right'].includes(side)||!file)throw new Error('snapshot_duplicates_changed');
  const allowed=()=>{
   if(epoch!==duplicateEpoch||$('duplicates-panel').hidden||!$('duplicates-consent').checked||$('duplicates-side').value!==side||
      requireInspectorData()!==data||inspectorWorking||busy||pending)throw new Error('snapshot_duplicates_changed');
  };
  allowed();duplicateWorking=true;duplicateControls();$('duplicates-summary').textContent='正在本机扫描已核验文件；不上传数据，不展示正文。';
  const report=await data.contract.inspectMemorySnapshotDuplicates(file,allowed);allowed();
  duplicateWorking=false;duplicateReport=report;duplicateBinding={data,file,side,allowed};renderDuplicateGroups();
  message('重复组扫描完成。正文未自动展示，没有合并、删除、上传或模型调用。');
 }catch{
  if(epoch===duplicateEpoch)duplicateFailure();
 }finally{if(epoch===duplicateEpoch){duplicateWorking=false;duplicateControls();}}
}
$('duplicates-open').addEventListener('click',()=>{
 try{
  requireInspectorData();if(inspectorWorking||busy||pending)return;
  // Drop unrelated body previews; preserve the verified files and edit draft.
  if(typeof invalidateExplorer==='function')invalidateExplorer();clearInspectorDetails();
  invalidateDuplicates();$('duplicates-panel').hidden=false;duplicateControls();
 }catch{invalidateDuplicates();}
});
$('duplicates-run').addEventListener('click',scanDuplicateSnapshot);
$('duplicates-close').addEventListener('click',()=>{invalidateDuplicates();message('重复审阅已清除。没有修改或删除文件及记忆。');});
$('duplicates-side').addEventListener('change',()=>{clearDuplicateResults();$('duplicates-consent').checked=false;duplicateControls();});
$('duplicates-consent').addEventListener('change',()=>{if(!$('duplicates-consent').checked)clearDuplicateResults();duplicateControls();});
$('duplicates-text-consent').addEventListener('change',()=>{
 clearDuplicateDetail();
 try{
  requireDuplicateBinding();
  for(const card of $('duplicates-members').children)card.children[card.children.length-1].disabled=!$('duplicates-text-consent').checked;
 }catch{duplicateFailure();}
});
$('duplicates-detail-clear').addEventListener('click',clearDuplicateDetail);
for(const [id,delta]of [['duplicates-prev',-20],['duplicates-next',20]])$(id).addEventListener('click',()=>{
 try{
  requireDuplicateBinding();const offset=duplicateGroupOffset+delta;if(offset<0||offset>=duplicateReport.groups.length)return;
  duplicateGroupOffset=offset;renderDuplicateGroups();
 }catch{duplicateFailure();}
});
for(const [id,delta]of [['duplicates-members-prev',-20],['duplicates-members-next',20]])$(id).addEventListener('click',()=>{
 try{
  requireDuplicateBinding();const offset=duplicateMemberOffset+delta;if(!duplicateSelected||offset<0||offset>=duplicateSelected.member_count)return;
  duplicateMemberOffset=offset;renderDuplicateMembers();
 }catch{duplicateFailure();}
});
// Inspector reset executes synchronously for file/consent/navigation/lock changes.
inspectorDuplicateHooks={reset:invalidateDuplicates,sync:duplicateControls};
document.addEventListener('click',event=>{
 if(event.target?.closest?.('#explorer-open,#overview-open,#lineage-open'))invalidateDuplicates();
},true);
invalidateDuplicates();
