import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {clientProfile,requiredClientTools} from '../src/client-kit.mjs';
import {claudeTaskRequest,taskContextRequest,deliverTaskContext} from '../src/client-task-context.mjs';
import {sha256,UltraError} from '../src/core.mjs';
function fixture(t,overrides={}) {
  const dir=mkdtempSync(join(tmpdir(),'ub-task-contract-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const workspace=join(dir,'work');mkdirSync(workspace);
  const raw={format:1,source:'default',project_id:'alpha',workspace,expected_instance:'11111111-1111-4111-8111-111111111111',
    expected_actor:'a'.repeat(64),allow_task_context:true,automatic_task_context:['claude-user'],server:{transport:'stdio',command:'node',args:['trusted-only']},...overrides};
  const p=clientProfile(raw),input={task:'不要删除 ALPHA 😀',workspace,consent:true};
  const event={hook_event_name:'UserPromptSubmit',cwd:workspace,session_id:'main',prompt:input.task};
  const row={id:'22222222-2222-4222-8222-222222222222',type:'preference',status:'active',content:'KEEP_NEGATION',content_hash:sha256('KEEP_NEGATION'),project_id:'alpha',owned_by_caller:true};
  return {p,raw,input,event,row,dir,result:{source_id:p.source,memories:[row]}};
}
test('task helpers remain disabled and do not expand required tool catalog by default',t=>{
 const {raw,input}=fixture(t);const p=clientProfile({...raw,allow_task_context:undefined,automatic_task_context:undefined});
 assert.equal(p.allowTaskContext,false);assert.deepEqual(p.automaticTaskContext,[]);
 assert.throws(()=>taskContextRequest(input,p),{code:'task_context_disabled'});
 assert.deepEqual(requiredClientTools(p),requiredClientTools({...p,allowTaskContext:true}));
 assert.equal(p.allowCapture,false);assert.equal(p.allowDocuments,false);
});
for(const [key,value] of [['allow_task_context','true'],['automatic_task_context',true],['automatic_task_context',['unknown']],['automatic_task_context',['claude-user','claude-user']]])
 test('malformed task-profile option refused '+key+JSON.stringify(value),t=>{const {raw}=fixture(t);assert.throws(()=>clientProfile({...raw,[key]:value}),{code:'invalid_profile'});});
test('identity/workspace pins and separate automatic authorization required',t=>{
 const {raw,input,event}=fixture(t);
 for(const key of ['expected_instance','expected_actor','workspace'])assert.throws(()=>clientProfile({...raw,[key]:undefined}),{code:'invalid_profile'});
 assert.throws(()=>clientProfile({...raw,allow_task_context:false}),{code:'invalid_profile'});
 const manual=clientProfile({...raw,automatic_task_context:[]});assert.equal(taskContextRequest(input,manual).task,input.task);
 assert.throws(()=>claudeTaskRequest(event,manual),{code:'task_context_disabled'});
});
test('request preserves task bytes, ignores no fields, fixes budget/project in trusted config',t=>{
 const {p,input}=fixture(t);const actual=taskContextRequest(input,p);
 assert.deepEqual(actual,{task:input.task,limit:20,budget_bytes:6000,project_id:'alpha'});
 for(const extra of [{source_id:'other'},{project_id:'other'},{budget_bytes:8192},{path:'/secret'},{transcript:'secret'},{limit:100}])
  assert.throws(()=>taskContextRequest({...input,...extra},p),{code:'invalid_params'});
 for(const consent of [false,undefined,'true',1])assert.throws(()=>taskContextRequest({...input,consent},p),{code:'task_context_disabled'});
});
test('strict 4096-byte task bound, valid UTF-8, no truncation and no blank queries',t=>{
 const {p,input}=fixture(t);
 for(const task of ['x'.repeat(4096),'😀'.repeat(1024),'a\r\n不要删除'])assert.equal(taskContextRequest({...input,task},p).task,task);
 for(const task of ['x'.repeat(4097),'😀'.repeat(1025),'\ud800','\0SECRET','\n\t ',null,5])
  assert.throws(()=>taskContextRequest({...input,task},p),{code:'invalid_params'});
});
test('wrong workspace fails even when caller consents',t=>{const {p,input,dir}=fixture(t);assert.throws(()=>taskContextRequest({...input,workspace:dir},p),{code:'workspace_mismatch'});});
test('Claude only inspects primary current prompt; never transcript or tool fields',t=>{
 const {p,event}=fixture(t);
 for(const name of ['transcript_path','tool_output','thinking','last_assistant_message'])Object.defineProperty(event,name,{get(){assert.fail('Forbidden field inspected: '+name);}});
 assert.deepEqual(claudeTaskRequest(event,p),{task:event.prompt,workspace:event.cwd,consent:true});
});
test('disabled or child/unsupported Claude events never access prompt',t=>{
 const {p,event}=fixture(t);
 const hidden={...event};Object.defineProperty(hidden,'prompt',{get(){assert.fail('prompt must not be inspected');}});
 for(const denied of [()=>claudeTaskRequest(hidden,{...p,allowTaskContext:false}),()=>claudeTaskRequest(hidden,{...p,automaticTaskContext:[]}),
  ()=>claudeTaskRequest({...event,hook_event_name:'SessionStart',get prompt(){assert.fail();}},p),
  ()=>claudeTaskRequest({...event,agent_id:'child',get prompt(){assert.fail();}},p)])assert.throws(denied);
});
test('Claude missing session or workspace refuses before querying',t=>{
 const {p,event,dir}=fixture(t);
 for(const changes of [{session_id:''},{session_id:undefined},{session_id:'x\n'},{session_id:'x'.repeat(257)},{cwd:dir}])assert.throws(()=>claudeTaskRequest({...event,...changes},p));
});
test('last mile sends exactly one existing read tool without registration or capture',async t=>{
 const {p,input,result}=fixture(t);const calls=[];
 const actual=await deliverTaskContext(input,p,{checkIdentity:async()=>{calls.push('identity');},invoke:async(name,args)=>{calls.push({name,args});return result;}});
 assert.deepEqual(actual,result);assert.equal(calls.length,2);assert.equal(calls[1].name,'ultra_personal_context');
 assert.equal(calls[1].args.task,input.task);assert.ok(!JSON.stringify(actual).includes(input.task));
});
test('snapshot taken before async identity wait preserves original consented task',async t=>{
 const {p,input,result}=fixture(t);const original={...input};
 await deliverTaskContext(input,p,{checkIdentity:async()=>{input.task='CHANGED';input.consent=false;input.workspace='/different';},invoke:async(_name,args)=>{assert.equal(args.task,original.task);return result;}});
});
test('revocation after identity check prevents task text transmission',async t=>{
 const {p,input}=fixture(t);let permitted=true;
 await assert.rejects(deliverTaskContext(input,p,{checkIdentity:async()=>{permitted=false;},authorize:()=>permitted,
   invoke:async()=>assert.fail('Task sent after revocation')}),{code:'task_context_disabled'});
});
test('authorization revoked while response in flight suppresses stale result',async t=>{
 const {p,input,result}=fixture(t);let allowed=true,count=0;
 await assert.rejects(deliverTaskContext(input,p,{checkIdentity:async()=>{},authorize:()=>allowed,invoke:async()=>{count++;allowed=false;return result;}}),{code:'task_context_disabled'});
 assert.equal(count,1); // Already sent request cannot be retracted or relabelled as unsent.
});
test('identity error propagates without sending task',async t=>{
 const {p,input}=fixture(t);
 await assert.rejects(deliverTaskContext(input,p,{checkIdentity:async()=>{throw new UltraError('identity_mismatch','synthetic');},invoke:async()=>assert.fail()}),{code:'identity_mismatch'});
});
for(const when of ['before','identity','authorize','response'])test('abort '+when+' blocks new requests or stale response',async t=>{
 const {p,input,result}=fixture(t);const controller=new AbortController();let sent=0;
 if(when==='before')controller.abort();
 await assert.rejects(deliverTaskContext(input,p,{signal:controller.signal,checkIdentity:async()=>{if(when==='identity')controller.abort();},
   authorize:()=>{if(when==='authorize')controller.abort();},invoke:async()=>{sent++;if(when==='response')controller.abort();return result;}}),{code:'aborted'});
 assert.equal(sent,when==='response'?1:0);
});
test('async authorization assertions fail rather than create a send race',async t=>{
 const {p,input}=fixture(t);await assert.rejects(deliverTaskContext(input,p,{checkIdentity:async()=>assert.fail(),authorize:async()=>{},invoke:async()=>assert.fail()}),{code:'invalid_params'});
});
test('bad response, foreign project, non-active entries or oversize do not reach Agent',async t=>{
 const {p,input,result,row}=fixture(t);
 const bad=[{...result,source_id:'other'},{...result,memories:[{...row,status:'candidate'}]},
  {...result,memories:[{...row,project_id:'foreign'}]},{...result,memories:[{...row,derivation_current:false}]},{...result,padding:'x'.repeat(6000)}];
 for(const value of bad)await assert.rejects(deliverTaskContext(input,p,{checkIdentity:async()=>{},invoke:async()=>value}),{code:'mcp_contract_changed'});
});
