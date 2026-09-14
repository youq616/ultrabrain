import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,unlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CaptureOutbox} from '../src/capture-outbox.mjs';
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
