/** Real Linux/Windows-capable processes; local run platform is recorded separately. */
import test from 'node:test';import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';import {mkdtempSync,mkdirSync,rmSync,readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';import {fileURLToPath} from 'node:url';
import {deliveryControlRound} from '../scripts/check-capture-delivery-control.mjs';
import {CaptureOutbox} from '../src/capture-outbox.mjs';
test('delivery process: eight enqueues while paused and exactly one CAS resume winner',async()=>{
 assert.deepEqual(await deliveryControlRound(),{passed:true,workers:8,consented_entries:8,resume_successes:1,stale_conflicts:7,payloads_unchanged:true,attempts_spent:0});
});
test('delivery process: committed pause survives actual writer termination and reopening',async t=>{
 const root=mkdtempSync(join(tmpdir(),'ub-control-kill-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const workspace=join(root,'work');mkdirSync(workspace,{mode:0o700});const input={format:1,source:'synthetic',allow_capture:true,workspace,
  outbox_directory:join(root,'queue'),expected_actor:'a'.repeat(64),expected_instance:'11111111-1111-4111-8111-111111111111',server:{transport:'stdio',command:'never-executed',args:[]}};
 const q=new CaptureOutbox(input);await q.enqueue({agent_id:'fixture',event_id:'one',consent:true,transcript:'SYNTHETIC_CRASH_INPUT'});
 const entry=join(q.directory,readdirSync(q.directory).find(n=>n.endsWith('.entry'))),before=readFileSync(entry);
 const child=spawn(process.execPath,[fileURLToPath(new URL('./fixtures/capture-delivery-control-worker.mjs',import.meta.url))],{stdio:['ignore','pipe','pipe','ipc']});
 const exited=new Promise(r=>child.once('close',r));let stderr='';child.stderr.on('data',b=>stderr+=b);child.stdout.resume();
 const timer=setTimeout(()=>child.kill('SIGKILL'),10000);
 try{
  const paused=await new Promise((resolve,reject)=>{
   child.once('error',reject);child.once('close',()=>reject(Error('No pause acknowledgement')));
   child.on('message',m=>{if(m?.ready)child.send({input,mode:'pause-hold'});if(m?.paused)resolve(m.paused);});
  });
  child.kill('SIGKILL');await exited;assert.equal(stderr,'');const reopened=new CaptureOutbox(input);
  assert.deepEqual((await reopened.status()).delivery,paused);assert.deepEqual(readFileSync(entry),before);
  await assert.rejects(reopened.flush(()=>assert.fail('A reopened paused journal must not connect')),{code:'outbox_paused'});
 }finally{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;}}
});
