/* Two previously verified local files. Metadata only; no data IO or mutations. */
'use strict';
let duplicateCompareEpoch=0,duplicateCompareWorking=false,duplicateCompareReport=null,duplicateCompareBinding=null;
let duplicateCompareOffset=0,duplicateCompareMemberOffset=0,duplicateCompareSelected=null,duplicateComparePageVersion=0;
let duplicateCompareIndices=[],duplicateCompareMembers=[],duplicateCompareRenderedKind='all';
const duplicateComparePageSize=20;
const duplicateCompareKinds=Object.freeze({all:'全部类别',left_only:'仅左侧重复',right_only:'仅右侧重复',changed:'两侧重复且有变化',unchanged:'两侧重复且相同'});
const duplicateCompareStates={candidate:'待确认',active:'已启用',archived:'已归档',private:'私有',source:'同源共享',agent:'Agent记录',document_fragment:'文档片段'};
const duplicateCompareFields={type:'类型',origin_kind:'来源类型',project_id:'项目',status:'状态',visibility:'可见性',importance:'重要性',
 confidence:'调用方估计',agent_id:'Agent标签',revision:'版本',created_at:'创建时间',updated_at:'更新时间',last_confirmed:'最后确认',
 provenance:'来源说明',derivation_current:'直接来源有效标记',derivation:'结构化引用（未核实来源）'};
function clearDuplicateCompareGroup(){
 duplicateCompareSelected=null;duplicateCompareMemberOffset=0;duplicateCompareMembers=[];
 $('dupcmp-detail').hidden=true;$('dupcmp-members').replaceChildren();$('dupcmp-detail-summary').textContent='';
 $('dupcmp-members-prev').disabled=true;$('dupcmp-members-next').disabled=true;
}
function clearDuplicateCompareResults(){
 duplicateCompareEpoch++;duplicateComparePageVersion++;duplicateCompareWorking=false;
 duplicateCompareReport=null;duplicateCompareBinding=null;duplicateCompareOffset=0;duplicateCompareIndices=[];duplicateCompareRenderedKind='all';
 clearDuplicateCompareGroup();$('dupcmp-groups').replaceChildren();$('dupcmp-files').textContent='';
 $('dupcmp-summary').textContent='尚未比较。空白不表示没有重复或没有变化。';
 $('dupcmp-prev').disabled=true;$('dupcmp-next').disabled=true;$('dupcmp-kind').disabled=true;
}
function invalidateDuplicateCompare(){
 clearDuplicateCompareResults();$('dupcmp-panel').hidden=true;$('dupcmp-consent').checked=false;$('dupcmp-kind').value='all';
 duplicateCompareControls();
}
function duplicateCompareControls(){
 let ready=false;try{const data=requireInspectorData();ready=!!data.left&&!!data.right;}catch{}
 $('dupcmp-open').disabled=!ready||inspectorWorking||duplicateCompareWorking;
 $('dupcmp-run').disabled=!ready||inspectorWorking||duplicateCompareWorking||!$('dupcmp-consent').checked||$('dupcmp-panel').hidden;
 $('dupcmp-kind').disabled=!duplicateCompareReport||duplicateCompareWorking;
}
function requireDuplicateCompare(){
 const binding=duplicateCompareBinding;
 if(!binding||!duplicateCompareReport||duplicateCompareWorking)throw new Error('snapshot_comparison_changed');
 binding.allowed();return binding;
}
function duplicateCompareFailure(sourceMismatch=false){
 clearDuplicateCompareResults();duplicateCompareControls();
 $('dupcmp-summary').textContent=sourceMismatch?'两份文件自述来源不同，拒绝比较；这不是零重复结果。':
  '比较未确认。文件、视图或同意已改变，或本地计算失败；没有输出部分结果。';
 message('跨快照重复审阅未完成。没有上传、删除、合并或修改记忆。',true);
}
function duplicateCompareSide(label,member){
 if(!member)return label+'：该内容组内无此 ID（不推断文件中该 ID 不存在）。';
 return label+'：'+member.type+' · '+duplicateCompareStates[member.status]+' · '+duplicateCompareStates[member.visibility]+
  ' · 项目 '+(member.project_id??'全局')+' · '+duplicateCompareStates[member.origin_kind]+' · 版本 '+member.revision;
}
function requireDuplicateCompareFilter(){
 const binding=requireDuplicateCompare();
 if($('dupcmp-kind').value!==duplicateCompareRenderedKind)throw new Error('snapshot_comparison_changed');
 return binding;
}
function renderDuplicateCompareMembers(){
 requireDuplicateCompareFilter();const group=duplicateCompareSelected;
 if(!group||!duplicateCompareReport.groups.includes(group))throw new Error('snapshot_comparison_changed');
 const start=duplicateCompareMemberOffset;$('dupcmp-members').replaceChildren();$('dupcmp-detail').hidden=false;
 for(const item of duplicateCompareMembers.slice(start,start+duplicateComparePageSize)){
  const card=element('article');card.dataset.memoryId=item.id;
  const membership=item.left&&item.right?'该内容组内两侧共有':item.left?'该内容组内仅左':'该内容组内仅右';
  card.append(element('strong',membership),element('p','记忆 ID：'+item.id,'meta'),
   element('p',duplicateCompareSide('左侧',item.left),'meta'),element('p',duplicateCompareSide('右侧',item.right),'meta'));
  if(item.left&&item.right)card.append(element('p',item.fields.length?
   '变化字段：'+item.fields.map(key=>duplicateCompareFields[key]).join('、'):'被比较字段相同；不证明引用有效或安全合并。','note'));
  $('dupcmp-members').append(card);
 }
 const side=s=>s.member_count===0?'无同文记录':s.duplicate?'达到重复条件':'单条同文记录，未达到重复条件';
 $('dupcmp-detail-summary').textContent='左侧 '+group.left.member_count+' 条（'+side(group.left)+'）；右侧 '+group.right.member_count+' 条（'+side(group.right)+'）。'+
  '该内容组内共有 '+group.membership.shared.length+' 个 ID，仅左 '+group.membership.left_only.length+'，仅右 '+group.membership.right_only.length+
  '。成员索引共 '+duplicateCompareMembers.length+' 项，本页第 '+(start+1)+'–'+Math.min(start+duplicateComparePageSize,duplicateCompareMembers.length)+' 项。';
 $('dupcmp-members-prev').disabled=start===0;$('dupcmp-members-next').disabled=start+duplicateComparePageSize>=duplicateCompareMembers.length;
}
function selectDuplicateCompareGroup(group){
 requireDuplicateCompare();clearDuplicateCompareGroup();duplicateCompareSelected=group;
 const left=new Map(group.left.members.map(m=>[m.id,m])),right=new Map(group.right.members.map(m=>[m.id,m]));
 const changes=new Map(group.shared_record_changes.map(c=>[c.id,c.fields]));
 duplicateCompareMembers=[...new Set([...left.keys(),...right.keys()])].sort().map(id=>({id,left:left.get(id),right:right.get(id),fields:changes.get(id)??[]}));
 renderDuplicateCompareMembers();
}
function renderDuplicateCompareGroups(){
 const binding=requireDuplicateCompare(),report=duplicateCompareReport,kind=$('dupcmp-kind').value;
 if(!Object.hasOwn(duplicateCompareKinds,kind))throw new Error('snapshot_comparison_changed');
 duplicateCompareRenderedKind=kind;
 const version=++duplicateComparePageVersion;clearDuplicateCompareGroup();$('dupcmp-groups').replaceChildren();
 duplicateCompareIndices=report.groups.map((g,index)=>({g,index})).filter(({g})=>kind==='all'||g.kind===kind);
 const start=duplicateCompareOffset;
 for(const {g:group,index} of duplicateCompareIndices.slice(start,start+duplicateComparePageSize)){
  const card=element('article');card.dataset.groupIndex=String(index);card.dataset.kind=group.kind;
  card.append(element('strong',duplicateCompareKinds[group.kind]),element('p','正文 SHA-256：'+group.content_sha256,'meta'),
   element('p','左侧 '+group.left.member_count+' 条／右侧 '+group.right.member_count+' 条 · 正文长度 '+group.content_bytes+' UTF-8 字节','note'));
  const select=element('button','核对两侧成员');select.type='button';select.setAttribute('aria-pressed','false');
  select.addEventListener('click',()=>{
   // A detached old control is a no-op, not an excuse to erase a newer report.
   if(duplicateCompareReport!==report||duplicateComparePageVersion!==version)return;
   try{
    if(requireDuplicateCompare()!==binding||$('dupcmp-kind').value!==kind)throw new Error('snapshot_comparison_changed');
    selectDuplicateCompareGroup(group);
    for(const item of $('dupcmp-groups').children){item.dataset.selected='false';item.children[item.children.length-1].setAttribute('aria-pressed','false');}
    card.dataset.selected='true';select.setAttribute('aria-pressed','true');
   }catch{duplicateCompareFailure();}
  });
  card.append(select);$('dupcmp-groups').append(card);
 }
 const c=report.counts;
 $('dupcmp-summary').textContent='完整比较：左侧 '+report.left.scanned_records+' 条，右侧 '+report.right.scanned_records+' 条；共 '+c.groups+
  ' 组。仅左重复 '+c.left_only+'／仅右重复 '+c.right_only+'／两侧有变化 '+c.changed+'／两侧相同 '+c.unchanged+
  '。当前筛选匹配 '+duplicateCompareIndices.length+' 组，本页 '+Math.min(duplicateComparePageSize,Math.max(0,duplicateCompareIndices.length-start))+
  ' 组。左右不表示时间先后；没有推断删除或安全合并。';
 $('dupcmp-prev').disabled=start===0;$('dupcmp-next').disabled=start+duplicateComparePageSize>=duplicateCompareIndices.length;
}
async function compareDuplicateSnapshots(){
 if(duplicateCompareWorking||inspectorWorking||busy||pending)return;
 clearDuplicateCompareResults();const epoch=duplicateCompareEpoch;
 try{
  const data=requireInspectorData();
  if(!data.left||!data.right)throw new Error('snapshot_comparison_changed');
  const allowed=()=>{
   if(epoch!==duplicateCompareEpoch||$('dupcmp-panel').hidden||!$('dupcmp-consent').checked||
    requireInspectorData()!==data||inspectorWorking||busy||pending)throw new Error('snapshot_comparison_changed');
  };
  allowed();duplicateCompareWorking=true;duplicateCompareControls();
  $('dupcmp-summary').textContent='正在本机比较两份已核验文件；不读取服务器或展示正文。';
  const report=await data.contract.compareMemorySnapshotDuplicates(data.left,data.right,allowed);allowed();
  duplicateCompareWorking=false;duplicateCompareReport=report;duplicateCompareBinding={data,allowed};duplicateCompareOffset=0;
  const description=(name,file)=>name+'：自述来源 '+file.snapshot.source_id+' · 文件时间 '+file.snapshot.snapshot_at+'\n文件 SHA-256：'+file.file_sha256;
  $('dupcmp-files').textContent=description('左侧',data.left)+'\n\n'+description('右侧',data.right);
  renderDuplicateCompareGroups();message('跨快照重复比较完成。仅展示元数据，不代表新增、删除或安全合并。');
 }catch(error){
  if(epoch===duplicateCompareEpoch){
   let sourceMismatch=false;try{sourceMismatch=Object.getOwnPropertyDescriptor(error,'code')?.value==='snapshot_source_mismatch';}catch{}
   duplicateCompareFailure(sourceMismatch);
  }
 }finally{if(epoch===duplicateCompareEpoch){duplicateCompareWorking=false;duplicateCompareControls();}}
}
$('dupcmp-open').addEventListener('click',()=>{
 try{
  const data=requireInspectorData();if(!data.right||inspectorWorking||busy||pending)return;
  if(typeof invalidateDuplicates==='function')invalidateDuplicates();
  if(typeof invalidateExplorer==='function')invalidateExplorer();clearInspectorDetails();
  invalidateDuplicateCompare();$('dupcmp-panel').hidden=false;duplicateCompareControls();
 }catch{invalidateDuplicateCompare();}
});
$('dupcmp-run').addEventListener('click',compareDuplicateSnapshots);
$('dupcmp-close').addEventListener('click',()=>{invalidateDuplicateCompare();message('跨快照重复审阅已清除，没有修改文件或记忆。');});
$('dupcmp-consent').addEventListener('change',()=>{if(!$('dupcmp-consent').checked)clearDuplicateCompareResults();duplicateCompareControls();});
$('dupcmp-kind').addEventListener('change',()=>{
 try{requireDuplicateCompare();duplicateCompareOffset=0;renderDuplicateCompareGroups();}catch{duplicateCompareFailure();}
});
for(const [id,delta]of [['dupcmp-prev',-20],['dupcmp-next',20]])$(id).addEventListener('click',()=>{
 try{
  requireDuplicateCompareFilter();const next=duplicateCompareOffset+delta;if(next<0||next>=duplicateCompareIndices.length)return;
  duplicateCompareOffset=next;renderDuplicateCompareGroups();
 }catch{duplicateCompareFailure();}
});
for(const [id,delta]of [['dupcmp-members-prev',-20],['dupcmp-members-next',20]])$(id).addEventListener('click',()=>{
 try{
  requireDuplicateCompareFilter();const next=duplicateCompareMemberOffset+delta;if(!duplicateCompareSelected||next<0||next>=duplicateCompareMembers.length)return;
  duplicateCompareMemberOffset=next;renderDuplicateCompareMembers();
 }catch{duplicateCompareFailure();}
});
// Separate optional consumer: never replace the explorer or single-file hooks.
inspectorDuplicateCompareHooks={reset:invalidateDuplicateCompare,sync:duplicateCompareControls};
document.addEventListener('click',event=>{
 if(event.target?.closest?.('#duplicates-open,#explorer-open,#overview-open,#lineage-open,#inspector-compare'))invalidateDuplicateCompare();
},true);
invalidateDuplicateCompare();
