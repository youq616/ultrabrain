#!/usr/bin/env node
/** Explicit one-page metadata read. No automatic pagination, retry or file scanning. */
import {isAbsolute} from 'node:path';
import {listClientCandidates} from './candidates.mjs';
import {candidatesFailure} from '../../../src/client-candidates.mjs';
import {readClientProfile,clientProfileAuthorization} from '../../../src/client-profile-file.mjs';
import {parseSnapshotJSON} from '../../../src/personal-snapshot-contract.mjs';
import {requireThat} from '../../../src/core.mjs';
export async function candidatesMain(args=process.argv.slice(2),{stdin=process.stdin,write=s=>process.stdout.write(s),run=listClientCandidates,signal}={}){
 let result;
 try{
  if(args.length===1&&args[0]==='--help'){
   write('Usage: ultrabrain-candidates --profile ABSOLUTE_PATH < request.json\n'+
    'Request: {"workspace":"/absolute/workspace","consent":true,"limit":20}. Optional after_id continues a live page.\n'+
    'Only owned non-document candidates in global/bound project. No body, writes, model, automatic paging or retries.\n');return 0;
  }
  requireThat(args.length===2&&args[0]==='--profile'&&isAbsolute(args[1]),'invalid_params','Use --profile ABSOLUTE_PATH');
  requireThat(!signal?.aborted,'aborted','Cancelled');
  const path=args[1],{input}=readClientProfile(path),authorize=clientProfileAuthorization(path,input);
  const chunks=[];let size=0;
  for await(const chunk of stdin){requireThat(!signal?.aborted,'aborted','Cancelled');const b=Buffer.from(chunk);size+=b.length;
   requireThat(size<=16384,'input_too_large','Input exceeds 16 KiB');chunks.push(b);}
  requireThat(!signal?.aborted,'aborted','Cancelled');let request;
  try{request=parseSnapshotJSON(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.concat(chunks)));}
  catch{requireThat(false,'invalid_params','Unambiguous UTF-8 JSON required');}
  authorize();result=await run(input,request,{authorize,signal});authorize();requireThat(!signal?.aborted,'aborted','Cancelled');
  write(JSON.stringify(result)+'\n');return 0;
 }catch(error){const e=candidatesFailure(error,result);write(JSON.stringify({ok:false,error:e.code,
  read_delivery:e.read_delivery,memory_writes_requested:false})+'\n');return 1;}
}
async function runCLI(){
 const c=new AbortController(),cancel=()=>{c.abort();process.stdin.destroy();};
 const timer=setTimeout(cancel,25000);timer.unref();process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
 process.stdout.on('error',()=>{c.abort();process.exitCode=1;});
 try{process.exitCode=await candidatesMain(undefined,{signal:c.signal});}
 finally{clearTimeout(timer);process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);process.stdin.destroy();}
}
void runCLI();
