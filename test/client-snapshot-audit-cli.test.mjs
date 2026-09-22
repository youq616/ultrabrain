/** Actual Node CLI, guarded against SDK/network/write/subprocess capabilities. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,statSync,rmSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';import {fileURLToPath} from 'node:url';
import {linkedRows,uuid,hash,envelope,encoded} from './helpers/snapshot-lineage-audit-fixture.mjs';
const cli=fileURLToPath(new URL('../packages/ultrabrain-client/src/snapshot-cli.mjs',import.meta.url));
const guard=fileURLToPath(new URL('./fixtures/snapshot-offline-guard.cjs',import.meta.url));
function run(t,extra={},rows=linkedRows(),raw){
  const dir=mkdtempSync(join(tmpdir(),'ub-audit-cli-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'selected 中文.json'),data=encoded(envelope(rows));writeFileSync(path,data);const before=statSync(path).mtimeMs;
  const request={operation:'audit',consent:true,files:[{path,expected_sha256:hash(data)}],...extra};
  const r=spawnSync(process.execPath,['--require',guard,cli],{cwd:dir,input:raw??JSON.stringify(request),encoding:'utf8',timeout:10000,
    env:Object.fromEntries(['PATH','SystemRoot','SYSTEMROOT','TEMP','TMP','HOME'].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]))});
  assert.ifError(r.error);assert.equal(r.signal,null);assert.equal(r.stderr,'');
  assert.ok(!r.stdout.includes(dir));assert.ok(!r.stdout.includes('PRIVATE_'));assert.ok(!r.stdout.includes('OFFLINE_FORBIDDEN_OPERATION'));
  assert.deepEqual(readFileSync(path),Buffer.from(data));assert.equal(statSync(path).mtimeMs,before);
  return {...r,data:JSON.parse(r.stdout)};
}
test('audit CLI: complete audit and one-record selection work under the offline guard',t=>{
  const full=run(t);assert.equal(full.status,0);assert.equal(full.data.result.audited_count,2);assert.equal(full.data.result.counts.matched,1);
  const one=run(t,{memory_id:uuid(2)});assert.equal(one.status,0);assert.equal(one.data.result.audited_count,1);
  assert.equal(one.data.result.entries[0].state,'matched');assert.equal(one.data.files[0].expected_hash_verified,true);
});
for(const [name,extra,error] of [
  ['consent',{consent:false},'snapshot_consent_required'],['absent ID',{memory_id:uuid(77)},'snapshot_record_missing'],
  ['null ID',{memory_id:null},'invalid_params'],['body disclosure',{include_text:true},'invalid_params'],
  ['filter injection',{options:{query:'PRIVATE_QUERY'}},'invalid_params'],
])test('audit CLI: rejects '+name,t=>{const r=run(t,extra);assert.equal(r.status,1);assert.equal(r.data.error,error);});
test('audit CLI: corrupt unselected content blocks exact-ID auditing',t=>{
  const rows=linkedRows();rows[0].content='PRIVATE_CHANGED';const r=run(t,{memory_id:uuid(2)},rows);
  assert.equal(r.status,1);assert.equal(r.data.error,'memory_snapshot_unconfirmed');
});
test('audit CLI: malformed references are findings, not a failed parse or truth approval',t=>{
  const r=run(t,{},linkedRows({}, {},{input_id:'PRIVATE_INVALID'}));assert.equal(r.status,0);
  assert.equal(r.data.result.counts.invalid_reference,1);assert.equal(r.data.truth_verified,false);
});
test('audit CLI: duplicate operation cannot silently change authorization',t=>{
  const r=run(t,{},linkedRows(),'{"operation":"audit","operation":"record","consent":true}');
  assert.equal(r.status,1);assert.equal(r.data.error,'snapshot_file_duplicate_key');
});
