/** Test-only IPC checkpoint AFTER the real queue acquire has exhausted EEXIST.
 * The parent removes only its own known synthetic lock. No retry is injected. */
import {CaptureOutbox} from '../../src/capture-outbox.mjs';
import {captureLockDiagnostic} from '../../src/capture-lock.mjs';
const selected=process.env.ULTRABRAIN_CONTROL_HELD_PHASE;
if(process.argv[1]?.endsWith('capture-delivery-control-worker.mjs')){
 const name=selected==='enqueue'?'enqueue':'resumeDelivery',original=CaptureOutbox.prototype[name];let observed=false;
 CaptureOutbox.prototype[name]=async function(...args){
  try{return await original.apply(this,args);}catch(error){
   const d=captureLockDiagnostic(error);
   if(!observed&&error.code==='outbox_busy'&&d?.kind==='queue'&&d.phase==='create'&&d.system_code==='EEXIST'){
    observed=true;
    await new Promise(resolve=>{process.once('message',resolve);process.send({busy_observed:true});});
   }
   throw error;
  }
 };
}
