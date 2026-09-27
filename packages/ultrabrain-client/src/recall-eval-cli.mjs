#!/usr/bin/env node
/** Separate manual executable; no hooks, outbox or remembered consent. */
import {resolve} from 'node:path';
import {readClientProfile,clientProfileAuthorization} from '../../../src/client-profile-file.mjs';
import {parseSnapshotJSON} from '../../../src/personal-snapshot-contract.mjs';
import {recallEvaluationRequest,recallEvaluationFailure,RECALL_EVALUATION_MAX_BYTES} from '../../../src/client-recall-evaluation.mjs';
import {requireThat} from '../../../src/core.mjs';
import {evaluateClientRecall} from './recall-eval.mjs';
async function main(){
 const controller=new AbortController(),cancel=()=>{controller.abort();process.stdin.destroy();};
 const timer=setTimeout(cancel,120000);timer.unref();
 process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
 process.stdout.on('error',()=>{controller.abort();process.exitCode=1;});
 let report;
 try{
  const args=process.argv.slice(2);
  if(args.length===1&&args[0]==='--help'){
   process.stdout.write('Usage: ultrabrain-recall-eval --profile ABSOLUTE_PROFILE < explicit-suite.json\n'+
    'Online read-only evaluation: 1..32 annotated tasks, consent:true, workspace and top_k:1..20.\n'+
    'Tasks go to the pinned server; ID metrics are not semantic or answer-quality certification.\n');return;
  }
  requireThat(args.length===2&&args[0]==='--profile','invalid_params','Use --profile PATH and JSON stdin');
  const path=resolve(args[1]),{input,profile}=readClientProfile(path),authorize=clientProfileAuthorization(path,input);
  const chunks=[];let size=0;
  for await(const chunk of process.stdin){const b=Buffer.from(chunk);size+=b.length;
   requireThat(size<=RECALL_EVALUATION_MAX_BYTES,'input_too_large','Evaluation stdin too large');chunks.push(b);}
  requireThat(!controller.signal.aborted,'aborted','Evaluation cancelled');
  let request;try{request=parseSnapshotJSON(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.concat(chunks)));}
  catch{throw Object.assign(new Error(),{code:'invalid_params'});}
  const selection=recallEvaluationRequest(request,profile);authorize();
  report=await evaluateClientRecall(input,selection,{authorize,signal:controller.signal});
  authorize();requireThat(!controller.signal.aborted,'aborted','Evaluation cancelled');
  process.stdout.write(JSON.stringify(report)+'\n');
 }catch(error){
  const e=recallEvaluationFailure(error,report?{attempted:report.query_requests,completed:report.cases.length}:undefined);
  process.stdout.write(JSON.stringify({ok:false,error:e.code,query_delivery:e.query_delivery,query_attempts:e.query_attempts,
   completed_cases:e.completed_cases,memory_writes_requested:false})+'\n');process.exitCode=1;
 }finally{clearTimeout(timer);process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);process.stdin.destroy();}
}
void main();
