/** Adversarial self-review probes; no remote-model or live service claim. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectMemorySnapshotDuplicates} from '../src/snapshot-duplicates.mjs';
import {inspectMemorySnapshotFile} from '../src/personal-snapshot-contract.mjs';
import {inspectClientSnapshotBytes,snapshotFailure} from '../src/client-snapshot.mjs';
import {row,hash,envelope,encoded} from './helpers/snapshot-audit-fixture.mjs';
const request={operation:'duplicates',consent:true};
const checked=rows=>inspectMemorySnapshotFile(encoded(envelope(rows)),hash);

test('duplicates boundary: a forged handle cannot run a snapshot getter',async()=>{
 let reads=0;const fake={get snapshot(){reads++;throw Error('PRIVATE_ACCESS');}};
 await assert.rejects(inspectMemorySnapshotDuplicates(fake),{code:'snapshot_not_inspected'});assert.equal(reads,0);
});
test('duplicates boundary: copying a canonical handle cannot forge its identity',async()=>{
 const file=await checked([]);await assert.rejects(inspectMemorySnapshotDuplicates({...file}),{code:'snapshot_not_inspected'});
});
test('duplicates boundary: same digest is not treated as proof of same content',async()=>{
 // Synthetic digest collision in the injected canonical-handle test seam.
 // Public APIs always compute real SHA-256; no collision attack is claimed.
 const digest='0'.repeat(64),rows=[row(1,{content:'A'}),row(2,{content:'B'}),row(3,{content:'A'})].map(r=>({...r,content_hash:digest}));
 const file=await inspectMemorySnapshotFile(encoded(envelope(rows,{memories_sha256:digest})),()=>digest);
 const result=await inspectMemorySnapshotDuplicates(file);assert.equal(result.groups.length,1);
 assert.deepEqual(result.groups[0].members.map(r=>r.id),[rows[0].id,rows[2].id]);
});
for(const cutoff of [50,150])test('duplicates boundary: revocation during scan or large-group projection at '+cutoff,async()=>{
 const file=await checked(Array.from({length:100},(_,i)=>row(i+1,{content:'same'})));let calls=0;
 await assert.rejects(inspectMemorySnapshotDuplicates(file,()=>{if(++calls===cutoff)throw Error('revoked');}),/revoked/);
 assert.equal(calls,cutoff);
});
test('duplicates boundary: final checkpoint can withhold a fully built report',async()=>{
 const file=await checked([row(1,{content:'same'}),row(2,{content:'same'})]);let count=0;
 await inspectMemorySnapshotDuplicates(file,()=>count++);let calls=0;
 await assert.rejects(inspectMemorySnapshotDuplicates(file,()=>{if(++calls===count)throw Error('revoked');}),/revoked/);
});
test('duplicates boundary: cancellation is serviced during projection of a giant group',async()=>{
 const file=await checked(Array.from({length:1000},(_,i)=>row(i+1,{content:'same'})));
 let calls=0,revoked=false,scheduled=false;
 const work=inspectMemorySnapshotDuplicates(file,()=>{
  if(++calls>1100&&!scheduled){scheduled=true;setImmediate(()=>revoked=true);}
  if(revoked)throw Error('revoked');
 });
 await assert.rejects(work,/revoked/);assert.ok(scheduled);
});
test('self-review: error code accessor is never invoked by snapshot failure projection',()=>{
 let calls=0;const error={get code(){calls++;throw Error('PRIVATE_DIAGNOSTIC');}};
 const result=snapshotFailure(error);assert.equal(result.code,'snapshot_operation_unconfirmed');assert.equal(calls,0);
});
test('self-review: revoked error proxy is safely projected',()=>{
 const {proxy,revoke}=Proxy.revocable({},{});revoke();
 assert.equal(snapshotFailure(proxy).code,'snapshot_operation_unconfirmed');
});
test('self-review: changing error code getter cannot leak an unchecked second value',async()=>{
 let calls=0;const error={get code(){return ++calls===1?'invalid_params':'PRIVATE_DIAGNOSTIC';}};
 await assert.rejects(inspectClientSnapshotBytes(request,[],{authorize:()=>{throw error;}}),
  e=>e.code==='snapshot_operation_unconfirmed'&&!e.message.includes('PRIVATE'));
 assert.equal(calls,0);
});
for(const value of [null,undefined,'PRIVATE',42,Symbol('PRIVATE')])test('failure projection tolerates non-error values '+typeof value,()=>{
 assert.equal(snapshotFailure(value).code,'snapshot_operation_unconfirmed');
});
