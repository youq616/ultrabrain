/** Separate implementer boundary audit of the SYNTHETIC caller budget.
 * Actual production lock refusals, controlled monotonic time; no OS speed claims. */
import test from 'node:test';import assert from 'node:assert/strict';
import {controlAttemptWindow} from './helpers/capture-control-attempt.mjs';
import {acquireCaptureLock,captureLockError,captureLockDiagnostic} from '../src/capture-lock.mjs';
import {controlWorkerReport} from './helpers/capture-control-report.mjs';
import {UltraError} from '../src/core.mjs';
const busy=async()=>{try{await acquireCaptureLock(()=>{throw captureLockError({code:'EEXIST'},'queue','create');},{kind:'queue',waitMs:0});}catch(e){return e;}};
for(const phase of ['enqueue','resume'])test('control budget: unchanged call retries only authentic unacquired lock '+phase,async()=>{
 const error=await busy();let calls=0;const sleeps=[];
 const budget=controlAttemptWindow({now:()=>0,sleep:async ms=>sleeps.push(ms)}),result=Object.freeze({observed:'fixed'});
 const action=()=>{if(++calls===1)throw error;return result;};
 assert.equal(await budget.run(phase,action),result);assert.equal(calls,2);assert.deepEqual(sleeps,[25]);
 assert.equal(budget.snapshot()[phase],1);assert.ok(Object.isFrozen(budget.snapshot()));
 await assert.rejects(budget.run(phase,action),/invalid_control_attempt/);assert.equal(calls,2);
});
for(const phase of ['enqueue','resume'])test('control budget: permanent contention is still fatal at eight attempts '+phase,async()=>{
 const error=await busy();let calls=0,sleeps=0;
 const b=controlAttemptWindow({now:()=>0,sleep:async()=>sleeps++});
 await assert.rejects(b.run(phase,()=>{calls++;throw error;}),e=>e===error);
 assert.equal(calls,8);assert.equal(sleeps,7);assert.equal(b.snapshot()[phase],7);
 assert.deepEqual(captureLockDiagnostic(error),{kind:'queue',phase:'create',system_code:'EEXIST'});
});
for(const [kind,phase,code]of [['queue','create','EPERM'],['queue','create','EACCES'],['queue','create','ENOENT'],
 ['queue','write','EEXIST'],['queue','file-sync','EEXIST'],['queue','retire-rename','EEXIST'],['delivery','create','EEXIST']])
 test('control budget: never retries native IO or later/foreign lock '+kind+'/'+phase+'/'+code,async()=>{
  const error=captureLockError({code},kind,phase);let calls=0;
  const b=controlAttemptWindow({now:()=>0,sleep:()=>assert.fail('No sleep')});
  await assert.rejects(b.run('enqueue',()=>{calls++;throw error;}),e=>e===error);assert.equal(calls,1);
 });
for(const code of ['conflict','outbox_journal_io','outbox_lock_changed','outbox_corrupt','aborted'])
 test('control budget: refusal or ambiguous publication is terminal '+code,async()=>{
  const e=new UltraError(code,'PRIVATE');let calls=0;
  const b=controlAttemptWindow({now:()=>0,sleep:()=>assert.fail('No sleep')});
  await assert.rejects(b.run('resume',()=>{calls++;throw e;}),x=>x===e);assert.equal(calls,1);
 });
test('control budget: plain, copied and hostile exceptions cannot impersonate WeakMap proof',async()=>{
 const trusted=await busy(),revoked=Proxy.revocable({},{});revoked.revoke();let accessed=0;
 for(const error of [{code:'outbox_busy'}, {...trusted},revoked.proxy,{get code(){accessed++;throw Error('PRIVATE');}}]){
  const b=controlAttemptWindow({now:()=>0,sleep:()=>assert.fail('No sleep')});let calls=0;
  // Node assert.rejects itself probes a revoked Proxy. Catch opaquely so
  // the assertion measures this helper's behavior, not the assertion library.
  let caught=false,actual;try{await b.run('enqueue',()=>{calls++;throw error;});}catch(e){caught=true;actual=e;}
  assert.equal(caught,true);assert.equal(actual,error);assert.equal(calls,1);
 }assert.equal(accessed,0);
});
test('control budget: enqueue and resume share a single absolute window',async()=>{
 let time=0,calls=0;const error=await busy(),b=controlAttemptWindow({now:()=>time,sleep:async()=>{time=10000;}});
 await b.run('enqueue',()=>{time=9990;return true;});
 await assert.rejects(b.run('resume',()=>{calls++;throw error;}),e=>e===error);
 assert.equal(calls,1);assert.deepEqual(b.snapshot(),{enqueue:0,resume:1});
});
test('control budget: delayed wakeup does not dispatch after deadline',async()=>{
 let time=0,calls=0;const e=await busy(),b=controlAttemptWindow({now:()=>time,sleep:async()=>{time=20000;}});
 await assert.rejects(b.run('enqueue',()=>{calls++;throw e;}),x=>x===e);assert.equal(calls,1);
});
test('control budget: expired initial dispatch never invokes mutation',async()=>{
 let time=0;const b=controlAttemptWindow({now:()=>time,sleep:()=>assert.fail('No sleep')});time=10000;
 await assert.rejects(b.run('enqueue',()=>assert.fail('No action')),/synthetic_control_deadline/);
});
test('control budget: IPC-phase idle time does not reset the workload clock',async()=>{
 let time=0;const b=controlAttemptWindow({now:()=>time,sleep:()=>assert.fail('No sleep')});
 await b.run('enqueue',()=>true);time=10001;
 await assert.rejects(b.run('resume',()=>assert.fail('No resume')),/synthetic_control_deadline/);
});
test('control budget: sleep failure never starts another attempt',async()=>{
 const e=await busy(),sleepError=Error('PRIVATE');let calls=0;
 const b=controlAttemptWindow({now:()=>0,sleep:async()=>{throw sleepError;}});
 await assert.rejects(b.run('enqueue',()=>{calls++;throw e;}),x=>x===sleepError);assert.equal(calls,1);
});
for(const waits of [null,[],{}, {enqueue:8,resume:0},{enqueue:0,resume:-1},{enqueue:0.5,resume:0},
 {enqueue:0,resume:0,extra:1}])test('control report: malformed wait counters are not accepted',()=>{
 assert.deepEqual(controlWorkerReport(JSON.stringify({ok:true,outcome:'resumed',lock_waits:waits})),{ok:false,code:'invalid_worker_report'});
});
test('control report: success/failure retain bounded waits, never copied arbitrary fields',()=>{
 for(const ok of [true,false]){
  const r=controlWorkerReport(JSON.stringify({ok,outcome:'conflict',code:'outbox_busy',lock_waits:{enqueue:7,resume:7},path:'PRIVATE'}));
  assert.deepEqual(r.lock_waits,{enqueue:7,resume:7});assert.equal(r.ok,ok);assert.ok(!JSON.stringify(r).includes('PRIVATE'));
 }
});
