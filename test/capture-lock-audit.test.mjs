/** Separate implementation-assistant audit, not second-agent review. */
import test from 'node:test';import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {acquireCaptureLock,captureLockError} from '../src/capture-lock.mjs';
test('audit: event-loop delay past the deadline must not issue another exclusive-create attempt',async()=>{
 let attempts=0;
 await assert.rejects(acquireCaptureLock(()=>{
  if(++attempts===1){
   // Timer scheduling is real: emulate a CPU-stalled consumer before lock retry.
   setTimeout(()=>{const until=performance.now()+50;while(performance.now()<until){};},0);
   throw captureLockError({code:'EEXIST'},'queue','create');
  }
  return ()=>{};
 },{kind:'queue',waitMs:20}),{code:'outbox_busy'});
 assert.equal(attempts,1);
});
test('audit: asynchronous authorization on owned handoff cannot leak the acquired lock',async()=>{
 let checks=0,released=0;
 await assert.rejects(acquireCaptureLock(()=>()=>released++,{kind:'queue',check:()=>++checks===1?true:Promise.resolve(true)}),{code:'invalid_params'});
 assert.equal(released,1);
});
test('audit: cancelled handoff with failed release does not hide the cleanup failure',async()=>{
 const c=new AbortController(),failure=captureLockError({code:'EPERM'},'queue','unlink');
 await assert.rejects(acquireCaptureLock(()=>{c.abort();return ()=>{throw failure;};},{kind:'queue',signal:c.signal}),e=>e===failure);
});
