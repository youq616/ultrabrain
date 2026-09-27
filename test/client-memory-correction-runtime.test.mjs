/** Real public SDK/runtime code with explicit official transport doubles. */
import test from 'node:test';import assert from 'node:assert/strict';import {register} from 'node:module';
import {rmSync} from 'node:fs';
import {state,reset,identity,Client} from './fixtures/client-sdk-stub.mjs';
import {fixture} from './helpers/memory-correction-fixture.mjs';
register(new URL('./fixtures/client-sdk-loader.mjs',import.meta.url));
const {reviewClientMemory}=await import('../packages/ultrabrain-client/src/memory-review.mjs');
function setup(t){
 const f=fixture(t);reset();const profile={format:1,source:'selected',workspace:f.profile.workspace,allow_capture:true,
  expected_instance:identity.instance_id,expected_actor:identity.actor_key,server:{transport:'stdio',command:'not-executed',args:[]}};
 state.onCall=req=>req.name==='ultra_identity'?{...identity,source_id:'selected'}:req.name==='ultra_memory_read'?
 {source_id:'selected',memory:structuredClone(f.state.row),read_only:true,trust:'untrusted-memory-data',coverage:'one'}:structuredClone(f.state.reply);
 return {...f,profile};
}
test('correction SDK: full lifecycle entry calls update once and closes',async t=>{
 const f=setup(t),r=await reviewClientMemory(f.profile,f.request);assert.equal(r.receipt.status,'candidate');assert.equal(state.closed,1);
 assert.equal(state.calls.filter(c=>c.name==='ultra_personal_update').length,1);assert.ok(!state.calls.some(c=>c.name==='ultra_personal_review'));
});
test('correction SDK: nested replacement copied before handshake',async t=>{
 const f=setup(t),route=state.onCall;state.onCall=req=>{f.request.memory.content='MUTATED';f.request.memory.visibility='source';return route(req);};
 await reviewClientMemory(f.profile,f.request);const wire=state.calls.find(c=>c.name==='ultra_personal_update');assert.equal(wire.args.memory.visibility,'private');
});
for(const mode of ['failure','revocation','workspace'])test('correction SDK: cleanup '+mode+' preserves prior confirmed fact',async t=>{
 const f=setup(t),original=Client.prototype.close;let permit=true;
 Client.prototype.close=async function(){await original.call(this);if(mode==='failure')throw Error('PRIVATE');if(mode==='revocation')permit=false;
  if(mode==='workspace')rmSync(f.profile.workspace,{recursive:true,force:true});};
 try{await assert.rejects(reviewClientMemory(f.profile,f.request,{authorize:()=>permit}),e=>e.write_delivery==='confirmed'&&e.write_attempts===1&&!e.message.includes('PRIVATE'));}
 finally{Client.prototype.close=original;}
});
test('correction SDK: invalid nested field rejects before connecting',async t=>{
 const f=setup(t);delete f.request.memory.confidence;await assert.rejects(reviewClientMemory(f.profile,f.request));assert.equal(state.connections,0);
});
test('correction SDK: post-write lost reply makes one unconfirmed attempt',async t=>{
 const f=setup(t),route=state.onCall;state.onCall=req=>{if(req.name==='ultra_personal_update')throw Error('PRIVATE_REMOTE');return route(req);};
 await assert.rejects(reviewClientMemory(f.profile,f.request),e=>e.write_delivery==='unconfirmed'&&e.write_attempts===1);
 assert.equal(state.calls.filter(c=>c.name==='ultra_personal_update').length,1);assert.equal(state.closed,1);
});
