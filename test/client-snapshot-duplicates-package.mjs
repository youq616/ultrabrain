/** Compiled offline CLI/library copied WITHOUT SDK; actual guard-protected subprocesses.
 * Accept a built/installed private package root, not customer data or credentials.
 */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,copyFileSync,statSync,rmSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';import {tmpdir} from 'node:os';import {fileURLToPath} from 'node:url';
import {row,uuid,hash,envelope,encoded} from './helpers/snapshot-audit-fixture.mjs';
const packageRoot=resolve(process.argv[2]??'packages/ultrabrain-client');
const guard=fileURLToPath(new URL('./fixtures/snapshot-offline-guard.cjs',import.meta.url));
const dir=mkdtempSync(join(tmpdir(),'ub-duplicates-bundle-'));
const env=Object.fromEntries(['PATH','SystemRoot','SYSTEMROOT','TEMP','TMP','HOME'].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]));
let checks=0;
try{
 const manifest=JSON.parse(readFileSync(join(packageRoot,'dist/build-manifest.json'),'utf8'));
 for(const name of ['snapshot.cjs','snapshot-cli.cjs']){
  const bytes=readFileSync(join(packageRoot,'dist',name));assert.equal(hash(bytes),manifest.artifacts[name]);
  copyFileSync(join(packageRoot,'dist',name),join(dir,name));
 }
 assert.equal(existsSync(join(dir,'node_modules')),false);
 const path=join(dir,'selected.json'),records=[row(1,{content:'PRIVATE_DUPLICATE_BUNDLE'}),row(2,{content:'PRIVATE_DUPLICATE_BUNDLE',project_id:'p'}),row(3)];
 writeFileSync(path,encoded(envelope(records)));const original=readFileSync(path),before=statSync(path).mtimeMs;
 const input={operation:'duplicates',consent:true,files:[{path,expected_sha256:hash(original)}]};
 const script=`const fs=require('node:fs'),api=require(process.argv[1]);
 const input=JSON.parse(fs.readFileSync(0,'utf8'));
 (async()=>{const {files,...request}=input;const r=process.argv[2]==='bytes'?
 await api.inspectClientSnapshotBytes(request,files.map(f=>({data:fs.readFileSync(f.path),expected_sha256:f.expected_sha256}))):
 await api.inspectClientSnapshots(input);process.stdout.write(JSON.stringify(r)+'\\n');})()
 .catch(e=>{process.stdout.write(JSON.stringify({error:e.code})+'\\n');process.exitCode=1;});`;
 const run=(mode,request)=>{
  const r=spawnSync(process.execPath,['--require',guard,...(mode==='cli'?[join(dir,'snapshot-cli.cjs')]:['-e',script,join(dir,'snapshot.cjs'),mode])],
   {cwd:dir,env,input:JSON.stringify(request),encoding:'utf8',timeout:10000,maxBuffer:2097152});
  assert.ifError(r.error);assert.equal(r.signal,null);assert.equal(r.stderr,'');
  for(const secret of [dir,'PRIVATE_DUPLICATE_BUNDLE','OFFLINE_FORBIDDEN_OPERATION'])assert.ok(!r.stdout.includes(secret));
  return {status:r.status,report:JSON.parse(r.stdout)};
 };
 for(const mode of ['cli','path','bytes']){
  const r=run(mode,input);assert.equal(r.status,0);assert.equal(r.report.result.counts.duplicate_groups,1);
  assert.deepEqual(r.report.result.groups[0].members.map(m=>m.id),[uuid(1),uuid(2)]);
  assert.equal(r.report.result.groups[0].cross_project,true);assert.equal(r.report.network_requests,0);checks++;
  const denied=run(mode,{...input,consent:false});assert.equal(denied.status,1);assert.equal(denied.report.error,'snapshot_consent_required');checks++;
  const digest=run(mode,{...input,files:[{path,expected_sha256:'0'.repeat(64)}]});assert.equal(digest.status,1);assert.equal(digest.report.error,'snapshot_hash_mismatch');checks++;
 }
 assert.deepEqual(readFileSync(path),original);assert.equal(statSync(path).mtimeMs,before);checks++;
 const report={passed:true,checks,mode:'compiled CLI/path/byte APIs copied without SDK, existing negative-capability guard',
  data:'synthetic snapshots only',input_bytes_and_mtime_unchanged:true,network_requests:0,model_calls:0,
  platform:process.platform,bundle_sha256:manifest.artifacts['snapshot.cjs']};
 if(process.env.ULTRABRAIN_DUPLICATES_REPORT)writeFileSync(process.env.ULTRABRAIN_DUPLICATES_REPORT,JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report));
}finally{rmSync(dir,{recursive:true,force:true});}
