/** Actual installed Node CLI/library, official MCP SDK, PostgreSQL and HTTP.
 * Only disposable synthetic data; four injected generators, zero external models.
 */
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {connect,ROOT} from '../src/runtime.mjs';
import {PersonalMemoryStore} from '../src/personal-memory-store.mjs';
import {PersonalDocumentStore} from '../src/personal-documents.mjs';
import {PersonalConsolidator} from '../src/personal-consolidation.mjs';
import {personalModelProfile} from '../src/personal-consolidation-core.mjs';
assert.equal(process.env.ULTRABRAIN_TEST_ALLOW_WRITE,'1','Disposable database only');
const packageRoot=process.env.ULTRABRAIN_TASK_CLIENT_ROOT;
assert.ok(packageRoot,'Use the actually installed package, not source imports');
const cli=join(packageRoot,'dist/cli.cjs'),library=join(packageRoot,'dist/lineage.cjs');
const engine=await connect(),source='clineage-'+randomBytes(5).toString('hex'),dir=mkdtempSync(join(tmpdir(),'ub-client-lineage-real-'));
const file=join(dir,'profile.json'),actorCtx={engine,sourceId:source,remote:false,transport:'stdio'};
const store=new PersonalMemoryStore(actorCtx),documents=new PersonalDocumentStore(actorCtx);
const fixture={},tables=['personal_memories','personal_events','personal_consolidations','agent_registry','personal_documents','personal_document_fragments'];
const sha=s=>createHash('sha256').update(s).digest('hex');
let checks=0,generators=0,httpServer,tokenName;const pass=()=>checks++;
let profile={format:1,source,workspace:dir,project_id:'lineage-project',server:{transport:'stdio',command:process.execPath,
 args:[ROOT+'/src/cli.mjs','mcp'],env:{ULTRABRAIN_HOME:process.env.ULTRABRAIN_HOME,GBRAIN_SOURCE:source,GBRAIN_SWEEP:'0'}}};
const save=()=>writeFileSync(file,JSON.stringify(profile),{mode:0o600});
const snapshot=async()=>{
 const r={};for(const t of tables)r[t]=(await engine.executeRaw(`SELECT md5(coalesce(string_agg(row_to_json(t)::text,',' ORDER BY row_to_json(t)::text),'')) AS h FROM ultrabrain.${t} t WHERE source_id=$1`,[source]))[0].h;
 return r;
};
const request=(id,extra={})=>({memory_id:id,workspace:dir,consent:true,...extra});
async function run(command,input,{sdk=false,race=false}={}){
 let controlError;
 const args=sdk?['-e',`const {inspectClientLineage}=require(process.argv[1]);const fs=require('node:fs');
 (async()=>{const profile=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));const r=await inspectClientLineage(profile,${JSON.stringify(input)});
 process.stdout.write(JSON.stringify(r)+'\\n');})().catch(()=>{process.exitCode=1;});`,library,file]:[cli,command,'--profile',file];
 if(race){
  const preload=join(dir,'race.cjs');
  // Fault coordination only: wait AFTER actual source response BEFORE final root read.
  writeFileSync(preload,`const {Client}=require(${JSON.stringify(join(dirname(packageRoot),'@modelcontextprotocol/sdk/dist/cjs/client/index.js'))});
 const original=Client.prototype.callTool;let fired=false;
 Client.prototype.callTool=async function(req,...rest){const result=await original.call(this,req,...rest);
 if(!fired&&req.name==='ultra_memory_read'&&req.arguments.memory_id===${JSON.stringify(fixture.matched.input)}){
 fired=true;await new Promise(resolve=>{process.once('message',resolve);process.send({sourceObserved:true});});process.disconnect();}
 return result;};`,{mode:0o600});
  args.unshift('--require',preload);
 }
 const child=spawn('node',args,{cwd:ROOT,env:process.env,stdio:['pipe','pipe','pipe',...(race?['ipc']:[])]});
 let out='',err='';child.stdout.on('data',b=>{out+=b;if(Buffer.byteLength(out)>1048576)child.kill('SIGKILL');});
 child.stderr.on('data',b=>{err+=b;if(Buffer.byteLength(err)>131072)child.kill('SIGKILL');});child.stdin.on('error',()=>{});
 if(race)child.on('message',m=>{if(m.sourceObserved)(async()=>{
  await store.update({memory_id:fixture.matched.id,expected_revision:1,event_id:'lineage-client-race',
   memory:{type:'preference',content:'CLIENT_CONCURRENT_CORRECTION',project_id:'lineage-project',provenance:'Explicit synthetic race'}});
  child.send({continue:true});
 })().catch(e=>{controlError=e;child.kill('SIGKILL');});});
 const timer=setTimeout(()=>child.kill('SIGKILL'),35000);
 try{
  child.stdin.end(input===undefined?'':JSON.stringify(input));
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  if(controlError)throw controlError;
  assert.ok(!out.includes(process.env.ULTRABRAIN_LINEAGE_TEST_TOKEN??'TOKEN_PRIVATE_SENTINEL'),'Credential leaked');
  assert.ok(!err.includes(process.env.ULTRABRAIN_LINEAGE_TEST_TOKEN??'TOKEN_PRIVATE_SENTINEL'),'Credential leaked in stderr');
  return {code,data:JSON.parse(out),out};
 }finally{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
}
try{
 await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)',[source]);
 await store.register({agent_id:'lineage-client-fixture'});
 const model=personalModelProfile({enabled:true,model:'fixture:client-lineage',revision:'synthetic',timeout_ms:120000});
 const quote='不要使用 Docker Hub',transcript='前言🙂\r\n'+quote+'。 <img src=x onerror="bad()">';
 const worker=new PersonalConsolidator(actorCtx,async()=>({profile:model,generate:async()=>{
  generators++;return {text:JSON.stringify({memories:[{type:'preference',content:'客户端候选：'+quote,quote}]})};
 }}));
 const finish=async(job,input)=>{
  const r=await worker.process({expected_source:source,job_id:job,allow_model_call:true});
  assert.equal(r.results[0].state,'completed');return {id:r.results[0].result.entries[0].id,input};
 };
 for(const name of ['matched','changed','archived']){
  const c=await store.capture({agent_id:'lineage-client-fixture',event_id:'capture-'+name,transcript,project_id:'lineage-project',consent:true});
  fixture[name]=await finish(c.job_id,c.input_id);
 }
 await store.update({memory_id:fixture.changed.input,expected_revision:1,event_id:'source-change',
  memory:{type:'experience',content:transcript+'\n后续修改',project_id:'lineage-project',provenance:'Synthetic edit'}});
 await store.review({memory_id:fixture.archived.input,expected_revision:1,event_id:'source-archive',status:'archived'});
 const bytes=Buffer.from(transcript),doc=await documents.documentImport({agent_id:'lineage-client-fixture',event_id:'doc',consent:true,
  label:'synthetic.txt',project_id:'lineage-project',content_base64:bytes.toString('base64'),content_sha256:sha(bytes)});
 const queued=await documents.documentQueue({document_id:doc.document_id,event_id:'queue-doc'});
 fixture.fragment=await finish(queued.fragments[0].job_id,queued.fragments[0].memory_id);
 for(const [name,project_id,visibility]of [['manual',null,'private'],['foreignProject','other-project','private'],['shared',null,'source']]){
  fixture[name]={id:(await store.commit({agent_id:'lineage-client-fixture',event_id:name,consent:true,
   memories:[{type:'preference',content:'SYNTHETIC_'+name,project_id,visibility}]})).entries[0].id};
 }
 await store.review({memory_id:fixture.shared.id,expected_revision:1,event_id:'share',status:'active'});
 save();let r=await run('probe');assert.equal(r.code,0);
 Object.assign(profile,{expected_instance:r.data.identity.instance_id,expected_actor:r.data.identity.actor_key});save();const ownerActor=r.data.identity.actor_key;pass();
 const before=await snapshot();
 for(const [name,state]of [['matched','matched'],['changed','changed'],['archived','archived'],['fragment','matched'],['manual','unlinked']]){
  r=await run('lineage',request(fixture[name].id));assert.equal(r.code,0);assert.equal(r.data.verdict.state,state);
  assert.equal(r.data.text,undefined);assert.ok(!r.out.includes(quote));assert.equal(r.data.memory_writes_requested,false);pass();
 }
 r=await run('lineage',request(fixture.matched.id,{include_text:true}));assert.equal(r.code,0);
 assert.equal(r.data.text.source,transcript);assert.equal(r.data.text.quote,quote);assert.equal(r.data.reference.input_hash,sha(transcript));pass();
 r=await run('lineage',request(fixture.matched.id),{sdk:true});assert.equal(r.code,0);assert.equal(r.data.verdict.state,'matched');assert.equal(r.data.text,undefined);pass();
 for(const patch of [{consent:false},{include_text:'yes'},{source_id:'other'},{workspace:join(dir,'missing')}] ){
  r=await run('lineage',request(fixture.matched.id,patch));assert.equal(r.code,1);assert.equal(r.data.read_delivery,'not_started');pass();
 }
 r=await run('lineage',request(fixture.foreignProject.id));assert.equal(r.code,1);assert.equal(r.data.error,'lineage_project_mismatch');pass();
 r=await run('lineage',request(randomUUID()));assert.equal(r.code,1);assert.equal(r.data.error,'not_found');pass();
 assert.deepEqual(await snapshot(),before);pass();
 // Actual competing root update, with unchanged source/unrelated memory oracle.
 const otherRows=async()=>(await engine.executeRaw(`SELECT md5(coalesce(string_agg(row_to_json(t)::text,',' ORDER BY row_to_json(t)::text),'')) AS h
 FROM ultrabrain.personal_memories t WHERE source_id=$1 AND id!=$2::uuid`,[source,fixture.matched.id]))[0].h;
 const count=async()=>(await engine.executeRaw('SELECT count(*)::int AS n FROM ultrabrain.personal_events WHERE source_id=$1',[source]))[0].n;
 const oldRows=await otherRows(),oldCount=await count();r=await run('lineage',request(fixture.matched.id),{race:true});
 assert.equal(r.code,1);assert.equal(r.data.error,'lineage_selected_changed');assert.equal(r.data.text,undefined);
 assert.equal(await otherRows(),oldRows);assert.equal(await count(),oldCount+1);
 const after=await snapshot();for(const t of tables.filter(t=>!['personal_memories','personal_events'].includes(t)))assert.equal(after[t],before[t]);pass();
 // Read-only HTTP credential belongs to a different authenticated actor.
 const free=createServer();free.listen(0,'127.0.0.1');await once(free,'listening');const port=free.address().port;await new Promise(r=>free.close(r));
 tokenName=source+'-reader';const secret='gbrain_'+randomBytes(32).toString('hex');
 await engine.executeRaw('INSERT INTO access_tokens(name,token_hash,scopes,permissions) VALUES($1,$2,$3::text[],$4::text::jsonb)',
 [tokenName,sha(secret),'{read}',JSON.stringify({source_id:source,takes_holders:['world']})]);
 httpServer=spawn(process.execPath,[ROOT+'/src/cli.mjs','mcp','--http','--bind','127.0.0.1','--port',String(port),'--suppress-bootstrap-token'],
 {cwd:ROOT,env:{...process.env,GBRAIN_SWEEP:'0',GBRAIN_ADMIN_BOOTSTRAP_TOKEN:randomBytes(32).toString('hex')},stdio:['ignore','ignore','pipe']});
 httpServer.stderr.on('data',()=>{});
 let ready=false;for(let i=0;i<100;i++){try{ready=(await fetch(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.timeout(300)})).ok;}catch{}if(ready)break;await new Promise(r=>setTimeout(r,100));}assert.ok(ready);
 process.env.ULTRABRAIN_LINEAGE_TEST_TOKEN=secret;
 profile={format:1,source,workspace:dir,project_id:'lineage-project',server:{transport:'http',url:`http://127.0.0.1:${port}/mcp`,bearer_env:'ULTRABRAIN_LINEAGE_TEST_TOKEN'}};
 save();r=await run('probe');assert.equal(r.code,0);assert.notEqual(r.data.identity.actor_key,ownerActor);
 Object.assign(profile,{expected_instance:r.data.identity.instance_id,expected_actor:r.data.identity.actor_key});save();
 r=await run('lineage',request(fixture.shared.id));assert.equal(r.code,0);assert.equal(r.data.verdict.state,'withheld');assert.equal(r.data.read_requests,1);pass();
 r=await run('lineage',request(fixture.changed.id));assert.equal(r.code,1);assert.equal(r.data.error,'not_found');assert.equal(r.data.text,undefined);pass();
 await engine.executeRaw('UPDATE access_tokens SET revoked_at=now() WHERE name=$1',[tokenName]);
 r=await run('lineage',request(fixture.shared.id));assert.equal(r.code,1);assert.equal(r.data.text,undefined);pass();
 assert.deepEqual(await snapshot(),after);assert.equal(generators,4);pass();
 const report={passed:true,checks,scope:'Installed Node CLI and library, official SDK, real PostgreSQL and stdio/read-only HTTP',
  synthetic_generators:generators,external_model_calls:0,read_phase_tables_unchanged:6,concurrent_correction_events:1,
  independent_user_host_or_agent_model_verified:false};
 if(process.env.ULTRABRAIN_CLIENT_LINEAGE_REPORT)writeFileSync(process.env.ULTRABRAIN_CLIENT_LINEAGE_REPORT,JSON.stringify(report,null,2)+'\n');
 console.log(`PASS ${checks} installed client lineage checks: default metadata, explicit text, stdio/HTTP identity, project isolation, six-table read-only oracle, one-event concurrent correction`);
}finally{
 delete process.env.ULTRABRAIN_LINEAGE_TEST_TOKEN;
 if(httpServer&&httpServer.exitCode===null&&httpServer.signalCode===null){httpServer.kill('SIGTERM');const t=setTimeout(()=>httpServer.kill('SIGKILL'),5000);await once(httpServer,'close');clearTimeout(t);}
 if(tokenName)await engine.executeRaw('DELETE FROM access_tokens WHERE name=$1',[tokenName]);
 await engine.disconnect();rmSync(dir,{recursive:true,force:true});
}
