/** Actual CLI and public file API under the existing offline descriptor guard. */
import test from 'node:test';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';import {mkdtempSync,writeFileSync,readFileSync,statSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {fileURLToPath} from 'node:url';
import {row,uuid,hash,envelope,encoded} from './helpers/snapshot-audit-fixture.mjs';
import {inspectClientSnapshots,snapshotFileRequest} from '../src/client-snapshot-files.mjs';
const cli=fileURLToPath(new URL('../packages/ultrabrain-client/src/snapshot-cli.mjs',import.meta.url));
const guard=fileURLToPath(new URL('./fixtures/snapshot-offline-guard.cjs',import.meta.url));
function setup(t,damaged=false){
 const dir=mkdtempSync(join(tmpdir(),'ub-duplicate-compare-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const a=join(dir,'左 snapshot.json'),b=join(dir,'右 snapshot.json'),rows=[row(1,{content:'PRIVATE_DUP_BODY'}),row(2,{content:'PRIVATE_DUP_BODY'})];
 const left=encoded(envelope(rows));if(damaged)rows[1].content='PRIVATE_CORRUPT';
 const right=encoded(envelope(rows));writeFileSync(a,left);writeFileSync(b,right);
 const before=[a,b].map(p=>[hash(readFileSync(p)),statSync(p).mtimeMs]);
 return {dir,a,b,before,input:{operation:'duplicate-compare',consent:true,files:[{path:a,expected_sha256:hash(left)},{path:b,expected_sha256:hash(right)}]}};
}
function run(t,extra={},damaged=false,raw){
 const f=setup(t,damaged),input={...f.input,...(typeof extra==='function'?extra(f):extra)};
 const child=spawnSync(process.execPath,['--require',guard,cli],{cwd:f.dir,encoding:'utf8',timeout:10000,
 input:raw?raw(input):JSON.stringify(input),env:Object.fromEntries(['PATH','HOME','SystemRoot','SYSTEMROOT','TEMP','TMP'].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]))});
 assert.ifError(child.error);assert.equal(child.signal,null);assert.equal(child.stderr,'');
 for(const v of ['PRIVATE_DUP_BODY','PRIVATE_CORRUPT','Synthetic audit fixture',f.dir,'OFFLINE_FORBIDDEN_OPERATION'])assert.ok(!child.stdout.includes(v));
 assert.deepEqual([f.a,f.b].map(p=>[hash(readFileSync(p)),statSync(p).mtimeMs]),f.before);
 return {code:child.status,r:JSON.parse(child.stdout)};
}
test('duplicate comparison CLI: both complete files, no side effects or metadata leaks',t=>{
 const x=run(t);assert.equal(x.code,0);assert.equal(x.r.result.counts.unchanged,1);assert.equal(x.r.files.length,2);
 assert.ok(x.r.files.every(f=>f.expected_hash_verified));assert.equal(x.r.network_requests,0);
});
for(const [extra,code]of [[{consent:false},'snapshot_consent_required'],[{include_text:true},'invalid_params'],[{memory_id:uuid(1)},'invalid_params'],
 [{files:[]},'invalid_params'],[f=>({files:[{path:f.a}]}),'invalid_params'],[f=>({files:[{path:f.a},{path:f.b,expected_sha256:'0'.repeat(64)}]}),'snapshot_hash_mismatch'],
 [f=>({files:[{path:f.a},{path:'relative.json'}]}),'snapshot_path_invalid']])test('duplicate comparison CLI: refuses '+code+' '+JSON.stringify(extra),t=>{
 const x=run(t,extra);assert.equal(x.code,1);assert.equal(x.r.error,code);assert.equal(x.r.result,undefined);
});
test('duplicate comparison CLI: unrelated integrity failure in second file withholds report',t=>{
 const x=run(t,{},true);assert.equal(x.code,1);assert.equal(x.r.error,'memory_snapshot_unconfirmed');
});
test('duplicate comparison CLI: duplicate escaped consent key refused',t=>{
 const x=run(t,{},false,q=>JSON.stringify(q).replace('"consent":true','"consent":true,"con\\u0073ent":true'));
 assert.equal(x.code,1);assert.equal(x.r.error,'snapshot_file_duplicate_key');
});
test('duplicate comparison file API: same canonical operation and exact bytes bound',async t=>{
 const f=setup(t);assert.equal(snapshotFileRequest(f.input).files.length,2);const r=await inspectClientSnapshots(f.input);
 assert.equal(r.result.groups[0].kind,'unchanged');assert.deepEqual([f.a,f.b].map(p=>[hash(readFileSync(p)),statSync(p).mtimeMs]),f.before);
});
test('duplicate comparison CLI: help explains two files and does not imply chronology',()=>{
 const x=spawnSync(process.execPath,[cli,'--help'],{encoding:'utf8',timeout:10000});assert.ifError(x.error);assert.equal(x.status,0);
 assert.match(x.stdout,/compare and duplicate-compare require two files/);assert.match(x.stdout,/no chronology or deletion inference/);
});
