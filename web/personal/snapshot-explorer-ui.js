/* Browse only an already inspected local file. No API, storage, download or write calls. */
'use strict';
let explorerPage=null,explorerBinding=null,explorerGeneration=0;
const explorerInputs=['explorer-side','explorer-query','explorer-status','explorer-type','explorer-importance',
  'explorer-origin','explorer-project-scope','explorer-project','explorer-agent','explorer-sort'];
const explorerLabels={candidate:'待确认',active:'已启用',archived:'已归档',low:'低',normal:'普通',high:'高',agent:'Agent记录',document_fragment:'文档片段'};
function clearExplorerDetail(){
  $('explorer-detail').hidden=true;$('explorer-detail-text').textContent='';$('explorer-detail-id').textContent='';
}
function clearExplorerResults(){
  explorerGeneration++;explorerPage=null;explorerBinding=null;clearExplorerDetail();
  $('explorer-results').replaceChildren();$('explorer-summary').textContent='';
  $('explorer-prev').disabled=true;$('explorer-next').disabled=true;
}
function invalidateExplorer(){
  clearExplorerResults();$('explorer-panel').hidden=true;$('explorer-consent').checked=false;
  for(const id of explorerInputs)$(id).value='';
  $('explorer-side').value='left';$('explorer-project-scope').value='all';$('explorer-sort').value='id_asc';
  $('explorer-project').disabled=true;
}
function explorerControls(){
  let ready=false;try{ready=!!requireInspectorData();}catch{}
  $('explorer-open').disabled=!ready||inspectorWorking;
  $('explorer-run').disabled=!ready||inspectorWorking||!$('explorer-consent').checked;
  $('explorer-side-right').disabled=!inspectorData?.right;
}
function explorerSelection(){return JSON.stringify(explorerInputs.map(id=>$(id).value));}
function explorerOptions(offset=0){
  return {query:$('explorer-query').value,status:$('explorer-status').value,type:$('explorer-type').value,
    importance:$('explorer-importance').value,origin_kind:$('explorer-origin').value,
    project_scope:$('explorer-project-scope').value,project_id:$('explorer-project').value,
    agent_id:$('explorer-agent').value,sort:$('explorer-sort').value,offset};
}
function requireExplorerBinding(){
  const binding=explorerBinding;
  if(!binding||$('explorer-panel').hidden||!$('explorer-consent').checked||
    requireInspectorData()!==binding.data||explorerSelection()!==binding.selection)
    throw new Error('snapshot_browser_changed');
  return binding;
}
function explorerFailure(){
  clearExplorerResults();explorerControls();message('文件、视图或授权已改变。未展示快照正文；请重新核验并明确读取。',true);
}
function renderExplorerPage(){
  const binding=requireExplorerBinding(),page=explorerPage,generation=explorerGeneration;
  if(!page)throw new Error('snapshot_browser_changed');
  clearExplorerDetail();$('explorer-results').replaceChildren();
  for(const row of page.rows){
    const card=element('article');
    card.append(element('strong',row.type+' · '+explorerLabels[row.status]),
      element('p','记忆 ID：'+row.id,'meta'),
      element('p','项目：'+(row.project_id??'全局')+' · Agent：'+row.agent_id+' · 重要性：'+explorerLabels[row.importance],'meta'),
      element('p','来源类型：'+explorerLabels[row.origin_kind]+' · 版本：'+row.revision+' · 更新：'+row.updated_at,'meta'));
    const show=element('button','查看此条本地记录');show.type='button';
    show.addEventListener('click',()=>{
      try{
        if(requireExplorerBinding()!==binding||explorerGeneration!==generation||explorerPage!==page)
          throw new Error('snapshot_browser_changed');
        const record=binding.data.contract.readMemorySnapshotRecord(binding.file,row.id);
        $('explorer-detail-id').textContent=(binding.side==='left'?'左侧':'右侧')+'快照 · '+row.id;
        $('explorer-detail-text').textContent=JSON.stringify(record,null,2);$('explorer-detail').hidden=false;
      }catch{explorerFailure();}
    });
    card.append(show);$('explorer-results').append(card);
  }
  $('explorer-summary').textContent=(binding.side==='left'?'左侧':'右侧')+'文件共 '+page.record_count+' 条；符合条件 '+page.matched_count+
    ' 条；本页 '+page.rows.length+' 条'+(page.rows.length?'（第 '+(page.offset+1)+'–'+(page.offset+page.rows.length)+' 条）':'')+
    '。仅本地快照，不代表数据库当前状态或身份验证。';
  if(!page.rows.length)$('explorer-results').append(element('p','所选文件中没有符合条件的记录。','note'));
  $('explorer-prev').disabled=page.previous_offset===null;$('explorer-next').disabled=page.next_offset===null;
}
function browseSnapshot(){
  clearExplorerResults();
  try{
    const data=requireInspectorData(),side=$('explorer-side').value;
    if($('explorer-panel').hidden||!$('explorer-consent').checked||!['left','right'].includes(side)||!data[side])
      throw new Error('snapshot_browser_changed');
    const file=data[side],selection=explorerSelection();
    const page=data.contract.queryMemorySnapshot(file,explorerOptions());
    explorerBinding={data,file,side,selection};explorerPage=page;renderExplorerPage();
    message('已在本机筛选快照索引。正文未自动展示，没有上传、读取数据库或修改记忆。');
  }catch(error){
    clearExplorerResults();message(error.message==='snapshot_query_invalid'?
      '筛选条件无效：正文关键词最多4096 UTF-8字节；类型和标识需符合格式，精确项目不能为空。未读取服务器。':
      '请先核验文件并同意浏览所选一侧；选择或授权改变后需重新读取。',true);
  }
  explorerControls();
}
$('explorer-open').addEventListener('click',()=>{
  try{requireInspectorData();invalidateExplorer();$('explorer-panel').hidden=false;explorerControls();}
  catch{explorerFailure();}
});
$('explorer-run').addEventListener('click',browseSnapshot);
$('explorer-consent').addEventListener('change',()=>{
  if(!$('explorer-consent').checked)clearExplorerResults();explorerControls();
});
for(const id of explorerInputs){
  for(const event of ['input','change'])$(id).addEventListener(event,()=>{
    clearExplorerResults();
    if(id==='explorer-side')$('explorer-consent').checked=false;
    if(id==='explorer-project-scope'){
      const exact=$('explorer-project-scope').value==='exact';$('explorer-project').disabled=!exact;
      if(!exact)$('explorer-project').value='';
    }
    explorerControls();
  });
  $(id).addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();browseSnapshot();}});
}
for(const [id,key]of [['explorer-prev','previous_offset'],['explorer-next','next_offset']])$(id).addEventListener('click',()=>{
  try{
    const binding=requireExplorerBinding(),offset=explorerPage?.[key];
    if(offset===null||offset===undefined)return;
    const page=binding.data.contract.queryMemorySnapshot(binding.file,explorerOptions(offset));
    explorerGeneration++;explorerPage=page;renderExplorerPage();
  }catch{explorerFailure();}
});
$('explorer-detail-clear').addEventListener('click',clearExplorerDetail);
$('explorer-close').addEventListener('click',()=>{invalidateExplorer();explorerControls();});
// Direct lifecycle hooks clear content synchronously when the containing inspector
// revokes or replaces a checked file. Per-action guards still check real authority.
inspectorBrowserHooks={reset:invalidateExplorer,sync:explorerControls};
invalidateExplorer();explorerControls();
