/** Complete exported byte pairs; synthetic data, no database or remote IO. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectClientSnapshotBytes,snapshotRequest} from '../src/client-snapshot.mjs';
import {row,uuid,hash,envelope,encoded} from './helpers/snapshot-audit-fixture.mjs';
const request=()=>({operation:'duplicate-compare',consent:true});
const compare=(left,right,authority={},lmeta={},rmeta={})=>inspectClientSnapshotBytes(request(),
 [{data:encoded(envelope(left,lmeta))},{data:encoded(envelope(right,rmeta))}],authority);
const same=(id,content='PRIVATE_DUPLICATE',extra={})=>row(id,{content,...extra});
const kinds=r=>r.result.groups.map(g=>g.kind);

test('duplicate comparison: new selector is exact and frozen',()=>{
 const r=snapshotRequest(request());assert.equal(r.operation,'duplicate-compare');assert.ok(Object.isFrozen(r));
});
for(const more of [{include_text:true},{memory_id:uuid(1)},{options:{}},{limit:1},{normalize:true},{scope:'project'},{retry:true}])
 test('duplicate comparison: forbidden selector '+JSON.stringify(more),()=>{
  assert.throws(()=>snapshotRequest({...request(),...more}),{code:'invalid_params'});
 });
test('duplicate comparison: explicit consent is required',async()=>{
 await assert.rejects(inspectClientSnapshotBytes({...request(),consent:false},[]),{code:'snapshot_consent_required'});
});
for(const n of [0,1,3])test('duplicate comparison: exact two-file selection rejects '+n,async()=>{
 await assert.rejects(inspectClientSnapshotBytes(request(),Array.from({length:n},()=>({data:encoded()}))),{code:'invalid_params'});
});
test('duplicate comparison: empty pair is complete, not a failed read',async()=>{
 const r=await compare([],[]);assert.equal(r.result.comparison_complete,true);assert.deepEqual(r.result.groups,[]);
 assert.deepEqual(r.result.counts,{groups:0,left_only:0,right_only:0,changed:0,unchanged:0});
 assert.deepEqual(r.result.left,{scanned_records:0,duplicate_groups:0,records_in_groups:0,additional_occurrences:0});
});
test('duplicate comparison: different unique contents on both sides are not duplicate changes',async()=>{
 const r=await compare([row(1),row(2)],[row(3),row(4)]);assert.equal(r.result.counts.groups,0);
 assert.equal(r.result.left.scanned_records,2);assert.equal(r.result.right.scanned_records,2);
});
test('duplicate comparison: a singleton on the opposite side remains visible',async()=>{
 const r=await compare([same(1),same(2)],[same(1)]),g=r.result.groups[0];
 assert.equal(g.kind,'left_only');assert.equal(g.left.duplicate,true);assert.equal(g.right.duplicate,false);
 assert.equal(g.right.member_count,1);assert.deepEqual(g.membership,{left_only:[uuid(2)],right_only:[],shared:[uuid(1)]});
 assert.equal(g.left.additional_occurrences,1);assert.equal(g.right.additional_occurrences,0);
});
test('duplicate comparison: absent versus singleton are distinguishable without deletion inference',async()=>{
 const r=await compare([same(1),same(2)],[]);assert.equal(r.result.groups[0].right.member_count,0);
 assert.deepEqual(kinds(r),['left_only']);assert.equal(r.result.automatic_action,'none');assert.equal(r.result.merge_safe,false);
});
test('duplicate comparison: right-side duplicates report all projects/states including fragments',async()=>{
 const r=await compare([same(1)],[same(1),same(2,'PRIVATE_DUPLICATE',{project_id:'p',origin_kind:'document_fragment',status:'archived',visibility:'source'})]);
 const g=r.result.groups[0];assert.equal(g.kind,'right_only');assert.equal(g.right.member_count,2);
 assert.deepEqual(g.right.status_counts,{candidate:1,active:0,archived:1});assert.equal(g.right.members[1].project_id,'p');
});
test('duplicate comparison: both sides duplicate with membership changes',async()=>{
 const g=(await compare([same(1),same(2)],[same(2),same(3)])).result.groups[0];
 assert.equal(g.kind,'changed');assert.deepEqual(g.membership,{left_only:[uuid(1)],right_only:[uuid(3)],shared:[uuid(2)]});
 assert.deepEqual(g.shared_record_changes,[]);
});
test('duplicate comparison: unchanged is structural comparison, not truth or merge authority',async()=>{
 const rows=[same(1),same(2)];const r=await compare(rows,rows);assert.deepEqual(kinds(r),['unchanged']);
 for(const k of ['identity_verified','truth_verified','merge_safe','references_verified','text_included'])assert.equal(r.result[k],false);
 assert.equal(r.identity_verified,false);assert.equal(r.network_requests,0);assert.equal(r.memory_writes_requested,false);
});
for(const [field,value]of [['type','goal'],['project_id','other'],['visibility','source'],['status','active'],['revision',2],['provenance','PRIVATE_PROVENANCE'],['derivation',{quote:'PRIVATE_QUOTE',note:'untrusted'}],['derivation_current',false]])
 test('duplicate comparison: metadata or reference difference named, never text: '+field,async()=>{
  const g=(await compare([same(1),same(2)],[same(1),same(2,'PRIVATE_DUPLICATE',{[field]:value})])).result.groups[0];
  assert.equal(g.kind,'changed');assert.deepEqual(g.shared_record_changes,[{id:uuid(2),fields:[field]}]);
  const text=JSON.stringify(g);for(const secret of ['PRIVATE_DUPLICATE','PRIVATE_PROVENANCE','PRIVATE_QUOTE'])assert.ok(!text.includes(secret));
 });
test('duplicate comparison: reference object key order is ignored but arrays retain order',async()=>{
 const left=[same(1,'A',{derivation:{a:1,b:[1,2]}}),same(2,'A')];
 const sameOrder=[same(1,'A',{derivation:{b:[1,2],a:1}}),same(2,'A')];
 assert.deepEqual(kinds(await compare(left,sameOrder)),['unchanged']);
 sameOrder[0].derivation.b.reverse();assert.deepEqual(kinds(await compare(left,sameOrder)),['changed']);
});
test('duplicate comparison: content changes can split one ID across unrelated groups',async()=>{
 const r=await compare([same(1,'A'),same(2,'A'),same(3,'B')],[same(1,'B'),same(2,'A'),same(3,'B')]);
 assert.deepEqual(kinds(r),['left_only','right_only']);assert.equal(r.result.groups[0].right.member_count,1);
 assert.equal(r.result.groups[1].left.member_count,1);assert.equal(r.result.counts.groups,2);
});
for(const [a,b]of [['A','a'],['A','A '],['A\n','A\r\n'],['é','e\u0301']])test('duplicate comparison: never normalizes '+JSON.stringify([a,b]),async()=>{
 const r=await compare([same(1,a),same(2,a)],[same(1,b),same(2,b)]);
 assert.deepEqual(kinds(r),['left_only','right_only']);assert.equal(r.result.groups[0].right.member_count,0);
});
test('duplicate comparison: reversed/equal timestamps do not define chronology',async()=>{
 const left=[same(1),same(2)];const r=await compare(left,[],{}, {snapshot_at:'2026-09-24T00:00:00.000Z'},{snapshot_at:'2026-09-20T00:00:00.000Z'});
 assert.deepEqual(kinds(r),['left_only']);assert.ok(r.limitations.includes('no-chronology-inference'));
});
test('duplicate comparison: different source labels reject the whole pair',async()=>{
 await assert.rejects(compare([],[],{},{},{source_id:'other'}),{code:'snapshot_source_mismatch'});
});
for(const side of [0,1])test('duplicate comparison: unrelated corrupted record blocks all output on side '+side,async()=>{
 const rows=[same(1),same(2),row(3)];rows[2].content+='tampered';
 const pair=[{data:encoded(envelope([same(1),same(2)]))},{data:encoded(envelope([same(1),same(2)]))}];pair[side]={data:encoded(envelope(rows))};
 await assert.rejects(inspectClientSnapshotBytes(request(),pair),{code:'memory_snapshot_unconfirmed'});
});
test('duplicate comparison: both bytes and disclosure request snapshot before awaits',async()=>{
 const input=request(),a=encoded(envelope([same(1),same(2)])),b=encoded(envelope([same(1)]));
 const work=inspectClientSnapshotBytes(input,[{data:a},{data:b}]);a.fill(0);b.fill(0);input.operation='record';input.include_text=true;
 assert.deepEqual(kinds(await work),['left_only']);
});
test('duplicate comparison: expected fingerprints bind each side independently',async()=>{
 const a=encoded(envelope([])),b=encoded(envelope([row(1)]));
 const r=await inspectClientSnapshotBytes(request(),[{data:a,expected_sha256:hash(a)},{data:b,expected_sha256:hash(b)}]);
 assert.ok(r.files.every(f=>f.expected_hash_verified));
 await assert.rejects(inspectClientSnapshotBytes(request(),[{data:a,expected_sha256:hash(b)},{data:b}]),{code:'snapshot_hash_mismatch'});
});
test('duplicate comparison: revocation and async approval fail closed without partial data',async()=>{
 await assert.rejects(compare([],[],{authorize:()=>false}),{code:'client_authorization_revoked'});
 await assert.rejects(compare([],[],{authorize:async()=>true}),{code:'invalid_params'});
 const controller=new AbortController();const work=compare([same(1),same(2)],[],{signal:controller.signal});controller.abort();await assert.rejects(work,{code:'aborted'});
});
test('duplicate comparison: large common group retains every member and partitions exactly',async()=>{
 const rows=Array.from({length:1000},(_,i)=>same(i+1)),r=await compare(rows,rows),g=r.result.groups[0];
 assert.equal(g.kind,'unchanged');assert.equal(g.left.member_count,1000);assert.equal(g.right.member_count,1000);
 assert.equal(g.membership.shared.length,1000);assert.equal(r.result.left.additional_occurrences,999);
 assert.ok(Object.isFrozen(r)&&Object.isFrozen(g.right.members)&&Object.isFrozen(g.membership.shared));
});
