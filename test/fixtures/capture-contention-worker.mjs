/** Fixed synthetic writer. IPC input originates only from check-capture-contention. */
import {CaptureOutbox} from '../../src/capture-outbox.mjs';
import {captureProcessDiagnostic} from '../helpers/capture-process-diagnostic.mjs';
import {setTimeout as delay} from 'node:timers/promises';
import {performance} from 'node:perf_hooks';
process.once('message',async({input,worker})=>{
 let busyRetries=0,replays=0;
 try{
  const q=new CaptureOutbox(input),deadline=performance.now()+10000;
  for(const event_id of ['writer-'+worker+'-0','shared-event','writer-'+worker+'-1']){
   const payload={agent_id:'contention-fixture',event_id,consent:true,transcript:'SYNTHETIC_CONTENTION_PAYLOAD:'+event_id};
   for(let retries=0;;){
    try{const result=await q.enqueue(payload);replays+=Number(result.replayed);break;}
    catch(error){
     if(error?.code!=='outbox_busy'||retries>=7||performance.now()>=deadline)throw error;
     retries++;busyRetries++;await delay(25);
    }
   }
  }
  process.stdout.write(JSON.stringify({ok:true,busy_retries:busyRetries,replays})+'\n');
 }catch(error){process.stdout.write(JSON.stringify({ok:false,busy_retries:busyRetries,...captureProcessDiagnostic(error)})+'\n');process.exitCode=1;}
 finally{if(process.connected)process.disconnect();}
});
process.send?.({ready:true});
