/** Actual console/PostgreSQL processing with trusted synthetic generators only.
 * Browser corrupts received acknowledgements after real work; status recovery never invokes a model.
 */
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {connect,ROOT} from '../src/runtime.mjs';
import {PersonalMemoryStore} from '../src/personal-memory-store.mjs';
import {PersonalConsolidator} from '../src/personal-consolidation.mjs';
import {personalModelProfile} from '../src/personal-consolidation-core.mjs';
import {startPersonalConsole} from '../src/personal-console.mjs';
assert.equal(process.env.ULTRABRAIN_TEST_ALLOW_WRITE,'1','Use an isolated synthetic database');
const engine=await connect(),source='job-recovery-'+randomBytes(5).toString('hex'),token=randomBytes(32).toString('hex');
const ctx={engine,sourceId:source,transport:'stdio',remote:false},store=new PersonalMemoryStore(ctx),jobs=new PersonalConsolidator(ctx);
const profile=personalModelProfile({enabled:true,model:'fixture:recovery',revision:'synthetic-only',timeout_ms:10000});
const f={},invocations=[];let ui;
const digest=async(table)=>(await engine.executeRaw(`SELECT md5(coalesce(string_agg(row_to_json(t)::text,',' ORDER BY row_to_json(t)::text),'')) AS digest
 FROM ultrabrain.${table} t WHERE source_id=$1`,[source]))[0].digest;
try{
 await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)',[source]);
 await store.register({agent_id:'recovery-fixture',agent_type:'general_agent'});
 for(const name of ['completed','retry','failed','no_work','lease'])
  f[name]=await store.capture({agent_id:'recovery-fixture',event_id:'capture-'+name,transcript:'RECOVERY_'+name,consent:true});
 const originals=await engine.executeRaw('SELECT * FROM ultrabrain.personal_memories WHERE source_id=$1 ORDER BY id',[source]);
 const inputIds=originals.map(r=>r.id);
 const unchanged={};for(const table of ['personal_events','agent_registry','personal_documents','personal_document_fragments'])unchanged[table]=await digest(table);
 const configureModel=async()=>({profile,generate:async request=>{
  const text=JSON.parse(request.prompt).untrusted_transcript;invocations.push(text);
  if(text==='RECOVERY_failed')throw Error('SYNTHETIC_FAILURE');
  if(text==='RECOVERY_lease')await jobs.cancel({job_id:f.lease.job_id});
  return {text:JSON.stringify({memories:[{type:'preference',content:'CANDIDATE_'+text,quote:text}]}),usage:{input_tokens:3,output_tokens:2}};
 }});
 ui=await startPersonalConsole({engine,source,token,port:0,configureModel});
 const child=spawn(process.env.ULTRABRAIN_BROWSER_PYTHON??'python3',[ROOT+'/test/personal-job-recovery-browser.py'],{
  cwd:ROOT,env:{...process.env,ULTRABRAIN_BROWSER_ORIGIN:ui.origin,ULTRABRAIN_BROWSER_TOKEN:token,
   ULTRABRAIN_RECOVERY_FIXTURE:JSON.stringify(f)},stdio:['ignore','inherit','inherit']});
 const deadline=setTimeout(()=>child.kill('SIGKILL'),180000);
 try{assert.equal(await new Promise((done,fail)=>{child.once('error',fail);child.once('close',done);}),0,'Recovery Chromium acceptance failed');}
 finally{clearTimeout(deadline);}
 assert.deepEqual(invocations,['RECOVERY_completed','RECOVERY_retry','RECOVERY_failed','RECOVERY_lease']);
 for(const [table,hash]of Object.entries(unchanged))assert.equal(await digest(table),hash,table+' unexpectedly changed');
 assert.deepEqual(await engine.executeRaw('SELECT * FROM ultrabrain.personal_memories WHERE source_id=$1 AND id=ANY($2::uuid[]) ORDER BY id',[source,inputIds]),originals);
 const rows=await engine.executeRaw(`SELECT j.id::text AS job_id,j.input_id::text,j.state,j.attempts,j.result,j.error_code,j.lease_id,j.lease_until,
   m.status AS input_status,m.revision AS input_revision FROM ultrabrain.personal_consolidations j
   LEFT JOIN ultrabrain.personal_memories m ON m.id=j.input_id AND m.actor_key=j.actor_key AND m.source_id=j.source_id
   WHERE j.source_id=$1 AND j.actor_key=$2 ORDER BY j.id`,[source,store.actor]);
 assert.equal(rows.length,5);
 for(const [name,input]of Object.entries(f)){
  const row=rows.find(r=>r.job_id===input.job_id);assert.ok(row);
  assert.equal(row.input_id,input.input_id);assert.equal(row.input_status,'candidate');assert.equal(row.input_revision,1);
  assert.equal(row.lease_id,null);assert.equal(row.lease_until,null);
  assert.equal(row.attempts,name==='no_work'?0:1);
  assert.equal(row.state,['completed','retry'].includes(name)?'completed':name==='failed'?'failed':'stale');
  if(['completed','retry'].includes(name))assert.equal(row.result.entries.length,1);else assert.equal(row.result,null);
 }
 const generated=await engine.executeRaw(`SELECT m.id::text,m.content,m.status,m.revision,m.visibility,m.derivation,
   j.id::text AS job_id,j.input_id::text,j.input_revision FROM ultrabrain.personal_memories m
   LEFT JOIN ultrabrain.personal_consolidations j ON j.id=(m.derivation->>'job_id')::uuid AND j.source_id=m.source_id AND j.actor_key=m.actor_key
   WHERE m.source_id=$1 AND m.actor_key=$2 AND NOT(m.id=ANY($3::uuid[])) ORDER BY m.content`,[source,store.actor,inputIds]);
 assert.equal(generated.length,2);
 for(const name of ['completed','retry']){
  const row=generated.find(r=>r.content==='CANDIDATE_RECOVERY_'+name);assert.ok(row);
  assert.equal(row.status,'candidate');assert.equal(row.revision,1);assert.equal(row.visibility,'private');
  assert.equal(row.job_id,f[name].job_id);assert.equal(row.input_id,f[name].input_id);assert.equal(row.input_revision,1);
  assert.equal(row.derivation.quote,'RECOVERY_'+name);
  assert.equal(rows.find(j=>j.job_id===row.job_id).result.entries[0].id,row.id);
 }
 console.log('PASS recovery DB oracle: 5 retained originals, exactly 2 bound private candidates, completed/failed/stale job states and attempt counts; 4 synthetic invocations, no duplicate processing or external model calls');
}finally{await ui?.close();await engine.disconnect();}
