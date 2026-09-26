/** Whole-file verification and exact-text grouping; synthetic snapshots only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectClientSnapshotBytes,snapshotRequest} from '../src/client-snapshot.mjs';
import {inspectMemorySnapshotDuplicates} from '../src/snapshot-duplicates.mjs';
import {inspectMemorySnapshotFile} from '../src/personal-snapshot-contract.mjs';
import {row,uuid,hash,envelope,encoded} from './helpers/snapshot-audit-fixture.mjs';
const request=()=>({operation:'duplicates',consent:true});
const run=(rows,options={})=>inspectClientSnapshotBytes(request(),[{data:encoded(envelope(rows))}],options);
const same=(n,changes={})=>row(n,{content:'PRIVATE_DUPLICATE_TEXT 中文🙂\r\n',...changes});
const groupsOf=result=>result.groups.map(g=>g.members.map(r=>r.id));

test('duplicates: full audit groups only exact content, ordered by smallest member ID',async()=>{
 const rows=[same(1),row(2),same(3,{status:'active'}),row(4,{content:'second'}),row(5,{content:'second'}),row(6)];
 const report=await run(rows),r=report.result;
 assert.equal(r.format,'ultrabrain-snapshot-duplicates-v1');assert.equal(report.operation,'duplicates');
 assert.deepEqual(groupsOf(r),[[uuid(1),uuid(3)],[uuid(4),uuid(5)]]);
 assert.deepEqual(r.counts,{distinct_contents:4,singleton_records:2,duplicate_groups:2,records_in_duplicate_groups:4,repeated_occurrences:2});
 assert.equal(r.record_count,6);assert.equal(r.groups[0].group_id,uuid(1));
 assert.deepEqual(r.groups[0].different_fields,['status']);
 assert.deepEqual(r.groups[0].status_counts,{candidate:1,active:1,archived:0});
 assert.equal(report.network_requests,0);assert.equal(report.memory_writes_requested,false);
 assert.equal(r.automatic_merge_safe,false);assert.equal(r.truth_verified,false);assert.equal(r.text_included,false);
 assert.ok(!JSON.stringify(report).includes('PRIVATE_DUPLICATE_TEXT'));
});
for(const rows of [[],[row(1)],[row(1),row(2),row(3)]])test('duplicates: complete zero finding is not an error '+rows.length,async()=>{
 const r=(await run(rows)).result;assert.deepEqual(r.groups,[]);assert.equal(r.complete,true);
 assert.equal(r.counts.singleton_records,rows.length);assert.equal(r.counts.distinct_contents,rows.length);
 assert.equal(r.counts.repeated_occurrences,0);
});
for(const [name,a,b]of [
 ['spaces','X',' X'],['trailing space','X','X '],['case','Text','text'],['line endings','A\r\nB','A\nB'],
 ['unicode normalization','é','e\u0301'],['emoji modifier','👍','👍🏻'],['BOM content','A','\ufeffA'],
 ['zero width','ab','a\u200bb'],['negation','Do use','Do not use'],['NUL','a','a\u0000']])
 test('duplicates: no normalization or semantic guessing: '+name,async()=>{
  const r=(await run([same(1,{content:a}),same(2,{content:b}),same(3,{content:a})])).result;
  assert.deepEqual(groupsOf(r),[[uuid(1),uuid(3)]]);assert.equal(r.counts.singleton_records,1);
 });
for(const text of ['','__proto__','constructor','toString','同一句话\n🙂'])test('duplicates: exact text is a safe Map key '+JSON.stringify(text),async()=>{
 const r=(await run([same(1,{content:text}),same(2,{content:text})])).result;
 assert.equal(r.groups.length,1);assert.equal(r.groups[0].member_count,2);
});
test('duplicates: all states/projects/origins included, differences prevent equivalence claims',async()=>{
 const rows=[same(1),same(2,{status:'active',project_id:'p',visibility:'source',type:'skill'}),
 same(3,{status:'archived',project_id:'null',origin_kind:'document_fragment',agent_id:'other',derivation_current:false,
 provenance:'PRIVATE_OTHER_PROVENANCE',derivation:{input_id:uuid(9),quote:'PRIVATE_QUOTE'}})];
 const report=await run(rows),r=report.result;
 assert.equal(r.groups[0].cross_project,true);assert.deepEqual(r.groups[0].status_counts,{candidate:1,active:1,archived:1});
 assert.deepEqual(r.groups[0].different_fields,['agent_id','derivation','derivation_current','origin_kind','project_id','provenance','status','type','visibility']);
 for(const secret of ['PRIVATE_DUPLICATE_TEXT','PRIVATE_OTHER_PROVENANCE','PRIVATE_QUOTE'])assert.ok(!JSON.stringify(report).includes(secret));
 assert.equal(r.automatic_merge_safe,false);
});
test('duplicates: metadata object key order ignored but arrays and types stay distinct',async()=>{
 const a={x:[1,2],y:{a:true,b:null}},b={y:{b:null,a:true},x:[1,2]},c={x:[2,1],y:{a:true,b:null}};
 let r=(await run([same(1,{derivation:a}),same(2,{derivation:b})])).result;
 assert.deepEqual(r.groups[0].different_fields,[]);
 r=(await run([same(1,{derivation:a}),same(2,{derivation:c})])).result;
 assert.deepEqual(r.groups[0].different_fields,['derivation']);
 r=(await run([same(1,{derivation:{x:1}}),same(2,{derivation:{x:'1'}})])).result;
 assert.deepEqual(r.groups[0].different_fields,['derivation']);
});
test('duplicates: group members and reports are deeply frozen owned projections',async()=>{
 const rows=[same(1),same(2)],r=(await run(rows)).result;
 for(const value of [r,r.counts,r.groups,r.groups[0],r.groups[0].members,r.groups[0].members[0],r.groups[0].different_fields,r.groups[0].status_counts])assert.ok(Object.isFrozen(value));
 assert.equal(r.groups[0].members[0].content,undefined);assert.equal(r.groups[0].members[0].derivation,undefined);
 rows[0].status='archived';assert.equal(r.groups[0].members[0].status,'candidate');
});
for(const extra of [{memory_id:uuid(1)},{include_text:true},{options:{status:'active'}},{limit:1},{normalize:true},{delete:true},{source_id:'other'}])
 test('duplicates: no selectors, normalization or mutation options '+JSON.stringify(extra),()=>{
  assert.throws(()=>snapshotRequest({...request(),...extra}),{code:'invalid_params'});
 });
test('duplicates: consent required and request is a frozen copy',()=>{
 assert.throws(()=>snapshotRequest({operation:'duplicates',consent:false}),{code:'snapshot_consent_required'});
 const input=request(),r=snapshotRequest(input);input.operation='record';assert.equal(r.operation,'duplicates');assert.ok(Object.isFrozen(r));
});
test('duplicates: corruption anywhere withholds the entire report',async()=>{
 const rows=[same(1),same(2),row(3)];rows[2].content='PRIVATE_CORRUPT';
 await assert.rejects(run(rows),{code:'memory_snapshot_unconfirmed'});
});
test('duplicates: invalid whole-file digest and excess records are rejected',async()=>{
 const data=encoded(envelope([same(1),same(2)],{memories_sha256:'0'.repeat(64)}));
 await assert.rejects(inspectClientSnapshotBytes(request(),[{data}]),{code:'memory_snapshot_unconfirmed'});
 await assert.rejects(run(Array.from({length:1001},(_,i)=>same(i+1))),{code:'memory_snapshot_unconfirmed'});
});
test('duplicates: a forged/cloned inspected handle is rejected before field access',async()=>{
 let accessed=false;const fake={get snapshot(){accessed=true;throw Error('PRIVATE_GETTER');}};
 await assert.rejects(inspectMemorySnapshotDuplicates(fake),{code:'snapshot_not_inspected'});assert.equal(accessed,false);
 const file=await inspectMemorySnapshotFile(encoded(envelope([same(1)])),hash);
 await assert.rejects(inspectMemorySnapshotDuplicates(structuredClone(file)),{code:'snapshot_not_inspected'});
});
test('duplicates: digest collisions alone cannot form a text group (injected internal hash fixture)',async()=>{
 const rows=[same(1,{content:'one'}),same(2,{content:'two'}),same(3,{content:'one'})];
 for(const r of rows)r.content_hash='0'.repeat(64);
 const data=encoded(envelope(rows,{memories_sha256:'0'.repeat(64)}));
 const file=await inspectMemorySnapshotFile(data,()=> '0'.repeat(64));
 assert.deepEqual(groupsOf(await inspectMemorySnapshotDuplicates(file)),[[uuid(1),uuid(3)]]);
});
for(const kind of ['one-large-group','many-groups'])test('duplicates: full 1000-record bound, no silent truncation '+kind,async()=>{
 const rows=Array.from({length:1000},(_,i)=>same(i+1,{content:kind==='one-large-group'?'same':String(i%500)}));
 const r=(await run(rows)).result;assert.equal(r.record_count,1000);assert.equal(r.counts.records_in_duplicate_groups,1000);
 assert.equal(r.groups.length,kind==='one-large-group'?1:500);assert.equal(r.counts.repeated_occurrences,kind==='one-large-group'?999:500);
 assert.deepEqual(r.groups.flatMap(g=>g.members.map(r=>r.id)).sort(),rows.map(r=>r.id));
});
test('duplicates: direct grouping yields to cancellation and withholds partial work',async()=>{
 const file=await inspectMemorySnapshotFile(encoded(envelope(Array.from({length:1000},(_,i)=>same(i+1)))),hash);
 let cancelled=false,turns=0;const timer=setImmediate(()=>{cancelled=true;turns++;});
 try{await assert.rejects(inspectMemorySnapshotDuplicates(file,()=>{if(cancelled)throw Object.assign(Error('cancelled'),{code:'aborted'});}),{code:'aborted'});assert.equal(turns,1);}
 finally{clearImmediate(timer);}
});
test('duplicates: caller byte/request changes cannot affect accepted selection',async()=>{
 const data=encoded(envelope([same(1),same(2)])),q=request();const work=inspectClientSnapshotBytes(q,[{data}]);
 data.fill(0);q.operation='record';q.include_text=true;
 const r=await work;assert.equal(r.operation,'duplicates');assert.equal(r.result.groups.length,1);
});
for(const auth of [()=>false,async()=>true])test('duplicates: revoked or asynchronous authority is refused',async()=>{
 await assert.rejects(run([same(1),same(2)],{authorize:auth}));
});
test('duplicates: pre-abort fails without a report',async()=>{
 const controller=new AbortController();controller.abort();await assert.rejects(run([same(1)],{signal:controller.signal}),{code:'aborted'});
});

// Separate implementer review: public error handling must not evaluate hostile
// exception properties. These probes apply to the shared offline failure path.
for(const kind of ['getter','revoked-proxy'])test('review: exception reflection cannot expose private callback diagnostics '+kind,async()=>{
 let reads=0,error;
 if(kind==='getter')error={get code(){reads++;throw Error('PRIVATE_EXCEPTION_ACCESSOR');}};
 else {const revocable=Proxy.revocable({},{});error=revocable.proxy;revocable.revoke();}
 await assert.rejects(run([same(1),same(2)],{authorize:()=>{throw error;}}),
  e=>e.code==='snapshot_operation_unconfirmed'&&e.message==='Offline snapshot operation was not confirmed');
 assert.equal(reads,0);
});
test('review: cancellation within a large group materialization withholds all groups',async()=>{
 const rows=Array.from({length:1000},(_,i)=>same(i+1));
 const file=await inspectMemorySnapshotFile(encoded(envelope(rows)),hash);
 let visits=0,stop=false;
 const checkpoint=()=>{if(++visits===1050)setImmediate(()=>{stop=true;});if(stop)throw Object.assign(Error('aborted'),{code:'aborted'});};
 await assert.rejects(inspectMemorySnapshotDuplicates(file,checkpoint),{code:'aborted'});
 assert.ok(visits>1050);
});
test('review: different-field projection detects every non-identity metadata difference',async()=>{
 const changes={agent_id:'new',confidence:0.5,created_at:'2026-09-20T00:00:00.000Z',derivation:{x:1},derivation_current:false,
 importance:'high',last_confirmed:'2026-09-21T00:00:00.000Z',origin_kind:'document_fragment',project_id:'p',provenance:'private',
 revision:2,status:'active',type:'goal',updated_at:'2026-09-22T00:00:00.000Z',visibility:'source'};
 const r=(await run([same(1),same(2,changes)])).result;
 assert.deepEqual(r.groups[0].different_fields,Object.keys(changes).sort());
});
test('review: nested prototype-looking derivation keys are data, not inherited properties',async()=>{
 const d=JSON.parse('{"__proto__":{"x":1},"constructor":2}');
 const r=(await run([same(1,{derivation:d}),same(2,{derivation:{constructor:2}})])).result;
 assert.deepEqual(r.groups[0].different_fields,['derivation']);
 assert.equal(Object.prototype.x,undefined);
});
test('review: independent exact-equality oracle on forty deterministic mixed snapshots',async()=>{
 let seed=0x39a1;
 const next=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
 const texts=['a','A','a ','a\n','é','e\u0301','__proto__','同文🙂',''];
 for(let n=0;n<40;n++){
  const rows=Array.from({length:10+next()%90},(_,i)=>same(i+1,{content:texts[next()%texts.length],
   project_id:next()%2?null:'p',status:['candidate','active','archived'][next()%3]}));
  // Deliberately O(n^2) array oracle, independent of production Map grouping.
  const seen=new Set(),expected=[];
  for(const a of rows){if(seen.has(a.id))continue;const group=rows.filter(b=>b.content===a.content);for(const b of group)seen.add(b.id);if(group.length>1)expected.push(group.map(r=>r.id));}
  const r=(await run(rows)).result;assert.deepEqual(groupsOf(r),expected);
  assert.equal(r.counts.singleton_records+r.counts.records_in_duplicate_groups,rows.length);
  assert.equal(r.counts.singleton_records+r.counts.duplicate_groups,r.counts.distinct_contents);
  assert.equal(r.counts.repeated_occurrences,rows.length-r.counts.distinct_contents);
 }
});
