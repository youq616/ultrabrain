/** Whole-file, exact-text duplicate review. Synthetic exports, not live data. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectClientSnapshotBytes,snapshotRequest} from '../src/client-snapshot.mjs';
import {row,uuid,hash,envelope,encoded} from './helpers/snapshot-audit-fixture.mjs';
const request=()=>({operation:'duplicates',consent:true});
const audit=(rows,options={})=>inspectClientSnapshotBytes(request(),[{data:encoded(envelope(rows))}],options);
const summaries=report=>report.result.groups.map(g=>g.members.map(m=>m.id));

test('duplicates: exact request schema is frozen',()=>{
 assert.deepEqual(snapshotRequest(request()),request());assert.ok(Object.isFrozen(snapshotRequest(request())));
});
for(const extra of [{include_text:false},{memory_id:uuid(1)},{options:{}},{limit:1},{normalize:true},{retry:true},{scope:'active'}])
 test('duplicates: unsupported selector rejected '+Object.keys(extra)[0],async()=>{
  await assert.rejects(inspectClientSnapshotBytes({...request(),...extra},[]),{code:'invalid_params'});
 });
test('duplicates: consent required before bytes are inspected',async()=>{
 await assert.rejects(inspectClientSnapshotBytes({...request(),consent:false},[]),{code:'snapshot_consent_required'});
});
for(const rows of [[],[row(1)],[row(1),row(2)]])test('duplicates: fully checked no-match snapshot of '+rows.length,async()=>{
 const report=await audit(rows),result=report.result;
 assert.deepEqual(result.counts,{groups:0,records_in_groups:0,records_outside_groups:rows.length,additional_occurrences:0});
 assert.equal(result.scanned_records,rows.length);assert.equal(result.scan_complete,true);assert.deepEqual(result.groups,[]);
 assert.equal(result.merge_safe,false);assert.equal(report.operation,'duplicates');
});
test('duplicates: two interleaved groups ordered by first ID and member ID',async()=>{
 const report=await audit([row(1,{content:'A'}),row(2,{content:'B'}),row(3,{content:'B'}),row(4,{content:'A'}),row(5,{content:'unique'})]);
 assert.deepEqual(summaries(report),[[uuid(1),uuid(4)],[uuid(2),uuid(3)]]);
 assert.deepEqual(report.result.counts,{groups:2,records_in_groups:4,records_outside_groups:1,additional_occurrences:2});
 assert.equal(report.result.groups[0].content_sha256,hash('A'));
});
for(const [a,b] of [['A','a'],['x',' x'],['x','x '],['x\r\n','x\n'],['café','cafe\u0301'],['可以共享','不可以共享'],['🙂','🙃'],['x','x\0']])
 test('duplicates: never normalizes or erases text distinctions '+JSON.stringify([a,b]),async()=>{
  const report=await audit([row(1,{content:a}),row(2,{content:b})]);assert.equal(report.result.counts.groups,0);
 });
test('duplicates: UTF-8 byte count, frozen metadata only and explicit non-authority',async()=>{
 const content='PRIVATE_DUPLICATE 正文🙂\r\n',provenance='PRIVATE_ORIGIN',derivation={quote:'PRIVATE_QUOTE'};
 const report=await audit([row(1,{content,provenance,derivation}),row(2,{content,provenance,derivation})]);
 const group=report.result.groups[0],text=JSON.stringify(report);
 assert.equal(group.content_bytes,Buffer.byteLength(content));assert.equal(group.derivation_present_count,2);
 assert.equal(Object.isFrozen(report.result.groups),true);assert.equal(Object.isFrozen(group.members[0]),true);
 for(const secret of [content,provenance,'PRIVATE_QUOTE'])assert.ok(!text.includes(secret));
 assert.equal(report.result.text_included,false);assert.equal(report.result.references_compared,false);
 assert.equal(report.result.merge_safe,false);assert.equal(report.result.automatic_action,'none');
 assert.equal(report.identity_verified,false);assert.equal(report.truth_verified,false);
 assert.equal(report.memory_writes_requested,false);assert.equal(report.network_requests,0);
 assert.throws(()=>{group.members[0].status='active';},TypeError);
});
test('duplicates: projects, origins, types, statuses and visibility do not hide same-text peers',async()=>{
 const content='PRIVATE_DUPLICATE';
 const report=await audit([row(1,{content}),row(2,{content,project_id:'elsewhere',type:'goal',origin_kind:'document_fragment',status:'archived',visibility:'source',derivation_current:false})]);
 assert.equal(report.result.groups.length,1);assert.deepEqual(report.result.groups[0].status_counts,{candidate:1,active:0,archived:1});
 for(const key of ['project_id','type','origin_kind','status','visibility','derivation_current'])assert.ok(report.result.groups[0].differing_fields.includes(key));
 assert.deepEqual(report.result.groups[0].members.map(r=>r.project_id),[null,'elsewhere']);
});
test('duplicates: selected metadata differences are named, not disclosed as full records',async()=>{
 const content='same',report=await audit([row(1,{content}),row(2,{content,importance:'high',confidence:0,agent_id:'different',revision:2,
  provenance:'PRIVATE_ORIGIN',updated_at:'2026-09-22T00:00:00.000Z',last_confirmed:'2026-09-22T00:00:00.000Z'})]);
 const group=report.result.groups[0];
 assert.deepEqual(group.differing_fields,['importance','confidence','agent_id','revision','updated_at','last_confirmed','provenance']);
 assert.ok(!JSON.stringify(report).includes('PRIVATE_ORIGIN'));assert.equal(group.members[1].revision,2);
});
test('duplicates: canonical contract may contain empty text, reported without inventing meaning',async()=>{
 const r=await audit([row(1,{content:''}),row(2,{content:''})]);assert.equal(r.result.groups[0].content_bytes,0);assert.equal(r.result.merge_safe,false);
});
test('duplicates: 1000 identical records are one complete non-quadratic group',async()=>{
 const r=await audit(Array.from({length:1000},(_,i)=>row(i+1,{content:'same'})));
 assert.deepEqual(r.result.counts,{groups:1,records_in_groups:1000,records_outside_groups:0,additional_occurrences:999});
 assert.equal(r.result.groups[0].members.length,1000);assert.equal(r.result.groups[0].members.at(-1).id,uuid(1000));
});
test('duplicates: corruption outside any matching group blocks the entire report',async()=>{
 const rows=[row(1,{content:'same'}),row(2,{content:'same'}),row(3)];rows[2].content='PRIVATE_TAMPER';
 await assert.rejects(inspectClientSnapshotBytes(request(),[{data:encoded(envelope(rows))}]),{code:'memory_snapshot_unconfirmed'});
});
test('duplicates: a fully rehashed file still cannot repeat a record ID',async()=>{
 await assert.rejects(audit([row(1,{content:'same'}),row(1,{content:'same'})]),{code:'memory_snapshot_unconfirmed'});
});
test('duplicates: bytes and operation are captured before the first hash await',async()=>{
 const data=encoded(envelope([row(1,{content:'same'}),row(2,{content:'same'})])),input=request();
 const work=inspectClientSnapshotBytes(input,[{data}]);data.fill(0);input.operation='record';input.include_text=true;
 assert.equal((await work).result.counts.groups,1);
});
test('duplicates: revoked or asynchronous authority cannot deliver a report',async()=>{
 await assert.rejects(audit([],{authorize:()=>false}),{code:'client_authorization_revoked'});
 await assert.rejects(audit([],{authorize:async()=>true}),{code:'invalid_params'});
 const controller=new AbortController();const work=audit([row(1)],{signal:controller.signal});controller.abort();
 await assert.rejects(work,{code:'aborted'});
});
test('duplicates: one and only one selected file is accepted',async()=>{
 for(const selections of [[],[{data:encoded()},{data:encoded()}]])await assert.rejects(inspectClientSnapshotBytes(request(),selections),{code:'invalid_params'});
});
