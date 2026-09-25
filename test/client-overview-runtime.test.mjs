/** Real client source / library with explicitly substituted SDK transport. */
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {register} from 'node:module';
import {state,reset,identity,Client} from './fixtures/client-sdk-stub.mjs';
import {overviewReceipt} from './helpers/overview-fixture.mjs';
register(new URL('./fixtures/client-sdk-loader.mjs',import.meta.url));
const {inspectClientOverview}=await import('../packages/ultrabrain-client/src/overview.mjs');
const {connectClient}=await import('../packages/ultrabrain-client/src/runtime.mjs');
const workspace=mkdtempSync(join(tmpdir(),'ub-overview-sdk-'));
process.on('exit',()=>rmSync(workspace,{recursive:true,force:true}));
const profile={format:1,source:'default',workspace,project_id:'project',expected_instance:identity.instance_id,expected_actor:identity.actor_key,
 server:{transport:'stdio',command:'not-executed',args:[]}};
const request=()=>({workspace,consent:true,scope:'owned-all-projects'});
const route=req=>req.name==='ultra_identity'?identity:overviewReceipt(req.arguments.request_id,'default');
function setup(){reset();state.onCall=route;}
test('one-shot SDK delivers verified counts, no bodies or writes, then closes',async()=>{
 setup();const r=await inspectClientOverview(profile,request());assert.equal(r.overview.memories.total,12);
 assert.equal(state.connections,1);assert.equal(state.closed,1);
 assert.deepEqual(state.calls.map(c=>c.name),['ultra_identity','ultra_identity','ultra_personal_overview','ultra_identity']);
 assert.equal(r.memory_writes_requested,false);
});
for(const patch of [{consent:false},{scope:'project'},{workspace:'not-absolute'},{source_id:'other'}])test('invalid input blocks transport '+JSON.stringify(patch),async()=>{
 setup();await assert.rejects(inspectClientOverview(profile,{...request(),...patch}));assert.equal(state.connections,0);
});
for(const pin of ['expected_actor','expected_instance','workspace'])test('missing pin blocks transport '+pin,async()=>{
 setup();const p={...profile};delete p[pin];await assert.rejects(inspectClientOverview(p,request()),{code:'overview_disabled'});assert.equal(state.connections,0);
});
for(const auth of [()=>false,async()=>true,()=>{throw Error('PRIVATE_DENIAL');}])test('denied SDK authority cannot open transport',async()=>{
 setup();await assert.rejects(inspectClientOverview(profile,request(),{authorize:auth}));assert.equal(state.connections,0);
});
test('profile and request are copied before handshake',async()=>{
 setup();const input=structuredClone(profile),selection=request();state.onCall=req=>{
  input.source='changed';input.server.command='changed';selection.consent=false;selection.workspace='changed';return route(req);
 };
 const r=await inspectClientOverview(input,selection);assert.equal(r.overview.source_id,'default');
});
for(const phase of ['handshake','before-read','after-read'])test('identity pin mismatch refuses '+phase,async()=>{
 setup();let n=0;state.onCall=req=>req.name==='ultra_identity'&&++n===({'handshake':1,'before-read':2,'after-read':3}[phase])?
 {...identity,actor_key:'b'.repeat(64)}:route(req);
 await assert.rejects(inspectClientOverview(profile,request()),e=>e.code==='identity_mismatch'&&e.read_delivery===(phase==='after-read'?'unconfirmed':'not_started'));
 assert.equal(state.closed,1);
});
for(const kind of ['connection','operation'])test('runtime '+kind+' cancellation reaches wire',async()=>{
 setup();const outer=new AbortController(),inner=new AbortController();const c=await connectClient(profile,{signal:outer.signal});state.calls=[];
 state.onCall=(req,options)=>{if(req.name==='ultra_personal_overview'){assert.ok(options.signal);(kind==='connection'?outer:inner).abort();}return route(req);};
 try{await assert.rejects(c.overview(request(),{signal:inner.signal}),e=>e.code==='aborted'&&e.read_delivery==='unconfirmed');}
 finally{await c.close();}
});
for(const phase of ['identity','response','cleanup'])test('SDK authority withdrawal suppresses '+phase,async()=>{
 setup();let permit=true;const close=Client.prototype.close;
 state.onCall=req=>{if(phase==='identity'||phase==='response'&&req.name==='ultra_personal_overview')permit=false;return route(req);};
 if(phase==='cleanup')Client.prototype.close=async function(){permit=false;return close.call(this);};
 try{await assert.rejects(inspectClientOverview(profile,request(),{authorize:()=>permit}),e=>e.code==='client_authorization_revoked'&&e.read_delivery===(phase==='identity'?'not_started':'unconfirmed'));}
 finally{Client.prototype.close=close;}
});
test('transport error is sanitized, closes and never retries',async()=>{
 setup();state.onCall=req=>{if(req.name!=='ultra_identity')throw Error('PRIVATE_SERVER_DIAGNOSTIC');return identity;};
 await assert.rejects(inspectClientOverview(profile,request()),e=>e.code==='overview_read_unconfirmed'&&e.read_delivery==='unconfirmed'&&!e.message.includes('PRIVATE'));
 assert.equal(state.calls.filter(c=>c.name==='ultra_personal_overview').length,1);assert.equal(state.closed,1);
});
test('pre-abort neither starts a transport nor loses read-only failure semantics',async()=>{
 setup();const controller=new AbortController();controller.abort();
 await assert.rejects(inspectClientOverview(profile,request(),{signal:controller.signal}),e=>e.code==='aborted'&&e.read_delivery==='not_started');assert.equal(state.connections,0);
});

test('self-review: workspace loss during SDK cleanup withholds the completed read',async()=>{
 setup();const dir=mkdtempSync(join(tmpdir(),'ub-overview-lost-')),p={...profile,workspace:dir},r={...request(),workspace:dir};
 const close=Client.prototype.close;Client.prototype.close=async function(){rmSync(dir,{recursive:true,force:true});return close.call(this);};
 try{await assert.rejects(inspectClientOverview(p,r),e=>e.read_delivery==='unconfirmed');}
 finally{Client.prototype.close=close;rmSync(dir,{recursive:true,force:true});}
});
