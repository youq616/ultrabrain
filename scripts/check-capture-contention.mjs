#!/usr/bin/env node
/** Real multi-process filesystem self-test, SYNTHETIC queues only. No server or
 * user profile/queue selection. Does not diagnose root cause from pass alone. */
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {CaptureOutbox} from '../src/capture-outbox.mjs';
const WORKERS=8;
const workerPath=fileURLToPath(new URL('../test/fixtures/capture-contention-worker.mjs',import.meta.url));
export async function captureContentionRound(){
 const root=mkdtempSync(join(tmpdir(),'ub-contention-')),workspace=join(root,'work');mkdirSync(workspace,{mode:0o700});
 const input={format:1,source:'synthetic',workspace,outbox_directory:join(root,'outbox'),allow_capture:true,
  expected_actor:'a'.repeat(64),expected_instance:'11111111-1111-4111-8111-111111111111',
  server:{transport:'stdio',command:'never-executed',args:[]}};
 const children=[];let timer;
 try{
  const tasks=Array.from({length:WORKERS},(_,worker)=>{
   const child=spawn(process.execPath,[workerPath],{stdio:['ignore','pipe','pipe','ipc']});children.push(child);
   let out='',size=0,stderr=false,overflow=false,readyResolve,readyReject;
   const ready=new Promise((r,j)=>{readyResolve=r;readyReject=j;});
   child.on('message',m=>{if(m?.ready===true)readyResolve();});
   child.stdout.on('data',chunk=>{size+=chunk.length;if(size>4096){overflow=true;child.kill();}else out+=chunk;});
   child.stderr.on('data',()=>{stderr=true;});
   const done=new Promise(resolve=>{
    child.once('error',()=>{readyReject(Error('child_spawn_failed'));});
    child.once('close',(exit,signal)=>{
     readyReject(Error('child_exited_before_barrier'));let result;
     try{result=JSON.parse(out);}catch{}
     const valid=!overflow&&!stderr&&result&&typeof result.ok==='boolean'&&Number.isSafeInteger(result.busy_retries)&&result.busy_retries>=0&&result.busy_retries<=21;
     resolve({worker,exit,signal,valid,result:valid?result:{ok:false,code:'invalid_child_report'}});
    });
   });
   return {ready,done,go:()=>child.send({input,worker},()=>{})};
  });
  timer=setTimeout(()=>{for(const child of children)child.kill();},15000);
  // All modules are loaded before any constructor or first binding is created.
  await Promise.all(tasks.map(t=>t.ready));for(const task of tasks)task.go();
  const outcomes=await Promise.all(tasks.map(t=>t.done));
  if(outcomes.some(v=>!v.valid||v.exit!==0||v.signal!==null||!v.result.ok))return {passed:false,stage:'writers',outcomes};
  const q=new CaptureOutbox(input),status=await q.status();
  const expected=['shared-event',...Array.from({length:WORKERS},(_,i)=>['writer-'+i+'-0','writer-'+i+'-1']).flat()].sort();
  const names=readdirSync(q.directory),records=names.filter(n=>n.endsWith('.entry')).map(n=>JSON.parse(readFileSync(join(q.directory,n),'utf8')));
  const actual=records.map(r=>r.payload.event_id).sort();
  const valid=JSON.stringify(actual)===JSON.stringify(expected)&&status.pending===expected.length&&status.blocked===0&&
   names.length===expected.length+1&&records.every(r=>r.attempts===0&&r.payload.transcript==='SYNTHETIC_CONTENTION_PAYLOAD:'+r.payload.event_id)&&
   outcomes.reduce((n,v)=>n+v.result.replays,0)===WORKERS-1;
  return {passed:valid,stage:'integrity',writers:WORKERS,requests:WORKERS*3,records:records.length,
   identical_replays:outcomes.reduce((n,v)=>n+v.result.replays,0),busy_retries:outcomes.reduce((n,v)=>n+v.result.busy_retries,0)};
 }finally{
  clearTimeout(timer);
  await Promise.all(children.filter(c=>c.exitCode===null&&c.signalCode===null).map(child=>new Promise(resolve=>{
   child.once('close',resolve);child.kill('SIGKILL');
  })));
  rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:30});
 }
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
 }catch{console.log(JSON.stringify({passed:false,error:'contention_unconfirmed',rounds_completed:observations.length}));process.exitCode=1;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)void main();
