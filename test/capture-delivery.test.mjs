import test from 'node:test';
import assert from 'node:assert/strict';
import {deliverCapture} from '../src/capture-delivery.mjs';
import {UltraError} from '../src/core.mjs';
const profile={allowCapture:true,projectId:'project'};
const payload=()=>({agent_id:'test',event_id:'event',transcript:'Original consented text',consent:true});
const fixture=()=>{const calls=[];return {calls,checkIdentity:async()=>{calls.push('identity');},invoke:async(name,p)=>{calls.push([name,p]);return {stored:true};}};};
test('normal capture checks identity and authorization before each write',async()=>{
 const f=fixture();await deliverCapture(payload(),profile,{...f,authorize:()=>f.calls.push('authorized')});
 assert.deepEqual(f.calls.map(x=>Array.isArray(x)?x[0]:x),['authorized','identity','authorized','ultra_agent_register','identity','authorized','ultra_personal_capture']);
 assert.equal(f.calls.at(-1)[1].project_id,'project');
});
test('revocation during registration prevents subsequent plaintext transmission',async()=>{
 const f=fixture();let revoked=false;
 await assert.rejects(deliverCapture(payload(),profile,{...f,invoke:async(name)=>{f.calls.push(name);revoked=true;},authorize:()=>{if(revoked)throw new UltraError('capture_disabled','Revoked');}}),{code:'capture_disabled'});
 assert.ok(!f.calls.includes('ultra_personal_capture'));
});
for(const checkpoint of [1,2])test('abort during identity check '+checkpoint+' prevents the following write',async()=>{
 const f=fixture(),controller=new AbortController();let n=0;
 await assert.rejects(deliverCapture(payload(),profile,{...f,signal:controller.signal,checkIdentity:async()=>{if(++n===checkpoint)controller.abort();}}),{code:'aborted'});
 assert.equal(f.calls.length,checkpoint-1);
});
test('readonly profiles and project overrides fail before network',async()=>{
 const f=fixture();await assert.rejects(deliverCapture(payload(),{...profile,allowCapture:false},f),{code:'capture_disabled'});
 await assert.rejects(deliverCapture({...payload(),project_id:'other'},profile,f),{code:'scope_denied'});assert.equal(f.calls.length,0);
});
test('request bytes cannot mutate during asynchronous checks',async()=>{
 const f=fixture(),p=payload();await deliverCapture(p,profile,{...f,checkIdentity:async()=>{p.transcript='changed';p.consent=false;}});
 assert.equal(f.calls.at(-1)[1].transcript,'Original consented text');assert.equal(f.calls.at(-1)[1].consent,true);
});
test('async authorization is rejected rather than treated as a successful assertion',async()=>{
 const f=fixture();await assert.rejects(deliverCapture(payload(),profile,{...f,authorize:async()=>{}}),{code:'invalid_params'});assert.deepEqual(f.calls,[]);
});
test('an explicit matching project preserves the canonical payload',async()=>{
 const f=fixture();await deliverCapture({...payload(),project_id:'project'},profile,f);assert.deepEqual(f.calls.at(-1)[1],{...payload(),project_id:'project'});
});
for(const when of ['before','first_identity','registration','last_identity'])test('boolean revocation '+when+' prevents any later capture write',async()=>{
 const calls=[];let permitted=when!=='before',checks=0;
 await assert.rejects(deliverCapture(payload(),profile,{authorize:()=>permitted,
  checkIdentity:async()=>{checks++;if(when==='first_identity'&&checks===1||when==='last_identity'&&checks===2)permitted=false;},
  invoke:async name=>{calls.push(name);if(when==='registration')permitted=false;}}),{code:'capture_disabled'});
 assert.deepEqual(calls,['registration','last_identity'].includes(when)?['ultra_agent_register']:[]);
 if(when==='before')assert.equal(checks,0);
});
test('a rejected asynchronous authorization is handled without any write or unhandled rejection',async()=>{
 const f=fixture();await assert.rejects(deliverCapture(payload(),profile,{...f,authorize:async()=>{throw Error('synthetic denial');}}),{code:'invalid_params'});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(f.calls.length,0);
});
