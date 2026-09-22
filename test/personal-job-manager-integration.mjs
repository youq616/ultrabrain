/** Complete task metadata/tracing/cancellation module on disposable PostgreSQL + native MCP + Chromium.
 * Model output used for seeding is an explicitly injected synthetic generator, never a provider call.
 */
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {connect,ROOT,loadNative} from '../src/runtime.mjs';
import {PersonalMemoryStore} from '../src/personal-memory-store.mjs';
import {PersonalConsolidator} from '../src/personal-consolidation.mjs';
import {personalModelProfile} from '../src/personal-consolidation-core.mjs';
import {startPersonalConsole} from '../src/personal-console.mjs';
import {Client} from '../vendor/gbrain/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import {StdioClientTransport} from '../vendor/gbrain/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
assert.equal(process.env.ULTRABRAIN_TEST_ALLOW_WRITE,'1','Disposable database required');
const engine=await connect(),source='job-module-'+randomBytes(5).toString('hex'),foreign=source+'-other';
const ctx={engine,sourceId:source,transport:'stdio',remote:false},token=randomBytes(32).toString('hex');
const memories=new PersonalMemoryStore(ctx),jobs=new PersonalConsolidator(ctx);
const {dispatchToolCall}=await loadNative('src/mcp/dispatch.ts');
const tables=['personal_memories','personal_events','personal_consolidations','agent_registry','personal_documents','personal_document_fragments'];
let ui,checks=0,syntheticInvocations=0;const pass=()=>checks++;
const call=async(name,input={},context=ctx)=>{
 const r=await dispatchToolCall(engine,name,input,context),data=JSON.parse(r.content[0].text);
 if(r.isError)throw Object.assign(Error(data.error),{code:data.error});return data;
};
const snapshot=async()=>{
 const r={};for(const table of tables)r[table]=(await engine.executeRaw(`SELECT md5(coalesce(string_agg(row_to_json(t)::text,',' ORDER BY row_to_json(t)::text),'')) AS digest FROM ultrabrain.${table} t WHERE source_id=$1`,[source]))[0].digest;
 return r;
};
const capture=event=>memories.capture({agent_id:'task-fixture',event_id:event,consent:true,transcript:'JOB_ORIGINAL_'+event});
const profile=personalModelProfile({enabled:true,model:'fixture:task-module',revision:'synthetic-only',timeout_ms:120000});
try{
 for(const id of [source,foreign])await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)',[id]);
 await memories.register({agent_id:'task-fixture',agent_type:'general_agent'});
 const queue=[];for(let i=0;i<23;i++)queue.push(await capture('queued-'+i));
 const success=await capture('completed'),failure=await capture('failed'),cancelled=await capture('cancelled'),racing=await capture('racing');
 const complete=new PersonalConsolidator(ctx,async()=>({profile,generate:async()=>{
  syntheticInvocations++;return {text:JSON.stringify({memories:[{type:'preference',content:'JOB_GENERATED_CANDIDATE',quote:'JOB_ORIGINAL_completed'}]})};
 }}));
 await complete.process({expected_source:source,job_id:success.job_id,allow_model_call:true});
 const failed=new PersonalConsolidator(ctx,async()=>({profile,generate:async()=>{syntheticInvocations++;throw Error('SYNTHETIC_PROVIDER_FAILURE');}}));
 await failed.process({expected_source:source,job_id:failure.job_id,allow_model_call:true});
 await call('ultra_personal_cancel',{job_id:cancelled.job_id});
 // Real admission and owner locks: cancellation after synthetic invocation prevents its output commit.
 let entered,release;const started=new Promise(r=>entered=r),held=new Promise(r=>release=r);
 const blocked=new PersonalConsolidator(ctx,async()=>({profile,generate:async()=>{syntheticInvocations++;entered();await held;
  return {text:JSON.stringify({memories:[{type:'preference',content:'MUST_NOT_COMMIT_AFTER_CANCEL',quote:'JOB_ORIGINAL_racing'}]})};}}));
 const processing=blocked.process({expected_source:source,job_id:racing.job_id,allow_model_call:true});
 const outcome=processing.then(value=>({value}),error=>({error}));let timer;
 try{
  await Promise.race([started,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Synthetic admission never reached')),10000);})]);
  assert.equal((await jobs.status({job_id:racing.job_id})).jobs[0].state,'processing');
  const r=await call('ultra_personal_cancel',{job_id:racing.job_id});assert.equal(r.id,racing.job_id);assert.equal(r.state,'stale');
 }finally{clearTimeout(timer);release();}
 const settled=await outcome;assert.equal(settled.error,undefined);assert.equal(settled.value.results[0].state,'lease_lost');
 const [leak]=await engine.executeRaw("SELECT count(*)::int AS n FROM ultrabrain.personal_memories WHERE source_id=$1 AND content='MUST_NOT_COMMIT_AFTER_CANCEL'",[source]);
 assert.equal(leak.n,0);pass();
 const beforeReads=await snapshot();
 const expected={queued:23,completed:1,failed:1,stale:2,processing:0};
 for(const [state,n]of Object.entries(expected)){
  const r=await call('ultra_personal_jobs',{state,limit:100});assert.equal(r.jobs.length,n);assert.ok(r.jobs.every(j=>j.state===state));pass();
 }
 const first=await call('ultra_personal_jobs',{state:'queued',limit:20}),last=await call('ultra_personal_jobs',{state:'queued',limit:20,offset:first.next_offset});
 assert.equal(first.jobs.length,20);assert.equal(last.jobs.length,3);assert.equal(last.next_offset,null);
 assert.equal(new Set([...first.jobs,...last.jobs].map(j=>j.job_id)).size,23);pass();
 const exact=await call('ultra_personal_jobs',{job_id:success.job_id,limit:1});assert.equal(exact.next_offset,null);
 const candidateId=exact.jobs[0].result.entries[0].id;
 assert.equal((await memories.read({memory_id:candidateId})).memory.derivation.job_id,success.job_id);pass();
 const other={engine,sourceId:source,remote:true,transport:'http',auth:{sourceId:source,scopes:['read'],principal:{kind:'oauth_client',id:'different-owner'}}};
 assert.equal((await call('ultra_personal_jobs',{state:'queued'},other)).jobs.length,0);
 for(const context of [other,{...ctx,sourceId:foreign}]){
  await assert.rejects(call('ultra_personal_jobs',{job_id:success.job_id},context),{code:'not_found'});pass();
 }
 await assert.rejects(call('ultra_personal_jobs',{job_id:randomUUID()}),{code:'not_found'});pass();
 for(const input of [{state:"queued' OR 1=1 --"},{job_id:success.job_id,state:'failed'},{job_id:success.job_id,offset:1},{source_id:foreign}]){
  await assert.rejects(call('ultra_personal_jobs',input),{code:'invalid_params'});pass();
 }
 await assert.rejects(call('ultra_personal_cancel',{job_id:queue[0].job_id},other),{code:'permission_denied'});pass();
 assert.deepEqual(await snapshot(),beforeReads);pass();
 // Real official-SDK stdio tools/list and call; state was added to the EXISTING tool only.
 const client=new Client({name:'task-module-acceptance',version:'1'}),transport=new StdioClientTransport({command:process.execPath,
  args:[ROOT+'/src/cli.mjs','mcp'],cwd:ROOT,env:{...process.env,GBRAIN_SOURCE:source,GBRAIN_SWEEP:'0'},stderr:'pipe'});
 transport.stderr?.on('data',()=>{});
 try{
  await client.connect(transport);const tool=(await client.listTools()).tools.find(t=>t.name==='ultra_personal_jobs');
  assert.ok(tool?.inputSchema.properties.state.enum.includes('failed'));
  const r=await client.callTool({name:'ultra_personal_jobs',arguments:{state:'completed'}});assert.ok(!r.isError);
  assert.equal(JSON.parse(r.content[0].text).jobs[0].job_id,success.job_id);pass();
 }finally{await client.close();}
 assert.deepEqual(await snapshot(),beforeReads);pass();
 const fixed={queued:queue.map(r=>r.job_id),completed:success.job_id,failed:failure.job_id,stale:cancelled.job_id,
  sourceMemory:success.input_id,candidateMemory:candidateId,cancelInput:queue[0].input_id};
 ui=await startPersonalConsole({engine,source,token,port:0});
 const beforeBrowser=await snapshot();
 const stableJobs=async()=>(await engine.executeRaw(`SELECT md5(coalesce(string_agg(row_to_json(t)::text,',' ORDER BY row_to_json(t)::text),'')) AS digest
  FROM ultrabrain.personal_consolidations t WHERE source_id=$1 AND id!=$2::uuid`,[source,queue[0].job_id]))[0].digest;
 const otherJobs=await stableJobs();
 const child=spawn(process.env.ULTRABRAIN_BROWSER_PYTHON??'python3',[ROOT+'/test/personal-job-manager-browser.py'],{
  cwd:ROOT,env:{...process.env,ULTRABRAIN_BROWSER_ORIGIN:ui.origin,ULTRABRAIN_BROWSER_TOKEN:token,ULTRABRAIN_JOB_FIXTURE:JSON.stringify(fixed)},
  stdio:['ignore','inherit','inherit']});
 const deadline=setTimeout(()=>child.kill('SIGKILL'),180000);
 try{assert.equal(await new Promise((done,fail)=>{child.once('error',fail);child.once('close',done);}),0,'Task module browser failed');}
 finally{clearTimeout(deadline);}
 const afterBrowser=await snapshot();
 for(const table of tables.filter(t=>t!=='personal_consolidations'))assert.equal(afterBrowser[table],beforeBrowser[table],table+' mutated unexpectedly');
 assert.equal(await stableJobs(),otherJobs,'An unrelated job changed');
 const [cancelledRow]=await engine.executeRaw(`SELECT j.state,j.error_code,j.attempts,j.lease_id,j.lease_until,
   m.id::text AS input_id,m.status AS input_status,m.revision AS input_revision
   FROM ultrabrain.personal_consolidations j LEFT JOIN ultrabrain.personal_memories m
     ON m.id=j.input_id AND m.source_id=j.source_id AND m.actor_key=j.actor_key
   WHERE j.source_id=$1 AND j.actor_key=$2 AND j.id=$3::uuid`,[source,memories.actor,queue[0].job_id]);
 assert.deepEqual({...cancelledRow},{state:'stale',error_code:'cancelled',attempts:0,lease_id:null,lease_until:null,
  input_id:queue[0].input_id,input_status:'candidate',input_revision:1});pass();
 assert.equal(syntheticInvocations,3);
 console.log(`PASS ${checks} task-module PostgreSQL/native-MCP checks; browser changed only one cancelled job, retained source, no new events/memories; 3 injected synthetic generator invocations, zero external model calls`);
}finally{await ui?.close();await engine.disconnect();}
