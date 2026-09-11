/** Destructive test fixture: only run in an explicitly authorized isolated test HOME. */
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {connect,loadNative} from '../src/runtime.mjs';
import {recordExecution} from '../src/projects.mjs';
import {runObserved} from '../src/verify-run.mjs';
import {DurableOutbox} from '../src/durable-outbox.mjs';
import {AgentMemory} from '../src/agent-memory.mjs';
import {SESSION_SCHEMA} from '../src/sessions.mjs';
assert.equal(process.env.ULTRABRAIN_TEST_ALLOW_WRITE,'1','Explicit isolated-test write opt-in is required');
const engine=await connect({migrate:true});
const {dispatchToolCall}=await loadNative('src/mcp/dispatch.ts');
const source=`reliable-${Date.now().toString(36)}`, project='memory-service';
const dir=mkdtempSync(join(tmpdir(),'ub-real-outbox-'));
let checks=0;
const check=()=>checks++;
const auth={token:'test-only',clientId:'reliability-ci',principal:{kind:'oauth_client',id:'reliability-ci'},sourceId:source,scopes:['read','write']};
const dispatch=(name,args,extra={})=>dispatchToolCall(engine,name,args,{sourceId:source,remote:true,transport:'stdio',auth,...extra});
const call=async(name,args,extra={})=>{
  const result=await dispatch(name,args,extra);const data=JSON.parse(result.content[0].text);
  if(result.isError)throw Object.assign(new Error(JSON.stringify(data)),{code:data.error});return data;
};
const save=(state,revision,event)=>call('ultra_project_save',{project_id:project,state,expected_revision:revision,event_id:event});
let state={goal:'Build a Linux agent memory service',constraints:['Native local PostgreSQL'],tasks:[
  {id:'ci',title:'Verify the fixture',acceptance:['Selected verification command exits zero'],status:'in_progress'}],
  blockers:[],next_actions:['Run the verification command']};
try {
  const [namespace] = await engine.executeRaw("SELECT current_schema() AS schema,to_regclass('ultrabrain.pages') IS NULL AS no_shadow");
  assert.equal(namespace.schema,'public');assert.equal(namespace.no_shadow,true);check();
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)',[source]);
  assert.equal((await save(state,0,'create')).revision,1);check();
  assert.equal((await save(state,0,'create')).replayed,true);check();
  await assert.rejects(save({...state,goal:'changed'},0,'create'),{code:'conflict'});check();
  const concurrent=await Promise.allSettled([save({...state,next_actions:['A']},1,'edit-a'),save({...state,next_actions:['B']},1,'edit-b')]);
  assert.equal(concurrent.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(concurrent.find(x=>x.status==='rejected').reason.code,'revision_conflict');check();
  const load=()=>call('ultra_project_load',{project_id:project});
  let current=await load();assert.equal(current.revision,2);check();
  let resume=await call('ultra_project_resume',{project_id:project,query:'继续开发'});
  assert.ok(resume.retrieval_query.includes('Linux'));assert.ok(resume.retrieval_query.includes('Verify the fixture'));check();
  await assert.rejects(save({...state,tasks:[{...state.tasks[0],status:'verified_complete',receipt_ids:[randomUUID()]}]},2,'fake'),{code:'evidence_required'});check();
  const execution=await runObserved([process.execPath,'-e','process.exit(0)']);
  const receipt=await recordExecution(engine,source,project,current.state.tasks[0],execution);
  state={...current.state,tasks:[{...current.state.tasks[0],status:'verified_complete',receipt_ids:[receipt.receipt_id]}]};
  assert.equal((await save(state,2,'verified')).revision,3);check();
  await assert.rejects(save({...state,tasks:[{...state.tasks[0],acceptance:['Different requirement']}]},3,'stale'),{code:'evidence_required'});check();
  const failed=await recordExecution(engine,source,project,state.tasks[0],await runObserved([process.execPath,'-e','process.exit(4)']));
  await assert.rejects(save({...state,tasks:[{...state.tasks[0],receipt_ids:[failed.receipt_id]}]},3,'failed'),{code:'evidence_required'});check();
  for(const extra of [{auth:{...auth,boundSlugPrefixes:['bounded/']}},{auth:{...auth,fenceProjectionDegraded:true}}]) {
    await assert.rejects(call('ultra_project_load',{project_id:project},extra));check();
  }
  const {operations}=await loadNative('src/core/operations.ts');
  await assert.rejects(operations.find(o=>o.name==='ultra_project_load').handler({sourceId:source,engine,auth,viaSubagent:true},{project_id:project}),{code:'permission_denied'});check();
  await assert.rejects(call('ultra_project_load',{project_id:project},{sourceId:'default',auth:{...auth,sourceId:'default'}}),{code:'not_found'});check();
  const history=await call('ultra_project_history',{project_id:project,limit:2});
  assert.deepEqual(history.revisions.map(r=>r.revision),[3,2]);assert.equal(history.next_before_revision,2);check();
  // A fresh AgentMemory instance restores project context before invoking its model callback.
  const memory=new AgentMemory({client:{callTool:req=>dispatch(req.name,req.arguments)},rootUri:`ultra://${source}/`,sessionId:'new-session',projectId:project});
  const turn=await memory.runTurn({input:'继续开发',generate:async ({projectContext})=>{
    assert.ok(projectContext.content.includes('Linux'));return 'restored';
  }});assert.equal(turn.query_enriched,true);check();
  // Lost acknowledgement after a REAL server commit: retry keeps one receipt key.
  const box=new DurableOutbox({directory:dir,rootUri:`ultra://${source}/`,principalId:'reliability-ci',serverId:'fixture'});
  box.enqueue({session_id:'capture',event_id:'event1',transcript:'Consented raw session awaiting a model.',visibility:'private'});
  let lost=true;
  await box.flush(async p=>{const r=await call('ultra_commit_session',p);if(lost){lost=false;throw new Error('simulated transport loss after server commit');}return r;});
  const replay=await box.flush(p=>call('ultra_commit_session',p),{force:true});
  assert.equal(replay.results[0].state,'needs_model',JSON.stringify(replay));assert.equal(box.inspect().pending,0);check();
  const [count]=await engine.executeRaw("SELECT count(*)::int AS n FROM ultrabrain.session_receipts WHERE source_id=$1 AND jsonb_typeof(result)='object'",[source]);assert.equal(count.n,1);check();
  await engine.executeRaw('UPDATE ultrabrain.session_receipts SET result=to_jsonb(result::text) WHERE source_id=$1',[source]);
  await engine.executeRaw(SESSION_SCHEMA.split(';').find(s=>s.includes('UPDATE ultrabrain.session_receipts SET result')));
  const sessionReplay=await call('ultra_commit_session',{session_id:'capture',event_id:'event1',transcript:'Consented raw session awaiting a model.',visibility:'private'});
  assert.equal(sessionReplay.storage,'stored');assert.equal(typeof sessionReplay.uri,'string');assert.equal(sessionReplay.replayed,true);check();
  await assert.rejects(call('ultra_project_forget',{project_id:project,expected_revision:2,confirm:project}),{code:'revision_conflict'});check();
  assert.equal((await call('ultra_project_forget',{project_id:project,expected_revision:3,confirm:project})).forgotten,true);check();
  await assert.rejects(load(),{code:'not_found'});check();
  await assert.rejects(save(state,0,'restore-old-event'),{code:'project_forgotten'});check();
  const [gone]=await engine.executeRaw('SELECT count(*)::int AS n FROM ultrabrain.verification_receipts WHERE source_id=$1',[source]);assert.equal(gone.n,0);check();
  console.log(`PASS ${checks} real PostgreSQL reliability checks (CAS, replay, execution evidence, scope, recovery, forgetting)`);
} finally {rmSync(dir,{recursive:true,force:true});await engine.disconnect();}
