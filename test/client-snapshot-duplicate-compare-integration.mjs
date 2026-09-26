/** Real PostgreSQL exports -> built offline CLI/path/byte APIs. Synthetic data only.
 * Preparation has explicit writes; the read phase fingerprints all six personal
 * tables and input files. The offline child has no SDK/network/write capability.
 */
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync,readFileSync,copyFileSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {spawnSync} from 'node:child_process';
import {connect,ROOT} from '../src/runtime.mjs';import {PersonalMemoryStore} from '../src/personal-memory-store.mjs';
assert.equal(process.env.ULTRABRAIN_TEST_ALLOW_WRITE,'1');
const pkg=process.env.ULTRABRAIN_TASK_CLIENT_ROOT;assert.ok(pkg,'Actual built/installed package root required');
const dir=mkdtempSync(join(tmpdir(),'ub-duplicate-compare-db-')),leftPath=join(dir,'left.json'),rightPath=join(dir,'right.json');
const engine=await connect(),source='dupcompare-'+randomBytes(5).toString('hex');
const ctx={engine,sourceId:source,remote:false,transport:'stdio'},store=new PersonalMemoryStore(ctx);
const hash=b=>createHash('sha256').update(b).digest('hex'),tables=['personal_memories','personal_events','personal_consolidations','agent_registry','personal_documents','personal_document_fragments'];
const fingerprint=async()=>{
 const result={};for(const name of tables)result[name]=(await engine.executeRaw(
  `SELECT md5(coalesce(string_agg(row_to_json(t)::text,',' ORDER BY row_to_json(t)::text),'')) AS h FROM ultrabrain.${name} t WHERE source_id=$1`,[source]))[0].h;
 return result;
};
const select=(a=leftPath,b=rightPath)=>({operation:'duplicate-compare',consent:true,files:[a,b].map(path=>({path,expected_sha256:hash(readFileSync(path))}))});
const guard=join(ROOT,'test/fixtures/snapshot-offline-guard.cjs');let checks=0;
function run(input,mode='cli',status=0){
 const script=`const fs=require('node:fs'),api=require(process.argv[1]);const input=JSON.parse(fs.readFileSync(0,'utf8'));
 (async()=>{let r;if(process.argv[2]==='bytes'){const {files,...q}=input;r=await api.inspectClientSnapshotBytes(q,files.map(f=>({data:fs.readFileSync(f.path),expected_sha256:f.expected_sha256})));}
 else r=await api.inspectClientSnapshots(input);process.stdout.write(JSON.stringify(r)+'\\n');})().catch(e=>{process.stdout.write(JSON.stringify({error:e.code})+'\\n');process.exitCode=1;});`;
 const args=['--require',guard,...(mode==='cli'?[join(dir,'snapshot-cli.cjs')]:['-e',script,join(dir,'snapshot.cjs'),mode])];
 const r=spawnSync('node',args,{cwd:dir,input:JSON.stringify(input),encoding:'utf8',timeout:15000,
  env:Object.fromEntries(['PATH','HOME','SystemRoot','SYSTEMROOT','TEMP','TMP'].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]))});
 assert.ifError(r.error);assert.equal(r.signal,null);assert.equal(r.status,status,r.stderr);assert.equal(r.stderr,'');
 for(const secret of ['PRIVATE_DUPCOMPARE','OFFLINE_FORBIDDEN_OPERATION',dir])assert.ok(!r.stdout.includes(secret));
 return JSON.parse(r.stdout);
}
try{
 await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)',[source]);await store.register({agent_id:'duplicate-compare-fixture'});
 const ids=[];
 for(const [i,key]of ['A','A','B','C','C','D','D'].entries()){
  const r=await store.commit({agent_id:'duplicate-compare-fixture',event_id:'seed-'+i,consent:true,memories:[
   {type:'preference',content:'PRIVATE_DUPCOMPARE_'+key,provenance:'Synthetic duplicate comparison fixture',project_id:i%2?'project-a':null}]});ids.push(r.entries[0].id);
 }
 const left=await store.snapshot({request_id:randomUUID(),consent:true});assert.equal(left.record_count,7);
 await store.update({memory_id:ids[1],expected_revision:1,event_id:'change-a',memory:{type:'preference',content:'PRIVATE_DUPCOMPARE_unique',provenance:'Synthetic edit'}});
 await store.review({memory_id:ids[3],expected_revision:1,event_id:'archive-c',status:'archived'});
 await store.commit({agent_id:'duplicate-compare-fixture',event_id:'add-b',consent:true,memories:[{type:'goal',content:'PRIVATE_DUPCOMPARE_B',provenance:'Synthetic addition'}]});
 const right=await store.snapshot({request_id:randomUUID(),consent:true});assert.equal(right.record_count,8);
 writeFileSync(leftPath,JSON.stringify(left,null,2)+'\n',{mode:0o600});writeFileSync(rightPath,'\ufeff'+JSON.stringify(right,null,2)+'\n',{mode:0o600});
 const manifest=JSON.parse(readFileSync(join(pkg,'dist/build-manifest.json'),'utf8'));
 for(const name of ['snapshot-cli.cjs','snapshot.cjs']){const bytes=readFileSync(join(pkg,'dist',name));assert.equal(hash(bytes),manifest.artifacts[name]);copyFileSync(join(pkg,'dist',name),join(dir,name));}
 const before=await fingerprint(),fileBefore=[leftPath,rightPath].map(p=>[hash(readFileSync(p)),statSync(p).mtimeMs]);
 for(const mode of ['cli','path','bytes']){
  const r=run(select(),mode);assert.deepEqual(r.result.counts,{groups:4,left_only:1,right_only:1,changed:1,unchanged:1});
  assert.equal(r.result.groups.find(g=>g.content_sha256===hash('PRIVATE_DUPCOMPARE_A')).right.member_count,1);
  assert.equal(r.result.groups.find(g=>g.content_sha256===hash('PRIVATE_DUPCOMPARE_B')).left.member_count,1);
  assert.equal(r.result.groups.find(g=>g.content_sha256===hash('PRIVATE_DUPCOMPARE_C')).kind,'changed');
  assert.equal(r.result.groups.find(g=>g.content_sha256===hash('PRIVATE_DUPCOMPARE_D')).kind,'unchanged');
  assert.equal(r.result.identity_verified,false);assert.equal(r.result.references_verified,false);assert.equal(r.network_requests,0);checks++;
 }
 const same=run(select(leftPath,leftPath));assert.equal(same.result.counts.unchanged,3);checks++;
 const reverse=run(select(rightPath,leftPath));assert.deepEqual(reverse.result.counts,{groups:4,left_only:1,right_only:1,changed:1,unchanged:1});checks++;
 const bad=select();bad.files[1].expected_sha256='0'.repeat(64);assert.equal(run(bad,'cli',1).error,'snapshot_hash_mismatch');checks++;
 const other=new PersonalMemoryStore({...ctx,remote:true,transport:'http',auth:{sourceId:source,scopes:['read'],principal:{kind:'oauth_client',id:'other-owner'}}});
 const empty=await other.snapshot({request_id:randomUUID(),consent:true}),otherPath=join(dir,'other.json');assert.equal(empty.record_count,0);
 writeFileSync(otherPath,JSON.stringify(empty),{mode:0o600});const unlike=run(select(leftPath,otherPath));
 assert.equal(unlike.result.counts.left_only,3);assert.equal(unlike.result.identity_verified,false);checks++;
 assert.deepEqual(await fingerprint(),before);assert.deepEqual([leftPath,rightPath].map(p=>[hash(readFileSync(p)),statSync(p).mtimeMs]),fileBefore);checks++;
 const report={passed:true,checks,mode:'actual PostgreSQL exports, built isolated CLI/path/byte APIs',exported_records:[7,8],
  input_bytes_and_mtime_unchanged:true,read_phase_tables_unchanged:6,external_model_calls:0,generator_calls:0,actual_user_host_verified:false};
 if(process.env.ULTRABRAIN_DUPLICATE_COMPARE_REPORT)writeFileSync(process.env.ULTRABRAIN_DUPLICATE_COMPARE_REPORT,JSON.stringify(report,null,2)+'\n');
 console.log(`PASS ${checks} real duplicate comparison checks; six unchanged tables, zero models, no SDK in offline child`);
}finally{await engine.disconnect();rmSync(dir,{recursive:true,force:true});}
