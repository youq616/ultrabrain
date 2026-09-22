/** Real PostgreSQL exports -> actually installed and isolated offline Node bundles.
 * Preparation writes synthetic records; the separately fingerprinted read phase
 * must not modify six application tables. No model or SDK double is used.
 */
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync,readFileSync,copyFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';import {spawn} from 'node:child_process';
import {connect,ROOT} from '../src/runtime.mjs';import {PersonalMemoryStore} from '../src/personal-memory-store.mjs';
assert.equal(process.env.ULTRABRAIN_TEST_ALLOW_WRITE,'1','Disposable database only');
const packageRoot=process.env.ULTRABRAIN_TASK_CLIENT_ROOT;assert.ok(packageRoot,'Actual installed package required');
const engine=await connect(),source='snapoff-'+randomBytes(5).toString('hex');
const ctx={engine,sourceId:source,remote:false,transport:'stdio'},store=new PersonalMemoryStore(ctx);
const dir=mkdtempSync(join(tmpdir(),'ub-snapshot-installed-'));
const leftPath=join(dir,'left export 中文.json'),rightPath=join(dir,'right.json');
const guard=join(ROOT,'test/fixtures/snapshot-offline-guard.cjs');
const tables=['personal_memories','personal_events','personal_consolidations','agent_registry','personal_documents','personal_document_fragments'];
const hash=value=>createHash('sha256').update(value).digest('hex');
const fingerprint=async()=>{
  const result={};for(const table of tables)result[table]=(await engine.executeRaw(
    `SELECT md5(coalesce(string_agg(row_to_json(t)::text,',' ORDER BY row_to_json(t)::text),'')) AS digest FROM ultrabrain.${table} t WHERE source_id=$1`,[source]))[0].digest;
  return result;
};
let checks=0;const pass=()=>checks++;
async function run(request,{library=false,bytes=false,isolated=false}={}){
  const root=isolated?dir:join(packageRoot,'dist');
  const script=`const fs=require('node:fs'),api=require(process.argv[1]);
    const input=JSON.parse(fs.readFileSync(0,'utf8'));
    (async()=>{let result;if(${bytes}){const {files,...query}=input;
      result=await api.inspectClientSnapshotBytes(query,files.map(f=>({data:fs.readFileSync(f.path),expected_sha256:f.expected_sha256})));}
    else result=await api.inspectClientSnapshots(input);
    process.stdout.write(JSON.stringify(result)+'\\n');})().catch(e=>{process.stdout.write(JSON.stringify({error:e.code})+'\\n');process.exitCode=1;});`;
  const args=['--require',guard,...(library?['-e',script,join(root,'snapshot.cjs')]:[join(root,'snapshot-cli.cjs')])];
  const child=spawn('node',args,{cwd:dir,env:process.env,stdio:['pipe','pipe','pipe']});
  let out='',err='';child.stdout.on('data',b=>{out+=b;if(Buffer.byteLength(out)>1048576)child.kill('SIGKILL');});
  child.stderr.on('data',b=>{err+=b;if(Buffer.byteLength(err)>65536)child.kill('SIGKILL');});child.stdin.on('error',()=>{});
  const timer=setTimeout(()=>child.kill('SIGKILL'),15000);
  try{
    const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
    child.stdin.end(JSON.stringify(request));const code=await done;
    assert.equal(err,'','Offline child stderr must be empty');assert.ok(out.trim(),'Child returned no JSON');
    assert.ok(!out.includes(dir)&&!out.includes('OFFLINE_FORBIDDEN_OPERATION'));
    return {code,data:JSON.parse(out),out};
  }finally{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
}
try{
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)',[source]);
  await store.register({agent_id:'snapshot-offline-fixture'});const ids=[];
  for(let i=0;i<23;i++){
    const r=await store.commit({agent_id:'snapshot-offline-fixture',event_id:'seed-'+i,consent:true,
      memories:[{type:'preference',content:'OFFLINE_SYNTHETIC_BODY_'+i+'\r\n🙂',provenance:'Synthetic offline snapshot fixture',project_id:i%2?'project-a':null}]});
    const id=r.entries[0].id;ids.push(id);
    if(i%3)await store.review({memory_id:id,expected_revision:1,event_id:'review-'+i,status:i%3===1?'active':'archived'});
  }
  const left=await store.snapshot({request_id:randomUUID(),consent:true});assert.equal(left.record_count,23);
  await store.update({memory_id:ids[0],expected_revision:1,event_id:'correct',memory:{type:'preference',content:'OFFLINE_CORRECTED_BODY\r\n🙂',provenance:'Synthetic correction'}});
  await store.review({memory_id:ids[1],expected_revision:2,event_id:'archive',status:'archived'});
  await store.commit({agent_id:'snapshot-offline-fixture',event_id:'added',consent:true,
    memories:[{type:'goal',content:'OFFLINE_ADDED_BODY',provenance:'Synthetic added record'}]});
  const right=await store.snapshot({request_id:randomUUID(),consent:true});assert.equal(right.record_count,24);
  writeFileSync(leftPath,JSON.stringify(left,null,2)+'\n',{mode:0o600});
  writeFileSync(rightPath,'\ufeff'+JSON.stringify(right,null,2)+'\n',{mode:0o600});
  const manifest=JSON.parse(readFileSync(join(packageRoot,'dist/build-manifest.json'),'utf8'));
  for(const name of ['snapshot.cjs','snapshot-cli.cjs']){
    assert.equal(hash(readFileSync(join(packageRoot,'dist',name))),manifest.artifacts[name]);
    copyFileSync(join(packageRoot,'dist',name),join(dir,name));
  }
  pass();
  const before=await fingerprint();
  const request=(operation,extra={})=>({operation,consent:true,files:[{path:leftPath}],...extra});
  const noText=r=>{assert.equal(r.code,0);assert.ok(!r.out.includes('OFFLINE_SYNTHETIC_BODY_'));assert.ok(!r.out.includes('OFFLINE_CORRECTED_BODY'));};
  let r=await run(request('inspect'));noText(r);assert.equal(r.data.result.record_count,23);pass();
  r=await run(request('inspect',{files:[{path:rightPath,expected_sha256:hash(readFileSync(rightPath))}]}));
  noText(r);assert.equal(r.data.files[0].expected_hash_verified,true);assert.equal(r.data.result.record_count,24);pass();
  r=await run(request('compare',{files:[{path:leftPath},{path:rightPath}]}));noText(r);
  assert.deepEqual(r.data.result.counts,{left_only:0,right_only:1,changed:2,unchanged:21});pass();
  const seen=[];for(const offset of [0,20]){r=await run(request('page',{options:{offset}}));noText(r);seen.push(...r.data.result.rows.map(x=>x.id));}
  assert.deepEqual(new Set(seen),new Set(ids));pass();
  r=await run(request('page',{options:{query:'OFFLINE_SYNTHETIC_BODY_0',project_scope:'global'}}));noText(r);
  assert.deepEqual(r.data.result.rows.map(x=>x.id),[ids[0]]);pass();
  r=await run(request('record',{memory_id:ids[0]}));noText(r);assert.equal(r.data.result.text_included,false);pass();
  r=await run(request('record',{memory_id:ids[0],include_text:true}));assert.equal(r.code,0);
  assert.equal(r.data.result.text.content,'OFFLINE_SYNTHETIC_BODY_0\r\n🙂');pass();
  r=await run(request('record',{files:[{path:rightPath}],memory_id:ids[0],include_text:true}));assert.equal(r.code,0);
  assert.equal(r.data.result.text.content,'OFFLINE_CORRECTED_BODY\r\n🙂');pass();
  r=await run(request('inspect'),{library:true});noText(r);assert.equal(r.data.result.record_count,23);pass();
  r=await run(request('compare',{files:[{path:leftPath},{path:rightPath}]}),{library:true,bytes:true});
  noText(r);assert.equal(r.data.result.counts.changed,2);pass();
  for(const library of [false,true]){
    r=await run(request('inspect'),{isolated:true,library});noText(r);assert.equal(r.data.network_requests,0);pass();
  }
  for(const [patch,error] of [[{consent:false},'snapshot_consent_required'],
    [{files:[{path:leftPath,expected_sha256:'0'.repeat(64)}]},'snapshot_hash_mismatch'],
    [{operation:'record',memory_id:randomUUID()},'snapshot_record_missing']]){
    r=await run(request('inspect',patch));assert.equal(r.code,1);assert.equal(r.data.error,error);pass();
  }
  const badPath=join(dir,'altered.json'),bad=structuredClone(left);bad.memories[0].content='OFFLINE_TAMPERED_BODY';
  writeFileSync(badPath,JSON.stringify(bad),{mode:0o600});
  r=await run(request('inspect',{files:[{path:badPath}]}));assert.equal(r.code,1);assert.equal(r.data.error,'memory_snapshot_unconfirmed');pass();
  // Real export from another principal with the SAME self-declared source label.
  // Comparison must not pretend matching source_id establishes the same owner.
  const other=new PersonalMemoryStore({...ctx,remote:true,transport:'http',auth:{sourceId:source,scopes:['read'],
    principal:{kind:'oauth_client',id:'offline-unrelated-owner'}}});
  const otherExport=await other.snapshot({request_id:randomUUID(),consent:true});assert.equal(otherExport.record_count,0);
  writeFileSync(badPath,JSON.stringify(otherExport),{mode:0o600});
  r=await run(request('compare',{files:[{path:leftPath},{path:badPath}]}));noText(r);
  assert.equal(r.data.identity_verified,false);assert.equal(r.data.result.identity_verified,false);
  assert.equal(r.data.result.counts.left_only,23);pass();
  assert.deepEqual(await fingerprint(),before);pass();
  const report={passed:true,checks,scope:'Real PostgreSQL export -> installed and isolated offline Node CLI/library',
    exported_records:[23,24],tables_unchanged_in_read_phase:6,application_network_and_write_guard:true,
    bundle_hashes_checked:true,isolated_without_sdk:true,external_model_calls:0,actual_user_host_verified:false};
  if(process.env.ULTRABRAIN_CLIENT_SNAPSHOT_REPORT)writeFileSync(process.env.ULTRABRAIN_CLIENT_SNAPSHOT_REPORT,JSON.stringify(report,null,2)+'\n');
  console.log(`PASS ${checks} installed offline snapshot checks: actual PostgreSQL exports, complete verification/compare/page/record, library bytes, standalone no-SDK bundles, six unchanged tables; zero models`);
}finally{await engine.disconnect();rmSync(dir,{recursive:true,force:true});}
