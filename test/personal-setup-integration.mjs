/** First-use setup through the public CLI and real Unix/SCRAM/PostgreSQL.
 * Only this disposable fixture mutates synthetic credentials/history for refusals.
 * Console startup below is separate and explicit; setup must never start it.
 */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync,readFileSync,lstatSync,renameSync,mkdirSync,rmdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {createHash,randomBytes} from 'node:crypto';
import {ROOT,HOME,connect} from '../src/runtime.mjs';
import {consoleToken,startPersonalConsole} from '../src/personal-console.mjs';
if(process.env.GITHUB_ACTIONS!=='true'||process.env.ULTRABRAIN_TEST_ALLOW_WRITE!=='1'||process.platform!=='linux'||
   process.getuid()===0||process.getuid()!==process.geteuid()||HOME!==join(homedir(),'ultrabrain-personal-services-test'))
 throw Error('Explicit disposable CI installation required');
const tokenFile=join(HOME,'personal-console-token');
const engine=await connect();let checks=0,ui;const pass=()=>checks++;
const source='setup-'+randomBytes(5).toString('hex');
const state=JSON.parse(readFileSync(join(HOME,'postgres/state.json'),'utf8'));
const privateValues=[state.app_password,state.admin_password,'SYNTHETIC_SETUP_PROVIDER_SECRET'];
const noActions=['services_started','services_stopped','configuration_changed','model_called','memory_read',
 'credentials_returned','database_write_requested'];
function invoke(action,{sourceId='default',expected,ok=true,verified=ok,env={}}={}){
 const args=[join(ROOT,'src/cli.mjs'),'personal-setup',action,'--home',HOME,'--source',sourceId];
 if(expected!==undefined)args.push('--expected-instance',expected);
 const p=spawnSync(process.execPath,args,{encoding:'utf8',env:{...process.env,...env},timeout:30000,maxBuffer:16384});
 assert.ifError(p.error);assert.equal(p.stderr,'');const result=JSON.parse(p.stdout);
 assert.equal(p.status,ok?0:1,JSON.stringify({error:result.error??null}));assert.equal(result.ok,ok);
 assert.equal(result.prepared,ok);assert.equal(result.identity_verified,verified);
 assert.equal(result.application_readiness,'not_checked');assert.equal(result.deployment_readiness,'not_checked');
 for(const key of noActions)assert.equal(result[key],false);
 for(const secret of privateValues)assert.ok(!p.stdout.includes(secret));
 if(!verified)assert.equal('instance_id'in result,false);
 return result;
}
function file(name){const path=join(HOME,name),st=lstatSync(path);return {name,ino:st.ino,mode:st.mode,
 sha:createHash('sha256').update(readFileSync(path)).digest('hex')};}
async function snapshot(){
 const [counts]=await engine.executeRaw(`SELECT
  (SELECT count(*)::text FROM public.sources) AS sources,
  (SELECT count(*)::text FROM ultrabrain.personal_memories) AS memories,
  (SELECT count(*)::text FROM ultrabrain.personal_events) AS events,
  (SELECT count(*)::text FROM ultrabrain.personal_documents) AS documents,
  (SELECT count(*)::text FROM ultrabrain.personal_consolidations) AS jobs,
  pg_catalog.pg_postmaster_start_time()::text AS started`);
 return {counts,files:['postgres/state.json','postgres/runtime.json','postgres/data/PG_VERSION',
  'postgres/data/postmaster.pid','gbrain/.gbrain/config.json'].map(file)};
}
try{
 assert.equal(existsSync(tokenFile),false,'Run setup tests only before credential initialization');
 assert.equal(existsSync(join(HOME,'personal-deployment')),false);assert.equal(existsSync(join(HOME,'personal-activation')),false);
 await engine.executeRaw('INSERT INTO public.sources(id,name) VALUES($1,$1)',[source]);
 const [stored]=await engine.executeRaw('SELECT instance_id::text AS instance_id FROM ultrabrain.instance_identity WHERE singleton');
 const before=await snapshot();
 const missing=invoke('check',{ok:false,verified:true});assert.equal(missing.state,'credentials_required');
 assert.equal(missing.instance_id,stored.instance_id);assert.equal(missing.token_creation,'absent');assert.equal(existsSync(tokenFile),false);pass();
 invoke('prepare',{sourceId:'absent-'+randomBytes(5).toString('hex'),ok:false});assert.equal(existsSync(tokenFile),false);pass();
 const wrongInstance=stored.instance_id==='11111111-1111-4111-8111-111111111111'?'22222222-2222-4222-8222-222222222222':'11111111-1111-4111-8111-111111111111';
 const mismatch=invoke('prepare',{expected:wrongInstance,ok:false});
 assert.equal(mismatch.error,'setup_instance_mismatch');assert.equal(existsSync(tokenFile),false);pass();
 const prepared=invoke('prepare',{sourceId:source,expected:stored.instance_id});
 assert.equal(prepared.token_creation,'created');assert.equal(prepared.instance_id,stored.instance_id);assert.equal(prepared.source_id,source);
 const raw=readFileSync(tokenFile),token=raw.toString('ascii').trim();privateValues.push(token);
 assert.equal(lstatSync(tokenFile).mode&0o777,0o600);assert.match(token,/^[a-f0-9]{64}$/);
 assert.ok(!JSON.stringify(prepared).includes(token));pass();
 const tokenBefore=file('personal-console-token');
 for(const action of ['check','prepare']){
  const result=invoke(action,{sourceId:source,expected:stored.instance_id});assert.equal(result.token_creation,'existing');
  assert.deepEqual(file('personal-console-token'),tokenBefore);pass();
 }
 // Ambient database/model overrides cannot choose another destination or credential.
 invoke('check',{expected:stored.instance_id,env:{PGHOST:'foreign.invalid',PGDATABASE:'other',PGUSER:'ultrabrain_admin',
  PGPASSWORD:'wrong',PGOPTIONS:'-c search_path=pg_catalog',OPENAI_API_KEY:'SYNTHETIC_SETUP_PROVIDER_SECRET'}});pass();
 // A genuine server-side SQL lock refuses without touching credentials, then recovers.
 let entered,release;const ready=new Promise(resolve=>entered=resolve),hold=new Promise(resolve=>release=resolve);
 const task=engine.transaction(async tx=>{await tx.executeRaw('LOCK TABLE public.sources IN ACCESS EXCLUSIVE MODE');entered();await hold;});
 await Promise.race([ready,task]);
 try{invoke('prepare',{ok:false});assert.deepEqual(file('personal-console-token'),tokenBefore);pass();}
 finally{release();await task;}
 invoke('check',{expected:stored.instance_id});pass();
 const held=join(HOME,'setup-test-held-token'),history=join(HOME,'personal-activation');
 assert.equal(existsSync(held),false);renameSync(tokenFile,held);
 try{
  mkdirSync(history,{mode:0o700});
  try{for(const action of ['check','prepare']){
   assert.equal(invoke(action,{ok:false}).error,'token_recovery_required');assert.equal(existsSync(tokenFile),false);pass();
  }}finally{rmdirSync(history);}
 }finally{renameSync(held,tokenFile);}
 try{
  writeFileSync(tokenFile,Buffer.from(token+'\r\n'));
  for(const action of ['check','prepare']){
   assert.equal(invoke(action,{ok:false}).error,'invalid_console_token');assert.equal(readFileSync(tokenFile,'ascii'),token+'\r\n');pass();
  }
 }finally{writeFileSync(tokenFile,raw);}
 assert.deepEqual(await snapshot(),before);assert.equal(consoleToken(tokenFile),token);pass();
 // Separately prove that the prepared token works with the real console. The
 // setup result while that console runs must still say readiness NOT CHECKED.
 ui=await startPersonalConsole({engine,source,token,port:0});
 const response=await fetch(ui.origin+'/api/call',{method:'POST',headers:{Origin:ui.origin,'Content-Type':'application/json',
  Authorization:'Bearer '+token},body:JSON.stringify({operation:'info'})});
 assert.equal(response.status,200);assert.equal((await response.json()).result.source_id,source);
 assert.equal(invoke('check',{sourceId:source,expected:stored.instance_id}).application_readiness,'not_checked');pass();
 const [clients]=await engine.executeRaw("SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity WHERE application_name='ultrabrain-personal-identity'");
 assert.equal(clients.n,0);assert.deepEqual(await snapshot(),before);assert.ok(readFileSync(tokenFile).equals(raw));pass();
 console.log(`PASS ${checks} first-use setup checks: actual CLI/private Unix/SCRAM/PostgreSQL, create-only credentials, wrong-instance/source refusal, SQL timeout recovery and separately authenticated console; no model calls`);
}finally{
 try{await ui?.close();}finally{try{await engine.executeRaw('DELETE FROM public.sources WHERE id=$1',[source]);}finally{await engine.disconnect();}}
}
