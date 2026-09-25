/* Explicit owner counts only. No body reads, polling, model calls, writes or persistence. */
'use strict';
let overviewEpoch=0,overviewController=null,overviewData=null,overviewWorking=false,overviewBinding=null,overviewContractPromise=null;
function loadOverviewContract(){return overviewContractPromise??=import('/overview-contract.mjs').catch(e=>{overviewContractPromise=null;throw e;});}
function overviewControls(){
 $('overview-run').disabled=overviewWorking||busy||!!pending;
 for(const id of ['overview-candidates','overview-active','overview-jobs','overview-documents','overview-agents'])
  $(id).disabled=!overviewData||overviewWorking||busy||!!pending;
}
function invalidateOverview(close=false){
 overviewEpoch++;overviewController?.abort();overviewController=null;overviewWorking=false;overviewData=null;overviewBinding=null;
 $('overview-cards').replaceChildren();$('overview-notice').textContent='尚未读取。本面板不自动轮询，空白不代表记忆库为空。';
 if(close)$('overview-panel').hidden=true;
 overviewControls();
}
function requireOverview(){
 if(!overviewData||!overviewBinding)throw new Error('overview_changed');
 overviewBinding();return overviewData;
}
function renderOverview(result){
 $('overview-cards').replaceChildren();
 const blocks=[['记忆',result.memories,[['total','全部记录'],['candidate','待确认'],['active','已启用'],['archived','已归档'],
  ['active_current','已启用且直接来源仍有效'],['active_stale','已启用但直接来源失效'],['candidate_stale','待确认且直接来源失效'],['document_fragments','文档片段（包含在全部记录内）']]],
 ['整理任务',result.jobs,[['total','全部任务'],['queued','等待整理'],['processing','处理中'],['processing_live','处理租约尚未到期'],
  ['processing_expired','处理租约已到期'],['failed','失败'],['failed_below_attempt_limit','失败且尝试次数未达上限'],['completed','已完成'],['stale','已取消或来源失效']]],
 ['导入文档',result.documents,[['total','全部文档'],['active','使用中'],['archived','已归档']]],
 ['已登记 Agent',result.agents,[['total','当前身份的标签数量']]]];
 for(const [title,values,labels]of blocks){
  const card=element('article');card.append(element('h3',title));
  for(const [key,label]of labels){const line=element('p',label+'：'+values[key]);line.dataset.metric=key;card.append(line);}
  $('overview-cards').append(card);
 }
 const m=result.memories,j=result.jobs;
 $('overview-notice').textContent='数据库观察时间：'+result.observed_at+' · 仅当前所有者／所有项目。'+
  '待确认 '+m.candidate+' 条；来源失效的已启用记忆 '+m.active_stale+' 条；租约已到期任务 '+j.processing_expired+' 条。'+
  '这是读取时刻的计数，不是事实证明、实时状态或恢复授权。请进入相应列表重新核对后再决定操作。';
}
async function readOverview(){
 if(overviewWorking||busy||pending)return;
 const session=token,source=sourceId,navigation=loadVersion,selected=view;
 invalidateOverview();const epoch=overviewEpoch,controller=new AbortController();overviewController=controller;
 const current=()=>epoch===overviewEpoch&&!!session&&token===session&&sourceId===source&&loadVersion===navigation&&view===selected&&
  !$('workspace').hidden&&!$('overview-panel').hidden;
 const allowed=()=>{if(!current()||controller.signal.aborted||busy||pending)throw new Error('overview_changed');};
 overviewWorking=true;overviewControls();
 try{
  allowed();$('overview-notice').textContent='正在读取当前所有者的汇总计数；不加载正文。';
  const contract=await loadOverviewContract();allowed();
  const request=contract.overviewRequest({request_id:crypto.randomUUID()});
  const response=await api('overview',request,controller.signal);allowed();
  const result=contract.verifyPersonalOverview(response,request,source);allowed();
  overviewData=result;overviewBinding=allowed;renderOverview(result);message('运行概览已读取。没有读取正文、调用模型或修改记录。');
 }catch(error){
  if(current()){
   overviewData=null;overviewBinding=null;$('overview-cards').replaceChildren();
   $('overview-notice').textContent='概览未确认。不能将读取失败或取消解释成记忆库为空。';
   const codes=new Set(['personal_overview_unconfirmed','permission_denied','network_unconfirmed','response_unconfirmed','overview_changed']);
   message('运行概览未完成：'+(codes.has(error.message)?error.message:'overview_read_unconfirmed')+'。未自动重试。',true);
  }
 }finally{if(epoch===overviewEpoch){overviewController=null;overviewWorking=false;overviewControls();}}
}
$('overview-open').addEventListener('click',()=>{
 if(!token||$('workspace').hidden||busy||pending){message('请先连接管理台并处理未确认操作。',true);return;}
 // Opening a separate workspace must not leave unrelated private previews visible.
 if(typeof invalidateLineage==='function')invalidateLineage(true);
 if(typeof invalidateInspector==='function')invalidateInspector(true);
 if(typeof invalidateSnapshot==='function')invalidateSnapshot();
 invalidateOverview();$('overview-panel').hidden=false;
});
$('overview-run').addEventListener('click',readOverview);
$('overview-close').addEventListener('click',()=>{invalidateOverview(true);message('运行概览已清除。没有取消服务器任务或删除记忆。');});
for(const [id,target]of [['overview-candidates','candidate'],['overview-active','active'],['overview-jobs','jobs'],['overview-documents','documents'],['overview-agents','agents']]){
 $(id).addEventListener('click',()=>{
  try{requireOverview();const navigation=document.querySelector('[data-view="'+target+'"]');
   if(!navigation)throw new Error('overview_changed');
   // Use existing navigation and its current filters; do not force a write or erase drafts.
   invalidateOverview(true);navigation.click();
  }catch{invalidateOverview();message('概览或会话已改变，请重新读取。没有执行任务或修改记录。',true);}
 });
}
const overviewObserver=new MutationObserver(records=>{
 if(records.some(r=>r.target===$('view-title')||r.target===$('workspace'))||busy||pending)invalidateOverview(true);
});
overviewObserver.observe($('view-title'),{childList:true});
overviewObserver.observe($('workspace'),{attributes:true,attributeFilter:['hidden']});
overviewObserver.observe($('logout'),{attributes:true,attributeFilter:['disabled']});
document.addEventListener('submit',()=>invalidateOverview(true),true);
document.addEventListener('click',event=>{
 if(event.target?.closest?.('[data-view],#refresh,#logout,#prev,#next,[data-write],#save,#retry,#snapshot-open,#inspector-open,#explorer-open,#lineage-open'))invalidateOverview(true);
},true);
invalidateOverview(true);
