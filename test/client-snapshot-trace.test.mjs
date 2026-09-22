/** Whole-file verification and real paths, not substituted hashes or SDK results. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,statSync,rmSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {inspectClientSnapshotBytes,snapshotRequest} from '../src/client-snapshot.mjs';
import {inspectClientSnapshots} from '../src/client-snapshot-files.mjs';
import * as lineage from '../src/snapshot-lineage-audit.mjs';
import {inspectMemorySnapshotFile} from '../src/personal-snapshot-contract.mjs';
import {chain,reference,row,uuid,hash,envelope,encoded} from './helpers/snapshot-trace-fixture.mjs';
const request={operation:'trace',consent:true,memory_id:uuid(4)};
const trace=(rows=chain(),extra={},runtime={})=>inspectClientSnapshotBytes({...request,...extra},[{data:encoded(envelope(rows))}],runtime);
function privateReport(r) {
  const text=JSON.stringify(r);assert.ok(!text.includes('TRACE_PRIVATE'));
  for(const key of ['content','quote','provenance','derivation'])assert.ok(!text.includes('"'+key+'":'),key);
  for(const key of ['identity_verified','truth_verified'])assert.equal(r[key],false);
  assert.equal(r.network_requests,0);assert.equal(r.memory_writes_requested,false);
  assert.equal(r.result.text_included,false);assert.equal(r.result.graph_verified,false);assert.equal(r.result.historical_chain_verified,false);
}
function frozen(v){if(v&&typeof v==='object'){assert.ok(Object.isFrozen(v));for(const x of Object.values(v))frozen(x);}}
test('snapshot trace: complete matching path terminates at an unlinked record with no text',async()=>{
  const r=await trace(),v=r.result;
  assert.equal(r.operation,'trace');assert.equal(v.format,'ultrabrain-snapshot-lineage-trace-v1');
  assert.equal(v.root_id,uuid(4));assert.equal(v.snapshot_record_count,4);assert.equal(v.max_hops,32);
  assert.equal(v.termination,'unlinked');assert.equal(v.reached_unlinked_record,true);assert.equal(v.cycle,null);
  assert.equal(v.followed_hops,3);assert.equal(v.visited_count,4);
  assert.deepEqual(v.steps.map(e=>e.memory.id),[4,3,2,1].map(uuid));
  assert.deepEqual(v.steps.map(e=>e.state),['matched','matched','matched','unlinked']);
  assert.equal(v.source_lookup,'same-verified-file-only');privateReport(r);frozen(r);
});
test('snapshot trace: an isolated unlinked record does not invent an origin or a verified history',async()=>{
  const r=await trace(chain(1),{memory_id:uuid(1)});assert.equal(r.result.followed_hops,0);
  assert.equal(r.result.visited_count,1);assert.equal(r.result.termination,'unlinked');privateReport(r);
});
for(const [name,change,state] of [
  ['revision',rows=>{rows[1].revision++;},'changed'],
  ['hash',rows=>{rows[1].content+=' edited';rows[1].content_hash=hash(rows[1].content);},'changed'],
  ['archival',rows=>{rows[1].status='archived';},'archived'],
  ['quote position',rows=>{rows[2].derivation.start=0;rows[2].derivation.end=13;},'quote_mismatch'],
  ['current flag',rows=>{rows[2].derivation_current=false;},'inconsistent'],
  ['invalid reference',rows=>{rows[2].derivation.input_id='https://TRACE_PRIVATE.invalid';},'invalid_reference'],
  ['document origin',rows=>{rows[2].origin_kind='document_fragment';},'unsupported_origin'],
])test('snapshot trace: stops instead of stitching incompatible history at '+name,async()=>{
  const rows=chain();change(rows);const r=await trace(rows),v=r.result;
  assert.equal(v.termination,state);assert.equal(v.followed_hops,1);assert.equal(v.visited_count,2);
  assert.equal(v.reached_unlinked_record,false);assert.equal(v.cycle,null);
  const direct=await inspectClientSnapshotBytes({operation:'audit',consent:true,memory_id:uuid(3)},[{data:encoded(envelope(rows))}]);
  assert.deepEqual(v.steps.at(-1),direct.result.entries[0]);privateReport(r);
});
test('snapshot trace: missing same-file source stops without guessing deletion or doing a lookup',async()=>{
  const rows=chain().slice(1);const r=await trace(rows);assert.equal(r.result.termination,'source_missing');
  assert.equal(r.result.visited_count,3);assert.equal(r.result.steps.at(-1).source,null);privateReport(r);
});
test('snapshot trace: matching source with document origin is followed once then marked unsupported',async()=>{
  const rows=chain();rows[2].origin_kind='document_fragment';rows[2].derivation=null;
  const r=await trace(rows);assert.equal(r.result.steps[0].state,'matched');assert.equal(r.result.termination,'unsupported_origin');
  assert.equal(r.result.followed_hops,1);privateReport(r);
});
for(const size of [2,3,4])test('snapshot trace: detects a verified closing edge in a '+size+'-record cycle',async()=>{
  const rows=chain(size);rows[0].derivation=reference(rows.at(-1));
  const r=await trace(rows,{memory_id:uuid(size)}),v=r.result;
  assert.equal(v.termination,'cycle');assert.equal(v.followed_hops,size-1);assert.equal(v.visited_count,size);
  assert.deepEqual(v.cycle,{entry_id:uuid(size),entry_index:0,closing_index:size-1});
  assert.ok(v.steps.every(e=>e.state==='matched'));assert.equal(v.reached_unlinked_record,false);privateReport(r);
});
test('snapshot trace: reports the actual cycle entry after a noncyclic prefix',async()=>{
  const rows=chain();rows[0].derivation=reference(rows[2]);const r=await trace(rows);
  assert.deepEqual(r.result.cycle,{entry_id:uuid(3),entry_index:1,closing_index:3});assert.equal(r.result.visited_count,4);
});
test('snapshot trace: a mismatching closing edge is a canonical mismatch, not a certified cycle',async()=>{
  const rows=chain(2);rows[0].derivation={...reference(rows[1]),input_revision:2};
  const r=await trace(rows,{memory_id:uuid(2)});assert.equal(r.result.termination,'changed');assert.equal(r.result.cycle,null);
});
test('snapshot trace: self-reference remains invalid under the existing contract',async()=>{
  const rows=chain();rows[3].derivation=reference(rows[3]);const r=await trace(rows);
  assert.equal(r.result.termination,'invalid_reference');assert.equal(r.result.cycle,null);assert.equal(r.result.followed_hops,0);
});
test('snapshot trace: hop limit stops before looking up or disclosing the next source',async()=>{
  const r=await trace(chain(),{max_hops:1}),v=r.result,last=v.steps.at(-1);
  assert.equal(v.termination,'depth_limit');assert.equal(v.max_hops,1);assert.equal(v.followed_hops,1);assert.equal(v.visited_count,2);
  assert.equal(last.memory.id,uuid(3));assert.equal(last.reference.input_id,uuid(2));
  assert.equal(last.source,null);assert.equal(last.comparison,null);assert.equal(last.same_project,null);
  assert.equal(v.reached_unlinked_record,false);privateReport(r);
});
test('snapshot trace: natural termination exactly on the hop boundary is not truncation',async()=>{
  const r=await trace(chain(),{max_hops:3});assert.equal(r.result.termination,'unlinked');assert.equal(r.result.followed_hops,3);
});
test('snapshot trace: no unexamined cycle claim beyond the hop budget',async()=>{
  const rows=chain(2);rows[0].derivation=reference(rows[1]);
  const r=await trace(rows,{memory_id:uuid(2),max_hops:1});assert.equal(r.result.termination,'depth_limit');assert.equal(r.result.cycle,null);
});
test('snapshot trace: missing source at the budget boundary is not looked up',async()=>{
  const rows=chain();rows[2].derivation.input_id=uuid(999);
  const r=await trace(rows,{max_hops:1});assert.equal(r.result.termination,'depth_limit');assert.equal(r.result.steps.at(-1).source,null);
});
test('snapshot trace: 1000-record input stays bounded to 128 followed hops and 129 steps',async()=>{
  const r=await trace(chain(1000),{memory_id:uuid(1000),max_hops:128});assert.equal(r.result.termination,'depth_limit');
  assert.equal(r.result.visited_count,129);assert.equal(r.result.followed_hops,128);
  assert.equal(r.result.steps.at(-1).memory.id,uuid(872));assert.ok(Buffer.byteLength(JSON.stringify(r))<262144);privateReport(r);
});
test('snapshot trace: default budget is enforced, not just reported',async()=>{
  const r=await trace(chain(40),{memory_id:uuid(40)});assert.equal(r.result.termination,'depth_limit');assert.equal(r.result.followed_hops,32);
});
test('snapshot trace: corrupt unrelated record blocks the selected path',async()=>{
  const rows=chain();rows.push(row(20));rows[4].content='TRACE_PRIVATE_CORRUPTION';
  await assert.rejects(trace(rows),{code:'memory_snapshot_unconfirmed'});
});
test('snapshot trace: requested absent root is not an empty successful trace',async()=>{
  await assert.rejects(trace(chain(),{memory_id:uuid(999)}),{code:'snapshot_record_missing'});
});
test('snapshot trace: incomplete exports cannot be traced',async()=>{
  await assert.rejects(inspectClientSnapshotBytes(request,[{data:encoded(envelope(chain(),{complete:false}))}]),{code:'memory_snapshot_unconfirmed'});
});
for(const extra of [{consent:false},{consent:'true'},{memory_id:undefined},{memory_id:null},{memory_id:'bad'},
  {memory_id:[uuid(4)]},{include_text:true},{include_text:false},{options:{}},{query:'TRACE_PRIVATE'},
  {operation:['trace']},{source_id:'foreign'},{max_hops:0},{max_hops:-1},{max_hops:129},{max_hops:1.5},
  {max_hops:'32'},{max_hops:null},{max_hops:true},{max_hops:NaN},{max_hops:Infinity}])
  test('snapshot trace: rejects ambiguous authority or bounds '+JSON.stringify(extra),()=>{
    assert.throws(()=>snapshotRequest({...request,...extra}));
  });
test('snapshot trace: copied request and bytes cannot redirect or widen disclosure during await',async()=>{
  const q={...request,max_hops:1},data=encoded(envelope(chain()));const p=inspectClientSnapshotBytes(q,[{data}]);
  q.max_hops=128;q.memory_id=uuid(1);q.include_text=true;data.fill(32);
  const r=await p;assert.equal(r.result.root_id,uuid(4));assert.equal(r.result.max_hops,1);assert.equal(r.result.termination,'depth_limit');privateReport(r);
});
test('snapshot trace: real selected file, fingerprint, metadata privacy and unchanged bytes/mtime',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'ub-trace-file-'));t.after(()=>rmSync(dir,{force:true,recursive:true}));
  const path=join(dir,'中文 snapshot.json'),data=encoded(envelope(chain()));writeFileSync(path,data);const before=statSync(path).mtimeMs;
  const r=await inspectClientSnapshots({...request,files:[{path,expected_sha256:hash(data)}]});
  assert.equal(r.result.termination,'unlinked');assert.equal(r.files[0].expected_hash_verified,true);assert.ok(!JSON.stringify(r).includes(dir));
  assert.equal(statSync(path).mtimeMs,before);assert.deepEqual(readFileSync(path),Buffer.from(data));privateReport(r);
});
test('snapshot trace: second file and invalid bounds fail before selected-file IO',async()=>{
  await assert.rejects(inspectClientSnapshots({...request,files:[{path:'/missing-a'},{path:'/missing-b'}]}),{code:'invalid_params'});
  await assert.rejects(inspectClientSnapshots({...request,max_hops:0,files:[{path:'/missing'}]}),{code:'invalid_params'});
});
test('snapshot trace: project comparison is descriptive, not online workspace authority',async()=>{
  const rows=chain();rows[2].project_id='other';const r=await trace(rows);
  assert.equal(r.result.termination,'unlinked');assert.equal(r.result.steps[0].same_project,false);assert.equal(r.result.steps[1].same_project,false);privateReport(r);
});
test('snapshot trace: forged handles cannot start traversal',async()=>{
  assert.equal(typeof lineage.traceMemorySnapshot,'function');
  const file=await inspectMemorySnapshotFile(encoded(envelope(chain())),hash);
  for(const fake of [null,{snapshot:file.snapshot},structuredClone(file)])
    await assert.rejects(lineage.traceMemorySnapshot(fake,uuid(4),32),{code:'snapshot_not_inspected'});
});
for(const mode of ['abort','revoke'])test('snapshot trace: real event-loop '+mode+' during traversal withholds partial results',async()=>{
  assert.equal(typeof lineage.traceMemorySnapshot,'function');
  const file=await inspectMemorySnapshotFile(encoded(envelope(chain(80))),hash);let revoked=false,checks=0;
  const code=mode==='abort'?'aborted':'client_authorization_revoked';
  const p=lineage.traceMemorySnapshot(file,uuid(80),128,()=>{checks++;if(revoked)throw Object.assign(Error('TRACE_PRIVATE'),{code});});
  setImmediate(()=>{revoked=true;});await assert.rejects(p,{code});assert.ok(checks>16);
});
test('snapshot trace: internal adapter also rejects unbounded traversal',async()=>{
  assert.equal(typeof lineage.traceMemorySnapshot,'function');
  const file=await inspectMemorySnapshotFile(encoded(envelope(chain())),hash);
  for(const n of [0,129,NaN,'32',null])await assert.rejects(lineage.traceMemorySnapshot(file,uuid(4),n),{code:'invalid_params'});
});
test('snapshot trace: unexpected authorization errors never echo callback data',async()=>{
  await assert.rejects(trace(chain(),{}, {authorize:()=>{throw Error('TRACE_PRIVATE');}}),e=>!e.message.includes('TRACE_PRIVATE'));
});
test('snapshot trace: 32 combinations preserve canonical comparison precedence',async()=>{
  for(let i=0;i<32;i++){
    const rows=chain(2),[s,m]=rows;
    if(i&1)s.revision++;
    if(i&2){s.content+=' edited';s.content_hash=hash(s.content);}
    if(i&4)s.status='archived';
    if(i&8){m.derivation.start=0;m.derivation.end=m.derivation.quote.length;}
    if(i&16)m.derivation_current=false;
    const r=await trace(rows,{memory_id:uuid(2)});
    const expected=i&4?'archived':i&3?'changed':i&8?'quote_mismatch':i&16?'inconsistent':'unlinked';
    assert.equal(r.result.termination,expected);assert.equal(r.result.steps[0].comparison.revision_matches,!(i&1));
    assert.equal(r.result.steps[0].comparison.content_matches,!(i&2));assert.equal(r.result.steps[0].comparison.quote_matches,!(i&8));
  }
});

test('snapshot trace: workflow preserves installed audit then appends trace before isolated cleanup',()=>{
  const flow=readFileSync(new URL('../.github/workflows/task-context.yml',import.meta.url),'utf8');
  const previous=flow.indexOf('run: bun test/client-snapshot-audit-integration.mjs');
  const traceStep=flow.indexOf('run: bun test/client-snapshot-trace-integration.mjs');
  const upload=flow.indexOf('name: snapshot-trace-${{ github.sha }}');
  assert.ok(previous>=0&&traceStep>previous&&upload>traceStep);
  assert.ok(flow.indexOf('name: Stop only isolated database')>upload);
  const integration=readFileSync(new URL('./client-snapshot-trace-integration.mjs',import.meta.url),'utf8');
  for(const text of ['synthetic_relation_updates','external_model_calls:0','actual_model_job_history_verified:false',
    'assert.deepEqual(await fingerprint(),before)','snapshot-cli.cjs','snapshot.cjs'])assert.ok(integration.includes(text));
});
