/** Actual source CLI under the no-network/no-write descriptor guard. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,statSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {fileURLToPath} from 'node:url';
import {row,uuid,hash,envelope,encoded} from './helpers/snapshot-audit-fixture.mjs';
const cli=fileURLToPath(new URL('../packages/ultrabrain-client/src/snapshot-cli.mjs',import.meta.url));
const guard=fileURLToPath(new URL('./fixtures/snapshot-offline-guard.cjs',import.meta.url));
function run(t,{more={},rows=[row(1,{content:'PRIVATE_DUP_BODY'}),row(2,{content:'PRIVATE_DUP_BODY',status:'archived'})],raw}={}){
 const dir=mkdtempSync(join(tmpdir(),'ub-duplicates-cli-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const path=join(dir,'快照 中文.json'),data=encoded(envelope(rows));writeFileSync(path,data);const mtime=statSync(path).mtimeMs;
 const input={operation:'duplicates',consent:true,files:[{path,expected_sha256:hash(data)}],...(typeof more==='function'?more(path):more)};
 const child=spawnSync(process.execPath,['--require',guard,cli],{cwd:dir,encoding:'utf8',timeout:10000,
  input:typeof raw==='function'?raw(input):raw??JSON.stringify(input),
  env:Object.fromEntries(['PATH','HOME','SystemRoot','SYSTEMROOT','TEMP','TMP'].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]))});
 assert.ifError(child.error);assert.equal(child.signal,null);assert.equal(child.stderr,'');
 for(const secret of ['PRIVATE_DUP_BODY','Synthetic audit fixture',dir,'OFFLINE_FORBIDDEN_OPERATION'])assert.ok(!child.stdout.includes(secret));
 assert.deepEqual(readFileSync(path),Buffer.from(data));assert.equal(statSync(path).mtimeMs,mtime);
 return {status:child.status,result:JSON.parse(child.stdout)};
}
test('duplicates CLI: guarded complete metadata result preserves selected file bytes and mtime',t=>{
 const r=run(t);assert.equal(r.status,0);assert.equal(r.result.files[0].expected_hash_verified,true);
 assert.deepEqual(r.result.result.groups[0].members.map(m=>m.id),[uuid(1),uuid(2)]);
 assert.equal(r.result.result.merge_safe,false);assert.equal(r.result.network_requests,0);
});
for(const [more,code]of [[{consent:false},'snapshot_consent_required'],[{include_text:true},'invalid_params'],
 [{memory_id:uuid(1)},'invalid_params'],[{normalize:true},'invalid_params'],[{limit:1},'invalid_params'],
 [path=>({files:[{path,expected_sha256:'0'.repeat(64)}]}),'snapshot_hash_mismatch']])
 test('duplicates CLI: rejects '+code+' '+typeof more,t=>{
  const r=run(t,{more});assert.equal(r.status,1);assert.equal(r.result.error,code);assert.equal(r.result.result,undefined);
 });
test('duplicates CLI: rehashed unrelated corruption still blocks output',t=>{
 const rows=[row(1,{content:'PRIVATE_DUP_BODY'}),row(2,{content:'PRIVATE_DUP_BODY'}),row(3)];rows[2].content+='corrupt';
 const r=run(t,{rows});assert.equal(r.status,1);assert.equal(r.result.error,'memory_snapshot_unconfirmed');
});
test('duplicates CLI: duplicate request keys fail rather than normalize',t=>{
 const r=run(t,{raw:q=>JSON.stringify(q).replace('"consent":true','"consent":true,"con\\u0073ent":true')});
 assert.equal(r.status,1);assert.equal(r.result.error,'snapshot_file_duplicate_key');
});
test('duplicates CLI: help describes exact text and no automatic merge',()=>{
 const r=spawnSync(process.execPath,[cli,'--help'],{encoding:'utf8',timeout:10000});assert.ifError(r.error);assert.equal(r.status,0);
 assert.match(r.stdout,/duplicates scans one complete file for exact equal content/);assert.match(r.stdout,/no merge or deletion/);
});
