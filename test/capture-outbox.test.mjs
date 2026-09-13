import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,readdirSync,rmSync,chmodSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {CaptureOutbox} from '../src/capture-outbox.mjs';
import {sha256} from '../src/core.mjs';
function setup(t){const dir=mkdtempSync(join(tmpdir(),'ub-queue-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const workspace=join(dir,'workspace');mkdirSync(workspace,{mode:0o700});
 const input={format:1,source:'personal',workspace,outbox_directory:join(dir,'outbox'),allow_capture:true,
 expected_actor:'a'.repeat(64),expected_instance:'11111111-1111-4111-8111-111111111111',server:{transport:'stdio',command:'node',args:['trusted-server.mjs']}};
 return {dir,input,q:new CaptureOutbox(input)};}
const item=(id='e',text='DO_NOT_UPLOAD_TO_LOG: do not use Docker Hub')=>({agent_id:'custom',event_id:id,transcript:text,consent:true});
function connection(input,overrides={}){return {identity:{format:1,source_id:input.source,instance_id:input.expected_instance,actor_key:input.expected_actor},capture:async p=>({source_id:input.source,event_id:p.event_id,storage:'journaled',job_id:'22222222-2222-4222-8222-222222222222'}),close:async()=>{},...overrides};}
test('queue persists before network, survives reopening and exposes no plaintext in status',async t=>{
 const {q,input}=setup(t);const r=await q.enqueue(item());assert.equal(r.storage,'client_journal');assert.equal((await new CaptureOutbox(input).status()).pending,1);
 assert.ok(!JSON.stringify(await q.status()).includes('DO_NOT_UPLOAD'));assert.equal(readdirSync(q.directory).filter(x=>x.endsWith('.entry')).length,1);
});
test('local event replay is idempotent and changed text is rejected',async t=>{
 const {q}=setup(t);assert.equal((await q.enqueue(item())).replayed,false);assert.equal((await q.enqueue(item())).replayed,true);
 await assert.rejects(q.enqueue(item('e','changed')),{code:'conflict'});assert.equal((await q.status()).pending,1);
});
test('consent must be granted before any raw-text write',async t=>{
 const {q}=setup(t);await assert.rejects(q.enqueue({...item(),consent:false}),{code:'capture_disabled'});assert.deepEqual(readdirSync(q.directory),[]);
});
test('different destination/actor/source/project cannot take over a nonempty journal',async t=>{
 const {q,input}=setup(t);await q.enqueue(item());
 for(const changes of [{expected_actor:'b'.repeat(64)},{source:'other'},{project_id:'other'},{server:{...input.server,args:['other-server']}}])
  await assert.rejects(new CaptureOutbox({...input,...changes}).status(),{code:'identity_mismatch'});
 assert.equal((await q.status()).pending,1);
});
test('disable capture preserves inspectability but denies sending',async t=>{
 const {q,input}=setup(t);await q.enqueue(item());const disabled=new CaptureOutbox({...input,allow_capture:false});assert.equal((await disabled.status()).pending,1);
 await assert.rejects(disabled.flush(()=>{assert.fail('Must not connect');}),{code:'capture_disabled'});
});
test('queue missing pins or inside a workspace is refused',t=>{
 const {input}=setup(t);assert.throws(()=>new CaptureOutbox({...input,expected_actor:undefined}));assert.throws(()=>new CaptureOutbox({...input,outbox_directory:join(input.workspace,'queue')}),{code:'insecure_outbox'});
});
test('one validated journal receipt removes the local payload',async t=>{
 const {q,input}=setup(t);await q.enqueue(item());let submitted=0;
 const r=await q.flush(async()=>connection(input,{capture:async p=>{submitted++;assert.equal(p.transcript,item().transcript);return {source_id:input.source,event_id:p.event_id,storage:'journaled',job_id:'22222222-2222-4222-8222-222222222222'};}}));
 assert.equal(r.delivered,1);assert.equal(submitted,1);assert.equal((await q.status()).pending,0);
});
test('lost acknowledgement retains immutable event and can safely replay',async t=>{
 const {q,input}=setup(t);await q.enqueue(item());const received=new Map();let calls=0;
 const connect=async()=>connection(input,{capture:async p=>{calls++;received.set(p.event_id,p.transcript);if(calls===1)throw Error('private provider error TOKEN');return {source_id:input.source,event_id:p.event_id,storage:'journaled',job_id:'22222222-2222-4222-8222-222222222222'};}});
 const first=await q.flush(connect);assert.equal(first.retained,1);assert.ok(!JSON.stringify(first).includes('TOKEN'));
 assert.equal((await q.flush(connect)).skipped,1);assert.equal(calls,1);
 const next=await new CaptureOutbox(input).flush(connect,{retryBlocked:true});assert.equal(next.delivered,1);assert.equal(received.size,1);assert.equal(calls,2);
});
for(const bad of [{source_id:'foreign'},{event_id:'other'},{storage:'queued'},{job_id:'not-a-uuid'}])test('invalid server receipt cannot remove an event '+JSON.stringify(bad),async t=>{
 const {q,input}=setup(t);await q.enqueue(item());const r=await q.flush(async()=>connection(input,{capture:async()=>({...await connection(input).capture(item()),...bad})}));assert.equal(r.blocked,1);assert.equal((await q.status()).blocked,1);
});
test('identity pin is checked before sending private payload',async t=>{
 const {q,input}=setup(t);await q.enqueue(item());let sent=false;const r=await q.flush(async()=>connection(input,{identity:{...connection(input).identity,actor_key:'b'.repeat(64)},capture:async()=>{sent=true;}}));
 assert.equal(r.blocked,1);assert.equal(r.last_error,'identity_mismatch');assert.equal(sent,false);
});
test('revocation after connect prevents payload submission',async t=>{
 const {q,input}=setup(t);await q.enqueue(item());let calls=0,sent=false;
 const r=await q.flush(async()=>connection(input,{capture:async()=>{sent=true;}}),{authorize:()=>{if(++calls>1){const e=Error();e.code='capture_disabled';throw e;}}});
 assert.equal(r.blocked,1);assert.equal(sent,false);
});
test('enqueue stays available while another drainer awaits the network',async t=>{
 const {q,input}=setup(t);await q.enqueue(item());let begin,release;const entered=new Promise(r=>begin=r),wait=new Promise(r=>release=r);
 const first=q.flush(async()=>connection(input,{capture:async p=>{begin();await wait;return connection(input).capture(p);}}));await entered;
 await q.enqueue(item('second'));await assert.rejects(new CaptureOutbox(input).flush(()=>assert.fail('not reached')),{code:'outbox_busy'});
 assert.equal((await q.status()).pending,2);release();assert.equal((await first).delivered,1);assert.equal((await q.status()).pending,1);
});
test('corrupt stored payload is never delivered or silently deleted',async t=>{
 const {q}=setup(t);await q.enqueue(item());const path=join(q.directory,sha256('e')+'.entry'),r=JSON.parse(readFileSync(path));r.payload.transcript='tampered';writeFileSync(path,JSON.stringify(r));
 await assert.rejects(q.flush(()=>assert.fail('not reached')),{code:'outbox_corrupt'});assert.ok(readdirSync(q.directory).includes(sha256('e')+'.entry'));
});
test('full journal refuses new events rather than evicting old ones',async t=>{
 const {q}=setup(t);for(let i=0;i<256;i++)await q.enqueue(item('e'+i,'x'));await assert.rejects(q.enqueue(item('extra')),{code:'outbox_full'});assert.equal((await q.status()).pending,256);
});
test('bounded automatic attempts eventually block; explicit replay retains the same ID',async t=>{
 const {q}=setup(t);await q.enqueue(item());for(let i=0;i<8;i++)await q.flush(async()=>{throw Error('offline');},{retryBlocked:true});
 assert.equal((await q.status()).blocked,1);const result=await q.flush(()=>assert.fail('blocked must not send'));assert.equal(result.skipped,1);
});
test('unknown nonempty directory is never implicitly bound to this profile',async t=>{
 const {q}=setup(t);writeFileSync(join(q.directory,'foreign.entry'),'raw',{mode:0o600});await assert.rejects(q.status(),{code:'outbox_unbound'});
});
test('foreign active lock is never stolen based on its age',async t=>{
 const {q}=setup(t);await q.enqueue(item());const path=join(q.directory,'.delivery.lock');writeFileSync(path,JSON.stringify({pid:process.pid,created_at:'2000-01-01'}),{mode:0o600});
 const info=q.inspectLock('delivery');assert.throws(()=>q.recoverLock('delivery',info.sha256,{writerStopped:true}),{code:'outbox_busy'});assert.equal(q.inspectLock('delivery').sha256,info.sha256);
});
test('operator-confirmed dead-process lock recovery is hash guarded',async t=>{
 const {q}=setup(t);await q.enqueue(item());writeFileSync(join(q.directory,'.delivery.lock'),JSON.stringify({pid:2147483647}),{mode:0o600});const info=q.inspectLock('delivery');
 assert.throws(()=>q.recoverLock('delivery',info.sha256),{code:'invalid_params'});assert.throws(()=>q.recoverLock('delivery','0'.repeat(64),{writerStopped:true}),{code:'conflict'});
 assert.equal(q.recoverLock('delivery',info.sha256,{writerStopped:true}).payloads_deleted,0);assert.equal((await q.status()).pending,1);
});
test('directory symlink/junction is refused',t=>{
 const {input,dir}=setup(t);const target=join(dir,'target');mkdirSync(target,{mode:0o700});const link=join(dir,'alias');symlinkSync(target,link,process.platform==='win32'?'junction':'dir');
 assert.throws(()=>new CaptureOutbox({...input,outbox_directory:link}),{code:'insecure_outbox'});
});
test('multiple independent processes enqueue without lost updates',async t=>{
 const {input,q,dir}=setup(t);const runner=join(dir,'writer.mjs');writeFileSync(runner,`import {CaptureOutbox} from ${JSON.stringify(new URL('../src/capture-outbox.mjs',import.meta.url).href)};await new CaptureOutbox(JSON.parse(process.argv[2])).enqueue(JSON.parse(process.argv[3]));`);
 const results=await Promise.all(Array.from({length:8},(_,i)=>new Promise((resolve,reject)=>{const p=spawn(process.execPath,[runner,JSON.stringify(input),JSON.stringify(item('child'+i))],{stdio:'ignore'});p.once('error',reject);p.once('exit',resolve);})));assert.ok(results.every(n=>n===0));assert.equal((await q.status()).pending,8);
});
