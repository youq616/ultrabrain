/** Real built offline entries copied into an SDK-free directory. No DB or mocks.
 * Run: node test/client-snapshot-offline-package.mjs /actual/package/root
 * These synthetic exports do NOT replace the existing PostgreSQL export job.
 */
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,copyFileSync,rmSync,statSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {encoded,envelope,row,uuid} from './helpers/snapshot-audit-fixture.mjs';
const root=resolve(process.argv[2]??'');assert.ok(process.argv[2],'Select an actual built package root');
const guard=fileURLToPath(new URL('./fixtures/snapshot-offline-guard.cjs',import.meta.url));
const sha=b=>createHash('sha256').update(b).digest('hex');
const manifest=JSON.parse(readFileSync(join(root,'dist/build-manifest.json'),'utf8'));
const dir=mkdtempSync(join(tmpdir(),'ub-no-sdk-offline-'));let checks=0;
const pass=()=>checks++;
try {
  for(const name of ['snapshot-cli.cjs','snapshot.cjs']){
    assert.equal(sha(readFileSync(join(root,'dist',name))),manifest.artifacts[name]);
    copyFileSync(join(root,'dist',name),join(dir,name));pass();
  }
  const path=join(dir,'local 中文 snapshot.json'),next=join(dir,'next.json');
  const body='PRIVATE_OFFLINE_BODY\r\n🙂<img src=x onerror=bad()>',provenance='PRIVATE_ORIGIN';
  const data=encoded(envelope([row(1,{content:body,provenance}),row(2,{derivation:{job_id:uuid(90),input_id:uuid(1),input_revision:1,input_hash:sha(body),
    profile_hash:sha('synthetic profile'),quote:body.slice(0,20),start:0,end:20,offset_unit:'UTF-16 code units'}}),row(3,{status:'archived'})]));
  writeFileSync(path,data,{mode:0o600});writeFileSync(next,encoded(envelope([row(1,{content:'CHANGED',revision:2}),row(4)])),{mode:0o600});
  const before=[path,next].map(p=>[sha(readFileSync(p)),statSync(p).mtimeMs]);
  const request=(operation,more={})=>({operation,consent:true,files:operation==='compare'?[{path},{path:next}]:[{path}],...more});
  const script=`const fs=require('node:fs'),api=require(process.argv[1]);
    const input=JSON.parse(fs.readFileSync(0,'utf8'));
    (async()=>{let r;if(process.argv[2]==='bytes'){const {files,...q}=input;
      r=await api.inspectClientSnapshotBytes(q,files.map(f=>({data:fs.readFileSync(f.path),expected_sha256:f.expected_sha256})));}
    else r=await api.inspectClientSnapshots(input);
    process.stdout.write(JSON.stringify(r)+'\\n');})().catch(e=>{process.stdout.write(JSON.stringify({error:e.code})+'\\n');process.exitCode=1;});`;
  function run(input,{mode='cli',status=0}={}){
    const args=['--require',guard,...(mode==='cli'?[join(dir,'snapshot-cli.cjs')]:['-e',script,join(dir,'snapshot.cjs'),mode])];
    const r=spawnSync(process.execPath,args,{cwd:dir,input:JSON.stringify(input),encoding:'utf8',timeout:10000,
      // No provider/token/profile variables, NODE_OPTIONS or NODE_PATH inherited.
      env:Object.fromEntries(['PATH','SystemRoot','SYSTEMROOT','TEMP','TMP','HOME'].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]))});
    assert.ifError(r.error);assert.equal(r.signal,null);assert.equal(r.status,status,r.stderr);assert.equal(r.stderr,'');
    assert.ok(!r.stdout.includes(dir)&&!r.stdout.includes('OFFLINE_FORBIDDEN_OPERATION'));
    return {report:JSON.parse(r.stdout),text:r.stdout};
  }
  for(const mode of ['cli','library','bytes'])for(const operation of ['inspect','compare','page','record','audit','trace']){
    const input=request(operation,['audit','trace'].includes(operation)?{memory_id:uuid(2)}:operation==='record'?{memory_id:uuid(1)}:operation==='page'?{options:{query:'PRIVATE_OFFLINE'}}:{});
    const {report,text}=run(input,{mode});assert.equal(report.operation,operation);assert.equal(report.identity_verified,false);
    assert.ok(!text.includes(body)&&!text.includes(provenance)&&!text.includes('PRIVATE_OFFLINE'));
    if(operation==='audit'){assert.equal(report.result.entries[0].state,'matched');assert.equal(report.result.text_included,false);}
    if(operation==='trace'){assert.equal(report.result.termination,'unlinked');assert.equal(report.result.followed_hops,1);}
    assert.equal(report.local_only,true);assert.equal(report.memory_writes_requested,false);pass();
  }
  for(const mode of ['cli','library','bytes']){
    const {report}=run(request('audit'),{mode});assert.equal(report.result.audited_count,3);
    assert.equal(report.result.counts.matched,1);assert.equal(report.result.graph_verified,false);pass();
  }
  for(const mode of ['cli','library','bytes']){
    const {report}=run(request('record',{memory_id:uuid(1),include_text:true,files:[{path,expected_sha256:sha(data)}]}),{mode});
    assert.equal(report.result.text.content,body);assert.equal(report.result.text.provenance,provenance);
    assert.equal(report.files[0].expected_hash_verified,true);pass();
  }
  for(const mode of ['cli','library','bytes']){
    assert.equal(run(request('inspect',{consent:false}),{mode,status:1}).report.error,'snapshot_consent_required');pass();
    assert.equal(run(request('inspect',{files:[{path,expected_sha256:'0'.repeat(64)}]}),{mode,status:1}).report.error,'snapshot_hash_mismatch');pass();
  }
  const bad=join(dir,'malformed.json');writeFileSync(bad,'{"PRIVATE_FRAGMENT":',{mode:0o600});
  const r=run(request('inspect',{files:[{path:bad}]}),{status:1});assert.ok(!r.text.includes('PRIVATE_FRAGMENT'));pass();
  assert.deepEqual([path,next].map(p=>[sha(readFileSync(p)),statSync(p).mtimeMs]),before);pass();
  const report={passed:true,checks,fixtures:'synthetic exported snapshots (no database)',
    execution:'actual built Node CLI/library copied without SDK',guard:'descriptor/file-handle and sticky denial exit',
    input_bytes_and_mtime_unchanged:true,model_calls:0,package_manifest:manifest,windows_verified:process.platform==='win32'};
  console.log(JSON.stringify(report,null,2));
}finally{rmSync(dir,{recursive:true,force:true});}
