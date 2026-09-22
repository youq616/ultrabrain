/** Real canonical byte verification; no server/SDK/digest doubles. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectClientSnapshotBytes,snapshotRequest} from '../src/client-snapshot.mjs';
import {inspectClientSnapshots} from '../src/client-snapshot-files.mjs';
import {mkdtempSync,writeFileSync,readFileSync,statSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {linkedRows,row,uuid,hash,envelope,encoded} from './helpers/snapshot-lineage-audit-fixture.mjs';
const request={operation:'audit',consent:true};
const audit=(rows=linkedRows(),extra={},runtime={})=>inspectClientSnapshotBytes({...request,...extra},[{data:encoded(envelope(rows))}],runtime);
const states=['unlinked','unsupported_origin','invalid_reference','source_missing','matched','changed','archived','quote_mismatch','inconsistent'];
function privateReport(r){
  const text=JSON.stringify(r);
  for(const s of ['PRIVATE_SOURCE','PRIVATE_QUOTE','PRIVATE_DERIVED_BODY','PRIVATE_PROVENANCE'])assert.ok(!text.includes(s),s);
  for(const k of ['content','quote','provenance','derivation'])assert.ok(!text.includes('"'+k+'":'),k);
  assert.equal(r.identity_verified,false);assert.equal(r.truth_verified,false);assert.equal(r.network_requests,0);
  assert.equal(r.memory_writes_requested,false);assert.equal(r.result.text_included,false);assert.equal(r.result.graph_verified,false);
}
function deepFrozen(v){if(v&&typeof v==='object'){assert.equal(Object.isFrozen(v),true);for(const child of Object.values(v))deepFrozen(child);}}
test('snapshot audit: complete metadata-only report uses canonical direct-source comparison',async()=>{
  const r=await audit();assert.equal(r.operation,'audit');assert.equal(r.result.format,'ultrabrain-snapshot-lineage-audit-v1');
  assert.equal(r.result.selection,'all');assert.equal(r.result.snapshot_record_count,2);assert.equal(r.result.audited_count,2);
  assert.deepEqual(r.result.counts,Object.fromEntries(states.map(s=>[s,['unlinked','matched'].includes(s)?1:0])));
  const e=r.result.entries[1];assert.equal(e.state,'matched');assert.equal(e.memory.id,uuid(2));assert.equal(e.source.id,uuid(1));
  for(const k of ['revision_matches','content_matches','quote_matches'])assert.equal(e.comparison[k],true);
  assert.equal(e.reference.offset_unit,'UTF-16 code units');assert.equal(e.reference.start,linkedRows()[1].derivation.start);
  privateReport(r);deepFrozen(r);
});
for(const [name,change,expected] of [
  ['revision',(s,m)=>{s.revision++;},'changed'],
  ['content',(s,m)=>{s.content+=' edited';s.content_hash=hash(s.content);},'changed'],
  ['archival',(s,m)=>{s.status='archived';},'archived'],
  ['wrong quoted occurrence',(s,m)=>{m.derivation.start=0;m.derivation.end=m.derivation.quote.length;},'quote_mismatch'],
  ['stale derivation flag',(s,m)=>{m.derivation_current=false;},'inconsistent'],
])test('snapshot audit: independent relationship dimension '+name,async()=>{
  const rows=linkedRows();change(...rows);const r=await audit(rows,{memory_id:uuid(2)}),e=r.result.entries[0];
  assert.equal(e.state,expected);assert.equal(e.comparison.state,expected);assert.equal(r.result.audited_count,1);
  assert.equal(r.result.snapshot_record_count,2);assert.equal(r.result.selection,'record');privateReport(r);
});
test('snapshot audit: archived source retains separate revision/hash/quote mismatches',async()=>{
  const rows=linkedRows();rows[0]=row(1,{content:'different',revision:2,status:'archived'});
  const e=(await audit(rows,{memory_id:uuid(2)})).result.entries[0];assert.equal(e.state,'archived');
  for(const k of ['revision_matches','content_matches','quote_matches'])assert.equal(e.comparison[k],false);
});
test('snapshot audit: absent source is not deletion and never triggers external lookup',async()=>{
  const r=await audit([linkedRows()[1]]);assert.equal(r.result.entries[0].state,'source_missing');assert.equal(r.result.entries[0].source,null);
  assert.equal(r.result.entries[0].comparison,null);assert.ok(r.limitations.includes('absence-is-not-deletion'));privateReport(r);
});
for(const derivation of [null,{document_id:uuid(60)}])test('snapshot audit: document lineage is not certified by the consolidation contract '+JSON.stringify(derivation),async()=>{
  const r=await audit([row(1,{origin_kind:'document_fragment',derivation})]);
  assert.equal(r.result.entries[0].state,'unsupported_origin');assert.equal(r.result.entries[0].reference,null);
});
const invalid=[
  ['empty',{}],['unknown field',{extra:'PRIVATE_EXTRA'}],['bad input id',{input_id:'https://PRIVATE_SOURCE.invalid/'}],
  ['self reference',{input_id:uuid(2)}],['job id',{job_id:'bad'}],['input hash',{input_hash:'bad'}],['profile hash',{profile_hash:'bad'}],
  ['zero revision',{input_revision:0}],['overflow revision',{input_revision:2147483648}],['fractional revision',{input_revision:1.5}],
  ['empty quote',{quote:'',start:0,end:0}],['blank quote',{quote:' ',start:0,end:1}],['nul quote',{quote:'\0',start:0,end:1}],
  ['surrogate quote',{quote:'\ud800',start:0,end:1}],['quote bound',{quote:'中'.repeat(683),start:0,end:683}],
  ['negative start',{start:-1,end:12}],['end bound',{start:32768,end:32781}],['length',{end:1}],['unit',{offset_unit:'UTF-8 bytes'}],
];
for(const [name,changes] of invalid)test('snapshot audit: malformed reference reported without following or leaking '+name,async()=>{
  const rows=linkedRows({}, {}, changes);if(name==='empty')rows[1].derivation={};
  const r=await audit(rows,{memory_id:uuid(2)}),e=r.result.entries[0];
  assert.equal(e.state,'invalid_reference');assert.equal(e.reference,null);assert.equal(e.source,null);assert.equal(e.comparison,null);privateReport(r);
});
test('snapshot audit: nonrecursive inspection does not certify a cyclic graph',async()=>{
  const rows=linkedRows();rows[0].derivation={...rows[1].derivation,input_id:uuid(2),input_hash:rows[1].content_hash,
    quote:rows[1].content,start:0,end:rows[1].content.length};
  const r=await audit(rows);assert.equal(r.result.counts.matched,2);assert.equal(r.result.graph_verified,false);
  assert.equal(r.result.source_lookup,'same-verified-file-only');privateReport(r);
});
test('snapshot audit: snapshot-wide project coverage is explicit, not an online workspace grant',async()=>{
  const rows=linkedRows({project_id:'project-a'},{project_id:'project-b'});
  const r=await audit(rows,{memory_id:uuid(2)}),e=r.result.entries[0];assert.equal(e.state,'matched');
  assert.equal(e.memory.project_id,'project-b');assert.equal(e.source.project_id,'project-a');assert.equal(e.same_project,false);
});
test('snapshot audit: empty complete snapshot has no invented matching evidence',async()=>{
  const r=await audit([]);assert.equal(r.result.audited_count,0);assert.deepEqual(r.result.entries,[]);
  assert.ok(Object.values(r.result.counts).every(n=>n===0));privateReport(r);
});
test('snapshot audit: full 1000-record coverage is ordered and never truncated',async()=>{
  const rows=Array.from({length:1000},(_,i)=>row(i+1));const r=await audit(rows);
  assert.equal(r.result.audited_count,1000);assert.equal(r.result.counts.unlinked,1000);
  assert.deepEqual(r.result.entries.map(e=>e.memory.id),rows.map(r=>r.id));
  assert.ok(Buffer.byteLength(JSON.stringify(r))<1048576);deepFrozen(r);
});
test('snapshot audit: selected record still verifies corrupt unselected content',async()=>{
  const rows=linkedRows();rows[0].content='unverified replacement';
  await assert.rejects(audit(rows,{memory_id:uuid(2)}),{code:'memory_snapshot_unconfirmed'});
});
test('snapshot audit: requested absent record refuses instead of becoming a successful empty audit',async()=>{
  await assert.rejects(audit(linkedRows(),{memory_id:uuid(77)}),{code:'snapshot_record_missing'});
});
for(const extra of [{consent:false},{consent:'true'},{memory_id:null},{memory_id:'bad'},{memory_id:[uuid(1)]},
  {include_text:true},{include_text:false},{options:{}},{query:'PRIVATE_QUERY'},{operation:['audit']},{source_id:'foreign'}])
  test('snapshot audit: strict authority and selector '+JSON.stringify(extra),()=>{
    assert.throws(()=>snapshotRequest({...request,...extra}));
  });
test('snapshot audit: caller cannot widen ID selection or replace bytes across await',async()=>{
  const q={...request,memory_id:uuid(2)},data=encoded(envelope(linkedRows()));
  const pending=inspectClientSnapshotBytes(q,[{data}]);q.memory_id=uuid(1);q.include_text=true;data.fill(32);
  const r=await pending;assert.equal(r.result.entries.length,1);assert.equal(r.result.entries[0].memory.id,uuid(2));privateReport(r);
});
for(const mode of ['abort','revoke'])test('snapshot audit: event-loop '+mode+' withholds the complete report',async()=>{
  const c=new AbortController();let allowed=true;const rows=Array.from({length:100},(_,i)=>row(i+1));
  const p=audit(rows,{}, {signal:c.signal,authorize:()=>allowed});setImmediate(()=>{if(mode==='abort')c.abort();else allowed=false;});
  await assert.rejects(p,{code:mode==='abort'?'aborted':'client_authorization_revoked'});
});
test('snapshot audit: real selected file stays unchanged, supports raw-byte fingerprint',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'ub-audit-file-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'中文.json'),data=encoded(envelope(linkedRows()));writeFileSync(path,data);const before=statSync(path);
  const r=await inspectClientSnapshots({...request,memory_id:uuid(2),files:[{path,expected_sha256:hash(data)}]});
  assert.equal(r.result.entries[0].state,'matched');assert.equal(r.files[0].expected_hash_verified,true);
  assert.deepEqual(readFileSync(path),Buffer.from(data));assert.equal(statSync(path).mtimeMs,before.mtimeMs);assert.ok(!JSON.stringify(r).includes(dir));privateReport(r);
});

// Separately exercise the adapter's private-handle and mid-audit boundaries.
const {auditMemorySnapshot}=await import('../src/snapshot-lineage-audit.mjs');
const {inspectMemorySnapshotFile}=await import('../src/personal-snapshot-contract.mjs');
test('snapshot audit: fabricated or cloned inspected handles cannot authorize traversal',async()=>{
  const file=await inspectMemorySnapshotFile(encoded(envelope(linkedRows())),hash);
  for(const fake of [{snapshot:file.snapshot},structuredClone(file),null])
    await assert.rejects(auditMemorySnapshot(fake),{code:'snapshot_not_inspected'});
});
test('snapshot audit: cancellation between audit batches cannot return a partial report',async()=>{
  const file=await inspectMemorySnapshotFile(encoded(envelope(Array.from({length:100},(_,i)=>row(i+1)))),hash);
  let cancelled=false,checkpoints=0;
  const work=auditMemorySnapshot(file,undefined,()=>{checkpoints++;if(cancelled)throw Object.assign(Error(),{code:'aborted'});});
  setImmediate(()=>{cancelled=true;});await assert.rejects(work,{code:'aborted'});assert.ok(checkpoints>32);
});
test('snapshot audit: incomplete snapshot cannot authorize an audit despite valid selected content',async()=>{
  const data=encoded(envelope(linkedRows(),{complete:false}));
  await assert.rejects(inspectClientSnapshotBytes({...request,memory_id:uuid(2)},[{data}]),{code:'memory_snapshot_unconfirmed'});
});
test('snapshot audit: exact audit rejects a second file before any file IO',async()=>{
  await assert.rejects(inspectClientSnapshots({...request,memory_id:uuid(2),files:[{path:'/missing-a'},{path:'/missing-b'}]}),{code:'invalid_params'});
});
test('snapshot audit: 120 deterministic mutations preserve all comparison dimensions',async()=>{
  for(let i=0;i<120;i++){
    const rows=linkedRows();const [s,m]=rows;
    if(i&1)s.revision++;
    if(i&2){s.content+=' appended';s.content_hash=hash(s.content);}
    if(i&4)s.status='archived';
    if(i&8){m.derivation.start=0;m.derivation.end=m.derivation.quote.length;}
    if(i&16)m.derivation_current=false;
    const e=(await audit(rows,{memory_id:uuid(2)})).result.entries[0];
    const expected=i&4?'archived':i&3?'changed':i&8?'quote_mismatch':i&16?'inconsistent':'matched';
    assert.equal(e.state,expected);assert.equal(e.comparison.revision_matches,!(i&1));
    assert.equal(e.comparison.content_matches,!(i&2));assert.equal(e.comparison.quote_matches,!(i&8));
  }
});
test('snapshot audit: actual database acceptance is additive and reports synthetic generations explicitly',()=>{
  const workflow=readFileSync(new URL('../.github/workflows/task-context.yml',import.meta.url),'utf8');
  const old=workflow.indexOf('run: bun test/client-snapshot-integration.mjs');
  const auditStep=workflow.indexOf('run: bun test/client-snapshot-audit-integration.mjs');
  assert.ok(old>=0&&auditStep>old);assert.ok(workflow.indexOf('name: snapshot-audit-${{ github.sha }}')>auditStep);
  assert.ok(workflow.indexOf('name: Stop only isolated database')>auditStep);
  const integration=readFileSync(new URL('./client-snapshot-audit-integration.mjs',import.meta.url),'utf8');
  for(const text of ['injected_synthetic_generations','external_model_calls:0','assert.deepEqual(await fingerprint(),before)',
    'assert.equal(exported.record_count,6)','snapshot-cli.cjs','snapshot.cjs'])assert.ok(integration.includes(text));
});
