/** Explicit automatic-capture manager and delivery lifecycle regressions. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {automaticCapture} from '../src/automatic-capture.mjs';
import {CaptureOutbox} from '../src/capture-outbox.mjs';
function setup(t){
 const root=mkdtempSync(join(tmpdir(),'ub-lock-lifecycle-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const workspace=join(root,'work');mkdirSync(workspace,{mode:0o700});
 const input={format:1,source:'personal',workspace,allow_capture:true,automatic_capture:['claude-user'],outbox_directory:join(root,'queue'),
  expected_actor:'a'.repeat(64),expected_instance:'11111111-1111-4111-8111-111111111111',server:{transport:'stdio',command:'never-executed',args:[]}};
 const path=join(root,'profile.json');writeFileSync(path,JSON.stringify(input),{mode:0o600});
 return {input,path,q:new CaptureOutbox(input)};
}
const payload=()=>({agent_id:'fixture',event_id:'stable',consent:true,transcript:'SYNTHETIC_PRIVATE_BODY'});
const connection=(input,capture)=>({identity:{format:1,source_id:input.source,instance_id:input.expected_instance,actor_key:input.expected_actor},capture,close:async()=>{}});
const receipt=input=>({source_id:input.source,event_id:'stable',storage:'journaled',job_id:'22222222-2222-4222-8222-222222222222'});
test('lifecycle: automatic manager close aborts its enqueue, not just its network phase',async t=>{
 const {input,path,q}=setup(t);await q.status();const lock=join(q.directory,'.queue.lock'),bytes=JSON.stringify({pid:process.pid});
 writeFileSync(lock,bytes,{mode:0o600});
 const writer=automaticCapture(path,()=>assert.fail('No connection'),{authorizedProfileInput:input});
 const work=writer.submit(payload(),input.workspace,'claude-user');writer.close();
 await assert.rejects(work,e=>['aborted','capture_disabled'].includes(e.code));assert.equal(readFileSync(lock,'utf8'),bytes);
 assert.equal(readdirSync(q.directory).filter(n=>n.endsWith('.entry')).length,0);
});
test('lifecycle: cancellation after local persistence preserves the enqueue receipt',async t=>{
 const {input,path,q}=setup(t);let writes=0;
 const writer=automaticCapture(path,async()=>{writer.close();return connection(input,async()=>{writes++;return receipt(input);});},{authorizedProfileInput:input});
 const result=await writer.submit(payload(),input.workspace,'claude-user');
 assert.equal(result.storage,'client_journal');assert.equal(result.delivery.delivered,0);assert.equal(writes,0);assert.equal((await q.status()).pending,1);
});
test('lifecycle: cancellation during the first queue wait does not spend retries or delete locks',async t=>{
 const {q}=setup(t);await q.enqueue(payload());const lock=join(q.directory,'.queue.lock');
 writeFileSync(lock,JSON.stringify({pid:process.pid}),{mode:0o600});const filename=readdirSync(q.directory).find(n=>n.endsWith('.entry')),before=readFileSync(join(q.directory,filename));
 const c=new AbortController(),work=q.flush(()=>assert.fail('No connection'),{signal:c.signal});setImmediate(()=>c.abort());
 await assert.rejects(work,{code:'aborted'});assert.deepEqual(readFileSync(join(q.directory,filename)),before);
 assert.ok(existsSync(lock));assert.ok(!existsSync(join(q.directory,'.delivery.lock')));
});
test('lifecycle: confirmed server receipt still removes exactly its record after cancellation',async t=>{
 const {input,q}=setup(t);await q.enqueue(payload());const c=new AbortController();let sent=0;
 const result=await q.flush(async()=>connection(input,async()=>{sent++;c.abort();return receipt(input);}),{signal:c.signal});
 assert.equal(sent,1);assert.equal(result.delivered,1);assert.equal((await q.status()).pending,0);
});
test('lifecycle: uncertain submission retains immutable payload and bounded attempt state after cancellation',async t=>{
 const {input,q}=setup(t);await q.enqueue(payload());const c=new AbortController();
 const result=await q.flush(async()=>connection(input,async()=>{c.abort();throw Error('PRIVATE_FAILURE');}),{signal:c.signal});
 assert.equal(result.retained,1);assert.equal(result.delivered,0);
 const file=readdirSync(q.directory).find(n=>n.endsWith('.entry')),r=JSON.parse(readFileSync(join(q.directory,file)));
 assert.deepEqual(r.payload,payload());assert.equal(r.attempts,1);assert.ok(!JSON.stringify(result).includes('PRIVATE'));
});
