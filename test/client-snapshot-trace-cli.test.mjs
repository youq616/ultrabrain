/** Actual source CLI subprocesses with the existing negative-capability guard. */
import test from 'node:test';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,statSync,rmSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';import {fileURLToPath} from 'node:url';
import {chain,reference,uuid,hash,envelope,encoded} from './helpers/snapshot-trace-fixture.mjs';
const cli=fileURLToPath(new URL('../packages/ultrabrain-client/src/snapshot-cli.mjs',import.meta.url));
const guard=fileURLToPath(new URL('./fixtures/snapshot-offline-guard.cjs',import.meta.url));
function run(t,extra={},rows=chain(),raw) {
  const dir=mkdtempSync(join(tmpdir(),'ub-trace-cli-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'selected 中文.json'),data=encoded(envelope(rows));writeFileSync(path,data);const before=statSync(path).mtimeMs;
  const input={operation:'trace',consent:true,memory_id:uuid(4),files:[{path,expected_sha256:hash(data)}],...extra};
  const child=spawnSync(process.execPath,['--require',guard,cli],{cwd:dir,input:raw??JSON.stringify(input),encoding:'utf8',timeout:10000,
    env:Object.fromEntries(['PATH','SystemRoot','SYSTEMROOT','TEMP','TMP','HOME'].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]))});
  assert.ifError(child.error);assert.equal(child.signal,null);assert.equal(child.stderr,'');
  for(const text of [dir,'TRACE_PRIVATE','OFFLINE_FORBIDDEN_OPERATION'])assert.ok(!child.stdout.includes(text));
  assert.deepEqual(readFileSync(path),Buffer.from(data));assert.equal(statSync(path).mtimeMs,before);
  return {status:child.status,report:JSON.parse(child.stdout)};
}
test('trace CLI: multi-hop trace runs without SDK/network/child-process/file-write capabilities',t=>{
  const {status,report}=run(t);assert.equal(status,0);assert.equal(report.result.termination,'unlinked');
  assert.equal(report.result.followed_hops,3);assert.equal(report.files[0].expected_hash_verified,true);
});
test('trace CLI: explicit depth boundary yields a complete report, not a success certificate',t=>{
  const {status,report}=run(t,{max_hops:1});assert.equal(status,0);assert.equal(report.result.termination,'depth_limit');
  assert.equal(report.result.reached_unlinked_record,false);assert.equal(report.result.historical_chain_verified,false);
});
test('trace CLI: cyclic references are a reported finding without looping or text leakage',t=>{
  const rows=chain();rows[0].derivation=reference(rows[2]);const {status,report}=run(t,{},rows);
  assert.equal(status,0);assert.equal(report.result.termination,'cycle');assert.equal(report.result.cycle.entry_index,1);
});
for(const [name,extra,code] of [
  ['consent',{consent:false},'snapshot_consent_required'],['missing ID',{memory_id:undefined},'invalid_params'],
  ['unknown ID',{memory_id:uuid(999)},'snapshot_record_missing'],['text disclosure',{include_text:true},'invalid_params'],
  ['hop overflow',{max_hops:129},'invalid_params'],['coercible hops',{max_hops:'32'},'invalid_params'],
  ['wrong fingerprint',{files:[{path:'/missing',expected_sha256:'bad'}]},'invalid_params'],
])test('trace CLI: rejects '+name,t=>{const r=run(t,extra);assert.equal(r.status,1);assert.equal(r.report.error,code);});
test('trace CLI: unrelated corrupt row blocks all output even with a one-hop budget',t=>{
  const rows=chain();rows[0].content='TRACE_PRIVATE_CORRUPT';const r=run(t,{max_hops:1},rows);
  assert.equal(r.status,1);assert.equal(r.report.error,'memory_snapshot_unconfirmed');
});
test('trace CLI: duplicate hop limit cannot silently widen the request',t=>{
  const r=run(t,{},chain(),'{"operation":"trace","consent":true,"max_hops":1,"max_hops":128}');
  assert.equal(r.status,1);assert.equal(r.report.error,'snapshot_file_duplicate_key');
});
test('trace CLI: help documents bounded metadata-only tracing',()=>{
  const r=spawnSync(process.execPath,[cli,'--help'],{encoding:'utf8',timeout:10000});assert.ifError(r.error);assert.equal(r.status,0);
  assert.ok(r.stdout.includes('trace requires memory_id'));assert.ok(r.stdout.includes('max_hops:1..128 (default 32)'));
});
