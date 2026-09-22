/* Explicit private snapshot export; shares the console's current source/session, never its write authority. */
'use strict';
let snapshotEpoch=0,snapshotController=null;
function snapshotControls(){
  $('snapshot-export').disabled=busy||!!pending||!!snapshotController||!$('snapshot-consent').checked;
}
// One explicit logical export, not paging/search and not a recoverable database backup.
function invalidateSnapshot(){
  snapshotEpoch++;snapshotController?.abort();snapshotController=null;
  $('snapshot-panel').hidden=true;$('snapshot-consent').checked=false;$('snapshot-export').disabled=true;
}
async function loadSnapshotContract(){return import('/snapshot-contract.mjs');}
async function exportMemorySnapshot(){
  if(busy||pending||snapshotController)return;
  const session=token,source=sourceId,navigation=loadVersion,selectedView=view,epoch=++snapshotEpoch;
  const controller=new AbortController();snapshotController=controller;snapshotControls();
  const current=()=>!!session&&token===session&&sourceId===source&&epoch===snapshotEpoch&&
    !controller.signal.aborted&&loadVersion===navigation&&view===selectedView;
  const allowed=()=>{
    if(!current()||!$('snapshot-consent').checked||$('snapshot-panel').hidden||busy||pending)throw new Error('snapshot_authorization_changed');
  };
  try{
    allowed();const {verifyMemorySnapshot}=await loadSnapshotContract();allowed();
    const input=Object.freeze({request_id:crypto.randomUUID(),consent:true});
    message('正在读取一致的个人记忆快照；含私有内容，不调用模型，不写入记忆。');
    const result=await api('memory_snapshot',input,controller.signal);allowed();
    await verifyMemorySnapshot(result,input,source,text=>sha256Hex(new TextEncoder().encode(text)),allowed);allowed();
    download(result,'ultrabrain-owned-memories.json');
    message('已核对并发起下载：'+result.record_count+' 条自己拥有的记忆（全部状态、全部项目）。不含其他所有者、原始文档文件、任务/事件历史或服务配置；不是完整数据库备份。');
  }catch(error){
    if(current())message('记忆快照未下载：'+error.message+'。未请求记忆写入或模型调用，未返回部分导出。',true);
  }finally{if(epoch===snapshotEpoch){snapshotController=null;$('snapshot-consent').checked=false;snapshotControls();}}
}
$('snapshot-open').addEventListener('click',()=>{
  if(busy||pending){message('请先处理未确认的写入，再导出记忆快照。',true);return;}
  invalidateSnapshot();$('snapshot-panel').hidden=false;
});
$('snapshot-consent').addEventListener('change',()=>{
  if(!$('snapshot-consent').checked){snapshotEpoch++;snapshotController?.abort();snapshotController=null;}snapshotControls();
});
$('snapshot-cancel').addEventListener('click',()=>{invalidateSnapshot();message('已取消本地快照下载；已发送的只读查询无法撤回，没有删除或修改记忆。');});
$('snapshot-export').addEventListener('click',exportMemorySnapshot);

// Observe navigation/lock/write UI changes for prompt local cancellation. The
// async checkpoints additionally read the actual source/session/loadVersion and
// busy/pending state, so safety does not rely on observer/event delivery timing.
const snapshotObserver=new MutationObserver(records=>{
  if(records.some(r=>r.target===$('view-title')||r.target===$('workspace'))||busy||pending)invalidateSnapshot();
  snapshotControls();
});
snapshotObserver.observe($('view-title'),{childList:true});
snapshotObserver.observe($('workspace'),{attributes:true,attributeFilter:['hidden']});
snapshotObserver.observe($('logout'),{attributes:true,attributeFilter:['disabled']});
document.addEventListener('submit',()=>invalidateSnapshot(),true);
document.addEventListener('click',event=>{
  if(event.target?.closest?.('[data-view],#refresh,#logout,#prev,#next,[data-write],#save,#retry'))invalidateSnapshot();
},true);
