/** Actual packaged CLI/SDK -> official MCP -> disposable PostgreSQL, stdio/HTTP.
 * Explicit synthetic fixture preparation writes; no generator or external model. */
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';import {spawn} from 'node:child_process';import {once} from 'node:events';import {createServer} from 'node:net';
import {connect,ROOT} from '../src/runtime.mjs';import {PersonalMemoryStore} from '../src/personal-memory-store.mjs';
assert.equal(process.env.ULTRABRAIN_TEST_ALLOW_WRITE,'1');
const pkg=process.env.ULTRABRAIN_TASK_CLIENT_ROOT;assert.ok(pkg,'Actual compiled/installed package required');
const dir=mkdtempSync(join(tmpdir(),'ub-eval-real-')),file=join(dir,'profile.json');
const engine=await connect(),source='reval-'+randomBytes(5).toString('hex'),sha=s=>createHash('sha256').update(s).digest('hex');
const store=new PersonalMemoryStore({sourceId:source,engine,remote:false,transport:'stdio'});
let server,tokenName,secret,checks=0;const pass=()=>checks++;
let profile={format:1,source,workspace:dir,project_id:'alpha',server:{transport:'stdio',command:process.execPath,
 args:[ROOT+'/src/cli.mjs','mcp'],env:{ULTRABRAIN_HOME:process.env.ULTRABRAIN_HOME,GBRAIN_SOURCE:source,GBRAIN_SWEEP:'0'}}};
const save=()=>writeFileSync(file,JSON.stringify(profile),{mode:0o600});
async function fingerprint(){const result={};for(const table of ['personal_memories','personal_events','personal_consolidations','agent_registry','personal_documents','personal_document_fragments'])
 result[table]=(await engine.executeRaw(`SELECT md5(coalesce(string_agg(row_to_json(t)::text,',' ORDER BY row_to_json(t)::text),'')) AS h FROM ultrabrain.${table} t WHERE source_id=$1`,[source]))[0].h;
 return result;}
async function run(input,{sdk=false,probe=false}={}){
 const code=`const fs=require('node:fs'),{evaluateClientRecall}=require(process.argv[1]);
 evaluateClientRecall(JSON.parse(fs.readFileSync(process.argv[2],'utf8')),JSON.parse(fs.readFileSync(0,'utf8')))
 .then(r=>process.stdout.write(JSON.stringify(r)+'\\n')).catch(e=>{process.stdout.write(JSON.stringify({ok:false,error:e.code,query_delivery:e.query_delivery,query_attempts:e.query_attempts})+'\\n');process.exitCode=1;});`;
 const args=probe?[join(pkg,'dist/cli.cjs'),'probe','--profile',file]:sdk?['-e',code,join(pkg,'dist/recall-eval.cjs'),file]:[join(pkg,'dist/recall-eval-cli.cjs'),'--profile',file];
 const child=spawn('node',args,{cwd:ROOT,env:process.env,stdio:['pipe','pipe','pipe']});let out='',err='';
 child.stdout.on('data',b=>{out+=b;if(out.length>131072)child.kill('SIGKILL');});child.stderr.on('data',b=>{err+=b;if(err.length>131072)child.kill('SIGKILL');});child.stdin.on('error',()=>{});
 const ended=new Promise((r,j)=>{child.once('error',j);child.once('close',r);}),timer=setTimeout(()=>child.kill('SIGKILL'),45000);
 try{
  child.stdin.end(input?JSON.stringify(input):'');const status=await ended;
  for(const v of ['PRIVATE_EVAL_BODY','PRIVATE_EVAL_TASK',secret??'NO_TOKEN'])assert.ok(!out.includes(v)&&!err.includes(v));
  assert.equal(err,'');return {status,data:JSON.parse(out)};
 }finally{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await ended.catch(()=>{});}}
}
try{
 const manifest=JSON.parse(readFileSync(join(pkg,'dist/build-manifest.json'),'utf8'));
 for(const name of ['recall-eval.cjs','recall-eval-cli.cjs'])assert.equal(sha(readFileSync(join(pkg,'dist',name))),manifest.artifacts[name]);pass();
 await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)',[source]);await store.register({agent_id:'recall-eval-fixture'});
 const definitions=[
  {content:'target_z9 PRIVATE_EVAL_BODY 不要删除原文',project_id:'alpha'},
  {content:'neutral reminder PRIVATE_EVAL_BODY',project_id:'alpha'},
  {content:'target_z9 PRIVATE_EVAL_BODY beta',project_id:'beta'},
  {content:'target_z9 PRIVATE_EVAL_BODY candidate',project_id:'alpha'},
  {content:'target_z9 PRIVATE_EVAL_BODY archived',project_id:'alpha'},
  {content:'shared_q8 PRIVATE_EVAL_BODY shared',visibility:'source'}];
 const entries=(await store.commit({agent_id:'recall-eval-fixture',event_id:'seed',consent:true,
  memories:definitions.map(m=>({type:'preference',provenance:'Explicit synthetic evaluation fixture',...m}))})).entries;
 for(const i of [0,1,2,5])await store.review({memory_id:entries[i].id,expected_revision:1,event_id:'activate-'+i,status:'active'});
 await store.review({memory_id:entries[4].id,expected_revision:1,event_id:'archive',status:'archived'});
 const forbidden=[2,3,4].map(i=>entries[i].id),suite={workspace:dir,consent:true,top_k:1,cases:[
  {id:'target',task:'target_z9 PRIVATE_EVAL_TASK',relevant_ids:[entries[0].id],forbidden_ids:forbidden},
  {id:'shared',task:'shared_q8 PRIVATE_EVAL_TASK',relevant_ids:[entries[5].id],forbidden_ids:forbidden},
  {id:'scope-negative',task:'target_z9 PRIVATE_EVAL_TASK',relevant_ids:[],forbidden_ids:forbidden}]};
 save();let r=await run(null,{probe:true});assert.equal(r.status,0);const owner=r.data.identity;
 Object.assign(profile,{expected_instance:owner.instance_id,expected_actor:owner.actor_key,allow_task_context:true});save();
 const before=await fingerprint();let suiteHash;
 for(const sdk of [false,true]){
  r=await run(suite,{sdk});assert.equal(r.status,0);assert.equal(r.data.query_requests,3);
  assert.deepEqual(r.data.summary,{case_count:3,positive_case_count:2,negative_only_case_count:1,
   hit_rate_at_k:1,mean_precision_at_k:1,mean_recall_at_k:1,mean_reciprocal_rank_at_k:1,forbidden_case_count:0,forbidden_occurrences:0});
  assert.equal(r.data.cases[2].recall_at_k,null);assert.equal(r.data.memory_writes_requested,false);
  if(suiteHash)assert.equal(r.data.suite_sha256,suiteHash);suiteHash=r.data.suite_sha256;pass();
 }
 for(const patch of [{consent:false},{top_k:21},{cases:[...suite.cases,{...suite.cases[0],id:'later',task:'x'.repeat(4097)}]}]){
  r=await run({...suite,...patch});assert.equal(r.status,1);assert.equal(r.data.query_attempts,0);pass();
 }
 profile.expected_actor='f'.repeat(64);save();r=await run(suite);assert.equal(r.status,1);assert.equal(r.data.error,'identity_mismatch');pass();
 assert.deepEqual(await fingerprint(),before);pass();
 const socket=createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r));
 secret='gbrain_'+randomBytes(32).toString('hex');tokenName=source+'-reader';
 await engine.executeRaw('INSERT INTO access_tokens(name,token_hash,scopes,permissions) VALUES($1,$2,$3::text[],$4::text::jsonb)',
 [tokenName,sha(secret),'{read}',JSON.stringify({source_id:source,takes_holders:['world']})]);
 server=spawn(process.execPath,[ROOT+'/src/cli.mjs','mcp','--http','--bind','127.0.0.1','--port',String(port),'--suppress-bootstrap-token'],
 {cwd:ROOT,env:{...process.env,GBRAIN_SWEEP:'0',GBRAIN_ADMIN_BOOTSTRAP_TOKEN:randomBytes(32).toString('hex')},stdio:['ignore','ignore','pipe']});server.stderr.on('data',()=>{});
 let ready=false;for(let n=0;n<100;n++){try{ready=(await fetch(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.timeout(300)})).ok;}catch{}if(ready)break;await new Promise(r=>setTimeout(r,100));}assert.ok(ready);
 process.env.ULTRABRAIN_EVAL_TEST_TOKEN=secret;
 profile={format:1,source,workspace:dir,project_id:'alpha',server:{transport:'http',url:`http://127.0.0.1:${port}/mcp`,bearer_env:'ULTRABRAIN_EVAL_TEST_TOKEN'}};
 save();r=await run(null,{probe:true});assert.equal(r.status,0);assert.notEqual(r.data.identity.actor_key,owner.actor_key);
 Object.assign(profile,{expected_instance:r.data.identity.instance_id,expected_actor:r.data.identity.actor_key,allow_task_context:true});save();
 for(const sdk of [false,true]){
  r=await run(suite,{sdk});assert.equal(r.status,0);assert.equal(r.data.summary.hit_rate_at_k,0.5);
  assert.equal(r.data.summary.mean_recall_at_k,0.5);assert.equal(r.data.summary.forbidden_occurrences,0);
  assert.deepEqual(r.data.cases[0].missing_ids,[entries[0].id]);assert.ok(r.data.cases.every(c=>c.top_ids.every(id=>id===entries[5].id)));pass();
 }
 await engine.executeRaw('UPDATE access_tokens SET revoked_at=now() WHERE name=$1',[tokenName]);r=await run(suite);assert.equal(r.status,1);assert.equal(r.data.query_attempts,0);pass();
 assert.deepEqual(await fingerprint(),before);pass();
 const report={passed:true,checks,mode:'actual compiled CLI/SDK, official MCP, disposable PostgreSQL, stdio and read-only HTTP',
  cases_per_run:3,read_phase_tables_unchanged:6,external_model_calls:0,generator_calls:0,user_environment_verified:false};
 if(process.env.ULTRABRAIN_RECALL_EVALUATION_REPORT)writeFileSync(process.env.ULTRABRAIN_RECALL_EVALUATION_REPORT,JSON.stringify(report,null,2)+'\n');
 console.log(`PASS ${checks} recall evaluation integration checks; six unchanged tables, zero models`);
}finally{
 delete process.env.ULTRABRAIN_EVAL_TEST_TOKEN;
 if(server&&server.exitCode===null&&server.signalCode===null){server.kill('SIGTERM');const t=setTimeout(()=>server.kill('SIGKILL'),5000);await once(server,'close');clearTimeout(t);}
 if(tokenName)await engine.executeRaw('DELETE FROM access_tokens WHERE name=$1',[tokenName]);
 await engine.disconnect();rmSync(dir,{recursive:true,force:true});
}
