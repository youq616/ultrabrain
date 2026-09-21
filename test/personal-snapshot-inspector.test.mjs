/** Canonical no-IO inspection and comparison, not an authenticity/restore test. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as c from '../src/personal-snapshot-contract.mjs';
import {hash,uuid,row,envelope,encoded} from './helpers/snapshot-audit-fixture.mjs';
const inspect=(s=envelope())=>c.inspectMemorySnapshotFile(encoded(s),hash);
test('inspect a real export spelling without changing text or granting identity',async()=>{
 const data=encoded();const r=await c.inspectMemorySnapshotFile(data,hash);
 assert.equal(r.snapshot.memories[0].content,row().content);assert.equal(r.file_sha256,hash(new TextDecoder().decode(data)));
 assert.equal(r.file_bytes,data.byteLength);assert.ok(Object.isFrozen(r.snapshot.memories[0]));
});
test('changed fields include metadata with unchanged content',async()=>{
 const left=await inspect(),right=await inspect(envelope([row(1,{importance:'high',status:'active',revision:2})]));
 const report=c.compareMemorySnapshots(left,right);
 assert.deepEqual(report.counts,{left_only:0,right_only:0,changed:1,unchanged:0});
 assert.deepEqual(report.differences[0],{id:uuid(1),kind:'changed',fields:['importance','revision','status']});
});
test('left-only/right-only are set observations, not deletion/creation claims',async()=>{
 const report=c.compareMemorySnapshots(await inspect(envelope([row(1)])),await inspect(envelope([row(2)])));
 assert.deepEqual(report.counts,{left_only:1,right_only:1,changed:0,unchanged:0});
 assert.equal(report.identity_verified,false);assert.equal(report.read_only,true);
 assert.ok(!JSON.stringify(report).includes('合成内容'));assert.ok(!JSON.stringify(report).includes('Synthetic audit fixture'));
});
test('reject cross-source comparisons and unverified objects',async()=>{
 const left=await inspect(),right=await inspect(envelope([row()],{source_id:'foreign'}));
 assert.throws(()=>c.compareMemorySnapshots(left,right),/snapshot_source_mismatch/);
 assert.throws(()=>c.compareMemorySnapshots({snapshot:envelope()},right),/snapshot_not_inspected/);
});
for(const [name,change] of [
 ['content',s=>s.memories[0].content='tampered'],['row hash',s=>s.memories[0].content_hash='0'.repeat(64)],
 ['array hash',s=>s.memories_sha256='0'.repeat(64)],['partial',s=>s.complete=false],['count',s=>s.record_count=2],
 ['unknown schema',s=>s.format='other'],['extra token',s=>s.token='SECRET'],['foreign row',s=>s.memories[0].owned_by_caller=false],
 ['wrong ID',s=>s.memories[0].id='wrong'],['bad timestamp',s=>s.snapshot_at='2026-02-30T00:00:00.000Z']])
 test('whole-file verification rejects '+name,async()=>{
  const s=envelope();change(s);await assert.rejects(inspect(s),/memory_snapshot_unconfirmed/);
 });
for(const text of ['{"a":1,"a":2}','{"a":1,"\\u0061":2}','{"x":{"a":1,"a":2}}'])
 test('duplicate keys cannot be silently overwritten '+text,async()=>{
  await assert.rejects(c.inspectMemorySnapshotFile(new TextEncoder().encode(text),hash),/snapshot_file_duplicate_key/);
 });
for(const text of ['', '{', '[]', 'null', '{"a":1,}', 'true'])test('invalid snapshot file fails '+JSON.stringify(text),async()=>{
 await assert.rejects(c.inspectMemorySnapshotFile(new TextEncoder().encode(text),hash));
});
test('UTF-8 invalid sequences fail instead of replacement decoding',async()=>{
 await assert.rejects(c.inspectMemorySnapshotFile(new Uint8Array([0xc3,0x28]),hash),/snapshot_file_invalid_utf8/);
});
test('file and nesting limits apply before hashing',async()=>{
 let calls=0;const digest=()=>{calls++;return hash('x');};
 await assert.rejects(c.inspectMemorySnapshotFile(new Uint8Array(c.SNAPSHOT_FILE_MAX_BYTES+1),digest),/snapshot_file_size/);
 await assert.rejects(c.inspectMemorySnapshotFile(new TextEncoder().encode('['.repeat(33)+'0'+']'.repeat(33)),digest),/snapshot_file_too_deep/);
 assert.equal(calls,0);
});
test('1001 records and unordered/duplicate IDs fail instead of truncating',async()=>{
 await assert.rejects(inspect(envelope(Array.from({length:1001},(_,i)=>row(i)))));
 for(const memories of [[row(2),row(1)],[row(1),row(1)]])await assert.rejects(inspect(envelope(memories)));
});
test('pretty file, BOM, escapes, quote and brace content are legal and faithful',async()=>{
 const content='\ufeff"{ a : [ ] }" \\ \u0000 🙂\r\n';
 const text='\ufeff'+JSON.stringify(envelope([row(1,{content})]),null,2)+'\r\n';
 const r=await c.inspectMemorySnapshotFile(new TextEncoder().encode(text),hash);
 assert.equal(r.snapshot.memories[0].content,content);assert.equal(r.file_sha256,hash(text));
});
test('empty snapshots compare without false differences',async()=>{
 const r=c.compareMemorySnapshots(await inspect(envelope([])),await inspect(envelope([])));
 assert.deepEqual(r.counts,{left_only:0,right_only:0,changed:0,unchanged:0});assert.equal(r.differences.length,0);
});
test('object key reordering does not cause a semantic difference',async()=>{
 const a=row(1,{derivation:{quote:'a',location:{x:1,y:2}}}),b=row(1,{derivation:{location:{y:2,x:1},quote:'a'}});
 const r=c.compareMemorySnapshots(await inspect(envelope([a])),await inspect(envelope([b])));
 assert.equal(r.counts.unchanged,1);
});
test('array order and same-revision derived state changes remain differences',async()=>{
 const a=row(1,{derivation:{hints:['a','b']}}),b=row(1,{derivation:{hints:['b','a']},derivation_current:false});
 const r=c.compareMemorySnapshots(await inspect(envelope([a])),await inspect(envelope([b])));
 assert.deepEqual(r.differences[0].fields,['derivation','derivation_current']);
});
test('older right-side timestamps do not imply invalid chronology or a restore plan',async()=>{
 const a=await inspect(),b=await inspect(envelope([row(1)],{snapshot_at:'2025-01-01T00:00:00.000Z'}));
 assert.equal(c.compareMemorySnapshots(a,b).counts.unchanged,1);
});
test('caller bytes cannot be changed during asynchronous validation',async()=>{
 const data=encoded();let used=false;
 const result=await c.inspectMemorySnapshotFile(data,async text=>{if(!used){used=true;data.fill(0);}return hash(text);});
 assert.equal(result.snapshot.memories[0].content,row().content);
 assert.throws(()=>{result.snapshot.memories[0].content='changed';},TypeError);
});
test('cancellation checkpoints stop delivery during hashing',async()=>{
 let cancelled=false;await assert.rejects(c.inspectMemorySnapshotFile(encoded(),async text=>{cancelled=true;return hash(text);},
 ()=>{if(cancelled)throw Error('explicit cancellation');}),/explicit cancellation/);
});
test('comparison of two maximal distinct-ID sets is complete and sorted',async()=>{
 const a=await inspect(envelope(Array.from({length:1000},(_,i)=>row(i)))),b=await inspect(envelope(Array.from({length:1000},(_,i)=>row(i+1000))));
 const report=c.compareMemorySnapshots(a,b);assert.equal(report.differences.length,2000);
 assert.deepEqual(report.counts,{left_only:1000,right_only:1000,changed:0,unchanged:0});
 assert.ok(report.differences.every((d,i)=>i===0||d.id>report.differences[i-1].id));
});
test('untrusted __proto__ keys stay inert data, never prototype assignments',async()=>{
 const derivation=JSON.parse('{"__proto__":{"polluted":true},"constructor":"data"}');
 const a=await inspect(envelope([row(1,{derivation})]));
 assert.equal({}.polluted,undefined);assert.equal(c.compareMemorySnapshots(a,a).counts.unchanged,1);
});

test('inspection retains all established portability suites and executes after snapshot setup',async()=>{
 const {readFileSync}=await import('node:fs');
 const workflow=readFileSync(new URL('../.github/workflows/client-portability.yml',import.meta.url),'utf8');
 const line=workflow.split('\n').find(s=>s.includes('run: node --test '));
 const suites=line.slice(line.indexOf('node --test ')+12).trim().split(/\s+/);
 const baseline=["test/personal-snapshot.test.mjs", "test/personal-snapshot-browser.test.mjs", "test/personal-job-recovery-barrier.test.mjs", "test/personal-job-recovery.test.mjs", "test/personal-document-module.test.mjs", "test/personal-document-read.test.mjs", "test/personal-jobs.test.mjs", "test/personal-job-manager.test.mjs", "test/personal-document-receipts.test.mjs", "test/personal-console-receipts.test.mjs", "test/personal-memory-compare.test.mjs", "test/personal-memory-read.test.mjs", "test/personal-memory-lookup.test.mjs", "test/client-authorization.test.mjs", "test/client-profile-authorization.test.mjs", "test/client-request-authorization.test.mjs", "test/client-task-context.test.mjs", "test/client-kit.test.mjs", "test/personal-documents.test.mjs", "test/client-document-boundaries.test.mjs", "test/native-adapters.test.mjs", "test/capture-outbox.test.mjs", "test/automatic-capture.test.mjs", "test/capture-hardening.test.mjs", "test/capture-delivery.test.mjs", "test/capture-profile-binding.test.mjs", "test/client-release-docs.test.mjs"];
 for(const name of [...baseline,'test/personal-snapshot-inspector.test.mjs','test/personal-snapshot-inspector-ui.test.mjs'])assert.ok(suites.includes(name),name);
 assert.equal(suites.length,new Set(suites).size);assert.ok(workflow.includes('windows-2025'));
 const browser=readFileSync(new URL('../.github/workflows/personal-recall-preview.yml',import.meta.url),'utf8');
 const step=browser.indexOf('run: bun test/personal-snapshot-inspector-integration.mjs');
 assert.ok(step>browser.indexOf('run: bun test/personal-snapshot-integration.mjs'));
 assert.ok(browser.indexOf('name: personal-recall-preview-${{ github.sha }}')>step);
 assert.ok(browser.slice(step).includes('personal-snapshot-inspector-report.json'));
});
test('compact snapshot limit is enforced independently of the on-disk pretty limit',async()=>{
 const data=encoded(envelope(Array.from({length:500},(_,i)=>row(i,{content:'x'.repeat(17000)}))));
 assert.ok(data.byteLength< c.SNAPSHOT_FILE_MAX_BYTES);
 await assert.rejects(c.inspectMemorySnapshotFile(data,hash),/memory_snapshot_unconfirmed/);
});
