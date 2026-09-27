/** Complete correction requests; real canonical read/normalization, synthetic transport. */
import test from 'node:test';import assert from 'node:assert/strict';
import {deliverMemoryReview,memoryReviewRequest,MEMORY_REVIEW_INPUT_MAX_BYTES} from '../src/client-memory-review.mjs';
import {fixture,uuid,hash} from './helpers/memory-correction-fixture.mjs';
const writes=s=>s.calls.filter(c=>c.name==='ultra_personal_update');
test('correction: exact full replacement and candidate receipt, never body in output',async t=>{
 const f=fixture(t),r=await deliverMemoryReview(f.request,f.profile,f.io);
 assert.deepEqual(f.state.calls.map(c=>c.name),['identity','ultra_memory_read','identity','ultra_personal_update','identity']);
 assert.deepEqual(writes(f.state)[0].args,{memory_id:uuid(1),expected_revision:1,event_id:'correct-one',memory:f.replacement});
 assert.equal(r.receipt.status,'candidate');assert.equal(r.review_required,true);assert.equal(r.receipt.review_required,true);
 assert.equal(r.write_delivery,'confirmed');assert.equal(r.current_state_verified,false);assert.equal(r.text_included,false);
 assert.ok(!JSON.stringify(r).includes('PRIVATE'));assert.ok(Object.isFrozen(r.receipt));
});
for(const status of ['active','candidate','archived'])test('correction: supports explicit '+status+' reset',async t=>{
 const f=fixture(t);f.state.row.status=status;f.request.expected_status=status;
 assert.equal((await deliverMemoryReview(f.request,f.profile,f.io)).receipt.status,'candidate');
});
for(const field of ['type','content','provenance','importance','confidence','visibility','project_id']){
 for(const mode of ['absent','undefined'])test('correction: no implicit defaults '+field+' '+mode,async t=>{
  const f=fixture(t);if(mode==='absent')delete f.request.memory[field];else f.request.memory[field]=undefined;
  await assert.rejects(deliverMemoryReview(f.request,f.profile,f.io),{code:'invalid_params'});assert.equal(f.state.calls.length,0);
 });
}
for(const patch of [{status:'active'},{include_text:true},{acknowledge_reset:false},{consent:false},{expected_revision:2147483647}])
 test('correction: rejects incompatible/unsafe selector '+JSON.stringify(patch),async t=>{
  const f=fixture(t);Object.assign(f.request,patch);await assert.rejects(deliverMemoryReview(f.request,f.profile,f.io));assert.equal(f.state.calls.length,0);
 });
for(const patch of [{confidence:NaN},{confidence:Infinity},{confidence:-1},{confidence:1.1},{content:''},{content:'  '},{content:'x\0y'},
 {content:'\ud800'},{content:'a'.repeat(65537)},{provenance:'p'.repeat(2049)},{visibility:'public'},{project_id:'other'},
 {type:'unknown'},{status:'active'},{derivation:null}])test('correction: invalid editable payload '+Object.keys(patch).join(','),async t=>{
 const f=fixture(t);Object.assign(f.request.memory,patch);await assert.rejects(deliverMemoryReview(f.request,f.profile,f.io));assert.equal(f.state.calls.length,0);
});
test('correction: UTF-8 content preserved, not trimmed or normalized',async t=>{
 const f=fixture(t);f.request.memory.content='  e\u0301\r\n🙂  ';
 await deliverMemoryReview(f.request,f.profile,f.io);assert.equal(writes(f.state)[0].args.memory.content,f.request.memory.content);
});
test('correction: JSON escape expansion is bounded even for valid 64 KiB content',async t=>{
 const f=fixture(t);f.request.memory.content='\x01'.repeat(65000);await assert.rejects(deliverMemoryReview(f.request,f.profile,f.io),{code:'input_too_large'});
 assert.equal(f.state.calls.length,0);assert.equal(MEMORY_REVIEW_INPUT_MAX_BYTES,131072);
});
test('correction: no-op full replacement is not an implicit source-reset request',async t=>{
 const f=fixture(t);for(const key of Object.keys(f.request.memory))f.request.memory[key]=f.state.row[key];
 await assert.rejects(deliverMemoryReview(f.request,f.profile,f.io),{code:'memory_correction_no_change'});assert.equal(writes(f.state).length,0);
});
test('correction: source-stale owned memory can be explicitly corrected, not silently activated',async t=>{
 const f=fixture(t);f.state.row.derivation_current=false;assert.equal((await deliverMemoryReview(f.request,f.profile,f.io)).receipt.status,'candidate');
});
for(const key of ['revision','content_hash','status','visibility','project_id'])test('correction: stale '+key+' never writes',async t=>{
 const f=fixture(t);const values={revision:2,content_hash:hash('different'),status:'archived',visibility:'source',project_id:'other'};
 f.state.row[key]=values[key];await assert.rejects(deliverMemoryReview(f.request,f.profile,f.io));assert.equal(writes(f.state).length,0);
});
for(const kind of ['nonowner','document','disabled'])test('correction: rejects '+kind,async t=>{
 const f=fixture(t);if(kind==='nonowner')Object.assign(f.state.row,{owned_by_caller:false,visibility:'source'});
 if(kind==='document')f.state.row.origin_kind='document_fragment';if(kind==='disabled')f.profile.allowCapture=false;
 await assert.rejects(deliverMemoryReview(f.request,f.profile,f.io));assert.equal(writes(f.state).length,0);
});
test('correction replay: exact normalized replacement and historical candidate acknowledgement',async t=>{
 const f=fixture(t);f.request.operation='replay-correction';f.state.row.revision=4;f.state.reply.replayed=true;
 const r=await deliverMemoryReview(f.request,f.profile,f.io);assert.equal(r.receipt.status,'candidate');assert.equal(r.receipt.replayed,true);
 assert.equal(r.observed_revision,4);assert.equal(r.current_state_verified,false);assert.deepEqual(writes(f.state)[0].args.memory,f.replacement);
});
for(const revision of [1,0])test('correction replay: cannot execute a first update at revision '+revision,async t=>{
 const f=fixture(t);f.request.operation='replay-correction';f.state.row.revision=revision;
 await assert.rejects(deliverMemoryReview(f.request,f.profile,f.io));assert.equal(writes(f.state).length,0);
});
test('correction replay: permitted explicit project change does not prevent journal recovery',async t=>{
 const f=fixture(t);f.profile.projectId='chosen';f.request.memory.project_id='chosen';await deliverMemoryReview(f.request,f.profile,f.io);
 f.request.operation='replay-correction';f.state.row.project_id='chosen';f.state.row.revision=2;f.state.reply.replayed=true;
 assert.equal((await deliverMemoryReview(f.request,f.profile,f.io)).receipt.replayed,true);
});
for(const patch of [{status:'active'},{review_required:false},{review_required:undefined},{replayed:'yes'},{revision:3},{content:'PRIVATE'}])
 test('correction: malformed acknowledgement withheld '+JSON.stringify(patch),async t=>{
  const f=fixture(t);Object.assign(f.state.reply,patch);
  await assert.rejects(deliverMemoryReview(f.request,f.profile,f.io),e=>e.code==='memory_review_receipt_unconfirmed'&&e.write_delivery==='unconfirmed');
 });
test('correction replay: server response must explicitly be replayed',async t=>{
 const f=fixture(t);f.request.operation='replay-correction';f.state.row.revision=2;
 await assert.rejects(deliverMemoryReview(f.request,f.profile,f.io),{code:'memory_review_receipt_unconfirmed'});
});
test('correction: replacement frozen before first identity await',async t=>{
 const f=fixture(t);f.io.checkIdentity=async()=>{f.request.memory.content='MUTATED';f.request.memory.visibility='source';f.request.event_id='other';f.request.acknowledge_reset=false;};
 await deliverMemoryReview(f.request,f.profile,f.io);assert.equal(writes(f.state)[0].args.memory.content,'PRIVATE_CORRECTED 🙂\r\n');
 assert.equal(writes(f.state)[0].args.memory.visibility,'private');assert.equal(writes(f.state)[0].args.event_id,'correct-one');
});
for(const stage of ['before','read','prewrite','write','postwrite'])test('correction: cancellation '+stage,async t=>{
 const f=fixture(t),c=new AbortController();let ids=0;f.io.signal=c.signal;
 if(stage==='before')c.abort();f.io.checkIdentity=async()=>{if(++ids===(stage==='prewrite'?2:stage==='postwrite'?3:99))c.abort();};
 const original=f.io.invoke;f.io.invoke=async(...a)=>{const r=await original(...a);if(stage==='read'&&a[0]==='ultra_memory_read'||stage==='write'&&a[0]==='ultra_personal_update')c.abort();return r;};
 await assert.rejects(deliverMemoryReview(f.request,f.profile,f.io),e=>e.code==='aborted'&&e.write_delivery===
  (stage==='postwrite'?'confirmed':stage==='write'?'unconfirmed':'not_started'));
});
