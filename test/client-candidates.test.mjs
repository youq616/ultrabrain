/** Client last-mile/installed API source; transport responses here are synthetic. */
import test from 'node:test';import assert from 'node:assert/strict';import {register} from 'node:module';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {state,reset,identity,Client} from './fixtures/client-sdk-stub.mjs';
import {CANDIDATES_FORMAT,CANDIDATES_SCOPE} from '../src/personal-candidates-contract.mjs';
import {candidatesRequest,deliverCandidates,candidatesFailure} from '../src/client-candidates.mjs';
register(new URL('./fixtures/client-sdk-loader.mjs',import.meta.url));
const {listClientCandidates}=await import('../packages/ultrabrain-client/src/candidates.mjs');
const {connectClient}=await import('../packages/ultrabrain-client/src/runtime.mjs');
const dir=mkdtempSync(join(tmpdir(),'ub-candidates-'));process.on('exit',()=>rmSync(dir,{recursive:true,force:true}));
const raw={format:1,source:'default',workspace:dir,expected_instance:identity.instance_id,expected_actor:identity.actor_key,
 server:{transport:'stdio',command:'not-executed',args:[]}};
const profile={source:'default',workspace:dir,expectedInstance:identity.instance_id,expectedActor:identity.actor_key,projectId:null};
const selection=()=>({workspace:dir,consent:true,limit:20});
const page=r=>({format:CANDIDATES_FORMAT,scope:CANDIDATES_SCOPE,source_id:'default',request_id:r.request_id,project_id:r.project_id??null,
 after_id:r.after_id??null,limit:r.limit,observed_at:'2026-09-27T00:00:00.000Z',memories:[],returned:0,has_more:false,next_after:null,
 read_only:true,model_calls:0,trust:'untrusted-memory-metadata',snapshot:false});
function setup(){reset();state.onCall=req=>{if(req.name==='ultra_identity')return identity;
 assert.equal(req.name,'ultra_personal_candidates');return page(req.arguments);};}
test('client candidates: SDK source connects, one read, closes, read-only profile accepted',async()=>{
 setup();const r=await listClientCandidates(raw,selection());assert.equal(r.read_requests,1);assert.equal(r.memory_writes_requested,false);assert.equal(state.closed,1);
 assert.deepEqual(state.calls.map(c=>c.name),['ultra_identity','ultra_identity','ultra_personal_candidates','ultra_identity']);
 assert.ok(Object.isFrozen(r.page.memories));
});
test('client candidates: derive project from pinned profile, do not send workspace or permission flags',async()=>{
 setup();const r=await listClientCandidates({...raw,project_id:'mine'},selection());assert.equal(r.page.project_id,'mine');
 const sent=state.calls.find(c=>c.name==='ultra_personal_candidates').args;
 assert.deepEqual(Object.keys(sent).sort(),['limit','project_id','request_id']);
});
for(const patch of [{consent:false},{limit:0},{limit:51},{after_id:'bad'},{project_id:'mine'},{include_text:true},{operation:'apply'},{limit:null}])
 test('client candidates: selection rejected before transport '+JSON.stringify(patch),async()=>{
  setup();await assert.rejects(listClientCandidates(raw,{...selection(),...patch}));assert.equal(state.connections,0);
 });
for(const key of ['expected_instance','expected_actor','workspace'])test('client candidates: no implicit identity/workspace binding '+key,async()=>{
 setup();const p={...raw};delete p[key];await assert.rejects(listClientCandidates(p,selection()),{code:'candidates_disabled'});assert.equal(state.connections,0);
});
for(const auth of [()=>false,async()=>true,()=>{throw Error('PRIVATE');}])test('client candidates: reject revoked/async authority without IO',async()=>{
 setup();await assert.rejects(listClientCandidates(raw,selection(),{authorize:auth}));assert.equal(state.connections,0);
});
for(const stage of ['pre-read','response','post-read','close'])test('client candidates: revoke during '+stage+' withholds page',async()=>{
 setup();let live=true,n=0;const route=state.onCall,close=Client.prototype.close;
 state.onCall=req=>{if(req.name==='ultra_identity'&&++n===(stage==='pre-read'?2:stage==='post-read'?3:-1)||stage==='response'&&req.name==='ultra_personal_candidates')live=false;return route(req);};
 if(stage==='close')Client.prototype.close=async function(){live=false;return close.call(this);};
 try{await assert.rejects(listClientCandidates(raw,selection(),{authorize:()=>live}),e=>e.code==='client_authorization_revoked'&&
  e.read_delivery===(stage==='pre-read'?'not_started':'unconfirmed'));assert.equal(state.closed,1);}
 finally{Client.prototype.close=close;}
});
for(const key of ['outer','operation'])test('client candidates: '+key+' AbortSignal reaches actual SDK options',async()=>{
 setup();const a=new AbortController(),b=new AbortController();const c=await connectClient(raw,{signal:a.signal}),route=state.onCall;
 state.onCall=(req,opts)=>{if(req.name==='ultra_personal_candidates'){assert.ok(opts.signal);(key==='outer'?a:b).abort();}return route(req);};
 try{await assert.rejects(c.candidates(selection(),{signal:b.signal}),{code:'aborted'});}finally{await c.close();}
});
test('client candidates: close failure sanitizes diagnostics and retains read-attempt fact',async()=>{
 setup();const close=Client.prototype.close;Client.prototype.close=async()=>{throw Error('PRIVATE_CLOSE');};
 try{await assert.rejects(listClientCandidates(raw,selection()),e=>e.code==='candidates_cleanup_failed'&&e.read_delivery==='unconfirmed'&&!e.message.includes('PRIVATE'));}
 finally{Client.prototype.close=close;}
});
test('client candidates: identity changes after read, no successful partial result',async()=>{
 setup();let n=0;const route=state.onCall;state.onCall=req=>req.name==='ultra_identity'&&++n===3?{...identity,actor_key:'f'.repeat(64)}:route(req);
 await assert.rejects(listClientCandidates(raw,selection()),{code:'identity_mismatch'});
});
test('client candidates: missing new tool does not make older optional client probe mandatory',async()=>{
 setup();state.onCall=req=>{if(req.name==='ultra_personal_candidates')throw Error('PRIVATE_UNKNOWN_TOOL');return identity;};
 await assert.rejects(listClientCandidates(raw,selection()),e=>e.read_delivery==='unconfirmed'&&!e.message.includes('PRIVATE'));
 assert.equal(state.calls.filter(c=>c.name==='ultra_personal_candidates').length,1);
});
test('client candidates: first await cannot change captured input',async()=>{
 setup();const p=structuredClone(raw),r=selection(),route=state.onCall;
 state.onCall=req=>{p.project_id='other';r.limit=50;r.consent=false;return route(req);};
 const result=await listClientCandidates(p,r);assert.equal(result.page.limit,20);assert.equal(result.page.project_id,null);
});
test('client candidates: no remote attempt counters trusted',()=>{
 const e=candidatesFailure({code:'PRIVATE',read_attempts:999});assert.equal(e.read_attempts,0);assert.equal(e.read_delivery,'not_started');
});
test('client candidates: malformed reply throws and is not empty success',async()=>{
 setup();const route=state.onCall;state.onCall=req=>req.name==='ultra_personal_candidates'?{...page(req.arguments),source_id:'foreign'}:route(req);
 await assert.rejects(listClientCandidates(raw,selection()),{code:'personal_candidates_unconfirmed'});assert.equal(state.closed,1);
});
