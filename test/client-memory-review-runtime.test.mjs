/** Public SDK and real client code; official transport replaced by explicit doubles. */
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {register} from 'node:module';
import {state,reset,identity,Client} from './fixtures/client-sdk-stub.mjs';
import {row,uuid,hash} from './helpers/snapshot-audit-fixture.mjs';
register(new URL('./fixtures/client-sdk-loader.mjs',import.meta.url));
const {reviewClientMemory}=await import('../packages/ultrabrain-client/src/memory-review.mjs');
const {connectClient}=await import('../packages/ultrabrain-client/src/runtime.mjs');
const workspace=mkdtempSync(join(tmpdir(),'ub-review-sdk-'));process.on('exit',()=>rmSync(workspace,{recursive:true,force:true}));
const profile={format:1,source:'default',workspace,expected_instance:identity.instance_id,expected_actor:identity.actor_key,allow_capture:true,
 server:{transport:'stdio',command:'not-executed',args:[]}};
const request=()=>({operation:'apply',workspace,consent:true,memory_id:uuid(1),event_id:'manual-review',expected_revision:1,
 expected_content_hash:hash('PRIVATE_BODY'),expected_status:'candidate',expected_visibility:'private',expected_project_id:null,status:'active'});
function setup(){reset();state.onCall=req=>req.name==='ultra_identity'?identity:req.name==='ultra_memory_read'?
 {source_id:'default',memory:row(1,{content:'PRIVATE_BODY'}),read_only:true,trust:'untrusted-memory-data',coverage:'one'}:
 {id:uuid(1),revision:2,status:'active',replayed:false,assurance:'caller review'};}
test('review SDK: official client source path is fully wired and closes',async()=>{
 setup();const r=await reviewClientMemory(profile,request());assert.equal(r.write_delivery,'confirmed');assert.equal(state.closed,1);
 assert.deepEqual(state.calls.map(c=>c.name),['ultra_identity','ultra_identity','ultra_memory_read','ultra_identity','ultra_personal_review','ultra_identity']);
});
test('review SDK: no write permission refuses before opening transport',async()=>{
 setup();await assert.rejects(reviewClientMemory({...profile,allow_capture:false},request()),{code:'memory_review_disabled'});assert.equal(state.connections,0);
});
for(const field of ['expected_actor','expected_instance','workspace'])test('review SDK: missing binding '+field,async()=>{
 setup();const p={...profile};delete p[field];await assert.rejects(reviewClientMemory(p,request()),{code:'memory_review_disabled'});assert.equal(state.connections,0);
});
for(const auth of [()=>false,async()=>true,()=>{throw Error('PRIVATE_AUTH');}])test('review SDK: denied authority before transport',async()=>{
 setup();await assert.rejects(reviewClientMemory(profile,request(),{authorize:auth}));assert.equal(state.connections,0);
});
test('review SDK: profile/request changes after handshake cannot change the action',async()=>{
 setup();const p=structuredClone(profile),q=request(),route=state.onCall;state.onCall=req=>{p.source='other';q.status='archived';return route(req);};
 const r=await reviewClientMemory(p,q);assert.equal(r.receipt.status,'active');assert.equal(r.source_id,'default');
});
for(const phase of ['handshake','pre-read','pre-write','post-write'])test('review SDK identity mismatch '+phase,async()=>{
 setup();let n=0;const route=state.onCall;state.onCall=req=>req.name==='ultra_identity'&&++n==={handshake:1,'pre-read':2,'pre-write':3,'post-write':4}[phase]?
 {...identity,actor_key:'b'.repeat(64)}:route(req);
 await assert.rejects(reviewClientMemory(profile,request()),e=>e.code==='identity_mismatch'&&e.write_delivery===(phase==='post-write'?'confirmed':'not_started'));
 assert.equal(state.closed,1);
});
for(const phase of ['read','write','cleanup'])test('review SDK revocation '+phase,async()=>{
 setup();let live=true;const route=state.onCall,close=Client.prototype.close;
 state.onCall=req=>{if(phase==='read'&&req.name==='ultra_memory_read'||phase==='write'&&req.name==='ultra_personal_review')live=false;return route(req);};
 if(phase==='cleanup')Client.prototype.close=async function(){live=false;return close.call(this);};
 try{await assert.rejects(reviewClientMemory(profile,request(),{authorize:()=>live}),e=>e.code==='client_authorization_revoked'&&
  e.write_delivery===(phase==='read'?'not_started':phase==='write'?'unconfirmed':'confirmed'));}finally{Client.prototype.close=close;}
});
test('review SDK: cleanup failure withholds data but preserves confirmed acknowledgement fact',async()=>{
 setup();const close=Client.prototype.close;Client.prototype.close=async()=>{throw Error('PRIVATE_CLEANUP');};
 try{await assert.rejects(reviewClientMemory(profile,request()),e=>e.code==='memory_review_cleanup_failed'&&e.write_delivery==='confirmed'&&!e.message.includes('PRIVATE'));}
 finally{Client.prototype.close=close;}
});
test('review SDK: workspace loss during cleanup withholds a confirmed result, does not deny prior write',async()=>{
 setup();const dir=mkdtempSync(join(tmpdir(),'ub-review-lost-')),close=Client.prototype.close;
 Client.prototype.close=async function(){rmSync(dir,{recursive:true,force:true});return close.call(this);};
 try{await assert.rejects(reviewClientMemory({...profile,workspace:dir},{...request(),workspace:dir}),e=>e.code==='workspace_mismatch'&&e.write_delivery==='confirmed');}
 finally{Client.prototype.close=close;rmSync(dir,{recursive:true,force:true});}
});
for(const kind of ['outer','operation'])test('review runtime propagates '+kind+' cancellation to actual call options',async()=>{
 setup();const outer=new AbortController(),inner=new AbortController();const c=await connectClient(profile,{signal:outer.signal});const route=state.onCall;
 state.onCall=(req,options)=>{if(req.name==='ultra_personal_review'){assert.ok(options.signal);(kind==='outer'?outer:inner).abort();}return route(req);};
 try{await assert.rejects(c.reviewMemory(request(),{signal:inner.signal}),e=>e.code==='aborted'&&e.write_delivery==='unconfirmed');}
 finally{await c.close();}
});
test('review SDK: ambiguous lost acknowledgement attempts once and never silently retries',async()=>{
 setup();const route=state.onCall;state.onCall=req=>{if(req.name==='ultra_personal_review')throw Error('PRIVATE_REMOTE');return route(req);};
 await assert.rejects(reviewClientMemory(profile,request()),e=>e.write_delivery==='unconfirmed');
 assert.equal(state.calls.filter(c=>c.name==='ultra_personal_review').length,1);assert.equal(state.closed,1);
});

test('review SDK: native insufficient_scope is projected without echoing remote text',async()=>{
 setup();const original=Client.prototype.callTool;
 Client.prototype.callTool=async function(req,...rest){
  if(req.name==='ultra_personal_review')return {isError:true,content:[{type:'text',text:JSON.stringify({error:'insufficient_scope',message:'PRIVATE_SERVER_DETAIL'})}]};
  return original.call(this,req,...rest);
 };
 try{await assert.rejects(reviewClientMemory(profile,request()),e=>e.code==='insufficient_scope'&&e.write_delivery==='unconfirmed'&&!e.message.includes('PRIVATE'));}
 finally{Client.prototype.callTool=original;}
});
