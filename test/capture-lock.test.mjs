import test from 'node:test';
import assert from 'node:assert/strict';
import {acquireCaptureLock,captureLockError,captureLockDiagnostic} from '../src/capture-lock.mjs';
import {UltraError} from '../src/core.mjs';
const collision=()=>captureLockError({code:'EEXIST'},'queue','create');
for(const kind of ['queue','delivery'])test('lock: exclusive handoff and explicit release '+kind,async()=>{
 let owned=0,released=0,checks=0;
 const release=await acquireCaptureLock(()=>{owned++;return ()=>released++;},{kind,check:()=>{checks++;}});
 assert.equal(owned,1);assert.equal(released,0);assert.equal(checks,2);release();assert.equal(released,1);
});
test('lock: only create collisions are retried, monotonic deadline ignores wall-clock changes',async t=>{
 t.mock.method(Date,'now',()=>-1e15);let calls=0;
 const release=await acquireCaptureLock(()=>{if(++calls<3)throw collision();return ()=>{};},{kind:'queue'});
 assert.equal(typeof release,'function');assert.equal(calls,3);
});
test('lock: zero wait makes exactly one claim, never waits or steals',async()=>{
 let calls=0;await assert.rejects(acquireCaptureLock(()=>{calls++;throw collision();},{kind:'queue',waitMs:0}),{code:'outbox_busy'});
 assert.equal(calls,1);
});
test('lock: persistent contention exhausts the bound with safe diagnostic',async()=>{
 let calls=0;await assert.rejects(acquireCaptureLock(()=>{calls++;throw collision();},{kind:'queue',waitMs:20}),error=>{
  assert.deepEqual(captureLockDiagnostic(error),{kind:'queue',phase:'create',system_code:'EEXIST'});return error.code==='outbox_busy';
 });assert.ok(calls>=2&&calls<=3);
});
for(const code of ['EPERM','EACCES','EBUSY','ENOSPC','EIO','ENOENT','EMFILE','EROFS'])test('lock: no permission or IO retries '+code,async()=>{
 let calls=0;await assert.rejects(acquireCaptureLock(()=>{calls++;throw captureLockError({code},'queue','create');},{kind:'queue'}),{code:'outbox_lock_io'});
 assert.equal(calls,1);
});
for(const phase of ['write','file-sync','close','directory-sync','verify-release','unlink','release-sync'])test('lock: EEXIST after exclusive open is not another-owner contention '+phase,async()=>{
 let calls=0;await assert.rejects(acquireCaptureLock(()=>{calls++;throw captureLockError({code:'EEXIST'},'queue',phase);},{kind:'queue'}),{code:'outbox_lock_io'});
 assert.equal(calls,1);
});
test('lock: raw error cannot impersonate trusted create contention',async()=>{
 let calls=0;const error={code:'outbox_lock_io',kind:'queue',phase:'create',system_code:'EEXIST'};
 await assert.rejects(acquireCaptureLock(()=>{calls++;throw error;},{kind:'queue'}),e=>e===error);assert.equal(calls,1);
});
test('lock: another lock kind cannot be mistaken for this one',async()=>{
 let calls=0;await assert.rejects(acquireCaptureLock(()=>{calls++;throw collision();},{kind:'delivery'}),{code:'outbox_lock_io'});assert.equal(calls,1);
});
for(const check of [()=>false,async()=>true,async()=>{throw Error('PRIVATE');}])test('lock: declined or asynchronous authority never claims',async()=>{
 let calls=0;await assert.rejects(acquireCaptureLock(()=>{calls++;return ()=>{};},{kind:'queue',check}));
 await new Promise(r=>setImmediate(r));assert.equal(calls,0);
});
test('lock: authorization rechecked after each collision',async()=>{
 let calls=0,permit=true;
 await assert.rejects(acquireCaptureLock(()=>{calls++;permit=false;throw collision();},{kind:'queue',check:()=>permit}),{code:'capture_disabled'});
 assert.equal(calls,1);
});
test('lock: pre-cancel checks before directory inspection or creation',async()=>{
 const c=new AbortController();c.abort();
 await assert.rejects(acquireCaptureLock(()=>assert.fail('No claim'),{kind:'queue',signal:c.signal,check:()=>assert.fail('No IO')}),{code:'aborted'});
});
test('lock: mid-wait cancellation preserves other owner and performs no more claims',async()=>{
 const c=new AbortController();let n=0;
 const promise=acquireCaptureLock(()=>{n++;setImmediate(()=>c.abort());throw collision();},{kind:'queue',signal:c.signal});
 await assert.rejects(promise,{code:'aborted'});assert.equal(n,1);
});
test('lock: cancellation at owned handoff releases the acquired lock, not the caller data',async()=>{
 const c=new AbortController();let freed=0;
 await assert.rejects(acquireCaptureLock(()=>{c.abort();return ()=>freed++;},{kind:'queue',signal:c.signal}),{code:'aborted'});
 assert.equal(freed,1);
});
test('lock: authority changes after successful claim still releases once',async()=>{
 let permit=true,freed=0;
 await assert.rejects(acquireCaptureLock(()=>{permit=false;return ()=>freed++;},{kind:'queue',check:()=>permit}),{code:'capture_disabled'});
 assert.equal(freed,1);
});
for(const options of [{kind:'other'},{kind:'queue',waitMs:-1},{kind:'queue',waitMs:1001},{kind:'queue',waitMs:NaN},
 {kind:'queue',waitMs:1.5},{kind:'queue',signal:{}},{kind:'queue',check:42}])test('lock: invalid internal configuration never calls claim',async()=>{
 await assert.rejects(acquireCaptureLock(()=>assert.fail('No claim'),options),{code:'invalid_params'});
});
for(const code of ['outbox_lock_changed','outbox_corrupt','insecure_outbox'])test('lock: ownership/security failure code preserved '+code,()=>{
 const e=captureLockError(new UltraError(code,'PRIVATE_PATH'),'queue','verify-release');assert.equal(e.code,code);
 assert.deepEqual(captureLockDiagnostic(e),{kind:'queue',phase:'verify-release',system_code:null});assert.ok(!e.message.includes('PRIVATE'));
});
for(const kind of ['getter','proxy','primitive','foreign-code'])test('lock: diagnostics avoid untrusted messages and getters '+kind,()=>{
 let calls=0,error;
 if(kind==='getter')error={get code(){calls++;throw Error('PRIVATE');},get message(){calls++;return 'PRIVATE';}};
 else if(kind==='proxy'){const p=Proxy.revocable({},{});p.revoke();error=p.proxy;}
 else error=kind==='primitive'?'PRIVATE':{code:'PRIVATE_ERROR',path:'PRIVATE_PATH'};
 const e=captureLockError(error,'queue','create');assert.equal(e.code,'outbox_lock_io');assert.equal(calls,0);
 assert.ok(!JSON.stringify(captureLockDiagnostic(e)).includes('PRIVATE'));assert.equal(captureLockDiagnostic({...e}),null);
 assert.ok(Object.isFrozen(captureLockDiagnostic(e)));
});
