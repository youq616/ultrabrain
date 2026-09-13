/* No HTML rendering of memory text, no browser token persistence, no automatic model calls. */
'use strict';
const $=id=>document.getElementById(id);
const labels={identity:'身份',preference:'偏好',environment:'环境',project:'项目',decision:'决策',skill:'技能',error:'错误经验',goal:'目标',experience:'经验'};
const views={candidate:'待确认记忆',active:'当前记忆',archived:'已归档',profile:'个人偏好',agents:'已登记 Agent'};
let token='',view='candidate',offset=0,nextOffset=null,current=null,editing=null,pending=null,busy=false,loadVersion=0;
function message(text,error=false){$('message').textContent=text;$('message').dataset.error=String(error);}
function element(tag,text,cls){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;return node;}
function controls(){
  for(const b of document.querySelectorAll('[data-write],#save,#cancel-edit'))b.disabled=busy||!!pending;
  $('retry').disabled=busy;$('pending-panel').hidden=!pending;$('logout').disabled=busy||!!pending;
  $('pending-id').textContent=pending?'事件编号：'+pending.input.event_id:'';
}
async function api(operation,input={}){
  let response;try{response=await fetch('/api/call',{method:'POST',credentials:'omit',cache:'no-store',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify({operation,input}),signal:AbortSignal.timeout(20000)});}
  catch{throw Object.assign(new Error('network_unconfirmed'),{unknown:true});}
  let result;try{result=await response.json();}catch{throw Object.assign(new Error('response_unconfirmed'),{unknown:true});}
  if(!response.ok||!result.ok)throw Object.assign(new Error(typeof result.error==='string'?result.error:'request_failed'),{unknown:result.delivery==='unconfirmed'||response.status>=500});
  return result.result;
}
function download(value,name){const u=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)+'\n'],{type:'application/json'}));const link=element('a');link.href=u;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(u),1000);}
function resetEditor(){editing=null;$('editor-title').textContent='新建候选记忆';$('memory-form').reset();$('provenance').value='用户在个人管理台明确输入';$('cancel-edit').hidden=true;}
function edit(row){if(pending||busy)return;editing=row;$('editor-title').textContent='修改记忆 · r'+row.revision;for(const [field,value]of Object.entries({type:row.type,content:row.content,importance:row.importance,visibility:row.visibility,provenance:row.provenance,project:row.project_id??''}))$(field).value=value;$('consent').checked=false;$('cancel-edit').hidden=false;$('content').focus();}
async function submitPending(){
  if(!pending||busy)return;busy=true;controls();
  try{
    if(pending.operation==='commit')await api('register',{agent_id:'personal-console',agent_type:'general_agent',capabilities:[]});
    const result=await api(pending.operation,pending.input);pending=null;resetEditor();message('操作已确认。'+(result.review_required?'该记忆需要明确确认后才进入当前上下文。':''));await load();
  }catch(e){
    if(!e.unknown){pending=null;message('请求被拒绝：'+e.message+'。版本冲突时请刷新并重新核对；不要覆盖他人的更改。',true);}
    else message('尚未取得可靠确认：'+e.message+'。请重试同一请求，不要更换事件编号。',true);
  }finally{busy=false;controls();}
}
function mutate(operation,input){if(busy||pending){message('请先处理尚未确认的请求。',true);return;}pending={operation,input:{...input,event_id:crypto.randomUUID()}};submitPending();}
function render(result){
  current=result;$('results').replaceChildren();
  const rows=view==='agents'?result.agents:result.memories;
  if(!rows?.length)$('results').append(element('p','这个窗口没有可见记录。新建记忆默认在“待确认”中。','note'));
  for(const row of rows??[]){
    const card=element('article');
    if(view==='agents'){
      card.append(element('strong',row.agent_id),element('p',row.agent_type+' · r'+row.revision,'meta'),element('p',(row.capabilities??[]).join(' / ')||'未声明能力','meta'),element('p','名称和能力是客户端自述，不是软件身份认证。','note'));
    }else{
      card.append(element('span',labels[row.type]??row.type,'badge'),element('span',row.owned_by_caller?'自己拥有':'同源共享','badge'),element('p',row.content,'memory-content'));
      card.append(element('p','r'+row.revision+' · '+(row.project_id??'全局')+' · '+row.visibility+' · 可信度估计：'+(row.confidence??'未知'),'meta'),element('p','来源：'+row.provenance,'meta'));
      if(row.owned_by_caller){
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
  $('view-title').textContent=views[view];$('search-form').hidden=['profile','agents'].includes(view);
  try{const data=await api(view==='agents'?'agents':view==='profile'?'profile':'search',view==='agents'?{limit:20,offset}:view==='profile'?{limit:50,budget_bytes:131072}:{status:view,query:$('query').value,limit:20,offset,budget_bytes:131072});if(request===loadVersion&&token)render(data);}
  catch(e){if(request===loadVersion)message('读取失败：'+e.message,true);}
}
$('login-form').addEventListener('submit',async e=>{e.preventDefault();token=$('token').value.trim();$('token').value='';try{const info=await api('info');$('scope').textContent='数据源：'+info.source_id+' · Linux 本机所有者（与同账号 stdio 共享）';$('login').hidden=true;$('workspace').hidden=false;$('logout').hidden=false;message('已连接。');await load();}catch(e){token='';message('连接失败：'+e.message,true);}});
$('logout').addEventListener('click',()=>{if(pending||busy)return;token='';loadVersion++;current=null;editing=null;$('content').value='';$('results').replaceChildren();$('workspace').hidden=true;$('login').hidden=false;$('logout').hidden=true;message('管理台已锁定。');});
for(const b of document.querySelectorAll('[data-view]'))b.addEventListener('click',()=>{view=b.dataset.view;offset=0;load();});
$('refresh').addEventListener('click',()=>load());$('search-form').addEventListener('submit',e=>{e.preventDefault();offset=0;load();});
$('prev').addEventListener('click',()=>{offset=Math.max(0,offset-20);load();});$('next').addEventListener('click',()=>{if(nextOffset!==null){offset=nextOffset;load();}});
$('export').addEventListener('click',()=>{if(current)download({format:1,exported_at:new Date().toISOString(),scope:'visible page only, not a full backup',complete:false,view,result:current},'ultrabrain-personal-page.json');});
$('cancel-edit').addEventListener('click',resetEditor);
$('memory-form').addEventListener('submit',e=>{
  e.preventDefault();if(!$('consent').checked){message('保存前必须明确同意采集。',true);return;}
  const memory={type:$('type').value,content:$('content').value,importance:$('importance').value,visibility:$('visibility').value,provenance:$('provenance').value,project_id:$('project').value||null,confidence:editing?.confidence??null};
  if(memory.visibility==='source'&&!confirm('激活后，同一数据源其他身份可读取这条内容。确认选择共享？'))return;
  if(editing)mutate('update',{memory_id:editing.id,expected_revision:editing.revision,event_id:crypto.randomUUID(),memory});
  else mutate('commit',{agent_id:'personal-console',consent:true,memories:[memory]});
});
$('retry').addEventListener('click',submitPending);$('save-pending').addEventListener('click',()=>{if(pending)download({format:1,warning:'Contains consented memory text; protect this local file. The request is not confirmed.',...pending},'ultrabrain-unconfirmed-request.json');});
window.addEventListener('beforeunload',e=>{if(pending){e.preventDefault();e.returnValue='';}});
