/** Real child process, accepts only parent-created synthetic test profiles. */
import {CaptureOutbox} from '../../src/capture-outbox.mjs';
const finish=result=>{process.stdout.write(JSON.stringify(result));if(process.connected)process.disconnect();};
const failure=error=>{finish({ok:false,code:['outbox_busy','outbox_corrupt','identity_mismatch','outbox_lock_io','outbox_lock_changed'].includes(error?.code)?error.code:'worker_failed'});process.exitCode=1;};
process.once('message',async ({input,worker,mode})=>{
 try{
  const q=new CaptureOutbox(input);
  if(mode==='pause-hold'){
   const paused=await q.pauseDelivery();process.send({paused});setInterval(()=>{},1000);return;
  }
  await q.enqueue({agent_id:'fixture',event_id:'child-'+worker,consent:true,transcript:'SYNTHETIC_CONTROL_PAYLOAD'});
  process.once('message',async ({expectedHash})=>{
   try{await q.resumeDelivery(expectedHash,{confirm:true});finish({ok:true,outcome:'resumed'});}
   catch(error){if(error?.code==='conflict')finish({ok:true,outcome:'conflict'});else failure(error);}
  });
  process.send({staged:true});
 }catch(error){failure(error);}
});
process.send({ready:true});
