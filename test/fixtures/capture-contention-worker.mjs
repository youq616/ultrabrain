/** Fixed synthetic writer. IPC input originates only from check-capture-contention. */
import {CaptureOutbox} from '../../src/capture-outbox.mjs';
import {captureProcessDiagnostic} from '../helpers/capture-process-diagnostic.mjs';
import {setTimeout as delay} from 'node:timers/promises';
import {performance} from 'node:perf_hooks';
import {createContentionDiagnostics} from '../helpers/capture-contention-diagnostics.mjs';
import {createContentionProgress, sealContentionProgress} from '../helpers/capture-contention-progress.mjs';
process.once('message',async({input,worker})=>{
 let busyRetries=0,replays=0,terminal='setup_error';
 const diagnostics=createContentionDiagnostics();
 // Optional telemetry is never allowed to replace a queue/retry decision.
 let progress,progressInvalid=false;try{progress=createContentionProgress();}catch{progressInvalid=true;}
 const observe=(...args)=>{try{progress?.observe(...args);}catch{progressInvalid=true;}};
 const transport=()=>{try{const capsule=sealContentionProgress(progress);return progressInvalid?null:capsule;}catch{return null;}};
 try{
  const q=new CaptureOutbox(input),deadline=performance.now()+10000;
  for(const [event,event_id] of ['writer-'+worker+'-0','shared-event','writer-'+worker+'-1'].entries()){
   const payload={agent_id:'contention-fixture',event_id,consent:true,transcript:'SYNTHETIC_CONTENTION_PAYLOAD:'+event_id};
   for(let retries=0;;){
    observe(event,retries+1,0,0);
    diagnostics.begin(event,retries+1);
    try{const result=await q.enqueue(payload),replayed=result.replayed;diagnostics.finish(replayed?'replayed':'accepted');replays+=Number(result.replayed);observe(event,retries+1,1,replayed?2:1);break;}
    catch(error){
     // Resolve the original short-circuit decision before observational work.
     const reason=error?.code!=='outbox_busy'?'non_busy_error':retries>=7?'retry_limit':performance.now()>=deadline?'deadline':null;
     diagnostics.finish(error?.code==='outbox_busy'?'busy':'error');
     observe(event,retries+1,1,reason==='non_busy_error'?4:3);
     if(reason){terminal=reason;throw error;}
     retries++;busyRetries++;await delay(25);
    }
   }
  }
  process.stdout.write(JSON.stringify({ok:true,busy_retries:busyRetries,replays,diagnostics:diagnostics.end('complete'),progress_transport:transport()})+'\n');
 }catch(error){process.stdout.write(JSON.stringify({ok:false,busy_retries:busyRetries,...captureProcessDiagnostic(error),diagnostics:diagnostics.end(terminal),progress_transport:transport()})+'\n');process.exitCode=1;}
 finally{if(process.connected)process.disconnect();}
});
process.send?.({ready:true});
