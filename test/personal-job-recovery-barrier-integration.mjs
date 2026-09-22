/** Actual console/PostgreSQL concurrency, controlled only by a synthetic child test.
 * No production test endpoints, provider credentials or schema mutations are added.
 */
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {connect,ROOT} from '../src/runtime.mjs';
import {PersonalMemoryStore} from '../src/personal-memory-store.mjs';
import {PersonalConsolidator} from '../src/personal-consolidation.mjs';
import {personalModelProfile} from '../src/personal-consolidation-core.mjs';
import {startPersonalConsole} from '../src/personal-console.mjs';
assert.equal(process.env.ULTRABRAIN_TEST_ALLOW_WRITE,'1','Use only an isolated synthetic database');
const engine=await connect(),source='recovery-barrier-'+randomBytes(5).toString('hex'),token=randomBytes(32).toString('hex');
const ctx={engine,sourceId:source,transport:'stdio',remote:false},store=new PersonalMemoryStore(ctx),jobs=new PersonalConsolidator(ctx);
const profile=personalModelProfile({enabled:true,model:'fixture:barrier',revision:'synthetic-only',timeout_ms:120000});
const f={},invocations=[],commands=[];let ui,modelEnabled=true,blockerOutcome;
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const primary=deferred(),blocker=deferred(),blockerEntered=deferred();
const digest=async table=>(await engine.executeRaw(`SELECT md5(coalesce(string_agg(row_to_json(t)::text,',' ORDER BY row_to_json(t)::text),'')) AS digest
 FROM ultrabrain.${table} t WHERE source_id=$1`,[source]))[0].digest;
try{
 await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)',[source]);
 await store.register({agent_id:'barrier-fixture',agent_type:'general_agent'});
 for(const name of ['primary','blocker','waiting','lost'])
  f[name]=await store.capture({agent_id:'barrier-fixture',event_id:'capture-'+name,transcript:'BARRIER_SOURCE_'+name,consent:true});
 const originals=await engine.executeRaw('SELECT * FROM ultrabrain.personal_memories WHERE source_id=$1 ORDER BY id',[source]);
 const inputIds=originals.map(r=>r.id),unchanged={};
 for(const table of ['personal_events','agent_registry','personal_documents','personal_document_fragments'])unchanged[table]=await digest(table);
 const configureModel=async()=>modelEnabled?{profile,generate:async request=>{
  const text=JSON.parse(request.prompt).untrusted_transcript;invocations.push(text);
  if(text==='BARRIER_SOURCE_primary')await primary.promise;
  if(text==='BARRIER_SOURCE_blocker'){blockerEntered.resolve();await blocker.promise;}
  if(text==='BARRIER_SOURCE_lost')await jobs.cancel({job_id:f.lost.job_id});
  return {text:JSON.stringify({memories:text==='BARRIER_SOURCE_blocker'?[]:[{type:'preference',content:'CANDIDATE_'+text,quote:text}]}),usage:{input_tokens:3,output_tokens:2}};
 }}:{profile:null};
 ui=await startPersonalConsole({engine,source,token,port:0,configureModel});
 const child=spawn(process.env.ULTRABRAIN_BROWSER_PYTHON??'python3',[ROOT+'/test/personal-job-recovery-barrier-browser.py'],{
  cwd:ROOT,env:{...process.env,ULTRABRAIN_BROWSER_ORIGIN:ui.origin,ULTRABRAIN_BROWSER_TOKEN:token,
   ULTRABRAIN_BARRIER_FIXTURE:JSON.stringify(f),ULTRABRAIN_BARRIER_SOURCE:source},stdio:['pipe','pipe','inherit']});
 // A bounded test-only stdin/stdout handshake releases the synthetic generator.
 // It does not extend the console HTTP surface or affect user model configuration.
 let buffer='',control=Promise.resolve(),controlError;
 const perform=async command=>{
  commands.push(command);
  if(command==='DISABLE')modelEnabled=false;
  else if(command==='ENABLE')modelEnabled=true;
  else if(command==='RELEASE_PRIMARY')primary.resolve();
  else if(command==='START_BLOCKER'){
   assert.equal(blockerOutcome,undefined);
   const p=new PersonalConsolidator(ctx,configureModel).process({expected_source:source,job_id:f.blocker.job_id,allow_model_call:true});
   blockerOutcome=p.then(value=>({value}),error=>({error}));
   await Promise.race([blockerEntered.promise,blockerOutcome.then(()=>{throw Error('Blocker did not enter the generator');})]);
  }else if(command==='RELEASE_BLOCKER'){
   assert.ok(blockerOutcome);blocker.resolve();const result=await blockerOutcome;
   assert.equal(result.error,undefined);assert.equal(result.value.results[0].state,'completed');
  }else throw Error('Unknown fixture control');
  if(child.stdin.writable)child.stdin.write('OK\n');
 };
 child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{
  buffer+=chunk;
  if(buffer.length>65536){controlError=Error('Oversized fixture output');child.kill('SIGTERM');return;}
  let end;while((end=buffer.indexOf('\n'))>=0){
   const line=buffer.slice(0,end).trimEnd();buffer=buffer.slice(end+1);
   if(line.startsWith('@@CONTROL '))control=control.then(()=>perform(line.slice(10))).catch(error=>{controlError=error;child.kill('SIGTERM');});
   else console.log(line);
  }
 });
 child.stdin.on('error',()=>{}); // A failing child may close its test-control pipe.
 const deadline=setTimeout(()=>child.kill('SIGKILL'),180000);
 try{assert.equal(await new Promise((done,fail)=>{child.once('error',fail);child.once('close',done);}),0,'Recovery barrier Chromium failed');}
 finally{clearTimeout(deadline);primary.resolve();blocker.resolve();}
 await control;assert.equal(controlError,undefined);
 assert.deepEqual(commands,['DISABLE','ENABLE','RELEASE_PRIMARY','START_BLOCKER','RELEASE_BLOCKER']);
 assert.deepEqual(invocations,['BARRIER_SOURCE_primary','BARRIER_SOURCE_blocker','BARRIER_SOURCE_waiting','BARRIER_SOURCE_lost']);
 for(const [table,hash]of Object.entries(unchanged))assert.equal(await digest(table),hash,table+' unexpectedly changed');
 assert.deepEqual(await engine.executeRaw('SELECT * FROM ultrabrain.personal_memories WHERE source_id=$1 AND id=ANY($2::uuid[]) ORDER BY id',[source,inputIds]),originals);
 const rows=await engine.executeRaw(`SELECT j.id::text AS job_id,j.input_id::text,j.state,j.attempts,j.result,j.error_code,j.lease_id,j.lease_until,
   m.status AS input_status,m.revision AS input_revision FROM ultrabrain.personal_consolidations j
   LEFT JOIN ultrabrain.personal_memories m ON m.id=j.input_id AND m.actor_key=j.actor_key AND m.source_id=j.source_id
   WHERE j.source_id=$1 AND j.actor_key=$2 ORDER BY j.id`,[source,store.actor]);
 assert.equal(rows.length,4);
 for(const [name,input]of Object.entries(f)){
  const row=rows.find(r=>r.job_id===input.job_id);assert.ok(row);
  assert.equal(row.input_id,input.input_id);assert.equal(row.input_status,'candidate');assert.equal(row.input_revision,1);
  assert.equal(row.attempts,1);assert.equal(row.lease_id,null);assert.equal(row.lease_until,null);
  assert.equal(row.state,name==='lost'?'stale':'completed');assert.equal(row.error_code,name==='lost'?'cancelled':null);
  if(name==='lost')assert.equal(row.result,null);else assert.equal(row.result.entries.length,name==='blocker'?0:1);
 }
 const generated=await engine.executeRaw(`SELECT m.id::text,m.content,m.status,m.revision,m.visibility,m.derivation,
   j.id::text AS job_id,j.input_id::text,j.input_revision FROM ultrabrain.personal_memories m
   LEFT JOIN ultrabrain.personal_consolidations j ON j.id=(m.derivation->>'job_id')::uuid AND j.source_id=m.source_id AND j.actor_key=m.actor_key
   WHERE m.source_id=$1 AND m.actor_key=$2 AND NOT(m.id=ANY($3::uuid[])) ORDER BY m.content`,[source,store.actor,inputIds]);
 assert.equal(generated.length,2);
 for(const name of ['primary','waiting']){
  const row=generated.find(r=>r.content==='CANDIDATE_BARRIER_SOURCE_'+name);assert.ok(row);
  assert.equal(row.status,'candidate');assert.equal(row.revision,1);assert.equal(row.visibility,'private');
  assert.equal(row.job_id,f[name].job_id);assert.equal(row.input_id,f[name].input_id);assert.equal(row.input_revision,1);
  assert.equal(row.derivation.quote,'BARRIER_SOURCE_'+name);
  assert.equal(rows.find(j=>j.job_id===row.job_id).result.entries[0].id,row.id);
 }
 console.log('PASS recovery barrier DB oracle: 4 unchanged originals, 2 bound private candidates, 4 single-attempt jobs; real live-lease and disabled-model no-ops, 4 synthetic invocations, zero external model calls');
}finally{primary.resolve();blocker.resolve();if(blockerOutcome)await blockerOutcome;await ui?.close();await engine.disconnect();}
