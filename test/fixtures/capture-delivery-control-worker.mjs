/** Real child process, accepts only parent-created synthetic test profiles. */
import {CaptureOutbox} from '../../src/capture-outbox.mjs';
import {controlAttemptWindow} from '../helpers/capture-control-attempt.mjs';
import {captureProcessDiagnostic} from '../helpers/capture-process-diagnostic.mjs';
let attempts;
const finish=result=>{process.stdout.write(JSON.stringify({...result,...(attempts?{lock_waits:attempts.snapshot()}:{})}));if(process.connected)process.disconnect();};
const failure=error=>{finish({ok:false,...captureProcessDiagnostic(error)});process.exitCode=1;};
process.once('message',async ({input,worker,mode})=>{
 try{
  const q=new CaptureOutbox(input);
  if(mode==='pause-hold'){
   const paused=await q.pauseDelivery();process.send({paused});setInterval(()=>{},1000);return;
  }
  attempts=controlAttemptWindow();
  const payload=Object.freeze({agent_id:'fixture',event_id:'child-'+worker,consent:true,transcript:'SYNTHETIC_CONTROL_PAYLOAD'});
  await attempts.run('enqueue',()=>q.enqueue(payload));
  process.once('message',async ({expectedHash})=>{
   try{await attempts.run('resume',()=>q.resumeDelivery(expectedHash,{confirm:true}));finish({ok:true,outcome:'resumed'});}
   catch(error){if(error?.code==='conflict')finish({ok:true,outcome:'conflict'});else failure(error);}
  });
  process.send({staged:true});
 }catch(error){failure(error);}
});
process.send({ready:true});
