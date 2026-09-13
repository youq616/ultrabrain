import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {clientProfile} from '../src/client-kit.mjs';
import {claudeCapture,openCodeCapture,automaticCapture} from '../src/automatic-capture.mjs';
import {CaptureOutbox} from '../src/capture-outbox.mjs';
function setup(t){const d=mkdtempSync(join(tmpdir(),'ub-auto-'));t.after(()=>rmSync(d,{recursive:true,force:true}));const workspace=join(d,'work');mkdirSync(workspace,{mode:0o700});
 const input={format:1,source:'default',allow_capture:true,workspace,outbox_directory:join(d,'queue'),automatic_capture:['claude-user','claude-assistant','opencode-user','opencode-assistant'],
 expected_instance:'11111111-1111-4111-8111-111111111111',expected_actor:'a'.repeat(64),server:{transport:'stdio',command:'node',args:['trusted']}};
 const path=join(d,'profile.json');writeFileSync(path,JSON.stringify(input),{mode:0o600});return {input,p:clientProfile(input),path,d};}
const prompt=p=>({hook_event_name:'UserPromptSubmit',session_id:'session',prompt_id:'22222222-2222-4222-8222-222222222222',cwd:p.workspace,prompt:'不要使用 Docker Hub。'});
test('automatic capture remains off without separately selected modes',t=>{
 const {input,p}=setup(t);const no=clientProfile({...input,automatic_capture:[]});assert.throws(()=>claudeCapture(prompt(p),no),{code:'capture_disabled'});
 assert.throws(()=>clientProfile({...input,allow_capture:false}),{code:'invalid_profile'});
});
test('Claude stable prompt ID preserves repeated identical prompts as distinct events',t=>{
 const {p}=setup(t),a=claudeCapture(prompt(p),p),b=claudeCapture({...prompt(p),prompt_id:'33333333-3333-4333-8333-333333333333'},p);
 assert.notEqual(a.event_id,b.event_id);assert.equal(claudeCapture(prompt(p),p).event_id,a.event_id);
 assert.throws(()=>claudeCapture({...prompt(p),prompt_id:undefined},p),{code:'stable_event_required'});
});
test('Claude ignores arbitrary transcript paths, tools and hidden reasoning',t=>{
 const {p}=setup(t);const e={...prompt(p),tool_output:'SECRET_TOOL',thinking:'SECRET_THOUGHT'};Object.defineProperty(e,'transcript_path',{get(){assert.fail('Must not read transcript_path');}});
 const value=JSON.stringify(claudeCapture(e,p));assert.ok(!value.includes('SECRET_'));assert.ok(value.includes('不要使用'));
});
test('subagents and stop-hook continuations are not automatically captured',t=>{
 const {p}=setup(t);assert.equal(claudeCapture({...prompt(p),agent_id:'child'},p),null);
 assert.equal(claudeCapture({...prompt(p),hook_event_name:'Stop',stop_hook_active:true,last_assistant_message:'not final'},p),null);
});
test('assistant output stays labelled an unverified assistant observation',t=>{
 const {p}=setup(t);const r=claudeCapture({...prompt(p),hook_event_name:'Stop',stop_hook_active:false,last_assistant_message:'已完成合成任务。'},p),body=JSON.parse(r.transcript);
 assert.equal(body.role,'assistant');assert.match(body.trust,/not user confirmation/);assert.equal(body.texts[0],'已完成合成任务。');
});
test('wrong workspace and oversized or ill-formed text fail without truncation',t=>{
 const {p,d}=setup(t);assert.throws(()=>claudeCapture({...prompt(p),cwd:d},p),{code:'workspace_mismatch'});
 for(const text of ['x'.repeat(40000),'\ud800'])assert.throws(()=>claudeCapture({...prompt(p),prompt:text},p),{code:'invalid_params'});
});
test('OpenCode captures only real plain user parts, preserving negative statements',t=>{
 const {p}=setup(t);const r=openCodeCapture('user',{sessionID:'s',messageID:'m'},
 {message:{role:'user',id:'m',sessionID:'s'},parts:[{type:'text',text:'不要删除。'},{type:'text',text:'SECRET',synthetic:true},{type:'file',url:'file:///secret'},{type:'text',text:'IGNORE',ignored:true}]},p,p.workspace);
 assert.deepEqual(JSON.parse(r.transcript).texts,['不要删除。']);assert.ok(!r.transcript.includes('SECRET'));
});
test('OpenCode rejects identity mismatch and keeps assistant part IDs stable',t=>{
 const {p}=setup(t);assert.throws(()=>openCodeCapture('user',{sessionID:'s'},{message:{role:'assistant',id:'m',sessionID:'s'},parts:[]},p,p.workspace));
 const input={sessionID:'s',messageID:'m',partID:'part'},r=openCodeCapture('assistant',input,{text:'answer'},p,p.workspace);
 assert.equal(openCodeCapture('assistant',input,{text:'answer'},p,p.workspace).event_id,r.event_id);
 assert.notEqual(openCodeCapture('assistant',{...input,partID:'other'},{text:'answer'},p,p.workspace).event_id,r.event_id);
});
test('manager journals before failed connect and notices profile revocation',async t=>{
 const {p,path,input}=setup(t),writer=automaticCapture(path,async()=>{throw Error('offline SECRET');});t.after(()=>writer.close());
 const r=await writer.submit(claudeCapture(prompt(p),p),p.workspace,'claude-user');assert.equal(r.storage,'client_journal');assert.equal(r.delivery.retained,1);
 assert.equal((await new CaptureOutbox(input).status()).pending,1);assert.ok(!JSON.stringify(r).includes('SECRET'));
 writeFileSync(path,JSON.stringify({...input,automatic_capture:[],allow_capture:false}));
 await assert.rejects(writer.submit(claudeCapture(prompt(p),p),p.workspace,'claude-user'),{code:'capture_disabled'});
});

import {createOpenCodePlugin} from '../packages/ultrabrain-client/src/native-adapters.mjs';
test('OpenCode real hook shape gates primary-session metadata and never mutates host output',async t=>{
 const {input,p,path}=setup(t);const captured=[],logs=[];
 const connection={identity:{format:1,source_id:p.source,actor_key:p.expectedActor,instance_id:p.expectedInstance},
 capture:async payload=>{captured.push(payload);return {source_id:p.source,event_id:payload.event_id,storage:'journaled',job_id:'33333333-3333-4333-8333-333333333333'};},close:async()=>{}};
 let parent=null;
 const hooks=await createOpenCodePlugin({profilePath:path},async()=>connection)({directory:p.workspace,client:{session:{get:async({path})=>({data:{id:path.id,directory:p.workspace,parentID:parent}})},app:{log:async data=>logs.push(data)}}});
 t.after(()=>hooks.dispose());
 const user={message:{role:'user',id:'m',sessionID:'s'},parts:[{type:'text',text:'hello'}]};const before=JSON.stringify(user);
 await hooks['chat.message']({sessionID:'s'},user);assert.equal(captured.length,1);assert.equal(JSON.stringify(user),before);
 const assistant={text:'answer'};await hooks['experimental.text.complete']({sessionID:'s',messageID:'a',partID:'p'},assistant);assert.deepEqual(assistant,{text:'answer'});assert.equal(captured.length,2);
 parent='parent';await hooks['chat.message']({sessionID:'child'},{message:{role:'user',id:'child-message',sessionID:'child'},parts:[{type:'text',text:'CHILD_SECRET'}]});assert.equal(captured.length,2);
 assert.ok(!JSON.stringify(logs).includes('CHILD_SECRET'));assert.equal((await new CaptureOutbox(input).status()).pending,0);
});
test('revoked scope is rechecked after waiting for the short writer lock',async t=>{
 const {input,p,path}=setup(t);const queue=new CaptureOutbox(input);await queue.status();
 const {unlinkSync}=await import('node:fs');const lock=join(queue.directory,'.queue.lock');writeFileSync(lock,JSON.stringify({pid:process.pid}),{mode:0o600});
 const writer=automaticCapture(path,()=>assert.fail('No network after revocation'));t.after(()=>writer.close());
 const pending=writer.submit(claudeCapture(prompt(p),p),p.workspace,'claude-user');
 writeFileSync(path,JSON.stringify({...input,automatic_capture:[],allow_capture:false}));unlinkSync(lock);
 await assert.rejects(pending,{code:'capture_disabled'});assert.equal((await queue.status()).pending,0);
});
