/** Separate implementer audit probes; never called a second-agent approval. */
import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {deliverMemoryReview,memoryReviewRequest,memoryReviewFailure} from '../src/client-memory-review.mjs';
import {fixture} from './helpers/memory-correction-fixture.mjs';
for(const location of ['memory','field'])test('correction audit: getter never invoked '+location,async t=>{
 const f=fixture(t);let calls=0;Object.defineProperty(location==='memory'?f.request:f.request.memory,location==='memory'?'memory':'content',
  {enumerable:true,get(){calls++;throw Error('PRIVATE');}});
 await assert.rejects(deliverMemoryReview(f.request,f.profile,f.io),{code:'invalid_params'});assert.equal(calls,0);assert.equal(f.state.calls.length,0);
});
for(const key of ['hidden',Symbol('extra')])test('correction audit: reject non-JSON own field '+typeof key,t=>{
 const f=fixture(t);Object.defineProperty(f.request.memory,key,{value:'PRIVATE'});assert.throws(()=>memoryReviewRequest(f.request,f.profile),{code:'invalid_params'});
});
test('correction audit: revoked replacement proxy cannot escape safe error projection',async t=>{
 const f=fixture(t),{proxy,revoke}=Proxy.revocable({},{});revoke();f.request.memory=proxy;
 await assert.rejects(deliverMemoryReview(f.request,f.profile,f.io),e=>e.code==='invalid_params'&&e.write_delivery==='not_started');
});
test('correction audit: receipt getter never executes; write remains unconfirmed',async t=>{
 const f=fixture(t);let calls=0;const invoke=f.io.invoke;f.io.invoke=async(...a)=>a[0]==='ultra_memory_read'?invoke(...a):
  Object.defineProperty({},'review_required',{enumerable:true,get(){calls++;return true;}});
 await assert.rejects(deliverMemoryReview(f.request,f.profile,f.io),e=>e.write_delivery==='unconfirmed');assert.equal(calls,0);
});
test('correction audit: server conflict is one attempt, no automatic retry',async t=>{
 const f=fixture(t);let writes=0;const invoke=f.io.invoke;f.io.invoke=async(...a)=>{if(a[0]==='ultra_personal_update'){writes++;throw Object.assign(Error('PRIVATE'),{code:'revision_conflict'});}return invoke(...a);};
 await assert.rejects(deliverMemoryReview(f.request,f.profile,f.io),e=>e.code==='revision_conflict'&&e.write_attempts===1&&e.write_delivery==='unconfirmed');assert.equal(writes,1);
});
test('correction audit: false acknowledgement counters cannot become verified local facts',async t=>{
 const f=fixture(t),invoke=f.io.invoke;f.io.invoke=async(...a)=>{if(a[0]==='ultra_personal_update')throw {code:'conflict',write_delivery:'confirmed',write_attempts:500};return invoke(...a);};
 await assert.rejects(deliverMemoryReview(f.request,f.profile,f.io),e=>e.write_attempts===1&&e.write_delivery==='unconfirmed');
 assert.equal(memoryReviewFailure({code:'conflict',write_delivery:'confirmed'}).write_attempts,0);
});
test('correction audit: frozen normalized request can pass public wrapper revalidation',t=>{
 const f=fixture(t),r=memoryReviewRequest(f.request,f.profile);assert.ok(Object.isFrozen(r.memory));assert.deepEqual(memoryReviewRequest(r,f.profile),r);
 assert.throws(()=>{r.memory.content='changed';},TypeError);
});
test('correction audit: no ownership inference from source sharing in the replacement',async t=>{
 const f=fixture(t);f.state.row.owned_by_caller=false;f.state.row.visibility='source';f.request.expected_visibility='source';f.request.memory.visibility='source';
 await assert.rejects(deliverMemoryReview(f.request,f.profile,f.io),{code:'memory_review_not_owned'});
});
test('correction audit: automatic status or derivation fields are never accepted in replacement',async t=>{
 const f=fixture(t);for(const field of ['status','derivation','last_confirmed','owned_by_caller','agent_id','content_hash']){
  await assert.rejects(deliverMemoryReview({...f.request,memory:{...f.request.memory,[field]:null}},f.profile,f.io),{code:'invalid_params'});
 }assert.equal(f.state.calls.length,0);
});
test('correction audit: source code and CI retain canonical validator and previous regression',()=>{
 const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
 assert.ok(read('src/client-memory-review.mjs').includes('normalizePersonalMemory(selected)'));
 const flow=read('.github/workflows/task-context.yml'),n=flow.indexOf('run: bun test/client-memory-correction-integration.mjs');
 assert.ok(n>flow.indexOf('npm install --prefix')&&n>flow.indexOf('run: bun test/client-memory-review-integration.mjs'));
 assert.ok(n<flow.indexOf('name: Stop only isolated database'));assert.ok(flow.includes('memory-correction-report.json'));
 const portable=read('.github/workflows/client-portability.yml');assert.ok(portable.includes('windows-2025')&&portable.includes('ubuntu-24.04'));
 assert.ok(portable.includes('test/client-memory-correction-review.test.mjs test/client-installed-resolution.test.mjs'));
});
