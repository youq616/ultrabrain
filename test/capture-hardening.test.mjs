import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,unlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CaptureOutbox} from '../src/capture-outbox.mjs';
import {deliverCapture} from '../src/capture-delivery.mjs';
function setup(t) {
  const root=mkdtempSync(join(tmpdir(),'ub-capture-hardening-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const workspace=join(root,'work');mkdirSync(workspace,{mode:0o700});
  const input={format:1,source:'default',allow_capture:true,workspace,outbox_directory:join(root,'queue'),
    expected_instance:'11111111-1111-4111-8111-111111111111',expected_actor:'a'.repeat(64),
    server:{transport:'stdio',command:'node',args:['synthetic-only.mjs']}};
  return {input,q:new CaptureOutbox(input)};
}
const payload=()=>({agent_id:'fixture',event_id:'original',transcript:'original consented input',consent:true});
const conn=(input,capture)=>({identity:{format:1,source_id:input.source,instance_id:input.expected_instance,actor_key:input.expected_actor},capture,close:async()=>{}});
const receipt=input=>({source_id:input.source,event_id:'original',storage:'journaled',job_id:'22222222-2222-4222-8222-222222222222'});
test('enqueue snapshots consented bytes before waiting for another writer',async t=>{
  const {q}=setup(t);await q.status();const lock=join(q.directory,'.queue.lock');
  writeFileSync(lock,JSON.stringify({pid:process.pid}),{mode:0o600});
  const data=payload(),queued=q.enqueue(data);
  data.transcript='changed after consent validation';data.event_id='changed';data.consent=false;
  unlinkSync(lock);await queued;
  assert.equal((await q.status()).pending,1);
  const record=JSON.parse(readFileSync(join(q.directory,readdirSync(q.directory).find(x=>x.endsWith('.entry')))));
  assert.deepEqual(record.payload,payload());
});
test('a cancellation during connection cannot submit queued plaintext',async t=>{
  const {input,q}=setup(t);await q.enqueue(payload());const controller=new AbortController();let sent=0;
  const report=await q.flush(async()=>{controller.abort();return conn(input,async()=>{sent++;return receipt(input);});},{signal:controller.signal});
  assert.equal(sent,0);assert.equal(report.delivered,0);assert.equal((await q.status()).pending,1);
});
test('inherited consent cannot authorize a journal record',async t=>{
  const {q}=setup(t);const data=Object.assign(Object.create({consent:true}),{agent_id:'fixture',event_id:'original',transcript:'not own consent'});
  await assert.rejects(q.enqueue(data));
  assert.equal(readdirSync(q.directory).filter(x=>x.endsWith('.entry')).length,0);
});
for(const [kind,authorize,code] of [['false',()=>false,'capture_disabled'],['async false',async()=>false,'invalid_params'],
 ['async rejection',async()=>{throw Error('synthetic denial');},'invalid_params'],['non-function',false,'invalid_params']]) {
 test('enqueue rejects '+kind+' authorization before persisting raw input',async t=>{
  const {q}=setup(t);await assert.rejects(q.enqueue(payload(),{authorize}),{code});
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(readdirSync(q.directory),[]);
 });
 test('flush rejects '+kind+' authorization before consuming retries or connecting',async t=>{
  const {q}=setup(t);await q.enqueue(payload());
  const path=join(q.directory,readdirSync(q.directory).find(x=>x.endsWith('.entry'))),original=readFileSync(path);
  await assert.rejects(q.flush(()=>assert.fail('No connection'),{authorize}),{code});
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(readFileSync(path),original);
 });
}
test('boolean revocation while waiting for the writer lock prevents plaintext persistence',async t=>{
 const {q}=setup(t);await q.status();const lock=join(q.directory,'.queue.lock');
 writeFileSync(lock,JSON.stringify({pid:process.pid}),{mode:0o600});
 let permitted=true;const queued=q.enqueue(payload(),{authorize:()=>permitted});
 permitted=false;unlinkSync(lock);
 await assert.rejects(queued,{code:'capture_disabled'});assert.equal((await q.status()).pending,0);
});
test('boolean revocation during connect retains the unchanged event without sending it',async t=>{
 const {input,q}=setup(t);await q.enqueue(payload());let permitted=true;
 const result=await q.flush(async()=>{permitted=false;return conn(input,()=>assert.fail('No plaintext transmission'));},{authorize:()=>permitted});
 assert.equal(result.delivered,0);assert.equal(result.blocked,1);assert.equal(result.last_error,'capture_disabled');
 const record=JSON.parse(readFileSync(join(q.directory,readdirSync(q.directory).find(x=>x.endsWith('.entry')))));
 assert.deepEqual(record.payload,payload());assert.equal(record.attempts,1);
});
for(const asynchronous of [false,true])test('queued last-mile registration rechecks '+(asynchronous?'asynchronous':'boolean')+' revocation before plaintext',async t=>{
 const {input,q}=setup(t);await q.enqueue(payload());let permitted=true;const calls=[];
 const result=await q.flush(async()=>conn(input,(p,{authorize})=>deliverCapture(p,q.profile,{authorize,
  checkIdentity:async()=>{},invoke:async name=>{calls.push(name);if(name==='ultra_agent_list')return {source_id:input.source,agents:[],next_offset:null};if(name==='ultra_agent_register')permitted=false;return receipt(input);}})),
  {authorize:()=>permitted?undefined:asynchronous?Promise.resolve(false):false});
 assert.deepEqual(calls,['ultra_agent_list','ultra_agent_register']);assert.equal(result.delivered,0);
 assert.equal((await q.status()).pending+(await q.status()).blocked,1);
});
test('confirmed receipt after transmission removes the event even when consent was subsequently revoked',async t=>{
 const {input,q}=setup(t);await q.enqueue(payload());let permitted=true;
 const result=await q.flush(async()=>conn(input,async()=>{permitted=false;return receipt(input);}),{authorize:()=>permitted});
 assert.equal(result.delivered,1);assert.equal((await q.status()).pending,0);assert.equal((await q.status()).blocked,0);
});
