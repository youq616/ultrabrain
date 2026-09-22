/** Public read-only CLI -> private Unix socket -> real managed PostgreSQL.
 * Only the explicitly authorized disposable CI installation may exercise fault cases.
 */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync,lstatSync,existsSync,mkdtempSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {homedir,tmpdir} from 'node:os';
import {createHash,randomBytes} from 'node:crypto';
import {connect,ROOT,HOME} from '../src/runtime.mjs';
if(process.env.GITHUB_ACTIONS!=='true'||process.env.ULTRABRAIN_TEST_ALLOW_WRITE!=='1'||
   process.platform!=='linux'||process.getuid()===0||process.getuid()!==process.geteuid()||
   HOME!==join(homedir(),'ultrabrain-personal-services-test'))throw Error('Disposable CI fixture required');
let checks=0;const pass=()=>checks++;
const dir=mkdtempSync(join(tmpdir(),'ub-identity-e2e-'));
const engine=await connect();
const source='identity-'+randomBytes(5).toString('hex');
const state=JSON.parse(readFileSync(join(HOME,'postgres/state.json'),'utf8'));
const config=JSON.parse(readFileSync(join(HOME,'gbrain/.gbrain/config.json'),'utf8'));
const secrets=[state.app_password,state.admin_password,config.database_url,'SYNTHETIC_PROVIDER_PRIVATE'];
const noActions=['services_started','services_stopped','configuration_changed','model_called','memory_read',
 'credentials_returned','application_ready','database_write_requested'];
function invoke({sourceId='default',home=HOME,env={},ok=true}={}){
 const p=spawnSync(process.execPath,[join(ROOT,'src/cli.mjs'),'personal-identity','--home',home,'--source',sourceId],
  {env:{...process.env,...env},encoding:'utf8',timeout:15000,maxBuffer:16384});
 assert.ifError(p.error);assert.equal(p.stderr,'');const result=JSON.parse(p.stdout);
 assert.equal(p.status,ok?0:1,JSON.stringify({error:result.error??null}));assert.equal(result.ok,ok);
 for(const secret of secrets)assert.ok(!p.stdout.includes(secret));
 for(const key of noActions)assert.equal(result[key],false);
 if(ok){assert.equal(result.identity_verified,true);assert.equal(result.database_process_binding_verified,true);
  assert.equal(result.transport,'private-unix-socket');assert.equal(result.authentication,'os-peer-and-scram-sha-256');}
 else{assert.equal(result.identity_verified,false);assert.equal('instance_id'in result,false);}
 return result;
}
async function snapshot(){
 const [counts]=await engine.executeRaw(`SELECT
  (SELECT count(*)::text FROM public.sources) AS sources,
  (SELECT count(*)::text FROM ultrabrain.personal_memories) AS memories,
  (SELECT count(*)::text FROM ultrabrain.personal_events) AS events,
  (SELECT count(*)::text FROM ultrabrain.personal_documents) AS documents,
  (SELECT count(*)::text FROM ultrabrain.personal_consolidations) AS jobs,
  pg_catalog.pg_postmaster_start_time()::text AS started`);
 const files=['postgres/state.json','postgres/runtime.json','postgres/data/PG_VERSION','postgres/data/postmaster.pid','gbrain/.gbrain/config.json'];
 return {counts,files:files.map(name=>{const path=join(HOME,name),st=lstatSync(path);return {name,ino:st.ino,mode:st.mode,
  sha:createHash('sha256').update(readFileSync(path)).digest('hex')};})};
}
try {
 assert.equal(existsSync(join(HOME,'personal-console-token')),false,'Run before credential initialization');
 await engine.executeRaw('INSERT INTO public.sources(id,name) VALUES($1,$1)',[source]);
 const before=await snapshot();
 const [stored]=await engine.executeRaw('SELECT instance_id::text AS instance_id FROM ultrabrain.instance_identity WHERE singleton');
 const first=invoke();assert.equal(first.instance_id,stored.instance_id);assert.equal(first.source_id,'default');pass();
 const selected=invoke({sourceId:source});assert.equal(selected.instance_id,stored.instance_id);assert.equal(selected.source_id,source);pass();
 assert.deepEqual(invoke(),first);pass();
 invoke({sourceId:'absent-'+randomBytes(6).toString('hex'),ok:false});pass();
 invoke({sourceId:"../other",ok:false});pass();
 invoke({home:join(dir,'not-installed'),ok:false});assert.equal(existsSync(join(dir,'not-installed')),false);pass();
 const alias=join(dir,'alias');symlinkSync(HOME,alias,'dir');invoke({home:alias,ok:false});pass();
 const marker=join(dir,'poison-executed'),rc=join(dir,'psqlrc');writeFileSync(rc,`\\! touch '${marker}'\n`);
 const polluted=invoke({env:{PGHOST:'foreign.invalid',PGHOSTADDR:'192.0.2.99',PGSERVICE:'bad',PGSERVICEFILE:rc,
  PGPASSFILE:rc,PGDATABASE:'foreign',PGUSER:'ultrabrain_admin',PGPASSWORD:'wrong',PGOPTIONS:'-c search_path=pg_catalog',
  PSQLRC:rc,PGREQUIREAUTH:'none',OPENAI_API_KEY:'SYNTHETIC_PROVIDER_PRIVATE'}});
 assert.deepEqual(polluted,first);assert.equal(existsSync(marker),false);pass();
 // Lock the source table in this disposable database. The public command must
 // time out without starting/restarting services; a later fresh query recovers.
 let release,entered;const ready=new Promise(resolve=>entered=resolve),hold=new Promise(resolve=>release=resolve);
 const task=engine.transaction(async tx=>{await tx.executeRaw('LOCK TABLE public.sources IN ACCESS EXCLUSIVE MODE');entered();await hold;});
 await Promise.race([ready,task]);
 try{invoke({ok:false});pass();}finally{release();await task;}
 assert.deepEqual(invoke(),first);pass();
 assert.deepEqual(await snapshot(),before);assert.equal(existsSync(join(HOME,'personal-console-token')),false);pass();
 const [active]=await engine.executeRaw("SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity WHERE application_name='ultrabrain-personal-identity'");
 assert.equal(active.n,0,'Probe clients must close after success and failure');pass();
 console.log(`PASS ${checks} managed identity checks: public CLI, real Unix/SCRAM/PostgreSQL/process binding, scoped source, ambient override refusal, actual SQL timeout and recovery; no model calls`);
} finally {try{await engine.executeRaw('DELETE FROM public.sources WHERE id=$1',[source]);}finally{await engine.disconnect();rmSync(dir,{recursive:true,force:true});}}
