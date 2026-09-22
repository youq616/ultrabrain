/** Whole-file verification and real graph traversal; no SDK or result doubles. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectClientSnapshotBytes,snapshotRequest} from '../src/client-snapshot.mjs';
import {inspectClientSnapshots} from '../src/client-snapshot-files.mjs';
import {graph,row,reference,uuid,hash,envelope,encoded} from './helpers/snapshot-impact-fixture.mjs';
const request={operation:'impact',consent:true,memory_id:uuid(1)};
const impact=(rows=graph([null,1,2,1]),extra={},runtime={})=>inspectClientSnapshotBytes(
  {...request,...extra},[{data:encoded(envelope(rows))}],runtime);
function privateReport(report) {
  const text=JSON.stringify(report);
  for(const value of ['PRIVATE_IMPACT','PRIVATE_UNCHECKED','PRIVATE_QUERY']) assert.ok(!text.includes(value),value);
  for(const field of ['content','quote','provenance','derivation']) assert.ok(!text.includes('"'+field+'":'),field);
  assert.equal(report.truth_verified,false);assert.equal(report.identity_verified,false);
  assert.equal(report.network_requests,0);assert.equal(report.memory_writes_requested,false);
  assert.equal(report.result.text_included,false);assert.equal(report.result.all_impacts_known,false);
  assert.equal(report.result.graph_verified,false);assert.equal(report.result.traversal_complete,true);
}
function frozen(value) {
  if(value&&typeof value==='object'){assert.equal(Object.isFrozen(value),true);Object.values(value).forEach(frozen);}
}
test('snapshot impact: direct and indirect dependencies have deterministic distance/ID order',async()=>{
  const r=await impact(),v=r.result;assert.equal(r.operation,'impact');
  assert.equal(v.format,'ultrabrain-snapshot-impact-v1');assert.equal(v.root.id,uuid(1));assert.equal(v.root_audit_state,'unlinked');
  assert.deepEqual(v.counts,{direct:2,indirect:1,total:3});
  assert.deepEqual(v.entries.map(e=>[e.memory.id,e.distance,e.parent_id]),[[uuid(2),1,uuid(1)],[uuid(4),1,uuid(1)],[uuid(3),2,uuid(2)]]);
  assert.equal(v.max_distance,2);assert.equal(v.root_in_cycle,false);assert.equal(v.reference_state_counts.matched,3);
  assert.deepEqual(v.status_counts,{candidate:0,active:3,archived:0});
  assert.equal(v.coverage.scanned_records,4);assert.equal(v.coverage.valid_references,3);
  assert.equal(v.coverage.invalid_references,0);assert.equal(v.coverage.unsupported_origins,0);assert.equal(v.coverage.missing_sources,0);
  assert.equal(v.source_lookup,'same-verified-file-only');privateReport(r);frozen(r);
});
test('snapshot impact: selecting an interior node excludes ancestors and siblings',async()=>{
  const r=await impact(graph([null,1,2,1]),{memory_id:uuid(2)});
  assert.deepEqual(r.result.entries.map(e=>e.memory.id),[uuid(3)]);assert.equal(r.result.root_audit_state,'matched');privateReport(r);
});
test('snapshot impact: leaf is a completed empty known traversal, never an all-clear',async()=>{
  const r=await impact(graph([null,1]),{memory_id:uuid(2)});
  assert.deepEqual(r.result.counts,{direct:0,indirect:0,total:0});assert.deepEqual(r.result.entries,[]);
  assert.equal(r.result.max_distance,0);privateReport(r);
});
for(const status of ['candidate','active','archived'])test('snapshot impact: dependent lifecycle never removes declared edges '+status,async()=>{
  const rows=graph([null,1,2]);rows[1].status=status;
  const r=await impact(rows);assert.equal(r.result.counts.total,2);assert.equal(r.result.entries[0].memory.status,status);
  assert.equal(r.result.entries[1].direct_source_state,status==='archived'?'archived':'matched');privateReport(r);
});
for(const [name,change,state] of [
  ['revision',rows=>{rows[0].revision++;},'changed'],
  ['content',rows=>{rows[0].content+=' changed';rows[0].content_hash=hash(rows[0].content);},'changed'],
  ['archive',rows=>{rows[0].status='archived';},'archived'],
  ['quote',rows=>{rows[1].derivation.quote='X'.repeat(rows[1].derivation.quote.length);},'quote_mismatch'],
  ['validity',rows=>{rows[1].derivation_current=false;},'inconsistent'],
])test('snapshot impact: stale edges stay traversable and findings propagate '+name,async()=>{
  const rows=graph([null,1,2]);change(rows);const r=await impact(rows),[direct,indirect]=r.result.entries;
  assert.equal(direct.direct_source_state,state);assert.equal(indirect.direct_source_state,'matched');
  assert.equal(direct.path_has_reference_findings,true);assert.equal(indirect.path_has_reference_findings,true);
  assert.equal(r.result.paths_with_reference_findings,2);assert.equal(direct.comparison.state,state);privateReport(r);
});
test('snapshot impact: project changes accumulate along the path even when final project equals root',async()=>{
  const rows=graph([null,1,2,1],{1:{project_id:'one'},2:{project_id:'two'},3:{project_id:'one'},4:{project_id:'one'}});
  const r=await impact(rows);assert.deepEqual(r.result.entries.map(e=>e.path_crosses_projects),[true,false,true]);
  assert.equal(r.result.cross_project_paths,2);assert.equal(r.result.entries[2].same_project,false);privateReport(r);
});
test('snapshot impact: invalid and unsupported references are counted but never guessed or followed',async()=>{
  const rows=graph([null,1,2,1,1]);rows[1].derivation.extra='PRIVATE_UNCHECKED';
  rows[3].origin_kind='document_fragment';rows[4].derivation.input_id=uuid(99);
  const r=await impact(rows);assert.deepEqual(r.result.entries,[]);
  assert.equal(r.result.coverage.invalid_references,1);assert.equal(r.result.coverage.unsupported_origins,1);
  assert.equal(r.result.coverage.missing_sources,1);assert.equal(r.result.coverage.unknown_dependencies_present,true);
  assert.equal(r.result.coverage.valid_references,2);privateReport(r);
});
test('snapshot impact: absent sources outside the traversal are visible as coverage gaps',async()=>{
  const rows=graph([null,1,null]);rows[2].derivation=reference(row(99));
  const r=await impact(rows);assert.equal(r.result.counts.total,1);assert.equal(r.result.coverage.missing_sources,1);
  assert.equal(r.result.coverage.unknown_dependencies_present,true);privateReport(r);
});
test('snapshot impact: unsupported root can still be a declared source, without certifying its own origin',async()=>{
  const rows=graph([null,1]);rows[0].origin_kind='document_fragment';
  const r=await impact(rows);assert.equal(r.result.root_audit_state,'unsupported_origin');assert.equal(r.result.counts.total,1);privateReport(r);
});
for(const [name,parents,total,cycle] of [
  ['two-node cycle',[2,1],1,true],['cycle with branch',[2,1,2,3],3,true],
  ['unrelated cycle',[null,1,4,3],1,false],['downstream of cycle',[2,1,2,3],1,false],
])test('snapshot impact: '+name+' terminates without duplicating root or certifying topology',async()=>{
  const id=name==='downstream of cycle'?uuid(3):uuid(1);const r=await impact(graph(parents),{memory_id:id});
  assert.equal(r.result.root_in_cycle,cycle);assert.equal(r.result.counts.total,total);
  assert.ok(!r.result.entries.some(e=>e.memory.id===id));assert.equal(new Set(r.result.entries.map(e=>e.memory.id)).size,total);privateReport(r);
});
test('snapshot impact: malformed self-reference is a coverage gap, not a graph edge',async()=>{
  const rows=graph([null,1]);rows[0].derivation=reference(rows[0]);
  const r=await impact(rows);assert.equal(r.result.coverage.invalid_references,1);assert.equal(r.result.root_in_cycle,false);
  assert.equal(r.result.root_audit_state,'invalid_reference');assert.equal(r.result.counts.total,1);privateReport(r);
});
for(const parents of [Array.from({length:1000},(_,i)=>i===0?null:i),Array.from({length:1000},(_,i)=>i===0?null:1)])
  test('snapshot impact: complete 1000-record '+(parents[2]===2?'chain':'fan-out')+' is bounded, iterative and untruncated',async()=>{
    const rows=graph(parents),r=await impact(rows),v=r.result;
    assert.equal(v.entries.length,999);assert.equal(v.coverage.scanned_records,1000);
    assert.equal(v.max_distance,parents[2]===2?999:1);assert.equal(v.counts.direct,parents[2]===2?1:999);
    assert.equal(v.entries.at(-1).memory.id,uuid(1000));assert.equal(new Set(v.entries.map(e=>e.memory.id)).size,999);privateReport(r);
  });
test('snapshot impact: 1000-node cycle terminates and preserves complete known descendants',async()=>{
  const rows=graph(Array.from({length:1000},(_,i)=>i===0?1000:i));const r=await impact(rows);
  assert.equal(r.result.root_in_cycle,true);assert.equal(r.result.counts.total,999);assert.equal(r.result.max_distance,999);privateReport(r);
});
test('snapshot impact: 96 deterministic graphs agree with an independent reverse-reachability oracle',async()=>{
  let seed=781237;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
  for(let sample=0;sample<96;sample++){
    const parents=Array.from({length:17},(_,i)=>{const p=random()%18;return p===0||p===i+1?null:p;});
    const rows=graph(parents),root=1+random()%17;
    const distances=new Map([[root,0]]);let changed=true;
    // Independent fixed-point oracle (not the production adjacency/BFS code).
    while(changed){changed=false;parents.forEach((p,i)=>{if(p!==null&&distances.has(p)&&!distances.has(i+1)){distances.set(i+1,distances.get(p)+1);changed=true;}});}
    const expected=[...distances].filter(([id])=>id!==root).sort((a,b)=>a[1]-b[1]||a[0]-b[0]);
    const r=await impact(rows,{memory_id:uuid(root)});
    assert.deepEqual(r.result.entries.map(e=>[e.memory.id,e.distance]),expected.map(([id,d])=>[uuid(id),d]));
    assert.equal(r.result.root_in_cycle,parents[root-1]!==null&&distances.has(parents[root-1]));
    assert.equal(r.result.counts.total,expected.length);privateReport(r);
  }
});
for(const [name,extra] of [
  ['missing ID',{memory_id:undefined}],['null ID',{memory_id:null}],['bad ID',{memory_id:'PRIVATE_UNCHECKED'}],
  ['uppercase ID',{memory_id:'A1111111-1111-4111-8111-111111111111'}],['array ID',{memory_id:[uuid(1)]}],
  ['text true',{include_text:true}],['text false',{include_text:false}],['options',{options:{}}],
  ['depth truncation',{max_depth:1}],['project override',{project_id:'other'}],['remote source',{url:'https://PRIVATE_UNCHECKED.invalid'}],
  ['coercible operation',{operation:['impact']}],
])test('snapshot impact: strict selection rejects '+name,async()=>{
  await assert.rejects(impact(undefined,extra),{code:'invalid_params'});
});
for(const consent of [undefined,false,1,'true',null])test('snapshot impact: explicit consent required '+String(consent),async()=>{
  await assert.rejects(impact(undefined,{consent}),{code:'snapshot_consent_required'});
});
test('snapshot impact: unknown root and empty snapshot refuse instead of returning safe-to-change',async()=>{
  await assert.rejects(impact(undefined,{memory_id:uuid(99)}),{code:'snapshot_record_missing'});
  await assert.rejects(impact([]),{code:'snapshot_record_missing'});
});
test('snapshot impact: selected root does not bypass corrupt or partial unrelated data',async()=>{
  const rows=graph([null,1,null]);rows[2].content='PRIVATE_UNCHECKED';
  await assert.rejects(impact(rows),{code:'memory_snapshot_unconfirmed'});
  await assert.rejects(inspectClientSnapshotBytes(request,[{data:encoded(envelope(graph([null]),{complete:false}))}]),{code:'memory_snapshot_unconfirmed'});
});
test('snapshot impact: selection and bytes are captured before the first asynchronous wait',async()=>{
  const input={...request},data=encoded(envelope(graph([null,1,2]))),work=inspectClientSnapshotBytes(input,[{data}]);
  input.memory_id=uuid(3);input.include_text=true;data.fill(0);
  const r=await work;assert.equal(r.result.root.id,uuid(1));assert.equal(r.result.counts.total,2);privateReport(r);
});
test('snapshot impact: invalid request and second file are rejected before actual file IO',async()=>{
  await assert.rejects(inspectClientSnapshots({...request,include_text:true,files:[{path:'/missing'}]}),{code:'invalid_params'});
  await assert.rejects(inspectClientSnapshots({...request,files:[{path:'/missing'},{path:'/missing-again'}]}),{code:'invalid_params'});
});
for(const [authorize,code] of [[()=>false,'client_authorization_revoked'],[async()=>true,'invalid_params'],
  [async()=>{throw Error('PRIVATE_UNCHECKED');},'invalid_params']])
  test('snapshot impact: denied or asynchronous authority never delivers',async()=>{
    await assert.rejects(impact(undefined,{}, {authorize}),{code});
  });
test('snapshot impact: real event-loop abort prevents report delivery',async()=>{
  const controller=new AbortController();const work=impact(undefined,{}, {signal:controller.signal});
  setImmediate(()=>controller.abort());await assert.rejects(work,{code:'aborted'});
});
test('snapshot impact: verified reports and caller data remain separate and immutable',async()=>{
  const rows=graph([null,1,2]),before=structuredClone(rows);const r=await impact(rows);
  assert.deepEqual(rows,before);frozen(r);assert.throws(()=>{r.result.entries[0].distance=0;},TypeError);
});

test('snapshot impact: earlier project crossing survives later same-project edges',async()=>{
  const rows=graph([null,1,2,3],{1:{project_id:'one'},2:{project_id:'two'},3:{project_id:'one'},4:{project_id:'one'}});
  const r=await impact(rows);assert.deepEqual(r.result.entries.map(e=>e.same_project),[false,false,true]);
  assert.deepEqual(r.result.entries.map(e=>e.path_crosses_projects),[true,true,true]);
  assert.equal(r.result.cross_project_paths,3);privateReport(r);
});
test('snapshot impact: root own upstream finding is separate from its descendant paths',async()=>{
  const rows=graph([null,1,2,3]);rows[0].revision++;
  const r=await impact(rows,{memory_id:uuid(2)});assert.equal(r.result.root_audit_state,'changed');
  assert.equal(r.result.paths_with_reference_findings,0);
  assert.ok(r.result.entries.every(e=>e.path_has_reference_findings===false));
  assert.equal(r.result.cross_project_paths,0);privateReport(r);
});
