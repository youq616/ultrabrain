/** Separate implementer review. Boundary probes, not another reviewer-agent. */
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {deliverMemoryReview,memoryReviewFailure} from '../src/client-memory-review.mjs';
import {row,uuid,hash} from './helpers/snapshot-audit-fixture.mjs';
const workspace=mkdtempSync(join(tmpdir(),'ub-review-boundary-'));process.on('exit',()=>rmSync(workspace,{recursive:true,force:true}));
const profile={source:'selected',workspace,expectedInstance:uuid(99),expectedActor:'a'.repeat(64),projectId:null,allowCapture:true};
const request=()=>({operation:'inspect',workspace,consent:true,memory_id:uuid(1)});
const envelope=()=>({source_id:'selected',memory:row(1,{content:'PRIVATE_BODY'}),trust:'untrusted-memory-data',read_only:true,coverage:'one'});
for(const location of ['top','record','derivation'])test('review audit: response data accessors are refused, not evaluated '+location,async()=>{
 const v=envelope();let called=0;
 if(location==='derivation')v.memory.derivation={};
 const target=location==='top'?v:location==='record'?v.memory:v.memory.derivation;
 const key=location==='top'?'coverage':location==='record'?'content':'quote';
 Object.defineProperty(target,key,{enumerable:true,get(){called++;return location==='record'?'PRIVATE_BODY':'one';}});
 await assert.rejects(deliverMemoryReview(request(),profile,{checkIdentity:async()=>{},invoke:async()=>v}));assert.equal(called,0);
});
test('review audit: nested cyclic response is bounded and withheld',async()=>{
 const v=envelope();v.memory.derivation={};v.memory.derivation.loop=v.memory.derivation;
 await assert.rejects(deliverMemoryReview(request(),profile,{checkIdentity:async()=>{},invoke:async()=>v}));
});
test('review audit: hidden fields and Symbol fields cannot be lost during projection',async()=>{
 for(const key of ['hidden',Symbol('hidden')]){const v=envelope();Object.defineProperty(v.memory,key,{value:'PRIVATE_SECRET'});
  await assert.rejects(deliverMemoryReview(request(),profile,{checkIdentity:async()=>{},invoke:async()=>v}));}
});
test('review audit: data-only error projection tolerates revoked proxies',()=>{
 const {proxy,revoke}=Proxy.revocable({},{});revoke();assert.equal(memoryReviewFailure(proxy).write_delivery,'not_started');
});
test('review audit: cancellable authorized reads do not invoke a writer',async()=>{
 const c=new AbortController();let calls=0;
 await assert.rejects(deliverMemoryReview(request(),profile,{signal:c.signal,checkIdentity:async()=>{},invoke:async()=>{calls++;c.abort();return envelope();}}),{code:'aborted'});
 assert.equal(calls,1);
});
test('review audit: permission and scope remain required for historical event lookup',async()=>{
 const q={...request(),operation:'replay',event_id:'old-event',expected_revision:1,expected_content_hash:hash('PRIVATE_BODY'),
  expected_status:'candidate',expected_visibility:'private',expected_project_id:'other',status:'active'};let n=0;
 await assert.rejects(deliverMemoryReview(q,profile,{checkIdentity:async()=>n++,invoke:async()=>envelope()}));assert.equal(n,0);
});
