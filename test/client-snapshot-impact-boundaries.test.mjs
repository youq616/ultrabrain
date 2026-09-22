/** Real canonical handles, real filesystem, and systematic checkpoint denials. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,statSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {inspectClientSnapshotBytes} from '../src/client-snapshot.mjs';
import {inspectClientSnapshots} from '../src/client-snapshot-files.mjs';
import {inspectMemorySnapshotImpact} from '../src/snapshot-impact.mjs';
import {inspectMemorySnapshotFile} from '../src/personal-snapshot-contract.mjs';
import {graph,uuid,hash,envelope,encoded} from './helpers/snapshot-impact-fixture.mjs';
const request={operation:'impact',consent:true,memory_id:uuid(1)};
const data=()=>encoded(envelope(graph([2,1,2,3])));
const handle=async rows=>inspectMemorySnapshotFile(encoded(envelope(rows)),async bytes=>hash(bytes));
for(const [name,file] of [['plain object',{}],['forged fields',{snapshot:envelope(graph([null,1]))}]])
  test('snapshot impact boundary: reject '+name+' before reading any fields',async()=>{
    await assert.rejects(inspectMemorySnapshotImpact(file,uuid(1)),{code:'snapshot_not_inspected'});
  });
test('snapshot impact boundary: forged handle getter never executes',async()=>{
  let touched=false;const file={get snapshot(){touched=true;throw Error('PRIVATE_UNCHECKED');}};
  await assert.rejects(inspectMemorySnapshotImpact(file,uuid(1)),{code:'snapshot_not_inspected'});
  assert.equal(touched,false);
});
test('snapshot impact boundary: every synchronous public authorization checkpoint fences delivery',async t=>{
  let calls=0;
  await inspectClientSnapshotBytes(request,[{data:data()}],{authorize:()=>{calls++;}});
  assert.ok(calls>30);
  for(let deniedAt=1;deniedAt<=calls;deniedAt++){
    let seen=0;
    await assert.rejects(inspectClientSnapshotBytes(request,[{data:data()}],{authorize:()=>++seen!==deniedAt}),{code:'client_authorization_revoked'});
    assert.equal(seen,deniedAt);
  }
  t.diagnostic('Denied each of '+calls+' actual authorization checkpoints independently');
});
test('snapshot impact boundary: abort inside every public authorization callback cannot escape',async t=>{
  let calls=0;await inspectClientSnapshotBytes(request,[{data:data()}],{authorize:()=>{calls++;}});
  for(let abortedAt=1;abortedAt<=calls;abortedAt++){
    const controller=new AbortController();let seen=0;
    await assert.rejects(inspectClientSnapshotBytes(request,[{data:data()}],{
      authorize:()=>{if(++seen===abortedAt)controller.abort();},signal:controller.signal}),{code:'aborted'});
    assert.equal(seen,abortedAt);
  }
  t.diagnostic('Aborted each of '+calls+' actual authorization checkpoints independently');
});
for(const topology of ['chain','fan-out'])test('snapshot impact boundary: event-loop revocation during '+topology+' traversal discards all results',async()=>{
  const parents=Array.from({length:1000},(_,i)=>i===0?null:topology==='chain'?i:1);
  const file=await handle(graph(parents));let total=0;
  await inspectMemorySnapshotImpact(file,uuid(1),()=>{total++;});
  // Revoke in the latter half, after full-file audit has had time to complete.
  // This schedules an actual event-loop callback, not a synchronous denial.
  const at=Math.floor(total*0.7);let calls=0,revoked=false,scheduled=false;
  const sentinel=Error('test authorization revoked');
  await assert.rejects(inspectMemorySnapshotImpact(file,uuid(1),()=>{
    if(revoked)throw sentinel;
    if(++calls===at){scheduled=true;setImmediate(()=>{revoked=true;});}
  }),error=>error===sentinel);
  assert.equal(scheduled,true);assert.equal(revoked,true);
});
test('snapshot impact boundary: selected file is read only and its raw-byte fingerprint is honored',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'ub-impact-path-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'选中的 snapshot.json'),bytes=Buffer.concat([Buffer.from('\ufeff'),Buffer.from(data())]);
  writeFileSync(path,bytes);const before=statSync(path).mtimeMs;
  const r=await inspectClientSnapshots({...request,files:[{path,expected_sha256:hash(bytes)}]});
  assert.equal(r.result.root_in_cycle,true);assert.equal(r.result.counts.total,3);assert.equal(r.files[0].expected_hash_verified,true);
  assert.ok(!JSON.stringify(r).includes(dir));assert.deepEqual(readFileSync(path),bytes);assert.equal(statSync(path).mtimeMs,before);
  await assert.rejects(inspectClientSnapshots({...request,files:[{path,expected_sha256:'0'.repeat(64)}]}),{code:'snapshot_hash_mismatch'});
});
test('snapshot impact boundary: errors sanitize arbitrary authority messages and never return partial entries',async()=>{
  let calls=0;
  await assert.rejects(inspectClientSnapshotBytes(request,[{data:data()}],{authorize:()=>{
    if(++calls===40)throw Error('PRIVATE_UNCHECKED_PATH_BODY');
  }}),error=>error.code==='snapshot_operation_unconfirmed'&&!error.message.includes('PRIVATE')&&error.result===undefined);
});
test('snapshot impact boundary: sparse, detached and shared buffers are not authorized data',async()=>{
  await assert.rejects(inspectClientSnapshotBytes(request,new Array(1)),{code:'invalid_params'});
  const detached=data();structuredClone(detached.buffer,{transfer:[detached.buffer]});
  await assert.rejects(inspectClientSnapshotBytes(request,[{data:detached}]),{code:'snapshot_file_size'});
  await assert.rejects(inspectClientSnapshotBytes(request,[{data:new Uint8Array(new SharedArrayBuffer(20))}]),{code:'invalid_params'});
});
