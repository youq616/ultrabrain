/** Real runtime/library, SDK substituted explicitly; no installed Agent/model claim. */
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {register} from 'node:module';
import {state,reset,identity,Client} from './fixtures/client-sdk-stub.mjs';import {sha256} from '../src/core.mjs';
register(new URL('./fixtures/client-sdk-loader.mjs',import.meta.url));
const {evaluateClientRecall}=await import('../packages/ultrabrain-client/src/recall-eval.mjs');
const workspace=mkdtempSync(join(tmpdir(),'ub-eval-sdk-'));process.on('exit',()=>rmSync(workspace,{recursive:true,force:true}));
const id='00000001-1111-4111-8111-111111111111';
const profile={format:1,source:'default',workspace,allow_task_context:true,expected_instance:identity.instance_id,expected_actor:identity.actor_key,
 server:{transport:'stdio',command:'not-executed',args:[]}};
const selection=()=>({workspace,consent:true,top_k:1,cases:[{id:'first',task:'PRIVATE_TASK',relevant_ids:[id],forbidden_ids:[]}]});
const context=()=>({source_id:'default',memories:[{id,type:'preference',content:'PRIVATE_MEMORY',content_hash:sha256('PRIVATE_MEMORY'),
 status:'active',project_id:null,owned_by_caller:true,derivation_current:true}]});
const route=req=>req.name==='ultra_identity'?identity:context();
const setup=()=>{reset();state.onCall=route;};
test('evaluation SDK: one connection, identity checks around query, close before delivery',async()=>{
 setup();const r=await evaluateClientRecall(profile,selection());assert.equal(r.summary.hit_rate_at_k,1);assert.equal(state.closed,1);
 assert.deepEqual(state.calls.map(c=>c.name),['ultra_identity','ultra_identity','ultra_personal_context','ultra_identity']);
 assert.ok(!JSON.stringify(r).includes('PRIVATE'));assert.equal(r.semantic_quality_verified,false);
});
for(const patch of [{consent:false},{top_k:21},{cases:[]},{include_text:true}])test('evaluation SDK: invalid suite prevents connection '+JSON.stringify(patch),async()=>{
 setup();await assert.rejects(evaluateClientRecall(profile,{...selection(),...patch}));assert.equal(state.connections,0);
});
for(const field of ['expected_actor','expected_instance','workspace','allow_task_context'])test('evaluation SDK: profile gating '+field,async()=>{
 setup();const p={...profile};delete p[field];await assert.rejects(evaluateClientRecall(p,selection()));assert.equal(state.connections,0);
});
for(const phase of ['initial','before','after'])test('evaluation SDK: identity mismatch '+phase,async()=>{
 setup();let n=0;state.onCall=req=>req.name==='ultra_identity'&&++n===({initial:1,before:2,after:3}[phase])?{...identity,actor_key:'b'.repeat(64)}:route(req);
 await assert.rejects(evaluateClientRecall(profile,selection()),e=>e.code==='identity_mismatch'&&e.query_attempts===(phase==='after'?1:0));assert.equal(state.closed,1);
});
for(const phase of ['query','cleanup'])test('evaluation SDK: revoke at '+phase+' refuses complete report',async()=>{
 setup();let permitted=true;const close=Client.prototype.close;
 if(phase==='query')state.onCall=req=>{if(req.name==='ultra_personal_context')permitted=false;return route(req);};
 else Client.prototype.close=async function(){permitted=false;return close.call(this);};
 try{await assert.rejects(evaluateClientRecall(profile,selection(),{authorize:()=>permitted}),e=>e.code==='client_authorization_revoked'&&e.query_attempts===1);}
 finally{Client.prototype.close=close;}
});
test('evaluation SDK: workspace disappears during cleanup, query outcome remains uncertain',async()=>{
 setup();const w=mkdtempSync(join(tmpdir(),'ub-eval-cleanup-'));const close=Client.prototype.close;
 Client.prototype.close=async function(){rmSync(w,{recursive:true,force:true});return close.call(this);};
 try{await assert.rejects(evaluateClientRecall({...profile,workspace:w},{...selection(),workspace:w}),e=>e.code==='workspace_mismatch'&&e.query_delivery==='unconfirmed');}
 finally{Client.prototype.close=close;rmSync(w,{recursive:true,force:true});}
});
test('evaluation SDK: cancel during wire prevents further cases and closes',async()=>{
 setup();const c=new AbortController();state.onCall=(req,opts)=>{if(req.name==='ultra_personal_context'){assert.ok(opts.signal);c.abort();}return route(req);};
 await assert.rejects(evaluateClientRecall(profile,selection(),{signal:c.signal}),e=>e.code==='aborted'&&e.query_attempts===1);assert.equal(state.closed,1);
});
test('evaluation SDK: readonly baseline permissions unchanged when capture enabled',async()=>{
 setup();await evaluateClientRecall({...profile,allow_capture:true,allow_documents:true},selection());
 assert.ok(state.calls.every(c=>['ultra_identity','ultra_personal_context'].includes(c.name)));
});
test('evaluation SDK: copies profile and suite before first wait',async()=>{
 setup();const p=structuredClone(profile),q=selection();state.onCall=req=>{p.source='elsewhere';q.cases[0].task='CHANGED';return route(req);};
 const r=await evaluateClientRecall(p,q);assert.equal(r.source_id,'default');assert.equal(state.calls.find(c=>c.name==='ultra_personal_context').args.task,'PRIVATE_TASK');
});
test('evaluation SDK: denied and async authorization cannot initialize transport',async()=>{
 for(const authorize of [()=>false,async()=>true]){setup();await assert.rejects(evaluateClientRecall(profile,selection(),{authorize}));assert.equal(state.connections,0);}
});
