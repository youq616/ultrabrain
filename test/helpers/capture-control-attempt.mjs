/** SYNTHETIC workload scheduling, not a client retry policy or a test rerun.
 * A control worker previously treated a valid one-second lock-acquire refusal
 * as a broken queue while the enqueue stress worker already handled contention.
 * Retry only the actual library's pre-acquisition queue/create/EEXIST outcome.
 * Preserve the exact event or CAS observation; every other failure is terminal.
 */
import {performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';
import {captureLockDiagnostic} from '../../src/capture-lock.mjs';
const phases=['enqueue','resume'];
const codeOf=error=>{try{return Object.getOwnPropertyDescriptor(error,'code')?.value;}catch{}};
export function controlAttemptWindow({now=()=>performance.now(),sleep=ms=>delay(ms)}={}){
 if(typeof now!=='function'||typeof sleep!=='function')throw Error('invalid_control_attempt_clock');
 // Same 10s workload budget as the existing enqueue checker, inside the
 // unchanged supervisor's 15s deadline. No whole-test/job retry or extension.
 const deadline=now()+10000,started=new Set(),waits={enqueue:0,resume:0};
 return Object.freeze({
  async run(phase,action){
   if(!phases.includes(phase)||started.has(phase)||typeof action!=='function')throw Error('invalid_control_attempt');
   started.add(phase);let last;
   for(;;){
    if(now()>=deadline)throw last??Error('synthetic_control_deadline');
    try{return await action();}catch(error){
     const d=captureLockDiagnostic(error);
     if(codeOf(error)!=='outbox_busy'||d?.kind!=='queue'||d.phase!=='create'||d.system_code!=='EEXIST'||
       waits[phase]>=7||now()>=deadline)throw error;
     last=error;waits[phase]++;
     await sleep(Math.min(25,Math.max(0,deadline-now())));
     // Recheck before invoking an action, including after delayed timer delivery.
    }
   }
  },
  snapshot:()=>Object.freeze({...waits})
 });
}
