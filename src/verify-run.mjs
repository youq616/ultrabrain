/** Host CLI only. No shell interpolation; no equivalent remote MCP executor. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { requireThat, integer, sha256, sourceId } from './core.mjs';
import { identifier, projectTools, recordExecution } from './projects.mjs';
import { observeWorkspace, workspaceEvidence } from './workspace-evidence.mjs';
export async function runObserved(argv,{ timeoutMs=300000,signal,cwd=process.cwd(),kind='test' }={}) {
  requireThat(Array.isArray(argv) && argv.length>0 && argv.length<=128 && argv.every(x => typeof x==='string'&&!x.includes('\0')),
    'invalid_params','Pass an executable and argument array');
  integer(timeoutMs,300000,10,3600000);
  requireThat(['test','build','check'].includes(kind),'invalid_params','kind must be test, build or check');
  requireThat(!signal?.aborted,'cancelled','Cancelled before process start');
  const before=await observeWorkspace(cwd);
  requireThat(!signal?.aborted,'cancelled','Cancelled before process start');
  const started_at=new Date().toISOString();
  const stdout=createHash('sha256'),stderr=createHash('sha256');
  let timed_out=false,cancelled=false,timer,force;
  const child=spawn(argv[0],argv.slice(1),{cwd,stdio:['ignore','pipe','pipe'],shell:false,detached:true});
  const stop=()=>{
    try {process.kill(-child.pid,'SIGTERM');} catch {}
    force=setTimeout(()=>{try {process.kill(-child.pid,'SIGKILL');} catch {}},1000); force.unref();
  };
  const cancel=()=>{cancelled=true;stop();};
  child.stdout.on('data',chunk=>stdout.update(chunk)); child.stderr.on('data',chunk=>stderr.update(chunk));
  signal?.addEventListener('abort',cancel,{once:true});
  timer=setTimeout(()=>{timed_out=true;stop();},timeoutMs);
  let exit_code;
  try {
    exit_code=await new Promise((resolve,reject)=>{
      child.once('error',()=>reject(Object.assign(new Error('Executable failed to start'),{code:'spawn_failed'})));
      child.once('close',(code)=>resolve(timed_out?124:cancelled?130:code??1));
    });
  } finally {clearTimeout(timer);clearTimeout(force);signal?.removeEventListener('abort',cancel);}
  const finished_at=new Date().toISOString();
  const workspace=workspaceEvidence(before,await observeWorkspace(cwd));
  return {kind,exit_code,timed_out,workspace,command_sha256:sha256(JSON.stringify(argv)),
    stdout_sha256:stdout.digest('hex'),stderr_sha256:stderr.digest('hex'),started_at,finished_at};
}
export async function verifyCLI(args,engine) {
  const split=args.indexOf('--');
  requireThat(split>=0,'invalid_params','verify --source SOURCE --project ID --task ID [--kind test|build|check] -- command args');
  const options={source:'default',kind:'test'};
  for(let i=0;i<split;i+=2) {
    const key=args[i].replace(/^--/,'');
    requireThat(['source','project','task','kind'].includes(key)&&args[i].startsWith('--')&&i+1<split,'invalid_params','Invalid verification option');
    options[key]=args[i+1];
  }
  sourceId(options.source);identifier(options.project);identifier(options.task);
  const state=await projectTools({sourceId:options.source,engine,remote:false}).load({project_id:options.project});
  const task=state.state.tasks.find(t=>t.id===options.task);
  requireThat(task,'not_found','Task not found; create the checkpoint before running verification');
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  let execution;
  try { execution=await runObserved(args.slice(split+1),{kind:options.kind,signal:controller.signal}); }
  finally { process.off('SIGINT',cancel); process.off('SIGTERM',cancel); }
  const receipt=await recordExecution(engine,options.source,options.project,task,execution);
  console.log(JSON.stringify(receipt,null,2));
  return execution.exit_code || (receipt.code_revision_matched === false ? 2 : 0);
}
