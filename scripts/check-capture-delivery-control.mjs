#!/usr/bin/env node
/** Eight real processes enqueue while paused, then race the same resume CAS.
 * Only generated temporary synthetic data; no user profile or queue option. */
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {CaptureOutbox} from '../src/capture-outbox.mjs';
const workerPath=fileURLToPath(new URL('../test/fixtures/capture-delivery-control-worker.mjs',import.meta.url));
export async function deliveryControlRound(){
 const root=mkdtempSync(join(tmpdir(),'ub-control-process-')),workspace=join(root,'work');mkdirSync(workspace,{mode:0o700});
 const input={format:1,source:'synthetic',workspace,outbox_directory:join(root,'queue'),allow_capture:true,expected_actor:'a'.repeat(64),
  expected_instance:'11111111-1111-4111-8111-111111111111',server:{transport:'stdio',command:'never-executed',args:[]}};
 const children=[];let timer;
 try{
  const q=new CaptureOutbox(input),pause=await q.pauseDelivery();
  const tasks=Array.from({length:8},(_,worker)=>{
   const child=spawn(process.execPath,[workerPath],{stdio:['ignore','pipe','pipe','ipc']});children.push(child);
   let readyResolve,stagedResolve,rejectReady,rejectStaged,output='',stderr=false,overflow=false;
   const ready=new Promise((r,j)=>{readyResolve=r;rejectReady=j;}),staged=new Promise((r,j)=>{stagedResolve=r;rejectStaged=j;});
   // Both phases have rejection handlers even if the other phase fails first.
   ready.catch(()=>{});staged.catch(()=>{});
   child.on('message',m=>{if(m?.ready===true)readyResolve();if(m?.staged===true)stagedResolve();});
   child.stdout.on('data',b=>{if(output.length+b.length>2048){overflow=true;child.kill();}else output+=b;});child.stderr.on('data',()=>stderr=true);
   const done=new Promise(resolve=>{
    const reject=()=>{rejectReady(Error('worker_unavailable'));rejectStaged(Error('worker_unavailable'));};
    child.once('error',reject);child.once('close',(exit,signal)=>{
     reject();let report;try{report=JSON.parse(output);}catch{}
     resolve({valid:!stderr&&!overflow&&exit===0&&signal===null&&report?.ok===true&&['resumed','conflict'].includes(report.outcome),outcome:report?.outcome});
    });
   });
   return {ready,staged,done,start:()=>child.send({input,worker},()=>{}),resume:()=>child.send({expectedHash:pause.control_sha256},()=>{})};
  });
  timer=setTimeout(()=>{for(const child of children)child.kill('SIGKILL');},15000);
  await Promise.all(tasks.map(t=>t.ready));for(const task of tasks)task.start();await Promise.all(tasks.map(t=>t.staged));
  const snapshot=()=>readdirSync(q.directory).filter(n=>n.endsWith('.entry')).sort().map(n=>readFileSync(join(q.directory,n),'utf8'));
  const before=snapshot(),paused=(await q.status()).delivery;
  for(const task of tasks)task.resume();const results=await Promise.all(tasks.map(t=>t.done));
  const after=snapshot(),status=await q.status(),resumed=results.filter(r=>r.outcome==='resumed').length,conflicts=results.filter(r=>r.outcome==='conflict').length;
  const passed=results.every(r=>r.valid)&&resumed===1&&conflicts===7&&paused.control_sha256===pause.control_sha256&&
   status.delivery.state==='running'&&status.delivery.revision===2&&status.pending===8&&status.blocked===0&&
   JSON.stringify(before)===JSON.stringify(after)&&after.every(b=>JSON.parse(b).attempts===0)&&
   readdirSync(q.directory).length===10;
  return {passed,workers:8,consented_entries:after.length,resume_successes:resumed,stale_conflicts:conflicts,
   payloads_unchanged:JSON.stringify(before)===JSON.stringify(after),attempts_spent:after.reduce((n,b)=>n+JSON.parse(b).attempts,0)};
 }finally{
  clearTimeout(timer);
  await Promise.all(children.filter(c=>c.exitCode===null&&c.signalCode===null).map(c=>new Promise(r=>{c.once('close',r);c.kill('SIGKILL');})));
  rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:30});
 }
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
 }catch{console.log(JSON.stringify({passed:false,error:'delivery_control_check_failed',rounds_completed:observations.length}));process.exitCode=1;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)void main();
