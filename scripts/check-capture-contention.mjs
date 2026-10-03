#!/usr/bin/env node
/** Real multi-process filesystem self-test, SYNTHETIC queues only. No server or
 * user profile/queue selection. Does not diagnose root cause from pass alone. */
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {CaptureOutbox} from '../src/capture-outbox.mjs';
import {captureWorkerBatch} from '../test/helpers/capture-worker-batch.mjs';
import {contentionWorkerReport} from '../test/helpers/capture-contention-report.mjs';
import {captureProcessDiagnostic} from '../test/helpers/capture-process-diagnostic.mjs';
import {CONTENTION_ROUND_FORMAT} from '../test/helpers/capture-contention-diagnostics.mjs';
const WORKERS=8;
const workerPath=fileURLToPath(new URL('../test/fixtures/capture-contention-worker.mjs',import.meta.url));
export async function captureContentionRound(){
 let root,batch,result,stage='setup';
 try{
  root=mkdtempSync(join(tmpdir(),'ub-contention-'));const workspace=join(root,'work');mkdirSync(workspace,{mode:0o700});
 const input={format:1,source:'synthetic',workspace,outbox_directory:join(root,'outbox'),allow_capture:true,
  expected_actor:'a'.repeat(64),expected_instance:'11111111-1111-4111-8111-111111111111',
  server:{transport:'stdio',command:'never-executed',args:[]}};
  batch=captureWorkerBatch({parseReport:contentionWorkerReport,contentionProgress:true,
   spawnWorker:()=>spawn(process.execPath,[workerPath],{stdio:['ignore','pipe','pipe','ipc']})});
  stage='ready';await batch.ready();
  stage='writers';batch.start(worker=>({input,worker}));
  const outcomes=await batch.outcomes();
  if(outcomes.some(v=>!v.valid))result={passed:false,stage,timed_out:batch.timedOut,outcomes};
  else{
  stage='integrity';
  const q=new CaptureOutbox(input),status=await q.status();
  const expected=['shared-event',...Array.from({length:WORKERS},(_,i)=>['writer-'+i+'-0','writer-'+i+'-1']).flat()].sort();
  const names=readdirSync(q.directory),records=names.filter(n=>n.endsWith('.entry')).map(n=>JSON.parse(readFileSync(join(q.directory,n),'utf8')));
  const actual=records.map(r=>r.payload.event_id).sort();
  const valid=JSON.stringify(actual)===JSON.stringify(expected)&&status.pending===expected.length&&status.blocked===0&&
   names.length===expected.length+1&&records.every(r=>r.attempts===0&&r.payload.transcript==='SYNTHETIC_CONTENTION_PAYLOAD:'+r.payload.event_id)&&
   outcomes.reduce((n,v)=>n+v.result.replays,0)===WORKERS-1;
  result={passed:valid,stage:'integrity',writers:WORKERS,requests:WORKERS*3,records:records.length,
   identical_replays:outcomes.reduce((n,v)=>n+v.result.replays,0),busy_retries:outcomes.reduce((n,v)=>n+v.result.busy_retries,0),outcomes};
  }
 }catch(error){result={passed:false,stage,timed_out:batch?.timedOut??false,error:captureProcessDiagnostic(error)};}
 finally{
  // Freeze already-received history before the unchanged shutdown; never wait
  // for progress. Instrumented passes cannot clear the historical failure.
  if(result?.passed===false&&stage==='writers'&&batch)result.progress=batch.freezeProgress();
  const closed=batch?await batch.shutdown():{outcomes:[],all_closed:true,timed_out:false};
  if(result?.passed===false&&!result.outcomes)result.outcomes=closed.outcomes;
  if(!closed.all_closed)result={...result,passed:false,workers_closed:false,cleanup_skipped:true};
  else if(root!==undefined)try{rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:30});}
  catch(error){result={...result,passed:false,cleanup:captureProcessDiagnostic(error)};}
 }
 return {...result,diagnostic_format:CONTENTION_ROUND_FORMAT};
}
async function main(){
 const args=process.argv.slice(2);
 if(args.length===1&&args[0]==='--help'){
  console.log('Usage: node scripts/check-capture-contention.mjs [--rounds 1..25]\nCreates only temporary synthetic queues; no profile, network, models or user data.');return;
 }
 const valid=!args.length||args.length===2&&args[0]==='--rounds'&&/^(?:[1-9]|1[0-9]|2[0-5])$/.test(args[1]);
 if(!valid){console.log(JSON.stringify({passed:false,error:'invalid_params'}));process.exitCode=1;return;}
 const rounds=args.length?Number(args[1]):3,observations=[];
 try{
  for(let i=0;i<rounds;i++){const r=await captureContentionRound();observations.push(r);if(!r.passed)break;}
  const report={format:'ultrabrain-capture-contention-v1',passed:observations.length===rounds&&observations.every(r=>r.passed),
   platform:process.platform,node:process.version,rounds_requested:rounds,rounds:observations,network_calls:0,model_calls:0,user_queue_access:false};
  console.log(JSON.stringify(report));if(!report.passed)process.exitCode=1;
 }catch(error){console.log(JSON.stringify({format:'ultrabrain-capture-contention-v1',passed:false,error:captureProcessDiagnostic(error),
  platform:process.platform,node:process.version,rounds_requested:rounds,rounds:observations,network_calls:0,model_calls:0,user_queue_access:false}));process.exitCode=1;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)void main();
