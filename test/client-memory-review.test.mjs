/** Pure last-mile tests. Synthetic protocol only; installed package tested separately. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sha256} from '../src/core.mjs';
import {memoryReviewRequest,deliverMemoryReview,memoryReviewFailure} from '../src/client-memory-review.mjs';
import {row,uuid} from './helpers/snapshot-audit-fixture.mjs';
const workspace=mkdtempSync(join(tmpdir(),'ub-review-'));
process.on('exit',()=>rmSync(workspace,{recursive:true,force:true}));
const profile={source:'selected',workspace,expectedInstance:uuid(99),expectedActor:'a'.repeat(64),projectId:null,allowCapture:true};
const memory=()=>row(1,{content:'PRIVATE_BODY',provenance:'PRIVATE_PROVENANCE'});
const inspect=()=>({operation:'inspect',memory_id:uuid(1),workspace,consent:true});
const apply=()=>({...inspect(),operation:'apply',event_id:'review-one',expected_revision:1,expected_content_hash:sha256('PRIVATE_BODY'),
 expected_status:'candidate',expected_visibility:'private',expected_project_id:null,status:'active'});
function io(edit=()=>{}){
 const f={calls:[],record:memory(),reply:{id:uuid(1),revision:2,status:'active',replayed:false,assurance:'Explicit caller review, not independent truth verification'}};
 f.checkIdentity=async()=>{f.calls.push('identity');};
 f.invoke=async(name,args)=>{f.calls.push({name,args});return name==='ultra_memory_read'?{source_id:'selected',memory:structuredClone(f.record),read_only:true,
  trust:'untrusted-memory-data',coverage:'single record'}:structuredClone(f.reply);};
 edit(f);return f;
}
test('review inspect: metadata-only read, no write opt-in required',async()=>{
 const f=io(),r=await deliverMemoryReview(inspect(),{...profile,allowCapture:false},f);
 assert.equal(r.operation,'inspect');assert.equal(r.memory.id,uuid(1));assert.equal(r.text_included,false);assert.equal(r.write_requests,0);
 assert.ok(!JSON.stringify(r).includes('PRIVATE'));assert.deepEqual(f.calls.map(x=>x.name??x),['identity','ultra_memory_read','identity']);
});
test('review inspect: separately selected full text retained exactly',async()=>{
 const f=io(),r=await deliverMemoryReview({...inspect(),include_text:true},profile,f);
 assert.equal(r.text.content,'PRIVATE_BODY');assert.equal(r.text.provenance,'PRIVATE_PROVENANCE');assert.ok(Object.isFrozen(r.text));
});
test('review apply: exact four-field server write follows read and identity fences',async()=>{
 const f=io(),r=await deliverMemoryReview(apply(),profile,f);
 assert.equal(r.write_delivery,'confirmed');assert.equal(r.receipt.revision,2);assert.equal(r.current_state_verified,false);
 assert.deepEqual(f.calls.map(x=>x.name??x),['identity','ultra_memory_read','identity','ultra_personal_review','identity']);
 assert.deepEqual(f.calls[3].args,{memory_id:uuid(1),expected_revision:1,event_id:'review-one',status:'active'});
 assert.ok(!JSON.stringify(r).includes('PRIVATE'));assert.ok(Object.isFrozen(r.receipt));
});
test('review archive: source-stale owned record can still be archived',async()=>{
 const f=io(f=>{f.record.derivation_current=false;f.reply.status='archived';});
 const r=await deliverMemoryReview({...apply(),status:'archived'},profile,f);assert.equal(r.receipt.status,'archived');
});
for(const patch of [{consent:false},{memory_id:'short'},{event_id:'bad event'},{status:'candidate'},{expected_revision:0},
 {expected_revision:2147483647},{expected_content_hash:'A'.repeat(64)},{expected_status:'bad'},{expected_visibility:'all'},
 {source_id:'foreign'},{include_text:true},{expected_project_id:'../bad'}])test('review invalid request before IO '+JSON.stringify(patch),async()=>{
 const f=io();await assert.rejects(deliverMemoryReview({...apply(),...patch},profile,f));assert.equal(f.calls.length,0);
});
for(const k of ['expectedInstance','expectedActor','workspace'])test('review pins required '+k,async()=>{
 const f=io();await assert.rejects(deliverMemoryReview(apply(),{...profile,[k]:null},f),{code:'memory_review_disabled'});assert.equal(f.calls.length,0);
});
test('review apply: existing write opt-in required, no new permission implied',async()=>{
 const f=io();await assert.rejects(deliverMemoryReview(apply(),{...profile,allowCapture:false},f),{code:'memory_review_disabled'});assert.equal(f.calls.length,0);
});
for(const [k,value] of [['revision',2],['content','NEW'],['status','archived'],['visibility','source'],['project_id','elsewhere']])
 test('review apply refuses stale '+k+' without sending write',async()=>{
  const f=io(f=>{f.record[k]=value;if(k==='content')f.record.content_hash=sha256(value);});
  await assert.rejects(deliverMemoryReview(apply(),profile,f));assert.equal(f.calls.filter(x=>x.name==='ultra_personal_review').length,0);
 });
for(const kind of ['shared','fragment','stale','already-active'])test('review refuses '+kind+' before write',async()=>{
 const f=io(f=>{
  if(kind==='shared')Object.assign(f.record,{owned_by_caller:false,status:'active',visibility:'source'});
  if(kind==='fragment')f.record.origin_kind='document_fragment';
  if(kind==='stale')f.record.derivation_current=false;
  if(kind==='already-active')f.record.status='active';
 });
 const request={...apply(),expected_status:f.record.status,expected_visibility:f.record.visibility};
 await assert.rejects(deliverMemoryReview(request,profile,f));assert.equal(f.calls.filter(x=>x.name==='ultra_personal_review').length,0);
});
test('review replay: original event only, strictly advanced revision forbids new CAS write',async()=>{
 const f=io(f=>{f.record.revision=4;f.record.status='archived';f.reply.replayed=true;});
 const r=await deliverMemoryReview({...apply(),operation:'replay'},profile,f);
 assert.equal(r.receipt.replayed,true);assert.equal(r.receipt.status,'active');assert.equal(r.observed_revision,4);assert.equal(r.current_state_verified,false);
});
test('review replay: unchanged row cannot be used to smuggle first write',async()=>{
 const f=io();await assert.rejects(deliverMemoryReview({...apply(),operation:'replay'},profile,f),{code:'memory_review_replay_unavailable'});
 assert.equal(f.calls.filter(x=>x.name==='ultra_personal_review').length,0);
});
for(const patch of [{id:uuid(2)},{revision:3},{status:'archived'},{replayed:'false'},{extra:'PRIVATE'},{assurance:42}])
 test('review rejects malformed acknowledgement '+JSON.stringify(patch),async()=>{
  const f=io(f=>Object.assign(f.reply,patch));
  await assert.rejects(deliverMemoryReview(apply(),profile,f),e=>e.code==='memory_review_receipt_unconfirmed'&&e.write_delivery==='unconfirmed');
 });
test('review replay refuses acknowledgement claiming new write',async()=>{
 const f=io(f=>f.record.revision=2);await assert.rejects(deliverMemoryReview({...apply(),operation:'replay'},profile,f),e=>e.write_delivery==='unconfirmed');
});
for(const when of ['before','read','before-write','after-write','last-identity'])test('review revocation at '+when,async()=>{
 let permit=when!=='before',ids=0;const f=io();const call=f.invoke;
 f.authorize=()=>permit;f.checkIdentity=async()=>{ids++;if(when==='before-write'&&ids===2||when==='last-identity'&&ids===3)permit=false;};
 f.invoke=async(...args)=>{const r=await call(...args);if(when==='read'&&args[0]==='ultra_memory_read'||when==='after-write'&&args[0]==='ultra_personal_review')permit=false;return r;};
 await assert.rejects(deliverMemoryReview(apply(),profile,f),e=>e.code==='client_authorization_revoked'&&
  e.write_delivery===(when==='last-identity'?'confirmed':when==='after-write'?'unconfirmed':'not_started'));
});
test('review snapshot: caller cannot replace event or consent across identity wait',async()=>{
 const input=apply(),f=io();f.checkIdentity=async()=>{input.event_id='other';input.consent=false;input.status='archived';};
 const r=await deliverMemoryReview(input,profile,f);assert.equal(r.event_id,'review-one');assert.equal(r.receipt.status,'active');
});
for(const key of ['consent','expected_revision'])test('review input getter refused without execution '+key,()=>{
 const r=apply();let n=0;Object.defineProperty(r,key,{enumerable:true,get(){n++;return true;}});
 assert.throws(()=>memoryReviewRequest(r,profile),{code:'invalid_params'});assert.equal(n,0);
});
test('review error: untrusted messages and fake attempt counters never propagate',async()=>{
 const f=io();f.invoke=async()=>{throw Object.assign(Error('PRIVATE_TOKEN'),{write_delivery:'confirmed',write_attempts:999});};
 await assert.rejects(deliverMemoryReview(apply(),profile,f),e=>e.write_attempts===0&&e.write_delivery==='not_started'&&!e.message.includes('PRIVATE'));
 const e=memoryReviewFailure({write_delivery:'confirmed'});assert.equal(e.write_delivery,'not_started');
});
