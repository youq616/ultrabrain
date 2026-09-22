/** Forward trace and reverse impact coexist over one canonical snapshot contract. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {inspectClientSnapshotBytes,snapshotRequest} from '../src/client-snapshot.mjs';
import {graph,uuid,hash,envelope,encoded} from './helpers/snapshot-impact-fixture.mjs';
const call=(rows,operation,id,extra={},authority={})=>inspectClientSnapshotBytes(
  {operation,consent:true,memory_id:uuid(id),...extra},[{data:encoded(envelope(rows))}],authority);
for(const state of ['matched','changed','archived','quote_mismatch','inconsistent'])
 test('navigation integration: forward stopping and reverse retention differ for '+state,async()=>{
  const rows=graph([null,1,2]);
  if(state==='changed'){rows[0].content+=' edited';rows[0].content_hash=hash(rows[0].content);rows[0].revision++;}
  if(state==='archived')rows[0].status='archived';
  if(state==='quote_mismatch'){rows[1].derivation.start=1;rows[1].derivation.end++;}
  if(state==='inconsistent')rows[1].derivation_current=false;
  const [forward,reverse]=await Promise.all([call(rows,'trace',3),call(rows,'impact',1)]);
  assert.equal(forward.result.termination,state==='matched'?'unlinked':state);
  assert.equal(forward.result.followed_hops,state==='matched'?2:1);
  assert.deepEqual(reverse.result.entries.map(e=>[e.memory.id,e.distance]),[[uuid(2),1],[uuid(3),2]]);
  assert.equal(reverse.result.entries[0].direct_source_state,state);
  assert.equal(reverse.result.entries[1].direct_source_state,'matched');
  assert.ok(reverse.result.entries.every(e=>e.path_has_reference_findings===(state!=='matched')));
  assert.equal(reverse.result.all_impacts_known,false);assert.equal(forward.result.historical_chain_verified,false);
  for(const result of [forward,reverse]){
    assert.equal(result.network_requests,0);assert.equal(result.memory_writes_requested,false);
    for(const secret of ['PRIVATE_IMPACT','quote','provenance'])assert.ok(!JSON.stringify(result).includes('"'+secret+'":'));
  }
 });
test('navigation integration: hop budget never silently limits impact, and trace never accepts impact options',async()=>{
 const rows=graph([null,1,2,3]);
 assert.equal((await call(rows,'trace',4,{max_hops:1})).result.termination,'depth_limit');
 assert.equal((await call(rows,'impact',1)).result.counts.total,3);
 for(const operation of ['trace','impact'])for(const extra of [{max_depth:1},{include_text:false},{direction:'reverse'}])
  await assert.rejects(call(rows,operation,1,extra),{code:'invalid_params'});
 await assert.rejects(call(rows,'impact',1,{max_hops:1}),{code:'invalid_params'});
});
test('navigation integration: cycle result conventions remain separate and deterministic',async()=>{
 const rows=graph([2,1,2,3]);
 const forward=await call(rows,'trace',4),reverse=await call(rows,'impact',1);
 assert.equal(forward.result.termination,'cycle');
 assert.deepEqual(forward.result.steps.map(e=>e.memory.id),[4,3,2,1].map(uuid));
 assert.deepEqual(reverse.result.entries.map(e=>e.memory.id),[2,3,4].map(uuid));
 assert.equal(reverse.result.root_in_cycle,true);assert.equal(reverse.result.counts.total,3);
 const fromBranch=await call(rows,'impact',3);assert.equal(fromBranch.result.root_in_cycle,false);
 assert.deepEqual(fromBranch.result.entries.map(e=>e.memory.id),[uuid(4)]);
});
test('navigation integration: missing upstream stops trace but does not erase known downstream edges',async()=>{
 const rows=graph([null,1,2]);rows[0].derivation={...rows[1].derivation,input_id:uuid(99)};
 const forward=await call(rows,'trace',3),reverse=await call(rows,'impact',1);
 assert.equal(forward.result.termination,'source_missing');assert.equal(reverse.result.counts.total,2);
 assert.equal(reverse.result.root_audit_state,'source_missing');assert.equal(reverse.result.coverage.missing_sources,1);
 assert.ok(reverse.result.entries.every(e=>!e.path_has_reference_findings));
});
test('navigation integration: removing a parent declaration disconnects both traversals without guessed edges',async()=>{
 const rows=graph([null,1,2,3]);rows[1].derivation=null;
 const forward=await call(rows,'trace',4),reverse=await call(rows,'impact',1);
 assert.equal(forward.result.termination,'unlinked');assert.equal(forward.result.followed_hops,2);
 assert.equal(reverse.result.counts.total,0);assert.equal((await call(rows,'impact',2)).result.counts.total,2);
});
test('navigation integration: operation and disclosure choices are copied before asynchronous work',async()=>{
 const rows=graph([null,1,2]),input={operation:'impact',consent:true,memory_id:uuid(1)};
 const work=inspectClientSnapshotBytes(input,[{data:encoded(envelope(rows))}]);
 input.operation='record';input.include_text=true;input.memory_id=uuid(3);
 const report=await work;assert.equal(report.operation,'impact');assert.equal(report.result.counts.total,2);
 assert.equal(report.result.text,undefined);assert.ok(Object.isFrozen(report.result.entries));
});
test('navigation integration: cancelling one operation cannot authorize or abort another',async()=>{
 const rows=graph([null,1,2]),controller=new AbortController();
 const stopped=call(rows,'impact',1,{}, {signal:controller.signal});const ongoing=call(rows,'trace',3);
 controller.abort();await assert.rejects(stopped,{code:'aborted'});
 assert.equal((await ongoing).result.termination,'unlinked');
});
for(const operation of ['trace','impact'])test('navigation integration: whole-file corruption is rejected even outside selected component '+operation,async()=>{
 const rows=graph([null,1,null]);rows[2].content='unverified changed body';
 await assert.rejects(call(rows,operation,1),{code:'memory_snapshot_unconfirmed'});
});
test('navigation integration: public request schemas cannot inherit the other operation budget',()=>{
 assert.equal(snapshotRequest({operation:'trace',consent:true,memory_id:uuid(1)}).max_hops,32);
 assert.equal(snapshotRequest({operation:'impact',consent:true,memory_id:uuid(1)}).max_hops,undefined);
 for(const operation of ['trace','impact'])assert.throws(()=>snapshotRequest({operation,consent:true}),{code:'invalid_params'});
});

test('navigation integration: portability retains every remote baseline suite in order',()=>{
 const text=readFileSync(new URL('../.github/workflows/client-portability.yml',import.meta.url),'utf8');
 const command=text.split('\n').find(line=>line.includes('node --test '));
 const actual=command.split('node --test ')[1].trim().split(/\s+/);
 const baseline=["test/client-snapshot-trace.test.mjs", "test/client-snapshot-trace-cli.test.mjs", "test/client-snapshot-audit.test.mjs", "test/client-snapshot-audit-cli.test.mjs", "test/snapshot-offline-guard.test.mjs", "test/client-snapshot.test.mjs", "test/client-snapshot-files.test.mjs", "test/client-snapshot-races.test.mjs", "test/client-snapshot-cli.test.mjs", "test/client-snapshot-package.test.mjs", "test/client-lineage.test.mjs", "test/client-lineage-runtime.test.mjs", "test/client-lineage-cli.test.mjs", "test/personal-lineage.test.mjs", "test/personal-lineage-ui.test.mjs", "test/personal-snapshot-explorer.test.mjs", "test/personal-snapshot-explorer-ui.test.mjs", "test/personal-snapshot-inspector.test.mjs", "test/personal-snapshot-inspector-ui.test.mjs", "test/personal-snapshot.test.mjs", "test/personal-snapshot-browser.test.mjs", "test/personal-job-recovery-barrier.test.mjs", "test/personal-job-recovery.test.mjs", "test/personal-document-module.test.mjs", "test/personal-document-read.test.mjs", "test/personal-jobs.test.mjs", "test/personal-job-manager.test.mjs", "test/personal-document-receipts.test.mjs", "test/personal-console-receipts.test.mjs", "test/personal-memory-compare.test.mjs", "test/personal-memory-read.test.mjs", "test/personal-memory-lookup.test.mjs", "test/client-authorization.test.mjs", "test/client-profile-authorization.test.mjs", "test/client-request-authorization.test.mjs", "test/client-task-context.test.mjs", "test/client-kit.test.mjs", "test/personal-documents.test.mjs", "test/client-document-boundaries.test.mjs", "test/native-adapters.test.mjs", "test/capture-outbox.test.mjs", "test/automatic-capture.test.mjs", "test/capture-hardening.test.mjs", "test/capture-delivery.test.mjs", "test/capture-profile-binding.test.mjs", "test/client-release-docs.test.mjs"];
 assert.deepEqual(actual.filter(name=>baseline.includes(name)),baseline);
 assert.equal(new Set(actual).size,actual.length);
 for(const name of ['client-snapshot-impact','client-snapshot-impact-cli','client-snapshot-impact-boundaries','client-snapshot-navigation'])
   assert.ok(actual.includes('test/'+name+'.test.mjs'));
 assert.ok(text.includes('ubuntu-24.04')&&text.includes('windows-2025'));
});
