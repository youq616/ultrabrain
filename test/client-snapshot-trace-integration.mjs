/** Actual PostgreSQL export -> actual built SDK-free Node CLI/path/bytes APIs.
 * Relationships are explicitly seeded synthetic metadata, not real model/job
 * ancestry. Preparation writes are outside the fingerprinted read-only phase.
 */
import assert from 'node:assert/strict';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync,readFileSync,copyFileSync,statSync,rmSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';import {spawnSync} from 'node:child_process';
import {connect,ROOT} from '../src/runtime.mjs';
import {PersonalMemoryStore} from '../src/personal-memory-store.mjs';
assert.equal(process.env.ULTRABRAIN_TEST_ALLOW_WRITE,'1','Disposable database only');
const packageRoot=process.env.ULTRABRAIN_TASK_CLIENT_ROOT;assert.ok(packageRoot,'Actual installed package required');
const engine=await connect(),source='sntrace-'+randomBytes(5).toString('hex');
const store=new PersonalMemoryStore({engine,sourceId:source,remote:false,transport:'stdio'});
const dir=mkdtempSync(join(tmpdir(),'ub-trace-installed-')),guard=join(ROOT,'test/fixtures/snapshot-offline-guard.cjs');
const sha=b=>createHash('sha256').update(b).digest('hex');
const tables=['personal_memories','personal_events','personal_consolidations','agent_registry','personal_documents','personal_document_fragments'];
async function fingerprint(){
  const result={};for(const table of tables)result[table]=(await engine.executeRaw(
    `SELECT md5(coalesce(string_agg(row_to_json(t)::text,',' ORDER BY row_to_json(t)::text),'')) AS h FROM ultrabrain.${table} t WHERE source_id=$1`,[source]))[0].h;
  return result;
}
let checks=0,injectedReferences=0;const pass=()=>checks++;
async function seedReference(child,input,content){
  const quote='TRACE_PRIVATE',start=content.indexOf(quote);
  const ref={job_id:randomUUID(),input_id:input,input_revision:1,input_hash:sha(content),profile_hash:sha('synthetic trace fixture'),
    quote,start,end:start+quote.length,offset_unit:'UTF-16 code units'};
  const changed=await engine.executeRaw(`UPDATE ultrabrain.personal_memories SET derivation=$4::text::jsonb
    WHERE source_id=$1 AND actor_key=$2 AND id=$3::uuid RETURNING id::text`,[source,store.actor,child,JSON.stringify(ref)]);
  assert.equal(changed.length,1);injectedReferences++;
}
async function exportFile(name,count){
  const data=await store.snapshot({request_id:randomUUID(),consent:true});assert.equal(data.record_count,count);
  const path=join(dir,name+'.json');writeFileSync(path,JSON.stringify(data,null,2)+'\n',{mode:0o600});return path;
}
function run(path,memory_id,mode,extra={},status=0){
  const input={operation:'trace',consent:true,memory_id,files:[{path,expected_sha256:sha(readFileSync(path))}],...extra};
  const script=`const fs=require('node:fs'),api=require(process.argv[1]);const input=JSON.parse(fs.readFileSync(0,'utf8'));
    (async()=>{const {files,...q}=input;const r=process.argv[2]==='bytes'?
      await api.inspectClientSnapshotBytes(q,files.map(f=>({data:fs.readFileSync(f.path),expected_sha256:f.expected_sha256}))):
      await api.inspectClientSnapshots(input);process.stdout.write(JSON.stringify(r)+'\\n');})()
      .catch(e=>{process.stdout.write(JSON.stringify({error:e.code})+'\\n');process.exitCode=1;});`;
  const args=['--require',guard,...(mode==='cli'?[join(dir,'snapshot-cli.cjs')]:['-e',script,join(dir,'snapshot.cjs'),mode])];
  const child=spawnSync('node',args,{cwd:dir,input:JSON.stringify(input),encoding:'utf8',timeout:15000,maxBuffer:1048576,
    env:Object.fromEntries(['PATH','HOME','TMP','TEMP','SystemRoot'].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]))});
  assert.ifError(child.error);assert.equal(child.signal,null);assert.equal(child.status,status,child.stderr);assert.equal(child.stderr,'');
  for(const text of [dir,'TRACE_PRIVATE','OFFLINE_FORBIDDEN_OPERATION'])assert.ok(!child.stdout.includes(text));
  const r=JSON.parse(child.stdout);
  if(status===0){assert.equal(r.result.graph_verified,false);assert.equal(r.result.historical_chain_verified,false);
    assert.equal(r.identity_verified,false);assert.equal(r.truth_verified,false);assert.equal(r.result.text_included,false);}
  return r;
}
try{
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)',[source]);await store.register({agent_id:'snapshot-trace-fixture'});
  const bodies=Array.from({length:6},(_,i)=>'前🙂\r\nTRACE_PRIVATE_DB_'+i);
  const batch=await store.commit({agent_id:'snapshot-trace-fixture',event_id:'chain',consent:true,
    memories:bodies.slice(0,4).map(content=>({type:'experience',content,provenance:'Explicit synthetic trace fixture'}))});
  const ids=batch.entries.map(e=>e.id);assert.equal(ids.length,4);
  for(let i=1;i<4;i++)await seedReference(ids[i],ids[i-1],bodies[i-1]);
  const original=await exportFile('original',4);
  await store.update({memory_id:ids[1],expected_revision:1,event_id:'change-source',
    memory:{type:'experience',content:bodies[1]+' edited',provenance:'Explicit synthetic correction'}});
  const changed=await exportFile('changed',4);
  const cycleBatch=await store.commit({agent_id:'snapshot-trace-fixture',event_id:'cycle',consent:true,
    memories:bodies.slice(4).map(content=>({type:'experience',content,provenance:'Explicit synthetic cycle fixture'}))});
  const cycleIds=cycleBatch.entries.map(e=>e.id);
  await seedReference(cycleIds[0],cycleIds[1],bodies[5]);await seedReference(cycleIds[1],cycleIds[0],bodies[4]);
  const cyclic=await exportFile('cyclic',6);
  const manifest=JSON.parse(readFileSync(join(packageRoot,'dist/build-manifest.json'),'utf8'));
  for(const name of ['snapshot.cjs','snapshot-cli.cjs']){
    assert.equal(sha(readFileSync(join(packageRoot,'dist',name))),manifest.artifacts[name]);
    copyFileSync(join(packageRoot,'dist',name),join(dir,name));pass();
  }
  const paths=[original,changed,cyclic],filesBefore=paths.map(p=>[sha(readFileSync(p)),statSync(p).mtimeMs]);
  const before=await fingerprint(); // All fixture writes finish BEFORE this phase.
  for(const mode of ['cli','library','bytes']){
    let r=run(original,ids[3],mode);assert.equal(r.result.termination,'unlinked');assert.equal(r.result.followed_hops,3);
    assert.deepEqual(r.result.steps.map(e=>e.memory.id),ids.toReversed());pass();
    r=run(original,ids[3],mode,{max_hops:1});assert.equal(r.result.termination,'depth_limit');
    assert.equal(r.result.steps.at(-1).source,null);assert.equal(r.result.followed_hops,1);pass();
    r=run(changed,ids[3],mode);assert.equal(r.result.termination,'changed');assert.equal(r.result.followed_hops,1);
    assert.equal(r.result.steps.at(-1).comparison.revision_matches,false);assert.equal(r.result.steps.at(-1).memory.derivation_current,false);pass();
    r=run(cyclic,cycleIds[0],mode);assert.equal(r.result.termination,'cycle');assert.equal(r.result.visited_count,2);
    assert.deepEqual(r.result.cycle,{entry_id:cycleIds[0],entry_index:0,closing_index:1});pass();
    assert.equal(run(original,randomUUID(),mode,{},1).error,'snapshot_record_missing');pass();
  }
  assert.deepEqual(await fingerprint(),before);assert.deepEqual(paths.map(p=>[sha(readFileSync(p)),statSync(p).mtimeMs]),filesBefore);pass();
  const report={passed:true,checks,scope:'Real PostgreSQL synthetic relationships -> actual export -> SDK-free built Node trace',
    synthetic_relation_updates:injectedReferences,exported_record_counts:[4,4,6],external_model_calls:0,
    actual_model_job_history_verified:false,tables_unchanged_in_trace_phase:6,input_bytes_and_mtime_unchanged:true,
    bundle_hashes_checked:true,actual_user_host_verified:false};
  if(process.env.ULTRABRAIN_SNAPSHOT_TRACE_REPORT)writeFileSync(process.env.ULTRABRAIN_SNAPSHOT_TRACE_REPORT,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
}finally{await engine.disconnect();rmSync(dir,{recursive:true,force:true});}
