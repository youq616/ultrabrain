#!/usr/bin/env node
/** Manual explicit review; no hooks, directory scanning, automatic confirmation or retry. */
import {resolve} from 'node:path';
import {reviewClientMemory} from './memory-review.mjs';
import {memoryReviewFailure,MEMORY_REVIEW_INPUT_MAX_BYTES} from '../../../src/client-memory-review.mjs';
import {readClientProfile,clientProfileAuthorization} from '../../../src/client-profile-file.mjs';
import {parseSnapshotJSON} from '../../../src/personal-snapshot-contract.mjs';
import {requireThat} from '../../../src/core.mjs';
export async function memoryReviewMain(args=process.argv.slice(2),{stdin=process.stdin,write=s=>process.stdout.write(s),run=reviewClientMemory,signal}={}){
 let result;
 try{
  if(args.length===1&&args[0]==='--help'){
   write('Usage: ultrabrain-memory-review --profile ABSOLUTE_PATH < request.json\nOperations: inspect, apply, replay, correct, replay-correction. Explicit consent and bound workspace required.\nInspect hides text unless include_text:true. Apply activates or archives one pinned version; existing allow_capture required.\nReplay requires an advanced current revision and returns only the original event receipt, not current state. No automatic retries.\nCorrect replaces all seven editable fields with acknowledge_reset:true; candidate status requires a separate review.\n');return 0;
  }
  requireThat(args.length===2&&args[0]==='--profile','invalid_params','Use --profile PATH');
  requireThat(!signal?.aborted,'aborted','Cancelled');
  const path=resolve(args[1]),{input}=readClientProfile(path),authorize=clientProfileAuthorization(path,input);
  const chunks=[];let size=0;
  for await(const chunk of stdin){requireThat(!signal?.aborted,'aborted','Cancelled');const b=Buffer.from(chunk);size+=b.length;
   requireThat(size<=MEMORY_REVIEW_INPUT_MAX_BYTES,'input_too_large','Input exceeds 128 KiB');chunks.push(b);}
  requireThat(!signal?.aborted,'aborted','Cancelled');
  let text;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.concat(chunks));}catch{requireThat(false,'invalid_params','UTF-8 required');}
  let request;try{request=parseSnapshotJSON(text);}catch{requireThat(false,'invalid_params','Unambiguous JSON required');}
  requireThat(['correct','replay-correction'].includes(request?.operation)||size<=16384,'input_too_large','Non-correction input exceeds 16 KiB');
  authorize();result=await run(input,request,{authorize,signal});authorize();requireThat(!signal?.aborted,'aborted','Cancelled');
  write(JSON.stringify(result)+'\n');return 0;
 }catch(error){
  const e=memoryReviewFailure(error,result);
  write(JSON.stringify({ok:false,error:e.code,read_delivery:e.read_delivery,write_delivery:e.write_delivery,
   write_attempts:e.write_attempts,memory_writes_requested:e.memory_writes_requested})+'\n');return 1;
 }
}
async function runCLI(){
 const c=new AbortController(),cancel=()=>{c.abort();process.stdin.destroy();};
 const timer=setTimeout(cancel,25000);timer.unref();process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
 process.stdout.on('error',()=>{c.abort();process.exitCode=1;});
 try{process.exitCode=await memoryReviewMain(undefined,{signal:c.signal});}
 finally{clearTimeout(timer);process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);process.stdin.destroy();}
}

void runCLI();
