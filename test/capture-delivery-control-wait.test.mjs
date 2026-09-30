/** Real queue contention outlasts the production one-second acquire window.
 * No timing gamble: parent releases its own lock only AFTER actual outbox_busy.
 * A retry must keep the event/hash; a permanent/ambiguous IO error never qualifies. */
import test from 'node:test';import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,unlinkSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {fileURLToPath} from 'node:url';
import {CaptureOutbox} from '../src/capture-outbox.mjs';
const worker=fileURLToPath(new URL('./fixtures/capture-delivery-control-worker.mjs',import.meta.url));
const preload=new URL('./fixtures/capture-control-held-lock-preload.mjs',import.meta.url).href;
for(const phase of ['enqueue','resume','stale-resume'])test('control wait: retain exact selection after real busy '+phase,async()=>{
 const root=mkdtempSync(join(tmpdir(),'ub-held-control-')),workspace=join(root,'work');mkdirSync(workspace,{mode:0o700});
 const input={format:1,source:'synthetic',workspace,outbox_directory:join(root,'queue'),allow_capture:true,
  expected_actor:'a'.repeat(64),expected_instance:'11111111-1111-4111-8111-111111111111',server:{transport:'stdio',command:'never-executed',args:[]}};
 let child,closed=false,timer,primary,markerHeld=false;const marker='SYNTHETIC_PARENT_LOCK',lock=join(input.outbox_directory,'.queue.lock');
 try{
  const q=new CaptureOutbox(input),pause=await q.pauseDelivery();let output='',stderr='',busy=0;
  const hold=()=>{writeFileSync(lock,marker,{flag:'wx',mode:0o600});markerHeld=true;};
  if(phase==='enqueue')hold();
  child=spawn(process.execPath,['--import',preload,worker],{stdio:['ignore','pipe','pipe','ipc'],
   env:{...process.env,ULTRABRAIN_CONTROL_HELD_PHASE:phase==='enqueue'?'enqueue':'resume'}});
  child.stdout.on('data',b=>{output+=b;if(output.length>4096)child.kill('SIGKILL');});child.stderr.on('data',b=>stderr+=b);
  child.on('message',m=>{void (async()=>{
   if(m.ready)child.send({input,worker:0});
   else if(m.busy_observed){
    busy++;assert.equal(readFileSync(lock,'utf8'),marker);unlinkSync(lock);markerHeld=false;
    child.send({lock_released:true});
   }else if(m.staged){
    if(phase==='stale-resume')await q.resumeDelivery(pause.control_sha256,{confirm:true});
    if(phase!=='enqueue')hold();
    child.send({expectedHash:pause.control_sha256});
   }else assert.fail('Unexpected synthetic checkpoint');
  })().catch(e=>{primary=e;child.kill('SIGKILL');});});
  timer=setTimeout(()=>child.kill('SIGKILL'),12000);
  const exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>{closed=true;resolve({code,signal});});});
  if(primary)throw primary;
  assert.equal(stderr,'');assert.equal(busy,1,'Must actually observe the original bounded EEXIST refusal');
  const report=JSON.parse(output);assert.deepEqual(exit,{code:0,signal:null},JSON.stringify(report));
  assert.equal(report.ok,true);assert.equal(report.outcome,phase==='stale-resume'?'conflict':'resumed');
  const status=await q.status();assert.equal(status.pending,1);assert.equal(status.delivery.state,'running');assert.equal(status.delivery.revision,2);
  const entries=readdirSync(q.directory).filter(n=>n.endsWith('.entry'));assert.equal(entries.length,1);
  const stored=JSON.parse(readFileSync(join(q.directory,entries[0])));assert.equal(stored.payload.event_id,'child-0');assert.equal(stored.attempts,0);
  assert.ok(!readdirSync(q.directory).some(n=>n.endsWith('.lock')||n.startsWith('.tmp-')));
 }finally{
  clearTimeout(timer);
  if(child&&!closed){child.kill('SIGKILL');await new Promise(resolve=>child.once('close',resolve));}
  if(markerHeld&&existsSync(lock)){assert.equal(readFileSync(lock,'utf8'),marker);unlinkSync(lock);}
  rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:30});
 }
});
