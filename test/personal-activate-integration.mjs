/** Actual activation/recovery inside the already-owned disposable CI install.
 * Only this fixture stops its own console between cases; activation/recovery
 * must never stop a service, change enablement or call a model.
 */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync,lstatSync,readFileSync,readdirSync,readlinkSync,renameSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {createHash,randomBytes} from 'node:crypto';
import {HOME,ROOT} from '../src/runtime.mjs';

const target='ultrabrain-personal.target',consoleUnit='ultrabrain-personal-console.service';
const worker='ultrabrain-personal-worker.service',database='ultrabrain-postgres.service';
const digest=value=>createHash('sha256').update(value).digest('hex');
const safeCode=value=>typeof value==='string'&&/^[a-z][a-z_]{0,79}$/.test(value)?value:null;
const noChanges=['configuration_changed','services_stopped','enablement_changed','model_called','automatic_stop_authorized'];

function file(path){
 const st=lstatSync(path),base={dev:st.dev,ino:st.ino,uid:st.uid,gid:st.gid,mode:st.mode};
 if(st.isSymbolicLink())return {...base,link:readlinkSync(path)};
 assert.ok(st.isFile()&&st.size<=262144,'Only bounded regular fixture files may be inspected');
 return {...base,sha256:digest(readFileSync(path))};
}
function tree(path){
 const st=lstatSync(path);assert.equal(st.isDirectory(),true);
 const result=[['',{dev:st.dev,ino:st.ino,uid:st.uid,gid:st.gid,mode:st.mode,mtime_ms:st.mtimeMs}]];
 for(const name of readdirSync(path).sort()){
  const child=join(path,name),value=lstatSync(child);
  if(value.isDirectory())result.push(...tree(child).map(([relative,snapshot])=>[join(name,relative),snapshot]));
  else result.push([name,{...file(child),mtime_ms:value.mtimeMs}]);
 }
 return result;
}

export async function verifyPersonalActivation({engine,spec,current,run,unrelatedUnits,competingDeployment}){
 assert.ok(process.env.GITHUB_ACTIONS==='true'&&process.env.ULTRABRAIN_TEST_ALLOW_WRITE==='1'&&
  process.env.ULTRABRAIN_SYSTEMD_TEST==='1'&&typeof process.getuid==='function'&&process.getuid()!==0&&
  typeof process.geteuid==='function'&&process.getuid()===process.geteuid()&&
  HOME===join(homedir(),'ultrabrain-personal-services-test'),
  'Only the explicitly authorized disposable CI installation may run this test');
 assert.equal(spec.worker,false);assert.match(spec.source,/^deploy-[a-f0-9]{10}$/);
 assert.match(current,/^[a-f0-9]{64}$/);assert.ok(Array.isArray(competingDeployment));
 const unitDir=join(homedir(),'.config/systemd/user'),tokenFile=join(HOME,'personal-console-token');
 const tokenBackup=join(HOME,'.activation-fixture-token-'+randomBytes(12).toString('hex'));
 const tokenBytes=readFileSync(tokenFile),token=tokenBytes.toString('utf8').trim(),secrets=new Set([token]);
 assert.match(token,/^[a-f0-9]{64}$/);assert.equal(existsSync(tokenBackup),false);
 const [identity]=await engine.executeRaw('SELECT instance_id::text AS instance_id FROM ultrabrain.instance_identity WHERE singleton');
 assert.match(identity?.instance_id??'',/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
 const base=['--home',HOME,'--bun',process.execPath,'--source',spec.source,'--port',String(spec.port),
  '--expected-current',current,'--expected-instance',identity.instance_id];
 let checks=0,activeCase='initial_snapshot',lastCode=null,lockPin,baseline,sourceRemoved=false,tokenMoved=false;
 const checkpoints=[],pass=()=>checks++;
 async function ctl(...args){
  assert.ok(['show','stop','reset-failed'].includes(args[0]),'Only fixed fixture manager operations are allowed');
  const result=await run('/usr/bin/systemctl',['--user','--no-pager','--no-ask-password',...args],{ok:false,timeout:15000});
  assert.equal(result.code,0,'Activation fixture systemctl '+args[0]+' failed');return result;
 }
 async function property(unit,key){return (await ctl('show',unit,'--property='+key,'--value')).text.trim();}
 async function invocation(){
  return {pid:await property(consoleUnit,'MainPID'),id:await property(consoleUnit,'InvocationID'),
   restarts:await property(consoleUnit,'NRestarts')};
 }
 async function until(fn,label){
  const end=Date.now()+20000;
  while(Date.now()<end){if(await fn())return;await new Promise(resolve=>setTimeout(resolve,200));}
  throw Error('Activation fixture timed out: '+label);
 }
 async function stopped(){
  assert.equal(await property(target,'ActiveState'),'inactive','Direct console activation must leave the target inactive');
  assert.equal(await property(consoleUnit,'ActiveState'),'inactive');assert.equal(await property(consoleUnit,'Job'),'');
  assert.equal(existsSync(join(unitDir,worker)),false);assert.equal(await property(database,'ActiveState'),'active');
 }
 async function stopOwnedConsole(){
  assert.deepEqual(file(join(unitDir,consoleUnit)),baseline.installed.find(([name])=>name===consoleUnit)[1],
   'Never stop a replacement console unit');
  await ctl('stop',consoleUnit);
  await until(async()=>await property(consoleUnit,'ActiveState')==='inactive'&&await property(consoleUnit,'Job')==='',
   'owned console stopped');
  // The generated service permits three starts per five minutes. Each crash
  // case is independent; only this disposable fixture resets its own stopped
  // console's counter, never the activation/recovery implementation.
  await ctl('reset-failed',consoleUnit);
  await stopped();
 }
 async function live(){
  const origin='http://127.0.0.1:'+spec.port;
  await until(async()=>{try{return (await fetch(origin,{signal:AbortSignal.timeout(1000)})).ok;}catch{return false;}},
   'owned console HTTP');
  assert.equal(await property(target,'ActiveState'),'inactive');
  assert.equal(await property(consoleUnit,'ActiveState'),'active');assert.equal(await property(consoleUnit,'SubState'),'running');
  const value=await invocation();assert.match(value.pid,/^[1-9][0-9]*$/);assert.match(value.id,/^[a-f0-9]{32}$/);
  return value;
 }
 async function snapshot(){
  const [counts]=await engine.executeRaw(`SELECT
   (SELECT count(*)::text FROM public.sources) AS sources,
   (SELECT count(*)::text FROM ultrabrain.personal_memories) AS memories,
   (SELECT count(*)::text FROM ultrabrain.personal_events) AS events,
   (SELECT count(*)::text FROM ultrabrain.personal_documents) AS documents,
   (SELECT count(*)::text FROM ultrabrain.personal_consolidations) AS consolidations,
   (SELECT coalesce(sum(attempts),0)::text FROM ultrabrain.personal_consolidations) AS model_attempts,
   pg_catalog.pg_postmaster_start_time()::text AS postmaster_started`);
  return {counts,unrelated_units:unrelatedUnits(),
   installed:[target,consoleUnit,database].map(name=>[name,file(join(unitDir,name))]),
   config:['gbrain/.gbrain/config.json','postgres/state.json','postgres/runtime.json']
    .map(name=>[name,file(join(HOME,name))]),token:file(tokenFile),
   database:{pid:await property(database,'MainPID'),invocation:await property(database,'InvocationID'),
    active:await property(database,'ActiveState')},
   enablement:await Promise.all([target,consoleUnit,database].map(async name=>[name,await property(name,'UnitFileState')]))};
 }
 async function command(label,args,{program='personal-activate',timeout=75000}={}){
  if(label!=='status')activeCase=label;lastCode=null;
  const response=await run(process.execPath,[ROOT+'/src/cli.mjs',program,...args],{ok:false,timeout});
  assert.equal([...secrets].some(secret=>response.text.includes(secret)),false,'CLI output exposed a bearer secret');
  let body;try{body=JSON.parse(response.text);}catch{throw Error('CLI did not return bounded JSON: '+label);}
  assert.ok(body&&typeof body==='object'&&!Array.isArray(body),'Invalid CLI envelope: '+label);
  lastCode=safeCode(body.error);return {...response,body};
 }
 async function success(label,args){
  const {code,body}=await command(label,args);assert.equal(code,0,'Activation command must succeed: '+label);
  assert.equal(body.ok,true,'Activation command success envelope required: '+label);
  assert.ok(body.result&&typeof body.result==='object');return body.result;
 }
 async function refused(label,args,{program,error}={}){
  const result=await command(label,args,{program});assert.notEqual(result.code,0,'Command must refuse: '+label);
  assert.equal(result.body.ok,false);assert.ok(lastCode,'Refusal must contain a safe error code');
  if(error)assert.equal(lastCode,error,'Unexpected refusal code: '+label);return result.body;
 }
 function unchanged(value){
  for(const key of noChanges)assert.equal(value[key],false,'Activation must report no change: '+key);
 }
 async function status(){return success('status',['status','--home',HOME]);}
 async function plan(){
  const value=await success('plan',['plan',...base]);assert.match(value.activation_plan_sha256,/^[a-f0-9]{64}$/);
  assert.deepEqual(value.starts,[consoleUnit]);assert.equal(value.target_started,false);assert.equal(value.worker_authorized,false);
  unchanged(value);return value.activation_plan_sha256;
 }
 async function pending(){const value=await status();assert.match(value.pending_sha256,/^[a-f0-9]{64}$/);return value.pending_sha256;}
 async function recover(hash,ready){
  const value=await success('recover',['recover','--home',HOME,'--expected-pending',hash]);
  unchanged(value);assert.equal(value.application_ready,ready,'Recovery must accurately report its observation');
  assert.equal((await status()).pending_sha256,null);return value;
 }
 async function crash(checkpoint){
  const hash=await plan();activeCase='crash_'+checkpoint;lastCode=null;
  const result=await run('/usr/bin/python3',['-I','-B',ROOT+'/test/personal-activate-crash.py','apply',...base,
   '--expected-plan',hash,'--checkpoint',checkpoint],{ok:false,timeout:75000});
  assert.equal([...secrets].some(secret=>result.text.includes(secret)),false,'Crash fixture exposed a bearer secret');
  assert.equal(result.code,73,'Actual coordinator must die at the requested durable checkpoint: '+checkpoint);
  return pending();
 }
 async function recoverUnreadReply(hash){
  const initial=await status();assert.equal(initial.dispatch_state,'outcome_unknown');assert.equal(initial.receipt_committed,false);
  const end=Date.now()+45000;
  for(let attempt=0;attempt<3&&Date.now()<end;attempt++){
   const before=await invocation(),wasRunning=await property(consoleUnit,'ActiveState')==='active';
   const response=await command('recover_sent_without_reply',['recover','--home',HOME,'--expected-pending',hash],
    {timeout:Math.min(35000,Math.max(1000,end-Date.now()))});
   if(response.code!==0){
    assert.equal(response.body.ok,false);assert.ok(lastCode,'Recovery refusal must contain a safe code');
    unchanged(response.body);assert.equal(await pending(),hash,'Uncertain recovery must preserve its reservation');
    await new Promise(resolve=>setTimeout(resolve,250));continue;
   }
   assert.equal(response.body.ok,true);const result=response.body.result;
   unchanged(result);assert.equal(result.dispatch_state,'outcome_unknown');
   assert.ok(['ready','not_running'].includes(result.activation_outcome),
    'A sent request without a read reply may be observed ready or terminal; acceptance is not assumed');
   assert.equal((await status()).pending_sha256,null);
   if(result.activation_outcome==='ready'){
    assert.equal(result.application_ready,true);const after=await live();
    assert.equal(result.readiness.console_pid,Number(after.pid));assert.equal(result.readiness.invocation_id,after.id);
    if(wasRunning&&before.pid!=='0')assert.deepEqual(after,before,'Recovery must keep an already-running invocation');
    assert.deepEqual(await invocation(),after,'Recovery completion must not dispatch another start');
    return 'observed_ready';
   }
   assert.equal(result.application_ready,false);
   assert.ok(['inactive','failed'].includes(await property(consoleUnit,'ActiveState')));
   assert.equal(await property(consoleUnit,'MainPID'),'0');assert.equal(await property(consoleUnit,'Job'),'');
   assert.equal(await property(target,'ActiveState'),'inactive');assert.equal(await property(database,'ActiveState'),'active');
   return 'observed_not_running';
  }
  throw Error('Sent-without-reply recovery did not reach a proved observation within its bounded attempts');
 }
 async function pinLock(){
  assert.equal(lockPin,undefined);
  const child=spawn('/usr/bin/python3',['-I','-B',ROOT+'/test/personal-activate-crash.py','hold-lock','--home',HOME],
   {env:process.env,cwd:ROOT,stdio:['pipe','pipe','pipe']});child.stdin.on('error',()=>{});
  let size=0;child.stderr.on('data',chunk=>{size+=chunk.length;if(size>4096)child.kill('SIGKILL');});
  const closed=new Promise(resolve=>{child.once('error',()=>resolve(null));child.once('close',resolve);});
  lockPin={child,closed,output:'',exited:false};const pin=lockPin;closed.then(()=>{pin.exited=true;});
  await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('Activation lock acknowledgement timed out'));},15000);
   const finish=error=>{clearTimeout(timer);error?reject(error):resolve();};
   child.once('error',()=>finish(Error('Activation lock fixture unavailable')));
   child.once('close',()=>finish(Error('Activation lock fixture exited before release')));
   child.stdout.on('data',chunk=>{pin.output+=chunk.toString();
    if(pin.output.length>256){child.kill('SIGKILL');finish(Error('Activation lock output exceeded its bound'));}
    else if(pin.output==='ULTRABRAIN_ACTIVATION_LOCK_READY\n')finish();
    else if(pin.output.includes('\n'))finish(Error('Invalid activation lock acknowledgement'));
   });
  });
 }
 async function releaseLock(){
  if(!lockPin)return;const pin=lockPin;lockPin=undefined;
  assert.equal(pin.exited,false,'Lock fixture must survive until explicit release');
  const timer=setTimeout(()=>pin.child.kill('SIGKILL'),5000);
  try{pin.child.stdin.end('release\n');assert.equal(await pin.closed,0,'Lock fixture release must succeed');
   assert.equal(pin.output,'ULTRABRAIN_ACTIVATION_LOCK_READY\nULTRABRAIN_ACTIVATION_LOCK_RELEASED\n');}
  finally{clearTimeout(timer);}
 }

 const coordination=()=>({deployment:tree(join(HOME,'personal-deployment')),
  activation:existsSync(join(HOME,'personal-activation'))?tree(join(HOME,'personal-activation')):null,
  shared:tree(join(homedir(),'.config/ultrabrain-personal-deployment'))});
 try{
  activeCase='initial_stopped';await stopped();
  activeCase='initial_start_counter_reset';await ctl('reset-failed',consoleUnit);
  activeCase='initial_snapshot';baseline=await snapshot();const beforePlan=coordination();
  assert.equal((await status()).pending_sha256,null);const initial=await plan();await stopped();
  assert.deepEqual(coordination(),beforePlan,'Plan and status must not write deployment or coordination files');pass();
  await refused('wrong_plan',['apply',...base,'--expected-plan',(initial[0]==='0'?'1':'0')+initial.slice(1)]);
  assert.equal((await status()).pending_sha256,null);await stopped();pass();
  const wrongCurrent=[...base];wrongCurrent[wrongCurrent.indexOf('--expected-current')+1]=(current[0]==='0'?'1':'0')+current.slice(1);
  await refused('wrong_current',['plan',...wrongCurrent]);await stopped();pass();
  activeCase='missing_token';renameSync(tokenFile,tokenBackup);tokenMoved=true;
  try{
   await refused('missing_token_plan',['plan',...base]);
   await refused('missing_token_apply',['apply',...base,'--expected-plan',initial]);
   assert.equal(existsSync(tokenFile),false,'Activation must not create a missing console token');
   assert.equal((await status()).pending_sha256,null);await stopped();pass();
  }finally{renameSync(tokenBackup,tokenFile);tokenMoved=false;}
  const stale=await plan(),rotated=randomBytes(32).toString('hex');secrets.add(rotated);
  try{writeFileSync(tokenFile,rotated+'\n');
   await refused('stale_token_plan',['apply',...base,'--expected-plan',stale]);
   assert.equal((await status()).pending_sha256,null);await stopped();pass();
  }finally{writeFileSync(tokenFile,tokenBytes);}
  const lockedPlan=await plan();activeCase='exclusive_lock';await pinLock();
  try{
   await refused('activation_refuses_exclusive_deployment_lock',['apply',...base,'--expected-plan',lockedPlan],{error:'deployment_busy'});
   await refused('deploy_refuses_exclusive_deployment_lock',['apply',...competingDeployment],{program:'personal-deploy',error:'deployment_busy'});
   await stopped();pass();
  }finally{await releaseLock();}
  assert.deepEqual(coordination(),beforePlan,'Rejected or lock-blocked operations must not create transaction files');
  const reviewed=await plan(),started=await success('start_owned_console',['apply',...base,'--expected-plan',reviewed]);
  assert.equal(started.application_ready,true);assert.equal(started.dispatch_state,'acknowledged');unchanged(started);
  const first=await live();assert.equal((await status()).pending_sha256,null);pass();
  await refused('running_console_plan',['plan',...base]);
  await refused('running_console_apply',['apply',...base,'--expected-plan',reviewed]);
  assert.deepEqual(await invocation(),first,'A refused repeated activation must not restart the console');pass();
  await stopOwnedConsole();

  for(const checkpoint of ['after_journal','after_attempt','after_send_before_reply','after_start_before_ack','after_ack','after_receipt','before_clear_pending']){
   const hash=await crash(checkpoint);
   assert.equal((await status()).dispatch_state,checkpoint==='after_journal'?'not_attempted':
    ['after_attempt','after_send_before_reply','after_start_before_ack'].includes(checkpoint)?'outcome_unknown':'acknowledged');
   if(checkpoint==='after_send_before_reply'){
    // A real request was flushed, but the departing sender may lose manager
    // credential lookup before its request is accepted. Both fenced outcomes
    // are valid; neither outcome claims that the reply was read or accepted.
    const outcome=await recoverUnreadReply(hash);
    checkpoints.push({checkpoint,outcome,dispatch_state:'outcome_unknown',client_waited_for_reply:false,extra_starts:0});pass();
    if(outcome==='observed_ready')await stopOwnedConsole();
    else{await ctl('reset-failed',consoleUnit);await stopped();}
    continue;
   }
   const dispatched=!['after_journal','after_attempt'].includes(checkpoint);
   const before=dispatched?await live():await invocation();
   if(checkpoint==='after_journal'){
    await refused('wrong_pending',['recover','--home',HOME,'--expected-pending',(hash[0]==='0'?'1':'0')+hash.slice(1)]);
    assert.equal(await pending(),hash);
    await refused('deploy_refuses_activation_pending',['apply',...competingDeployment],{program:'personal-deploy'});
    assert.equal(await pending(),hash);await stopped();pass();
   }
   if(checkpoint==='after_ack'){
    // Delete only this fixture's unused source after the actual console has
    // opened HTTP. Recovery must execute fresh SQL before committing readiness.
    activeCase='remove_source_after_dispatch';
    const [source]=await engine.executeRaw('SELECT name FROM public.sources WHERE id=$1',[spec.source]);
    assert.equal(source?.name,spec.source);
    await engine.executeRaw('DELETE FROM public.sources WHERE id=$1',[spec.source]);sourceRemoved=true;
    try{
     await refused('recover_live_source_missing',['recover','--home',HOME,'--expected-pending',hash]);
     assert.equal(await pending(),hash);assert.deepEqual(await invocation(),before,
      'Failed readiness must retain the running console and pending operation');pass();
    }finally{await engine.executeRaw('INSERT INTO public.sources(id,name) VALUES($1,$1)',[spec.source]);sourceRemoved=false;}
   }
   const receiptCommitted=['after_receipt','before_clear_pending'].includes(checkpoint);
   await recover(hash,receiptCommitted?'not_checked':dispatched);
   assert.deepEqual(await invocation(),before,'Recovery must never redispatch or restart the console');
   checkpoints.push({checkpoint,outcome:receiptCommitted?'receipt_completed':dispatched?'observed_ready':'terminal_stopped',
    ...(checkpoint==='after_start_before_ack'?{client_waited_for_reply:true,acknowledgement_durable:false}:{}),extra_starts:0});pass();
   if(dispatched)await stopOwnedConsole();else await stopped();
  }
  activeCase='unchanged_after_activation';
  assert.deepEqual(await snapshot(),baseline,
   'Activation cases must preserve database identity, installed generation, private data, config, token and enablement');pass();
  return {checks,systemd:'actual-disposable-user-manager',database:'actual-managed-postgresql',
   activation:'direct-console-start-with-target-inactive',recovery:'actual-process-exit-and-observation-only-recovery',
   checkpoints,source_removed_after_dispatch_refused:true,same_console_after_source_restoration:true,
   fixture_between_cases:'stop-and-reset-failed-only-the-verified-owned-console',
   fixture_console_cache_reference:'existing-ci-helper-with-180-second-bound',
   lock:'actual-exclusive-deployment-flock',configuration_unchanged:true,model_calls:0,user_host_deployed:false};
 }catch(error){
  console.log(JSON.stringify({personal_activation_failure_after_checks:checks,case:activeCase,error_code:lastCode}));
  throw error;
 }finally{
  await releaseLock();
  if(tokenMoved){renameSync(tokenBackup,tokenFile);tokenMoved=false;}
  if(sourceRemoved)await engine.executeRaw('INSERT INTO public.sources(id,name) VALUES($1,$1)',[spec.source]);
 }
}
