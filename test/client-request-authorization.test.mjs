/** Actual client runtime with explicit SDK doubles; real SDK/DB coverage is separate. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {register} from 'node:module';
import {state,reset,identity} from './fixtures/client-sdk-stub.mjs';
register(new URL('./fixtures/client-sdk-loader.mjs',import.meta.url));
const {connectClient}=await import('../packages/ultrabrain-client/src/runtime.mjs');
const input={format:1,source:'default',allow_capture:true,allow_documents:true,
 server:{transport:'stdio',command:'synthetic-not-executed',args:[]}};
const capture=()=>({agent_id:'fixture',event_id:'event',transcript:'Original explicitly consented text',consent:true});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};

test('connection-wide false authorization refuses before starting a transport',async()=>{
 reset();await assert.rejects(connectClient(input,{authorize:()=>false}),{code:'client_authorization_revoked'});
 assert.equal(state.connections,0);assert.equal(state.calls.length,0);
});
for(const authorize of [false,async()=>false,async()=>{throw Error('PRIVATE_DENIAL');}])test('unsupported connection authorization fails closed '+typeof authorize,async()=>{
 reset();await assert.rejects(connectClient(input,{authorize}),{code:'invalid_params'});
 await new Promise(r=>setImmediate(r));assert.equal(state.connections,0);assert.equal(state.calls.length,0);
});
for(const name of ['ultra_personal_capture','ultra_personal_review','ultra_personal_context','ultra_personal_document_read'])test('revoked live connection cannot forward '+name,async()=>{
 reset();let allowed=true;const c=await connectClient(input,{authorize:()=>allowed});state.calls=[];allowed=false;
 try{await assert.rejects(c.callAllowed(name,capture()),{code:'client_authorization_revoked'});assert.equal(state.calls.length,0);}
 finally{await c.close();}
});
test('revocation while checking identity prevents the following plaintext write',async()=>{
 reset();let allowed=true;const c=await connectClient(input,{authorize:()=>allowed});state.calls=[];
 state.onCall=async request=>{assert.equal(request.name,'ultra_identity');allowed=false;return identity;};
 try{await assert.rejects(c.callAllowed('ultra_personal_capture',capture()),{code:'client_authorization_revoked'});
 assert.deepEqual(state.calls.map(x=>x.name),['ultra_identity']);}finally{await c.close();}
});
test('request consent and nested content are frozen before the identity wait',async()=>{
 reset();const c=await connectClient(input),waiting=deferred(),started=deferred();state.calls=[];
 state.onCall=async request=>{if(request.name==='ultra_identity'){started.resolve();await waiting.promise;return identity;}return {stored:true};};
 const args={agent_id:'fixture',event_id:'event',consent:true,memories:[{type:'preference',content:'ORIGINAL'}]};
 const pending=c.callAllowed('ultra_memory_commit',args);await started.promise;
 args.consent=false;args.event_id='replaced';args.memories[0].content='UNCONSENTED_REPLACEMENT';waiting.resolve();
 try{await pending;assert.deepEqual(state.calls.at(-1).args,{agent_id:'fixture',event_id:'event',consent:true,memories:[{type:'preference',content:'ORIGINAL'}]});}
 finally{await c.close();}
});
test('pre-cancelled proxy request starts neither identity nor content request',async()=>{
 reset();const c=await connectClient(input);state.calls=[];const controller=new AbortController();controller.abort();
 try{await assert.rejects(c.callAllowed('ultra_personal_capture',capture(),controller.signal),{code:'aborted'});
 assert.equal(state.calls.length,0);}finally{await c.close();}
});
test('request cancellation is propagated into the pending identity lookup',async()=>{
 reset();const c=await connectClient(input),controller=new AbortController();state.calls=[];
 state.onCall=async (request,options)=>{assert.equal(request.name,'ultra_identity');
  assert.ok(options.signal,'Request signal must protect identity, not just final write');controller.abort();return identity;};
 try{await assert.rejects(c.callAllowed('ultra_personal_capture',capture(),controller.signal),{code:'aborted'});
 assert.deepEqual(state.calls.map(x=>x.name),['ultra_identity']);}finally{await c.close();}
});
for(const name of ['ultra_personal_context','ultra_memory_commit'])test('revocation while '+name+' is pending suppresses returned private data',async()=>{
 reset();let allowed=true;const c=await connectClient(input,{authorize:()=>allowed});state.calls=[];
 state.onCall=async request=>{if(request.name==='ultra_identity')return identity;allowed=false;return {content:'PRIVATE_RESULT'};};
 try{await assert.rejects(c.callAllowed(name,{consent:true}),{code:'client_authorization_revoked'});
 assert.equal(state.calls.filter(x=>x.name===name).length,1);}finally{await c.close();}
});
test('revoked catalog cannot leak a cached or fresh write surface',async()=>{
 reset();let allowed=true;const c=await connectClient(input,{authorize:()=>allowed});allowed=false;state.calls=[];
 try{await assert.rejects(c.catalog(),{code:'client_authorization_revoked'});assert.equal(state.calls.length,0);}finally{await c.close();}
});
test('revocation while a catalog page is pending suppresses tools',async()=>{
 reset();let allowed=true;const c=await connectClient(input,{authorize:()=>allowed});
 state.onList=async()=>{allowed=false;return {tools:[{name:'ultra_personal_capture'}]};};
 try{await assert.rejects(c.catalog(),{code:'client_authorization_revoked'});}finally{await c.close();}
});
test('read-only permissions and explicit consent still refuse without a network call',async()=>{
 reset();const c=await connectClient({...input,allow_capture:false});state.calls=[];
 try{await assert.rejects(c.callAllowed('ultra_personal_capture',capture()),{code:'permission_denied'});assert.equal(state.calls.length,0);}finally{await c.close();}
 reset();const w=await connectClient(input);state.calls=[];
 try{await assert.rejects(w.callAllowed('ultra_memory_commit',{consent:false}),{code:'capture_disabled'});assert.equal(state.calls.length,0);}finally{await w.close();}
});
test('upstream identity change is not hidden by the local authorization guard',async()=>{
 reset();const c=await connectClient(input);state.calls=[];state.onCall=async()=>({...identity,actor_key:'b'.repeat(64)});
 try{await assert.rejects(c.callAllowed('ultra_personal_context',{}),{code:'identity_mismatch'});assert.equal(state.calls.length,1);}finally{await c.close();}
});
test('pre-cancelled tools listing never reaches the upstream catalogue',async()=>{
 reset();const c=await connectClient(input),controller=new AbortController();controller.abort();state.calls=[];
 try{await assert.rejects(c.catalog(controller.signal),{code:'aborted'});assert.deepEqual(state.calls,[]);}finally{await c.close();}
});
test('catalog cancellation propagates into the current page and prevents the next',async()=>{
 reset();const c=await connectClient(input),controller=new AbortController();state.calls=[];
 state.onList=async options=>{assert.ok(options.signal);controller.abort();return {tools:[],nextCursor:'next'};};
 try{await assert.rejects(c.catalog(controller.signal),{code:'aborted'});assert.equal(state.calls.length,1);assert.equal(state.calls[0].signal.aborted,true);}finally{await c.close();}
});

test('exact memory reads are available with readonly client permission and frozen IDs',async()=>{
 reset();const c=await connectClient({...input,allow_capture:false,allow_documents:false});state.calls=[];
 try{await c.callAllowed('ultra_memory_read',{memory_id:'11111111-1111-4111-8111-111111111111'});
 assert.deepEqual(state.calls.map(x=>x.name),['ultra_identity','ultra_memory_read']);}finally{await c.close();}
});
