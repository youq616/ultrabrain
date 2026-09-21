/** Evidence-reference contract over validated current records; no models or database IO. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {row,uuid,hash,lineagePair as pair} from './helpers/lineage-fixture.mjs';
let c;try{c=await import('../src/personal-lineage-contract.mjs');}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;c={};}
test('lineage: canonical reference copies only the existing consolidation contract',()=>{
 const {memory}=pair(),ref=c.lineageReference(memory);assert.deepEqual(ref,memory.derivation);
 assert.ok(Object.isFrozen(ref));memory.derivation.quote='edited';assert.equal(ref.quote,'不要使用 Docker Hub');
});
for(const [name,change] of [
 ['id',d=>d.input_id='bad'],['self-cycle',d=>d.input_id=uuid(1)],['job',d=>d.job_id='bad'],['hash',d=>d.input_hash='BAD'],
 ['profile',d=>d.profile_hash='z'.repeat(64)],['version',d=>d.input_revision=0],['overflow version',d=>d.input_revision=2147483648],
 ['fraction',d=>d.start=.5],['negative',d=>d.start=-1],['wrong span',d=>d.end++],['wrong unit',d=>d.offset_unit='utf8-bytes'],
 ['past capture limit',d=>{d.start=32768;d.end=d.start+d.quote.length;}],['unknown field',d=>d.url='https://example.invalid'],
 ['empty quote',d=>{d.quote='';d.end=d.start;}],['whitespace quote',d=>{d.quote=' ';d.end=d.start+1;}],
 ['NUL quote',d=>{d.quote='\0';d.end=d.start+1;}],['broken Unicode',d=>{d.quote='\ud800';d.end=d.start+1;}],
 ['long quote',d=>{d.quote='中'.repeat(683);d.end=d.start+d.quote.length;}],['missing field',d=>delete d.job_id]])
 test('lineage: rejects malformed reference before it can authorize a source request: '+name,()=>{
  const {memory}=pair();change(memory.derivation);assert.throws(()=>c.lineageReference(memory),{code:'lineage_reference_invalid'});
 });
test('lineage: null and withheld references have distinct outcomes and never infer document ancestry',()=>{
 const owned=row(),shared=row(1,{owned_by_caller:false,status:'active',visibility:'source'});
 assert.equal(c.lineageReference(owned),null);assert.equal(c.lineageReference(shared),null);
 assert.equal(c.lineageReference({...owned,origin_kind:'document_fragment'}),null);
 const bad={...shared,derivation:pair().memory.derivation};assert.throws(()=>c.lineageReference(bad));
});
test('lineage: quote proof is scoped to location, not model truth or ownership authentication',()=>{
 const {memory,source}=pair(),r=c.compareLineage(memory,source);
 assert.equal(r.state,'matched');assert.equal(r.quote_matches,true);assert.equal(r.revision_matches,true);
 assert.equal(r.content_matches,true);assert.equal(r.truth_verified,false);assert.ok(Object.isFrozen(r));
 assert.ok(!JSON.stringify(r).includes(source.content));
});
for(const [name,change,state]of [
 ['edited',s=>{s.content='已经改写';s.content_hash=hash(s.content);s.revision++;},'changed'],
 ['metadata revision',s=>s.revision++,'changed'],
 ['archived same body',s=>{s.status='archived';s.revision++;},'archived'],
 ['hash changed',s=>s.content_hash='a'.repeat(64),'changed']])test('lineage: reports observed '+name+' without replacing historical reference',()=>{
 const {memory,source}=pair(),before=JSON.stringify(memory.derivation);change(source);memory.derivation_current=false;
 const r=c.compareLineage(memory,source);assert.equal(r.state,state);assert.equal(JSON.stringify(memory.derivation),before);
 assert.equal(r.truth_verified,false);
});
test('lineage: wrong quote at the claimed offset is not rescued by finding it elsewhere',()=>{
 const {memory,source}=pair();memory.derivation.start--;memory.derivation.end--;
 assert.equal(c.compareLineage(memory,source).state,'quote_mismatch');
});
test('lineage: quote offsets use UTF16 including supplementary Unicode and CRLF',()=>{
 const {memory,source}=pair();assert.equal(memory.derivation.start,6);
 assert.equal(c.compareLineage(memory,source).state,'matched');
 const quote='🙂\r\n';memory.derivation={...memory.derivation,quote,start:2,end:2+quote.length};
 assert.equal(c.compareLineage(memory,source).state,'matched');
});
test('lineage: full source read must be the expected owned record',()=>{
 for(const change of [{id:uuid(9)},{owned_by_caller:false}]){
  const {memory,source}=pair();assert.throws(()=>c.compareLineage(memory,{...source,...change}),{code:'lineage_source_invalid'});
 }
});
test('lineage: a false server flag is not overridden by locally matching bytes',()=>{
 const {memory,source}=pair();memory.derivation_current=false;
 assert.equal(c.compareLineage(memory,source).state,'inconsistent');
});
test('lineage: repeat-read matching covers all returned metadata, ignores only object key order',()=>{
 const {memory}=pair(),reordered=Object.fromEntries(Object.entries(memory).reverse());
 reordered.derivation=Object.fromEntries(Object.entries(memory.derivation).reverse());
 assert.equal(c.sameLineageRecord(memory,reordered),true);
 for(const changes of [{status:'archived'},{visibility:'source'},{derivation_current:false},{revision:2},
  {content:'new'},{provenance:'new'},{project_id:'other'},{confidence:.4},{updated_at:'different'}])
  assert.equal(c.sameLineageRecord(memory,{...memory,...changes}),false);
});

test('lineage: portability retains every prior suite and appends both new suites',()=>{
 const y=readFileSync(new URL('../.github/workflows/client-portability.yml',import.meta.url),'utf8');
 const line=y.split('\n').find(s=>s.includes('node --test ')),files=line.slice(line.indexOf('node --test ')+12).split(/\s+/);
 const prior=['personal-snapshot-explorer','personal-snapshot-explorer-ui','personal-snapshot-inspector','personal-snapshot-inspector-ui',
  'personal-snapshot','personal-snapshot-browser','personal-job-recovery-barrier','personal-job-recovery','personal-document-module',
  'personal-document-read','personal-jobs','personal-job-manager','personal-document-receipts','personal-console-receipts',
  'personal-memory-compare','personal-memory-read','personal-memory-lookup','client-authorization','client-profile-authorization',
  'client-request-authorization','client-task-context','client-kit','personal-documents','client-document-boundaries','native-adapters',
  'capture-outbox','automatic-capture','capture-hardening','capture-delivery','capture-profile-binding','client-release-docs'];
 for(const name of [...prior,'personal-lineage','personal-lineage-ui'])assert.ok(files.includes('test/'+name+'.test.mjs'),name);
 assert.equal(new Set(files).size,files.length);assert.ok(y.includes('ubuntu-24.04')&&y.includes('windows-2025'));
});
test('lineage: browser integration runs after setup and all prior stages, then uploads report',()=>{
 const y=readFileSync(new URL('../.github/workflows/personal-recall-preview.yml',import.meta.url),'utf8');
 const task=y.indexOf('run: bun test/personal-lineage-integration.mjs');assert.ok(task>0);
 for(const f of ['bash scripts/bootstrap-linux.sh','playwright install --with-deps chromium','personal-recall-browser-fixture.mjs',
  'personal-document-module-integration.mjs','personal-job-manager-integration.mjs','personal-job-recovery-integration.mjs',
  'personal-job-recovery-barrier-integration.mjs','personal-snapshot-integration.mjs','personal-snapshot-inspector-integration.mjs',
  'personal-snapshot-explorer-integration.mjs'])assert.ok(y.indexOf(f)>0&&y.indexOf(f)<task,f);
 const uploaded=y.slice(y.indexOf('name: personal-recall-preview-${{ github.sha }}'));
 assert.ok(y.indexOf('name: personal-recall-preview-${{ github.sha }}')>task);
 for(const f of ['personal-lineage-report.json','personal-lineage.png'])assert.ok(uploaded.includes(f));
});
