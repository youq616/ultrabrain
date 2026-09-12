/** Execute against an ACTUAL old source tree, then the candidate, in a private test database. */
import assert from 'node:assert/strict';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {evaluateRetrieval} from '../src/evaluation.mjs';
import {compareRetrievalReports} from '../src/evaluation-gate.mjs';
import {applyMigrations,migrations,checksum,migrationStatus} from '../src/migrations.mjs';
assert.equal(process.env.ULTRABRAIN_TEST_ALLOW_WRITE,'1','Only use an isolated, explicitly allowed test installation');
const [stage,tree,directory]=process.argv.slice(2);
assert.ok(['seed','verify'].includes(stage)&&tree&&directory);
const runtime=await import(pathToFileURL(join(resolve(tree),'src/runtime.mjs')).href);
const {dispatchToolCall}=await runtime.loadNative('src/mcp/dispatch.ts');
const {DurableOutbox}=await import(pathToFileURL(join(resolve(tree),'src/durable-outbox.mjs')).href);
const engine=await runtime.connect({migrate:true});
const source='upgrade-fixture',project='upgrade-project';
const call=async(name,args,extra={})=>{
  const r=await dispatchToolCall(engine,name,args,{sourceId:source,remote:false,transport:'stdio',...extra});
  const value=JSON.parse(r.content[0].text);
  if(r.isError)throw Object.assign(new Error('Fixture operation rejected'),{code:value.error});
  return value;
};
const fingerprint=async()=>{
  const out={};
  for(const [name,sql] of Object.entries({
    native_facts:"SELECT md5(string_agg(id::text||':'||fact||':'||visibility,',' ORDER BY id)) AS value FROM public.facts WHERE source_id=$1",
    pages:"SELECT md5(string_agg(id::text||':'||content_hash,',' ORDER BY id)) AS value FROM pages WHERE source_id=$1",
    project:"SELECT md5(state::text||':'||revision::text) AS value FROM ultrabrain.projects WHERE source_id=$1",
    history:"SELECT md5(string_agg(state::text||':'||revision::text,',' ORDER BY revision)) AS value FROM ultrabrain.project_revisions WHERE source_id=$1",
    receipts:"SELECT md5(string_agg(content_hash||':'||state,',' ORDER BY session_id,event_id)) AS value FROM ultrabrain.session_receipts WHERE source_id=$1"
  }))out[name]=(await engine.executeRaw(sql,[source]))[0].value;
  return out;
};
const labels=[{id:'lookup',query:'ubupgradecanary',expected_uris:[`ultra://${source}/resources/preserved`]},
  {id:'empty',query:'ubabsolutelyabsenttoken',expected_uris:[],expect_empty:true}];
const evaluate=()=>evaluateRetrieval(labels,s=>call('ultra_retrieve',{uri:`ultra://${source}/`,query:s.query}),
  {corpusFingerprint:'upgrade-fixture-v1',evaluationKind:'synthetic-keyword-v1'});
const boxOptions={directory:join(directory,'outbox'),rootUri:`ultra://${source}/`,principalId:'upgrade-agent',serverId:'upgrade-fixture'};
try {
  mkdirSync(directory,{recursive:true,mode:0o700});
  if(stage==='seed') {
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES ($1,$1)',[source]);
    await call('put_page',{slug:'resources/preserved',content:'---\ntype: note\nvisibility: world\n---\nubupgradecanary persistent body'});
    await call('put_page',{slug:'private/preserved',content:'---\ntype: note\nvisibility: private\n---\nprivate-upgrade-canary'});
    await call('ultra_project_save',{project_id:project,event_id:'checkpoint',expected_revision:0,state:{goal:'Preserve old data',tasks:[],next_actions:['Resume work']}});
    await call('ultra_commit_session',{session_id:'s1',event_id:'e1',transcript:'Consented upgrade fixture transcript',visibility:'private'});
    const fact=await call('remember',{fact:'Legacy native fact without a source binding',provenance:'Upgrade fixture',visibility:'world'});
    writeFileSync(join(directory,'native-fact.json'),JSON.stringify(fact),{mode:0o600});
    const box=new DurableOutbox(boxOptions);
    box.enqueue({session_id:'s2',event_id:'escaped',transcript:'x'+'"'.repeat(65535),visibility:'private'});
    const [policies]=await engine.executeRaw("SELECT to_regclass('ultrabrain.memory_policies') IS NOT NULL AS present");
    if(policies.present) {
      await call('put_page',{slug:'references/legacy-quote',content:'---\ntype: note\nvisibility: world\n---\nLegacy quoted source fixture'});
      const reference=await call('ultra_memory_inspect',{uri:`ultra://${source}/references/legacy-quote`});
      await call('ultra_memory_review',{uri:reference.uri,content_sha256:reference.content_sha256,expected_revision:0,
        event_id:'legacy-review',status:'active',assertion_kind:'source_quote',reason:'Legacy quote fixture',provenance:'Synthetic',
        evidence:{uri:reference.uri,content_sha256:reference.content_sha256,start:0,end:10}});
      const [dependencies]=await engine.executeRaw("SELECT to_regclass('ultrabrain.review_dependencies') IS NOT NULL AS present");
      writeFileSync(join(directory,'legacy-quote.json'),JSON.stringify({...reference,dependencies_present:dependencies.present}),{mode:0o600});
    }
    writeFileSync(join(directory,'fingerprints.json'),JSON.stringify(await fingerprint()),{mode:0o600});
    writeFileSync(join(directory,'baseline-eval.json'),JSON.stringify(await evaluate()),{mode:0o600});
    console.log('PASS old-source seed: pages, privacy, project/history, session receipt, legacy oversized queue record');
  } else {
    const legacy=JSON.parse(readFileSync(join(directory,'native-fact.json'),'utf8'));
    assert.equal((await call('ultra_fact_inspect',{fact_id:legacy.id})).evidence.status,'unlinked');
    assert.equal((await call('ultra_recall',{uri:`ultra://${source}/`})).facts.length,0);
    assert.ok((await call('ultra_recall',{uri:`ultra://${source}/`,memory_policy:'history'})).facts.some(f=>f.fact_id===legacy.id));
    assert.deepEqual(await fingerprint(),JSON.parse(readFileSync(join(directory,'fingerprints.json'),'utf8')));
    if(existsSync(join(directory,'legacy-quote.json'))) {
      const reference=JSON.parse(readFileSync(join(directory,'legacy-quote.json'),'utf8'));
      const current=await call('ultra_memory_inspect',{uri:reference.uri});
      assert.equal(current.memory.status,reference.dependencies_present?'active':'review_required');
      assert.equal(current.memory.revision,reference.dependencies_present?1:2);
      assert.equal(current.content_sha256,reference.content_sha256);
    }
    assert.equal((await call('ultra_project_load',{project_id:project})).revision,1);
    await assert.rejects(call('ultra_read',{uri:`ultra://${source}/private/preserved`,level:'L2'},{remote:true}));
    await assert.rejects(call('ultra_project_load',{project_id:project},{sourceId:'default',remote:true}));
    assert.equal((await call('ultra_commit_session',{session_id:'s1',event_id:'e1',transcript:'Consented upgrade fixture transcript',visibility:'private'})).replayed,true);
    const box=new DurableOutbox(boxOptions);let sent=0;
    await box.flush(async p=>{assert.equal(Buffer.byteLength(p.transcript),65536);sent++;return {state:'needs_model',uri:`ultra://${source}/sessions/s2/escaped`};});
    assert.equal(sent,1);assert.equal(box.inspect().pending,0);
    assert.deepEqual((await applyMigrations(engine)).applied,[]);
    const before=await migrationStatus(engine);assert.equal(before.pending.length,0);
    const failure={id:'0099-failure-probe',statements:['CREATE TABLE ultrabrain.rollback_probe (id integer)','SELECT * FROM ultrabrain.deliberately_missing_table']};
    await assert.rejects(applyMigrations(engine,{plan:[...migrations,failure]}));
    assert.equal((await engine.executeRaw("SELECT to_regclass('ultrabrain.rollback_probe') IS NULL AS gone"))[0].gone,true);
    assert.deepEqual(await migrationStatus(engine),before);
    await assert.rejects(applyMigrations(engine,{plan:migrations.map((m,i)=>i===0?{...m,statements:['SELECT 1']}:m)}),{code:'migration_checksum_mismatch'});
    await Promise.all([applyMigrations(engine),applyMigrations(engine)]);
    assert.deepEqual(await migrationStatus(engine),before);
    const report=await evaluate();writeFileSync(join(directory,'candidate-eval.json'),JSON.stringify(report),{mode:0o600});
    const gate=compareRetrievalReports(JSON.parse(readFileSync(join(directory,'baseline-eval.json'),'utf8')),report);
    assert.equal(gate.passed,true);writeFileSync(join(directory,'upgrade-gate.json'),JSON.stringify(gate,null,2),{mode:0o600});
    console.log('PASS old-to-new data/ACL/receipt/history/outbox, idempotent migration, concurrent migration, rollback and checksum refusal');
    console.log('PASS paired synthetic keyword gate (not semantic-memory quality)');
  }
} finally {await engine.disconnect();}
