/** Installed CLI/library -> official SDK -> real PostgreSQL over stdio/HTTP.
 * Disposable synthetic records only, zero injected or external model calls.
 */
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';import {once} from 'node:events';import {createServer} from 'node:net';
import {connect,ROOT} from '../src/runtime.mjs';
import {PersonalMemoryStore} from '../src/personal-memory-store.mjs';
import {PersonalDocumentStore} from '../src/personal-documents.mjs';
assert.equal(process.env.ULTRABRAIN_TEST_ALLOW_WRITE,'1');
const pkg=process.env.ULTRABRAIN_TASK_CLIENT_ROOT;assert.ok(pkg,'Use the installed package');
const cli=join(pkg,'dist/cli.cjs'),library=join(pkg,'dist/overview.cjs');
const dir=mkdtempSync(join(tmpdir(),'ub-overview-real-')),file=join(dir,'profile.json');
const engine=await connect(),source='coverview-'+randomBytes(5).toString('hex');
const ctx={engine,sourceId:source,remote:false,transport:'stdio'},store=new PersonalMemoryStore(ctx);
const sha=s=>createHash('sha256').update(s).digest('hex');
const tables=['personal_memories','personal_events','personal_consolidations','agent_registry','personal_documents','personal_document_fragments'];
let server,tokenName,secret,checks=0;const pass=()=>checks++;
let profile={format:1,source,workspace:dir,project_id:'project-one',server:{transport:'stdio',command:process.execPath,
 args:[ROOT+'/src/cli.mjs','mcp'],env:{ULTRABRAIN_HOME:process.env.ULTRABRAIN_HOME,GBRAIN_SOURCE:source,GBRAIN_SWEEP:'0'}}};
const save=()=>writeFileSync(file,JSON.stringify(profile),{mode:0o600});
const selection=(extra={})=>({workspace:dir,scope:'owned-all-projects',consent:true,...extra});
async function snapshot(){
 const out={};for(const t of tables)out[t]=(await engine.executeRaw(`SELECT md5(coalesce(string_agg(row_to_json(t)::text,',' ORDER BY row_to_json(t)::text),'')) AS h FROM ultrabrain.${t} t WHERE source_id=$1`,[source]))[0].h;
 return out;
}
async function run(command,input,{sdk=false,raw}={}){
 const args=sdk?['-e',`const {inspectClientOverview}=require(process.argv[1]);const fs=require('node:fs');
 inspectClientOverview(JSON.parse(fs.readFileSync(process.argv[2],'utf8')),JSON.parse(process.argv[3]))
 .then(r=>process.stdout.write(JSON.stringify(r)+'\\n')).catch(e=>{process.stdout.write(JSON.stringify({ok:false,error:e.code,read_delivery:e.read_delivery})+'\\n');process.exitCode=1;});`,
 library,file,JSON.stringify(input)]:[cli,command,'--profile',file];
 const child=spawn('node',args,{cwd:ROOT,env:process.env,stdio:['pipe','pipe','pipe']});
 let out='',err='';child.stdout.on('data',b=>{out+=b;if(out.length>65536)child.kill('SIGKILL');});
 child.stderr.on('data',b=>{err+=b;if(err.length>65536)child.kill('SIGKILL');});child.stdin.on('error',()=>{});
 const timer=setTimeout(()=>child.kill('SIGKILL'),35000);
 try{
  child.stdin.end(raw??(input===undefined?'':JSON.stringify(input)));
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  for(const text of [secret??'NO_CREDENTIAL_SENTINEL','PRIVATE_OVERVIEW_RECORD'])assert.ok(!out.includes(text)&&!err.includes(text));
  assert.equal(err,'');return {code,data:JSON.parse(out)};
 }finally{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
}
try{
 await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)',[source]);
 await store.register({agent_id:'overview-client-fixture'});
 const entries=(await store.commit({agent_id:'overview-client-fixture',event_id:'seed',consent:true,memories:[
  {type:'preference',content:'PRIVATE_OVERVIEW_RECORD global shared',visibility:'source'},
  {type:'preference',content:'PRIVATE_OVERVIEW_RECORD project one',project_id:'project-one'},
  {type:'preference',content:'PRIVATE_OVERVIEW_RECORD project two',project_id:'project-two'}]})).entries;
 await store.review({memory_id:entries[0].id,expected_revision:1,event_id:'activate',status:'active'});
 await store.review({memory_id:entries[2].id,expected_revision:1,event_id:'archive',status:'archived'});
 await store.capture({agent_id:'overview-client-fixture',event_id:'capture',consent:true,transcript:'PRIVATE_OVERVIEW_RECORD queued'});
 const documents=new PersonalDocumentStore(ctx),bytes=Buffer.from('PRIVATE_OVERVIEW_RECORD document');
 const doc=await documents.documentImport({agent_id:'overview-client-fixture',event_id:'document',consent:true,label:'synthetic.txt',content_base64:bytes.toString('base64'),content_sha256:sha(bytes)});
 await documents.documentQueue({document_id:doc.document_id,event_id:'document-queue'});
 save();let r=await run('probe');assert.equal(r.code,0);const owner=r.data.identity;
 Object.assign(profile,{expected_actor:owner.actor_key,expected_instance:owner.instance_id});save();
 const before=await snapshot();let lastId;
 for(const sdk of [false,true]){
  r=await run('overview',selection(),{sdk});assert.equal(r.code,0);const v=r.data.overview;
  assert.equal(r.data.format,'ultrabrain-client-overview-v1');assert.equal(r.data.read_requests,1);assert.equal(r.data.memory_writes_requested,false);
  assert.equal(v.source_id,source);assert.equal(v.scope,'owned-all-projects');assert.equal(v.model_calls,0);
  assert.deepEqual(v.memories,{total:5,candidate:3,active:1,archived:1,active_current:1,active_stale:0,candidate_stale:0,document_fragments:1});
  assert.equal(v.jobs.total,2);assert.equal(v.jobs.queued,2);assert.equal(v.jobs.processing,0);
  assert.deepEqual(v.documents,{total:1,active:1,archived:0});assert.deepEqual(v.agents,{total:1});
  assert.notEqual(v.request_id,lastId);lastId=v.request_id;pass();
 }
 for(const patch of [{consent:false},{scope:'project'},{source_id:'other'},{include_text:true},{workspace:join(dir,'absent')}]){
  r=await run('overview',selection(patch));assert.equal(r.code,1);assert.equal(r.data.read_delivery,'not_started');assert.equal(r.data.memory_writes_requested,false);pass();
 }
 profile.expected_actor='f'.repeat(64);save();r=await run('overview',selection());assert.equal(r.code,1);assert.equal(r.data.error,'identity_mismatch');pass();
 assert.deepEqual(await snapshot(),before);pass();
 // A read token in the same source has a distinct owner: source sharing does
 // not expose the stdio owner's aggregate statistics to this principal.
 const socket=createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r));
 secret='gbrain_'+randomBytes(32).toString('hex');tokenName=source+'-reader';
 await engine.executeRaw('INSERT INTO access_tokens(name,token_hash,scopes,permissions) VALUES($1,$2,$3::text[],$4::text::jsonb)',
 [tokenName,sha(secret),'{read}',JSON.stringify({source_id:source,takes_holders:['world']})]);
 server=spawn(process.execPath,[ROOT+'/src/cli.mjs','mcp','--http','--bind','127.0.0.1','--port',String(port),'--suppress-bootstrap-token'],
 {cwd:ROOT,env:{...process.env,GBRAIN_SWEEP:'0',GBRAIN_ADMIN_BOOTSTRAP_TOKEN:randomBytes(32).toString('hex')},stdio:['ignore','ignore','pipe']});server.stderr.on('data',()=>{});
 let ready=false;for(let i=0;i<100;i++){try{ready=(await fetch(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.timeout(300)})).ok;}catch{}if(ready)break;await new Promise(r=>setTimeout(r,100));}assert.ok(ready);
 process.env.ULTRABRAIN_OVERVIEW_TEST_TOKEN=secret;
 profile={format:1,source,workspace:dir,server:{transport:'http',url:`http://127.0.0.1:${port}/mcp`,bearer_env:'ULTRABRAIN_OVERVIEW_TEST_TOKEN'}};
 save();r=await run('probe');assert.equal(r.code,0);assert.notEqual(r.data.identity.actor_key,owner.actor_key);
 Object.assign(profile,{expected_actor:r.data.identity.actor_key,expected_instance:r.data.identity.instance_id});save();
 for(const sdk of [false,true]){
  r=await run('overview',selection(),{sdk});assert.equal(r.code,0);
  for(const group of ['memories','jobs','documents','agents'])assert.ok(Object.values(r.data.overview[group]).every(n=>n===0));pass();
 }
 await engine.executeRaw('UPDATE access_tokens SET revoked_at=now() WHERE name=$1',[tokenName]);
 r=await run('overview',selection());assert.equal(r.code,1);assert.equal(r.data.read_delivery,'not_started');assert.equal(r.data.overview,undefined);pass();
 assert.deepEqual(await snapshot(),before);pass();
 const report={passed:true,checks,mode:'installed Node CLI/library, official SDK, PostgreSQL, stdio and authenticated HTTP',
 model_calls:0,read_phase_tables_unchanged:6,customer_host_verified:false};
 if(process.env.ULTRABRAIN_CLIENT_OVERVIEW_REPORT)writeFileSync(process.env.ULTRABRAIN_CLIENT_OVERVIEW_REPORT,JSON.stringify(report,null,2)+'\n');
 console.log(`PASS ${checks} installed client overview checks; owner/project scope, read-only HTTP, six unchanged tables, zero models`);
}finally{
 delete process.env.ULTRABRAIN_OVERVIEW_TEST_TOKEN;
 if(server&&server.exitCode===null&&server.signalCode===null){server.kill('SIGTERM');const t=setTimeout(()=>server.kill('SIGKILL'),5000);await once(server,'close');clearTimeout(t);}
 if(tokenName)await engine.executeRaw('DELETE FROM access_tokens WHERE name=$1',[tokenName]);
 await engine.disconnect();rmSync(dir,{recursive:true,force:true});
}
