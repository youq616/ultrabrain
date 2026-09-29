/** Real filesystem regressions for cancellation at cooperative lock boundaries. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync,readFileSync,readdirSync,existsSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {CaptureOutbox} from '../src/capture-outbox.mjs';
import {sha256} from '../src/core.mjs';
function setup(t){
 const dir=mkdtempSync(join(tmpdir(),'ub-lock-cancel-'));
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const workspace=join(dir,'workspace');mkdirSync(workspace,{mode:0o700});
 const input={format:1,source:'personal',workspace,outbox_directory:join(dir,'queue'),allow_capture:true,
  expected_actor:'a'.repeat(64),expected_instance:'11111111-1111-4111-8111-111111111111',
  server:{transport:'stdio',command:'not-started',args:[]}};
 return {q:new CaptureOutbox(input),input};
}
const payload=()=>({agent_id:'fixture',event_id:'stable',consent:true,transcript:'SYNTHETIC_PRIVATE_INPUT'});
for(const operation of ['enqueue','status','flush'])test('cancel: pre-aborted '+operation+' creates no manifest, lock or record',async t=>{
 const {q}=setup(t),c=new AbortController();c.abort();
 const work=operation==='enqueue'?q.enqueue(payload(),{signal:c.signal}):operation==='status'?q.status({signal:c.signal}):q.flush(()=>assert.fail('No connection'),{signal:c.signal});
 await assert.rejects(work,{code:'aborted'});assert.deepEqual(readdirSync(q.directory),[]);
});
test('cancel: pending queue acquisition aborts rather than timing out or deleting the owner lock',async t=>{
 const {q}=setup(t);await q.status();const path=join(q.directory,'.queue.lock');
 const bytes=JSON.stringify({pid:process.pid,lock_id:'synthetic-holder'});writeFileSync(path,bytes,{mode:0o600});
 const c=new AbortController(),work=q.enqueue(payload(),{signal:c.signal});
 setImmediate(()=>c.abort());await assert.rejects(work,{code:'aborted'});
 assert.equal(readFileSync(path,'utf8'),bytes);assert.ok(!existsSync(join(q.directory,sha256('stable')+'.entry')));
});
test('cancel: revocation during delivery-lock handoff spends no capture attempts',async t=>{
 const {q}=setup(t);await q.enqueue(payload());const file=join(q.directory,sha256('stable')+'.entry'),before=readFileSync(file);
 const c=new AbortController();
 await assert.rejects(q.flush(()=>assert.fail('No connection'),{signal:c.signal,authorize:()=>{
  if(existsSync(join(q.directory,'.delivery.lock')))c.abort();return true;
 }}),{code:'aborted'});
 assert.deepEqual(readFileSync(file),before);assert.ok(!existsSync(join(q.directory,'.delivery.lock')));
});
