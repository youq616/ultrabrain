/** Real child process, accepts only parent-created synthetic test profiles. */
import {CaptureOutbox} from '../../src/capture-outbox.mjs';
import {controlAttemptWindow} from '../helpers/capture-control-attempt.mjs';
import {captureProcessDiagnostic} from '../helpers/capture-process-diagnostic.mjs';
let attempts,finished=false;
const outputFailure=()=>process.exit(1);
process.stdout.on('error',outputFailure);
const finish=(result,exitCode)=>{
 if(finished)return;finished=true;process.exitCode=exitCode;
 try{
  const report=JSON.stringify({...result,...(attempts?{lock_waits:attempts.snapshot()}:{})});
  if(Buffer.byteLength(report)>4096){outputFailure();return;}
  // Keep IPC connected until the single bounded report has finished writing.
  process.stdout.write(report,error=>process.exit(error?1:exitCode));
 }catch{outputFailure();}
};
const failure=error=>finish({ok:false,...captureProcessDiagnostic(error)},1);
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
   try{await attempts.run('resume',()=>q.resumeDelivery(expectedHash,{confirm:true}));finish({ok:true,outcome:'resumed'},0);}
   catch(error){if(error?.code==='conflict')finish({ok:true,outcome:'conflict'},0);else failure(error);}
  });
  process.send({staged:true});
 }catch(error){failure(error);}
});
process.send({ready:true});
