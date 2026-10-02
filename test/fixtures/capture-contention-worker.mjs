/** Fixed synthetic writer. IPC input originates only from check-capture-contention. */
import {CaptureOutbox} from '../../src/capture-outbox.mjs';
import {captureProcessDiagnostic} from '../helpers/capture-process-diagnostic.mjs';
import {setTimeout as delay} from 'node:timers/promises';
import {performance} from 'node:perf_hooks';
import {createContentionDiagnostics} from '../helpers/capture-contention-diagnostics.mjs';
process.once('message',async({input,worker})=>{
 let busyRetries=0,replays=0,terminal='setup_error';
 const diagnostics=createContentionDiagnostics();
 try{
  const q=new CaptureOutbox(input),deadline=performance.now()+10000;
  for(const [event,event_id] of ['writer-'+worker+'-0','shared-event','writer-'+worker+'-1'].entries()){
   const payload={agent_id:'contention-fixture',event_id,consent:true,transcript:'SYNTHETIC_CONTENTION_PAYLOAD:'+event_id};
   for(let retries=0;;){
    diagnostics.begin(event,retries+1);
    try{const result=await q.enqueue(payload);diagnostics.finish(result.replayed?'replayed':'accepted');replays+=Number(result.replayed);break;}
    catch(error){
     // Resolve the original short-circuit decision before observational work.
     const reason=error?.code!=='outbox_busy'?'non_busy_error':retries>=7?'retry_limit':performance.now()>=deadline?'deadline':null;
     diagnostics.finish(error?.code==='outbox_busy'?'busy':'error');
     if(reason){terminal=reason;throw error;}
     retries++;busyRetries++;await delay(25);
    }
   }
  }
  process.stdout.write(JSON.stringify({ok:true,busy_retries:busyRetries,replays,diagnostics:diagnostics.end('complete')})+'\n');
 }catch(error){process.stdout.write(JSON.stringify({ok:false,busy_retries:busyRetries,...captureProcessDiagnostic(error),diagnostics:diagnostics.end(terminal)})+'\n');process.exitCode=1;}
 finally{if(process.connected)process.disconnect();}
});
process.send?.({ready:true});
