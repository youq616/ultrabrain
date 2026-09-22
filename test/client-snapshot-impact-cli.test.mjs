/** Actual Node executable and public source wrappers under the offline guard.
 * This is source execution; release bundle execution has a separate CI test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,statSync,rmSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';import {fileURLToPath} from 'node:url';
import {graph,uuid,hash,envelope,encoded} from './helpers/snapshot-impact-fixture.mjs';
const cli=fileURLToPath(new URL('../packages/ultrabrain-client/src/snapshot-cli.mjs',import.meta.url));
const api=new URL('../packages/ultrabrain-client/src/snapshot.mjs',import.meta.url).href;
const guard=fileURLToPath(new URL('./fixtures/snapshot-offline-guard.cjs',import.meta.url));
const env=Object.fromEntries(['PATH','SystemRoot','SYSTEMROOT','TEMP','TMP','HOME']
  .filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]]));
function run(t,extra={},rows=graph([null,1,2,1]),mode='cli',raw) {
  const dir=mkdtempSync(join(tmpdir(),'ub-impact-cli-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'selected 中文.json'),data=encoded(envelope(rows));writeFileSync(path,data);const mtime=statSync(path).mtimeMs;
  const request={operation:'impact',consent:true,memory_id:uuid(1),files:[{path,expected_sha256:hash(data)}],...extra};
  const script=`import fs from 'node:fs';import * as api from ${JSON.stringify(api)};
    const input=JSON.parse(fs.readFileSync(0,'utf8'));
    try { const {files,...q}=input; const result=${mode==='bytes'
      ? 'await api.inspectClientSnapshotBytes(q,files.map(f=>({data:fs.readFileSync(f.path),expected_sha256:f.expected_sha256})))'
      : 'await api.inspectClientSnapshots(input)'};
      process.stdout.write(JSON.stringify(result)+'\\n');
    } catch(error){process.stdout.write(JSON.stringify({error:error.code})+'\\n');process.exitCode=1;}`;
  const r=spawnSync(process.execPath,['--require',guard,...(mode==='cli'?[cli]:['--input-type=module','-e',script])],
    {cwd:dir,input:raw??JSON.stringify(request),encoding:'utf8',timeout:10000,maxBuffer:1048576,env});
  assert.ifError(r.error);assert.equal(r.signal,null);assert.equal(r.stderr,'');
  assert.ok(!r.stdout.includes(dir));assert.ok(!r.stdout.includes('PRIVATE_'));assert.ok(!r.stdout.includes('OFFLINE_FORBIDDEN_OPERATION'));
  assert.deepEqual(readFileSync(path),Buffer.from(data));assert.equal(statSync(path).mtimeMs,mtime);
  return {...r,report:JSON.parse(r.stdout)};
}
for(const mode of ['cli','path-api','bytes'])test('impact CLI: complete source '+mode+' under descriptor/network/subprocess guard',t=>{
  const r=run(t,{},undefined,mode);assert.equal(r.status,0);assert.deepEqual(r.report.result.counts,{direct:2,indirect:1,total:3});
  assert.deepEqual(r.report.result.entries.map(e=>e.memory.id),[uuid(2),uuid(4),uuid(3)]);
  assert.equal(r.report.result.all_impacts_known,false);assert.equal(r.report.result.text_included,false);assert.equal(r.report.network_requests,0);
});
for(const [name,extra,code] of [
  ['no consent',{consent:false},'snapshot_consent_required'],['no root',{memory_id:undefined},'invalid_params'],
  ['null root',{memory_id:null},'invalid_params'],['absent root',{memory_id:uuid(99)},'snapshot_record_missing'],
  ['text disclosure',{include_text:true},'invalid_params'],['filter injection',{options:{query:'PRIVATE_QUERY'}},'invalid_params'],
])test('impact CLI: rejects '+name,t=>{const r=run(t,extra);assert.equal(r.status,1);assert.equal(r.report.error,code);});
test('impact CLI: malformed dependency is a visible coverage gap, not a parse failure or all-clear',t=>{
  const rows=graph([null,1,2]);rows[1].derivation.extra='PRIVATE_UNCHECKED';const r=run(t,{},rows);
  assert.equal(r.status,0);assert.equal(r.report.result.coverage.invalid_references,1);
  assert.equal(r.report.result.coverage.unknown_dependencies_present,true);assert.equal(r.report.result.counts.total,0);
});
test('impact CLI: unrelated corrupt row blocks the selected root report',t=>{
  const rows=graph([null,1,null]);rows[2].content='PRIVATE_CHANGED';const r=run(t,{},rows);
  assert.equal(r.status,1);assert.equal(r.report.error,'memory_snapshot_unconfirmed');
});
test('impact CLI: cycle is reported without duplicate root',t=>{
  const r=run(t,{},graph([2,1,2]));assert.equal(r.status,0);assert.equal(r.report.result.root_in_cycle,true);
  assert.deepEqual(r.report.result.entries.map(e=>e.memory.id),[uuid(2),uuid(3)]);
});
test('impact CLI: duplicate root selection cannot switch a consented target',t=>{
  const r=run(t,{},undefined,'cli','{"operation":"impact","consent":true,"memory_id":"a","memory_id":"b"}');
  assert.equal(r.status,1);assert.equal(r.report.error,'snapshot_file_duplicate_key');
});
test('impact CLI: help describes explicit impact operation without loading any profile',()=>{
  const r=spawnSync(process.execPath,['--require',guard,cli,'--help'],{encoding:'utf8',timeout:10000,env});
  assert.ifError(r.error);assert.equal(r.status,0);assert.equal(r.stderr,'');assert.ok(r.stdout.includes('impact requires memory_id'));
});
