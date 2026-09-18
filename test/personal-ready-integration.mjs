/** Readiness acceptance within the already-owned disposable deployment fixture.
 * No unit is started, stopped, reloaded or enabled by this helper. The caller
 * has installed and started its console-only generation and owns its cleanup.
 */
import assert from 'node:assert/strict';
import {existsSync,lstatSync,readFileSync,readdirSync,readlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {createHash,randomBytes} from 'node:crypto';
import {HOME,ROOT} from '../src/runtime.mjs';

const consoleUnit='ultrabrain-personal-console.service',workerUnit='ultrabrain-personal-worker.service';
const units=['ultrabrain-personal.target',consoleUnit,'ultrabrain-postgres.service'];
const noActions=['configuration_changed','services_started','services_stopped','enablement_changed','model_called'];
const digest=value=>createHash('sha256').update(value).digest('hex');

function fileSnapshot(path,{timestamps=true}={}){
 const st=lstatSync(path),identity={dev:st.dev,ino:st.ino,uid:st.uid,gid:st.gid,mode:st.mode};
 if(timestamps)identity.mtime_ms=st.mtimeMs;
 if(st.isSymbolicLink())return {...identity,link:readlinkSync(path)};
 assert.equal(st.isFile(),true,'Only expected regular fixture files may be inspected');
 assert.ok(st.size<=262144,'Fixture file exceeded the inspection bound');
 return {...identity,sha256:digest(readFileSync(path))};
}
function treeSnapshot(path){
 const st=lstatSync(path);
 assert.equal(st.isDirectory(),true,'Fixture snapshot directory must be real');
 const result=[['',{dev:st.dev,ino:st.ino,uid:st.uid,gid:st.gid,mode:st.mode,mtime_ms:st.mtimeMs}]];
 for(const name of readdirSync(path).sort()){
  const child=join(path,name),value=lstatSync(child);
  if(value.isDirectory())result.push(...treeSnapshot(child).map(([relative,snapshot])=>[join(name,relative),snapshot]));
  else result.push([name,fileSnapshot(child)]);
 }
 return result;
}

export async function verifyPersonalReadiness({engine,spec,current,run,unrelatedUnits}){
 assert.ok(process.env.GITHUB_ACTIONS==='true'&&process.env.ULTRABRAIN_TEST_ALLOW_WRITE==='1'&&
  process.env.ULTRABRAIN_SYSTEMD_TEST==='1'&&typeof process.getuid==='function'&&process.getuid()!==0&&
  HOME===join(homedir(),'ultrabrain-personal-services-test'),
  'Only the explicitly authorized disposable CI installation may run this test');
 assert.equal(spec.worker,false,'Readiness acceptance uses only the owned console-only generation');
 assert.match(spec.source,/^deploy-[a-f0-9]{10}$/);
 const unitDir=join(homedir(),'.config/systemd/user'),tokenFile=join(HOME,'personal-console-token');
 assert.equal(existsSync(join(unitDir,workerUnit)),false);
 const tokenBytes=readFileSync(tokenFile),token=tokenBytes.toString('utf8').trim();
 assert.equal(/^[a-f0-9]{64}$/.test(token),true,'Owned console token fixture format is invalid');
 const tokenSecrets=new Set([token]);
 const [identity]=await engine.executeRaw('SELECT instance_id::text AS instance_id FROM ultrabrain.instance_identity WHERE singleton');
 assert.match(identity?.instance_id??'',/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
 const instance=identity.instance_id;
 // PostgreSQL's explicit inet-to-text cast keeps /32; readiness needs the
 // canonical host address. Exercise this real type contract, not a mocked row.
 const [address]=await engine.executeRaw(`SELECT pg_catalog.inet_server_addr()::text AS cast_address,
  pg_catalog.host(pg_catalog.inet_server_addr()) AS host_address`);
 assert.equal(address.cast_address,'127.0.0.1/32');assert.equal(address.host_address,'127.0.0.1');
 const base=new Map([['--home',HOME],['--bun',process.execPath],['--source',spec.source],
  ['--port',String(spec.port)],['--expected-current',current],['--expected-instance',instance]]);
 let checks=0,activeCase='initial_snapshot',lastCode=null,releaseLock,lockTask,lockGuard;
 const pass=()=>checks++;
 async function serviceSnapshot(){
  const keys=['Id','ActiveState','SubState','MainPID','InvocationID','Job','NeedDaemonReload','UnitFileState'];
  const value=await run('/usr/bin/systemctl',['--user','--no-pager','--no-ask-password','show',
   '--property='+keys.join(','),'--',...units],{timeout:10000});
  const rows=value.text.trim().split(/\n\n+/).map(block=>Object.fromEntries(block.split('\n').map(line=>{
   const at=line.indexOf('=');return [line.slice(0,at),line.slice(at+1)];
  }).filter(([key])=>keys.includes(key))));
  assert.deepEqual(rows.map(row=>row.Id).sort(),[...units].sort());
  return rows.sort((a,b)=>a.Id.localeCompare(b.Id));
 }
 async function snapshot(){
  const [counts]=await engine.executeRaw(`SELECT
   (SELECT count(*)::text FROM public.sources) AS sources,
   (SELECT count(*)::text FROM ultrabrain.personal_memories) AS memories,
   (SELECT count(*)::text FROM ultrabrain.personal_events) AS events,
   (SELECT count(*)::text FROM ultrabrain.personal_documents) AS documents,
   (SELECT count(*)::text FROM ultrabrain.personal_consolidations) AS consolidations,
   (SELECT coalesce(sum(attempts),0)::text FROM ultrabrain.personal_consolidations) AS model_attempts`);
  return {counts,services:await serviceSnapshot(),unrelated_units:unrelatedUnits(),
   deployment:treeSnapshot(join(HOME,'personal-deployment')),
   coordination:treeSnapshot(join(homedir(),'.config/ultrabrain-personal-deployment')),
   installed:units.map(name=>[name,fileSnapshot(join(unitDir,name))]),
   config:['gbrain/.gbrain/config.json','postgres/state.json','postgres/runtime.json']
    .map(relative=>[relative,fileSnapshot(join(HOME,relative))]),
   // Rotation below deliberately changes this file's timestamps. Its inode,
   // ownership, mode and exact original bytes must still be restored.
   token:fileSnapshot(tokenFile,{timestamps:false})};
 }
 const baseline=await snapshot(),consoleBefore=baseline.services.find(row=>row.Id===consoleUnit);
 assert.equal(consoleBefore.ActiveState,'active');assert.equal(consoleBefore.SubState,'running');
 assert.match(consoleBefore.MainPID,/^[1-9][0-9]*$/);assert.match(consoleBefore.InvocationID,/^[a-f0-9]{32}$/);
 async function probe(label,overrides={}){
  activeCase=label;lastCode=null;
  const args=new Map(base);for(const [key,value] of Object.entries(overrides))args.set(key,String(value));
  const started=performance.now();
  const response=await run(process.execPath,[ROOT+'/src/cli.mjs','personal-ready',...[...args].flat()],
   {ok:false,timeout:15000});
  const elapsed=performance.now()-started;
  // Never print captured output: even a failing implementation must not put a
  // private token or configuration value into these test diagnostics.
  assert.equal([...tokenSecrets].some(value=>response.text.includes(value)),false,'Readiness CLI exposed a bearer secret');
  let body;try{body=JSON.parse(response.text);}catch{throw Error('Readiness CLI did not return bounded JSON: '+label);}
  assert.equal(!!body&&typeof body==='object'&&!Array.isArray(body),true,'Readiness CLI envelope must be an object');
  if(typeof body.error==='string'&&/^[a-z][a-z_]{0,79}$/.test(body.error))lastCode=body.error;
  return {code:response.code,body,elapsed};
 }
 async function success(label){
  const {code,body}=await probe(label);
  assert.equal(code,0,'Readiness must succeed for the owned live console: '+label);
  assert.equal(body.ok===true,true,'Readiness success envelope is invalid');const value=body.result;
  assert.equal(!!value&&typeof value==='object',true,'Readiness success result is missing');
  for(const [key,expected] of Object.entries({application_ready:true,current_sha256:current,source_id:spec.source,
   instance_id:instance,console_pid:Number(consoleBefore.MainPID),invocation_id:consoleBefore.InvocationID,
   unit_binding_verified:true,database_process_binding_verified:true}))
   assert.equal(value[key]===expected,true,'Readiness result does not match the fixture: '+key);
  for(const key of noActions)assert.equal(value[key]===false,true,'Readiness must report no action: '+key);
  pass();return value;
 }
 async function refused(label,overrides={},expectedError,count=true){
  const response=await probe(label,overrides),{code,body}=response;
  assert.notEqual(code,0,'Readiness must refuse this case: '+label);
  assert.equal(body.ok===false&&body.application_ready===false,true,'Readiness refusal envelope is invalid');
  assert.equal(typeof body.error==='string'&&/^[a-z][a-z_]{0,79}$/.test(body.error),true,'Readiness error code must be safe');
  if(expectedError)assert.equal(body.error===expectedError,true,'Readiness must report '+expectedError+': '+label);
  for(const key of noActions)assert.equal(body[key]===false,true,'A failed probe must report no action: '+key);
  if(count)pass();return response;
 }
 async function unlock(){
  releaseLock?.();if(lockGuard)clearTimeout(lockGuard);lockGuard=null;
  const task=lockTask;lockTask=null;if(task)await task;
 }
 try{
  await success('owned_live_console');
  await refused('wrong_source',{'--source':'ready-wrong-source'});
  await refused('wrong_port',{'--port':spec.port===65535?65534:spec.port+1});
  await refused('wrong_current',{'--expected-current':(current[0]==='0'?'1':'0')+current.slice(1)});
  await refused('wrong_instance',{'--expected-instance':(instance[0]==='0'?'1':'0')+instance.slice(1)},'expected_instance_mismatch');
  activeCase='token_rotation';
  try{
   const rotated=randomBytes(32).toString('hex');tokenSecrets.add(rotated);
   writeFileSync(tokenFile,rotated+'\n');
   await refused('token_rotated_without_restart',{},'readiness_unverified');
  }finally{writeFileSync(tokenFile,tokenBytes);}
  await success('original_token_restored');
  // The fixture creates A solely for this console and has written no memory,
  // event or document under it. A stale startup-only source check must fail.
  activeCase='source_removal';
  const [source]=await engine.executeRaw('SELECT name FROM public.sources WHERE id=$1',[spec.source]);
  assert.equal(source?.name,spec.source);
  await engine.executeRaw('DELETE FROM public.sources WHERE id=$1',[spec.source]);
  try{await refused('source_removed_after_start',{},'readiness_unverified');}
  finally{await engine.executeRaw('INSERT INTO public.sources(id,name) VALUES($1,$1)',[spec.source]);}
  await success('source_restored_without_restart');
  activeCase='database_table_lock';
  let acquired,lockReleased=false;
  const ready=new Promise(resolve=>acquired=resolve),unblock=new Promise(resolve=>releaseLock=resolve);
  lockTask=engine.transaction(async tx=>{
   await tx.executeRaw("SET LOCAL statement_timeout='15s'");
   await tx.executeRaw("SET LOCAL idle_in_transaction_session_timeout='20s'");
   await tx.executeRaw('LOCK TABLE public.sources IN ACCESS EXCLUSIVE MODE');
   acquired();await unblock;
  }).finally(()=>{lockReleased=true;});
  lockGuard=setTimeout(()=>releaseLock(),20000);
  let firstLockError;
  try{
   await Promise.race([ready,lockTask.then(()=>{throw Error('Fixture transaction ended before locking the source table');})]);
   const locked=await refused('live_database_table_locked',{},'readiness_unverified',false);
   assert.equal(lockReleased,false,'PostgreSQL table lock must still be held when the readiness probe refuses');
   assert.ok(locked.elapsed<15000,'The actual locked-database probe must finish within the CLI watchdog');pass();
  }catch(error){firstLockError=error;
  }finally{
   try{await unlock();}catch(error){
    throw new AggregateError([...(firstLockError?[firstLockError]:[]),error],'Readiness fixture lock cleanup failed');
   }
  }
  if(firstLockError)throw firstLockError;
  await success('database_unlocked_same_console_instance');
  activeCase='unchanged_after_probes';
  assert.deepEqual(await snapshot(),baseline,'Probes must preserve configuration, unit identity, enablement and personal data');pass();
  return {checks,systemd:'same-actual-console-invocation',database:'actual-source-removal-and-table-lock-refusal',
   recovery:'same-console-instance-after-source-and-lock-restoration',readonly_snapshot_unchanged:true,
   actual_postgres_address_conversion_verified:true,model_calls:0};
 }catch(error){
  console.log(JSON.stringify({personal_readiness_failure_after_checks:checks,case:activeCase,error_code:lastCode}));
  throw error;
 }finally{
  await unlock();
 }
}
