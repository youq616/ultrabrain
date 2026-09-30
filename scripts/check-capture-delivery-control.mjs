#!/usr/bin/env node
/** Eight real processes enqueue while paused, then race the same resume CAS.
 * Only generated temporary synthetic data; no user profile or queue option. */
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {CaptureOutbox} from '../src/capture-outbox.mjs';
import {captureProcessDiagnostic} from '../test/helpers/capture-process-diagnostic.mjs';
import {controlWorkerReport} from '../test/helpers/capture-control-report.mjs';
import {captureWorkerBatch} from '../test/helpers/capture-worker-batch.mjs';
const workerPath=fileURLToPath(new URL('../test/fixtures/capture-delivery-control-worker.mjs',import.meta.url));
export async function deliveryControlRound(){
 let root,batch,stage='setup',result;
 try{
  root=mkdtempSync(join(tmpdir(),'ub-control-process-'));const workspace=join(root,'work');mkdirSync(workspace,{mode:0o700});
 const input={format:1,source:'synthetic',workspace,outbox_directory:join(root,'queue'),allow_capture:true,expected_actor:'a'.repeat(64),
  expected_instance:'11111111-1111-4111-8111-111111111111',server:{transport:'stdio',command:'never-executed',args:[]}};
  const q=new CaptureOutbox(input),pause=await q.pauseDelivery();
  batch=captureWorkerBatch({staged:true,parseReport:controlWorkerReport,
   spawnWorker:()=>spawn(process.execPath,[workerPath],{stdio:['ignore','pipe','pipe','ipc']})});
  stage='ready';await batch.ready();batch.start(worker=>({input,worker}));
  stage='enqueue';await batch.staged();
  const snapshot=()=>readdirSync(q.directory).filter(n=>n.endsWith('.entry')).sort().map(n=>readFileSync(join(q.directory,n),'utf8'));
  const before=snapshot(),paused=(await q.status()).delivery;
  stage='resume';batch.resume(()=>({expectedHash:pause.control_sha256}));const outcomes=await batch.outcomes();
  if(outcomes.some(r=>!r.valid))result={passed:false,stage,timed_out:batch?.timedOut??false,outcomes};
  else{
   stage='integrity';const after=snapshot(),status=await q.status(),resumed=outcomes.filter(r=>r.result.outcome==='resumed').length,conflicts=outcomes.filter(r=>r.result.outcome==='conflict').length;
   const passed=resumed===1&&conflicts===7&&paused.control_sha256===pause.control_sha256&&
    status.delivery.state==='running'&&status.delivery.revision===2&&status.pending===8&&status.blocked===0&&
    JSON.stringify(before)===JSON.stringify(after)&&after.every(b=>JSON.parse(b).attempts===0)&&readdirSync(q.directory).length===10;
   result={passed,workers:8,consented_entries:after.length,resume_successes:resumed,stale_conflicts:conflicts,
    payloads_unchanged:JSON.stringify(before)===JSON.stringify(after),attempts_spent:after.reduce((n,b)=>n+JSON.parse(b).attempts,0)};
   if(!passed)Object.assign(result,{stage,timed_out:batch?.timedOut??false,outcomes});
  }
 }catch(error){result={passed:false,stage,timed_out:batch?.timedOut??false,error:captureProcessDiagnostic(error)};}
 finally{
  const closed=batch?await batch.shutdown():{outcomes:[],all_closed:true,timed_out:false};
  if(result?.passed===false&&!result.outcomes)result.outcomes=closed.outcomes;
  if(!closed.all_closed)result={...result,passed:false,workers_closed:false,cleanup_skipped:true};
  else if(root!==undefined)try{rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:30});}
  catch(error){result={...result,passed:false,cleanup:captureProcessDiagnostic(error)};}

 }
 return result;
}
async function main(){
 const args=process.argv.slice(2),valid=!args.length||args.length===2&&args[0]==='--rounds'&&/^(?:[1-9]|1[0-9]|2[0-5])$/.test(args[1]);
 if(!valid){console.log(JSON.stringify({passed:false,error:'invalid_params'}));process.exitCode=1;return;}
 const rounds=args.length?Number(args[1]):3,observations=[];
 try{
  for(let i=0;i<rounds;i++){const r=await deliveryControlRound();observations.push(r);if(!r.passed)break;}
  const passed=observations.length===rounds&&observations.every(r=>r.passed);
  console.log(JSON.stringify({format:'ultrabrain-delivery-control-check-v1',passed,platform:process.platform,node:process.version,
   rounds_requested:rounds,rounds:observations,network_calls:0,model_calls:0,user_queue_access:false}));if(!passed)process.exitCode=1;
 }catch(error){console.log(JSON.stringify({format:'ultrabrain-delivery-control-check-v1',passed:false,error:captureProcessDiagnostic(error),
  platform:process.platform,node:process.version,rounds_requested:rounds,rounds:observations,network_calls:0,model_calls:0,user_queue_access:false}));process.exitCode=1;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)void main();
