/** Real source CLI/path/byte APIs under the existing negative-capability guard. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,statSync,rmSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';import {fileURLToPath} from 'node:url';
import {row,uuid,hash,envelope,encoded} from './helpers/snapshot-audit-fixture.mjs';
const cli=fileURLToPath(new URL('../packages/ultrabrain-client/src/snapshot-cli.mjs',import.meta.url));
const api=new URL('../packages/ultrabrain-client/src/snapshot.mjs',import.meta.url).href;
const guard=fileURLToPath(new URL('./fixtures/snapshot-offline-guard.cjs',import.meta.url));
const env=Object.fromEntries(['PATH','SystemRoot','SYSTEMROOT','TEMP','TMP','HOME'].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]));
const rows=()=>[row(1,{content:'PRIVATE_DUPLICATE_BODY'}),row(2),row(3,{content:'PRIVATE_DUPLICATE_BODY',status:'active'})];
function run(t,{mode='cli',extra={},records=rows(),raw,pretty=true}={}){
 const dir=mkdtempSync(join(tmpdir(),'ub-duplicates-cli-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const path=join(dir,'selected 中文.json'),snapshot=envelope(records);
 const data=pretty?encoded(snapshot):Buffer.from(JSON.stringify(snapshot));writeFileSync(path,data);
 const before=statSync(path).mtimeMs;
 const input={operation:'duplicates',consent:true,files:[{path,expected_sha256:hash(data)}],...(typeof extra==='function'?extra(path):extra)};
 const script=`import fs from 'node:fs';import * as api from ${JSON.stringify(api)};
 const input=JSON.parse(fs.readFileSync(0,'utf8'));
 try{const {files,...request}=input;
 const result=${mode==='bytes'?'await api.inspectClientSnapshotBytes(request,files.map(f=>({data:fs.readFileSync(f.path),expected_sha256:f.expected_sha256})))':'await api.inspectClientSnapshots(input)'};
 process.stdout.write(JSON.stringify(result)+'\\n');}
 catch(e){process.stdout.write(JSON.stringify({error:e.code})+'\\n');process.exitCode=1;}`;
 const r=spawnSync(process.execPath,['--require',guard,...(mode==='cli'?[cli]:['--input-type=module','-e',script])],
 {cwd:dir,input:raw??JSON.stringify(input),env,encoding:'utf8',timeout:10000,maxBuffer:2097152});
 assert.ifError(r.error);assert.equal(r.signal,null);assert.equal(r.stderr,'');
 assert.equal(r.stdout.trim().split('\n').length,1);
 for(const secret of [dir,'PRIVATE_DUPLICATE_BODY','OFFLINE_FORBIDDEN_OPERATION'])assert.ok(!r.stdout.includes(secret));
 assert.deepEqual(readFileSync(path),Buffer.from(data));assert.equal(statSync(path).mtimeMs,before);
 return {status:r.status,report:JSON.parse(r.stdout)};
}
for(const mode of ['cli','path','bytes'])test('duplicates source '+mode+' works without network/subprocess/write capabilities',t=>{
 const {status,report}=run(t,{mode});assert.equal(status,0);assert.equal(report.operation,'duplicates');
 assert.equal(report.result.counts.duplicate_groups,1);assert.equal(report.files[0].expected_hash_verified,true);
 assert.deepEqual(report.result.groups[0].members.map(m=>m.id),[uuid(1),uuid(3)]);
 assert.equal(report.result.automatic_merge_safe,false);assert.equal(report.network_requests,0);
});
for(const [label,extra,code]of [
 ['no consent',{consent:false},'snapshot_consent_required'],['body',{include_text:true},'invalid_params'],
 ['filter',{options:{status:'active'}},'invalid_params'],['root',{memory_id:uuid(1)},'invalid_params'],
 ['extra file',path=>({files:[{path},{path}]}),'invalid_params'],
 ['wrong digest',path=>({files:[{path,expected_sha256:'0'.repeat(64)}]}),'snapshot_hash_mismatch']])
 test('duplicates CLI rejects '+label,t=>{const r=run(t,{extra});assert.equal(r.status,1);assert.equal(r.report.error,code);assert.equal(r.report.result,undefined);});
test('duplicates CLI rejects duplicate and escaped-alias request keys before IO',t=>{
 for(const key of ['consent','con\\u0073ent']){
  const r=run(t,{raw:'{"operation":"duplicates","consent":true,"'+key+'":false}'});
  assert.equal(r.status,1);assert.equal(r.report.error,'snapshot_file_duplicate_key');
 }
});
test('duplicates CLI refuses corrupt singleton as well as corrupt duplicate',t=>{
 const records=rows();records[1].content='corrupt singleton';const r=run(t,{records});
 assert.equal(r.status,1);assert.equal(r.report.error,'memory_snapshot_unconfirmed');
});
test('duplicates CLI matches compact and formatted snapshot group results',t=>{
 assert.deepEqual(run(t,{pretty:true}).report.result,run(t,{pretty:false}).report.result);
});
test('duplicates CLI documents limits without loading live client or SDK',()=>{
 const r=spawnSync(process.execPath,['--require',guard,cli,'--help'],{env,encoding:'utf8',timeout:10000});
 assert.ifError(r.error);assert.equal(r.status,0);assert.equal(r.stderr,'');assert.match(r.stdout,/duplicates accepts no filters/);
});
