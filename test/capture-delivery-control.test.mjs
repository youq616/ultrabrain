/** Real local journals; server receipts in these tests are explicitly synthetic. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {CaptureOutbox} from '../src/capture-outbox.mjs';
import {deliverCapture} from '../src/capture-delivery.mjs';
import {automaticCapture} from '../src/automatic-capture.mjs';
const CONTROL='delivery-control.json';
function setup(t){
 const root=mkdtempSync(join(tmpdir(),'ub-delivery-control-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const workspace=join(root,'work');mkdirSync(workspace,{mode:0o700});
 const input={format:1,source:'personal',allow_capture:true,automatic_capture:['claude-user'],workspace,outbox_directory:join(root,'queue'),
  expected_actor:'a'.repeat(64),expected_instance:'11111111-1111-4111-8111-111111111111',server:{transport:'stdio',command:'never-executed',args:[]}};
 const profilePath=join(root,'profile.json');writeFileSync(profilePath,JSON.stringify(input),{mode:0o600});
 return {root,input,profilePath,q:new CaptureOutbox(input)};
}
const item=(id='one')=>({agent_id:'fixture',event_id:id,consent:true,transcript:'SYNTHETIC_PRIVATE_TEXT'});
const connection=(input,capture)=>({identity:{format:1,source_id:input.source,instance_id:input.expected_instance,actor_key:input.expected_actor},capture,close:async()=>{}});
const receipt=p=>({source_id:'personal',event_id:p.event_id,storage:'journaled',job_id:'22222222-2222-4222-8222-222222222222'});
const entries=q=>Object.fromEntries(readdirSync(q.directory).filter(n=>n.endsWith('.entry')).map(n=>[n,readFileSync(join(q.directory,n),'utf8')]));
test('delivery control: legacy queue is running without creating a control record',async t=>{
 const {q}=setup(t);await q.enqueue(item());const before=entries(q),s=await q.status();
 assert.deepEqual(s.delivery,{format:1,state:'running',revision:0,changed_at:null,control_sha256:null,persisted:false});
 assert.deepEqual(entries(q),before);assert.equal(existsSync(join(q.directory,CONTROL)),false);
});
test('delivery control: pause survives reopening, permits local consented enqueue and prevents connection',async t=>{
 const {q,input}=setup(t);await q.enqueue(item());const before=entries(q),p=await q.pauseDelivery();
 assert.equal(p.state,'paused');assert.match(p.control_sha256,/^[a-f0-9]{64}$/);assert.equal(p.revision,1);
 const reopened=new CaptureOutbox(input);assert.deepEqual((await reopened.status()).delivery,p);
 assert.deepEqual(entries(q),before);await reopened.enqueue(item('two'));const all=entries(q);
 await assert.rejects(reopened.flush(()=>assert.fail('Paused journal must not connect')),{code:'outbox_paused'});
 assert.deepEqual(entries(q),all);assert.ok(Object.values(all).every(b=>JSON.parse(b).attempts===0));
});
test('delivery control: matching explicit resume changes only control, never sends or resets attempts',async t=>{
 const {q,input}=setup(t);await q.enqueue(item());await q.flush(async()=>{throw Error('offline');});
 const before=entries(q),p=await q.pauseDelivery();const r=await q.resumeDelivery(p.control_sha256,{confirm:true});
 assert.equal(r.state,'running');assert.equal(r.revision,2);assert.notEqual(r.control_sha256,p.control_sha256);assert.deepEqual(entries(q),before);
 const skipped=await q.flush(()=>assert.fail('Resume must retain backoff'));assert.equal(skipped.skipped,1);
 assert.equal((await q.flush(async()=>connection(input,async p=>receipt(p)),{retryBlocked:true})).delivered,1);
});
test('delivery control: a second pause invalidates an older resume observation',async t=>{
 const {q}=setup(t);const first=await q.pauseDelivery(),second=await q.pauseDelivery();assert.equal(second.revision,2);
 assert.notEqual(first.control_sha256,second.control_sha256);
 await assert.rejects(q.resumeDelivery(first.control_sha256,{confirm:true}),{code:'conflict'});
 assert.deepEqual((await q.status()).delivery,second);
});
test('delivery control: old token cannot authorize a later pause after resume',async t=>{
 const {q}=setup(t);const a=await q.pauseDelivery();await q.resumeDelivery(a.control_sha256,{confirm:true});const b=await q.pauseDelivery();
 await assert.rejects(q.resumeDelivery(a.control_sha256,{confirm:true}),{code:'conflict'});
 assert.equal((await q.status()).delivery.control_sha256,b.control_sha256);
});
test('delivery control: pause while connect waits stops private transmission, preserving reserved attempt',async t=>{
 const {q,input}=setup(t);await q.enqueue(item());let entered,finish;const began=new Promise(r=>entered=r),wait=new Promise(r=>finish=r);
 const flush=q.flush(async()=>{entered();await wait;return connection(input,()=>assert.fail('No body after pause'));});await began;
 await new CaptureOutbox(input).pauseDelivery();finish();const r=await flush;
 assert.equal(r.delivered,0);assert.equal(r.retained,1);assert.equal(r.last_error,'outbox_paused');
 const stored=JSON.parse(Object.values(entries(q))[0]);assert.equal(stored.attempts,1);assert.deepEqual(stored.payload,item());
});
test('delivery control: valid in-flight acknowledgement is still accounted after pause',async t=>{
 const {q,input}=setup(t);await q.enqueue(item());let entered,finish;const began=new Promise(r=>entered=r),wait=new Promise(r=>finish=r);
 const flush=q.flush(async()=>connection(input,async p=>{entered();await wait;return receipt(p);}));await began;
 await new CaptureOutbox(input).pauseDelivery();finish();const r=await flush;
 assert.equal(r.delivered,1);assert.deepEqual(entries(q),{});assert.equal((await q.status()).delivery.state,'paused');
});
test('delivery control: automatic capture reports local retention while paused',async t=>{
 const {q,input,profilePath}=setup(t);await q.pauseDelivery();const writer=automaticCapture(profilePath,()=>assert.fail('No connection'),{authorizedProfileInput:input});t.after(()=>writer.close());
 const r=await writer.submit(item(),input.workspace,'claude-user');assert.equal(r.storage,'client_journal');assert.equal(r.delivery.last_error,'outbox_paused');
 assert.equal(JSON.parse(Object.values(entries(q))[0]).attempts,0);
});
for(const changes of [{source:'other'},{expected_actor:'b'.repeat(64)},{project_id:'other'},{server:{transport:'stdio',command:'other',args:[]}}])
test('delivery control: foreign profile cannot pause or resume '+Object.keys(changes)[0],async t=>{
 const {q,input}=setup(t);const paused=await q.pauseDelivery(),before=readFileSync(join(q.directory,CONTROL));
 const other=new CaptureOutbox({...input,...changes});await assert.rejects(other.pauseDelivery(),{code:'identity_mismatch'});
 await assert.rejects(other.resumeDelivery(paused.control_sha256,{confirm:true}),{code:'identity_mismatch'});
 assert.deepEqual(readFileSync(join(q.directory,CONTROL)),before);
});
test('delivery control: disabled capture may pause but never resume',async t=>{
 const {q,input}=setup(t);const disabled=new CaptureOutbox({...input,allow_capture:false,automatic_capture:[]}),p=await disabled.pauseDelivery();
 await assert.rejects(disabled.resumeDelivery(p.control_sha256,{confirm:true}),{code:'capture_disabled'});
 assert.deepEqual((await q.status()).delivery,p);
});
for(const [hash,confirm] of [[undefined,true],['0'.repeat(64),false],['0'.repeat(64),'true'],['X'.repeat(64),true],[{toString:()=> '0'.repeat(64)},true]])
test('delivery control: malformed or unconfirmed resume cannot change state '+typeof hash+'/'+String(confirm),async t=>{
 const {q}=setup(t);const paused=await q.pauseDelivery();await assert.rejects(q.resumeDelivery(hash,{confirm}),{code:'invalid_params'});
 assert.deepEqual((await q.status()).delivery,paused);
});
test('delivery control: resume without a pause cannot create one or start sending',async t=>{
 const {q}=setup(t);await assert.rejects(q.resumeDelivery('0'.repeat(64),{confirm:true}),{code:'conflict'});
 assert.equal(existsSync(join(q.directory,CONTROL)),false);
});
for(const op of ['pause','resume']){
 test('delivery control: pre-aborted '+op+' does not change control or entries',async t=>{
  const {q}=setup(t);await q.enqueue(item());const p=await q.pauseDelivery(),before=readFileSync(join(q.directory,CONTROL));
  const c=new AbortController();c.abort();const promise=op==='pause'?q.pauseDelivery({signal:c.signal}):q.resumeDelivery(p.control_sha256,{confirm:true,signal:c.signal});
  await assert.rejects(promise,{code:'aborted'});assert.deepEqual(readFileSync(join(q.directory,CONTROL)),before);
 });
 test('delivery control: cancellation while '+op+' waits leaves foreign lock and control intact',async t=>{
  const {q}=setup(t);const p=await q.pauseDelivery(),path=join(q.directory,CONTROL),before=readFileSync(path);
  const lock=join(q.directory,'.queue.lock'),bytes=JSON.stringify({pid:process.pid});writeFileSync(lock,bytes,{mode:0o600});
  const c=new AbortController(),promise=op==='pause'?q.pauseDelivery({signal:c.signal}):q.resumeDelivery(p.control_sha256,{confirm:true,signal:c.signal});setImmediate(()=>c.abort());
  await assert.rejects(promise,{code:'aborted'});assert.deepEqual(readFileSync(path),before);assert.equal(readFileSync(lock,'utf8'),bytes);
 });
 for(const [name,authorize,code] of [['denied',()=>false,'capture_disabled'],['async',async()=>true,'invalid_params'],['async-rejection',async()=>{throw Error('PRIVATE');},'invalid_params']])
 test('delivery control: '+name+' authorization cannot '+op,async t=>{
  const {q}=setup(t);const p=await q.pauseDelivery(),before=readFileSync(join(q.directory,CONTROL));
  await assert.rejects(op==='pause'?q.pauseDelivery({authorize}):q.resumeDelivery(p.control_sha256,{confirm:true,authorize}),{code});
  assert.deepEqual(readFileSync(join(q.directory,CONTROL)),before);await new Promise(r=>setImmediate(r));
 });
}
test('delivery control: resume does not reset blocked events or their last error',async t=>{
 const {q}=setup(t);await q.enqueue(item());await q.flush(async()=>{throw Object.assign(Error('denied'),{code:'permission_denied'});});
 assert.equal((await q.status()).blocked,1);const before=entries(q),p=await q.pauseDelivery();await q.resumeDelivery(p.control_sha256,{confirm:true});
 assert.deepEqual(entries(q),before);assert.equal((await q.flush(()=>assert.fail('Blocked must stay blocked'))).skipped,1);
});
test('delivery control: explicit blocked retry does not bypass a pause',async t=>{
 const {q}=setup(t);await q.enqueue(item());await q.pauseDelivery();const before=entries(q);
 await assert.rejects(q.flush(()=>assert.fail('No connect'),{retryBlocked:true}),{code:'outbox_paused'});assert.deepEqual(entries(q),before);
});
test('delivery control: last-mile registration checks pause before private capture',async t=>{
 const {q,input}=setup(t);await q.enqueue(item());const calls=[];
 const result=await q.flush(async()=>connection(input,(p,{authorize})=>deliverCapture(p,q.profile,{authorize,checkIdentity:async()=>{},invoke:async name=>{
  calls.push(name);if(name==='ultra_agent_list')return {source_id:input.source,agents:[],next_offset:null};
  if(name==='ultra_agent_register'){await new CaptureOutbox(input).pauseDelivery();return {};}
  assert.fail('Private body must not be sent');
 }})));
 assert.deepEqual(calls,['ultra_agent_list','ultra_agent_register']);assert.equal(result.retained,1);assert.equal(result.last_error,'outbox_paused');
});
test('delivery control: unconfirmed in-flight response is retained after pause',async t=>{
 const {q,input}=setup(t);await q.enqueue(item());const report=await q.flush(async()=>connection(input,async()=>{
  await new CaptureOutbox(input).pauseDelivery();throw Error('SYNTHETIC_PRIVATE_TRANSPORT_ERROR');
 }));
 assert.equal(report.retained,1);assert.equal(report.delivered,0);assert.equal(report.last_error,'delivery_unconfirmed');
 assert.deepEqual(JSON.parse(Object.values(entries(q))[0]).payload,item());assert.ok(!JSON.stringify(report).includes('PRIVATE'));
});
test('delivery control: idempotent local replay remains possible while paused',async t=>{
 const {q}=setup(t);await q.enqueue(item());await q.pauseDelivery();const before=entries(q);
 assert.equal((await q.enqueue(item())).replayed,true);assert.deepEqual(entries(q),before);
});
