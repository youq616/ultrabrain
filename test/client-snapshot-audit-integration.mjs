/** Real PostgreSQL/consolidator export -> actual built, SDK-free offline entries.
 * Three explicitly injected synthetic generations, ZERO external model calls.
 * Preparation writes are separate from the six-table-fingerprinted audit phase.
 */
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync,readFileSync,copyFileSync,statSync,rmSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';import {spawnSync} from 'node:child_process';
import {connect,ROOT} from '../src/runtime.mjs';
import {PersonalMemoryStore} from '../src/personal-memory-store.mjs';
import {PersonalConsolidator} from '../src/personal-consolidation.mjs';
import {personalModelProfile} from '../src/personal-consolidation-core.mjs';
assert.equal(process.env.ULTRABRAIN_TEST_ALLOW_WRITE,'1','Disposable database only');
const packageRoot=process.env.ULTRABRAIN_TASK_CLIENT_ROOT;assert.ok(packageRoot,'Actual installed package required');
const engine=await connect(),source='snaudit-'+randomBytes(5).toString('hex');
const ctx={engine,sourceId:source,remote:false,transport:'stdio'},store=new PersonalMemoryStore(ctx);
const dir=mkdtempSync(join(tmpdir(),'ub-audit-installed-')),path=join(dir,'actual export 中文.json');
const guard=join(ROOT,'test/fixtures/snapshot-offline-guard.cjs');
const tables=['personal_memories','personal_events','personal_consolidations','agent_registry','personal_documents','personal_document_fragments'];
const sha=value=>createHash('sha256').update(value).digest('hex');
const fingerprint=async()=>{
  const result={};for(const table of tables)result[table]=(await engine.executeRaw(
    `SELECT md5(coalesce(string_agg(row_to_json(t)::text,',' ORDER BY row_to_json(t)::text),'')) AS h FROM ultrabrain.${table} t WHERE source_id=$1`,[source]))[0].h;
  return result;
};
let checks=0,generations=0;const pass=()=>checks++;
function run(extra={},mode='cli',expectedCode=0){
  const request={operation:'audit',consent:true,files:[{path,expected_sha256:sha(readFileSync(path))}],...extra};
  const script=`const fs=require('node:fs'),api=require(process.argv[1]);
    const input=JSON.parse(fs.readFileSync(0,'utf8'));
    (async()=>{const {files,...q}=input;
      const r=process.argv[2]==='bytes'?await api.inspectClientSnapshotBytes(q,files.map(f=>({data:fs.readFileSync(f.path),expected_sha256:f.expected_sha256}))):await api.inspectClientSnapshots(input);
      process.stdout.write(JSON.stringify(r)+'\\n');})().catch(e=>{process.stdout.write(JSON.stringify({error:e.code})+'\\n');process.exitCode=1;});`;
  const args=['--require',guard,...(mode==='cli'?[join(dir,'snapshot-cli.cjs')]:['-e',script,join(dir,'snapshot.cjs'),mode])];
  const child=spawnSync('node',args,{cwd:dir,input:JSON.stringify(request),encoding:'utf8',timeout:15000,maxBuffer:1048576,
    env:Object.fromEntries(['PATH','HOME','TMP','TEMP','SystemRoot'].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]))});
  assert.ifError(child.error);assert.equal(child.signal,null);assert.equal(child.status,expectedCode,child.stderr);
  assert.equal(child.stderr,'');assert.ok(!child.stdout.includes(dir));assert.ok(!child.stdout.includes('AUDIT_PRIVATE'));
  assert.ok(!child.stdout.includes('OFFLINE_FORBIDDEN_OPERATION'));return JSON.parse(child.stdout);
}
try{
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)',[source]);await store.register({agent_id:'snapshot-audit-fixture'});
  const quote='AUDIT_PRIVATE_QUOTE',transcript='AUDIT_PRIVATE_SOURCE 前🙂\r\n'+quote+' 尾';
  const profile=personalModelProfile({enabled:true,model:'fixture:snapshot-audit',revision:'synthetic',timeout_ms:120000});
  const worker=new PersonalConsolidator(ctx,async()=>({profile,generate:async()=>{
    generations++;return {text:JSON.stringify({memories:[{type:'preference',content:'AUDIT_PRIVATE_DERIVED',quote}]})};
  }}));
  const fixtures={};
  for(const name of ['matched','changed','archived']){
    const captured=await store.capture({agent_id:'snapshot-audit-fixture',event_id:'capture-'+name,transcript,consent:true});
    const processed=await worker.process({expected_source:source,job_id:captured.job_id,allow_model_call:true});
    assert.equal(processed.results[0].state,'completed');
    fixtures[name]={input:captured.input_id,id:processed.results[0].result.entries[0].id};
  }
  assert.equal(generations,3);
  await store.update({memory_id:fixtures.changed.input,expected_revision:1,event_id:'source-change',
    memory:{type:'experience',content:transcript+' edited',provenance:'Explicit synthetic correction'}});
  await store.review({memory_id:fixtures.archived.input,expected_revision:1,event_id:'source-archive',status:'archived'});
  const exported=await store.snapshot({request_id:randomUUID(),consent:true});assert.equal(exported.record_count,6);
  writeFileSync(path,JSON.stringify(exported,null,2)+'\n',{mode:0o600});
  const manifest=JSON.parse(readFileSync(join(packageRoot,'dist/build-manifest.json'),'utf8'));
  for(const name of ['snapshot.cjs','snapshot-cli.cjs']){
    assert.equal(sha(readFileSync(join(packageRoot,'dist',name))),manifest.artifacts[name]);
    copyFileSync(join(packageRoot,'dist',name),join(dir,name));pass();
  }
  const before=await fingerprint(),fileBefore=[sha(readFileSync(path)),statSync(path).mtimeMs];
  for(const mode of ['cli','library','bytes']){
    const r=run({},mode);assert.equal(r.identity_verified,false);assert.equal(r.truth_verified,false);
    assert.equal(r.result.audited_count,6);assert.equal(r.result.counts.unlinked,3);
    for(const state of ['matched','changed','archived'])assert.equal(r.result.counts[state],1);
    assert.equal(Object.values(r.result.counts).reduce((a,b)=>a+b,0),6);assert.equal(r.result.graph_verified,false);pass();
    for(const [state,f] of Object.entries(fixtures)){
      const one=run({memory_id:f.id},mode);assert.equal(one.result.entries.length,1);
      assert.equal(one.result.entries[0].state,state);assert.equal(one.result.entries[0].reference.input_id,f.input);pass();
    }
    for(const [state,f] of Object.entries(fixtures)){
      const traced=run({operation:'trace',memory_id:f.id},mode);
      assert.equal(traced.result.termination,state==='matched'?'unlinked':state);
      assert.equal(traced.result.followed_hops,state==='matched'?1:0);
      assert.equal(traced.result.historical_chain_verified,false);pass();
    }
    assert.equal(run({memory_id:randomUUID()},mode,1).error,'snapshot_record_missing');pass();
  }
  assert.deepEqual(await fingerprint(),before);assert.deepEqual([sha(readFileSync(path)),statSync(path).mtimeMs],fileBefore);pass();
  const report={passed:true,checks,scope:'Real PostgreSQL/consolidator snapshot -> SDK-free installed Node audit CLI/library/bytes',
    exported_records:6,injected_synthetic_generations:generations,external_model_calls:0,tables_unchanged_in_audit_phase:6,
    input_bytes_and_mtime_unchanged:true,bundle_hashes_checked:true,actual_user_host_verified:false};
  if(process.env.ULTRABRAIN_SNAPSHOT_AUDIT_REPORT)writeFileSync(process.env.ULTRABRAIN_SNAPSHOT_AUDIT_REPORT,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
}finally{await engine.disconnect();rmSync(dir,{recursive:true,force:true});}
