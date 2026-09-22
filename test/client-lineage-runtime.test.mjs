/** Production runtime and public package entry point with explicit SDK doubles. */
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {register} from 'node:module';
import {state,reset,identity} from './fixtures/client-sdk-stub.mjs';
import {lineagePair,uuid} from './helpers/lineage-fixture.mjs';
register(new URL('./fixtures/client-sdk-loader.mjs',import.meta.url));
const {connectClient}=await import('../packages/ultrabrain-client/src/runtime.mjs');
const {inspectClientLineage}=await import('../packages/ultrabrain-client/src/lineage.mjs');
const workspace=mkdtempSync(join(tmpdir(),'ub-lineage-sdk-'));
process.on('exit',()=>rmSync(workspace,{recursive:true,force:true}));
const input={format:1,source:'default',workspace,expected_instance:identity.instance_id,expected_actor:identity.actor_key,
 server:{transport:'stdio',command:'not-executed',args:[]}};
const request=()=>({memory_id:uuid(1),workspace,consent:true});
function route(){
 const p=lineagePair();return req=>req.name==='ultra_identity'?identity:{source_id:'default',memory:req.arguments.memory_id===p.memory.id?p.memory:p.source,
  read_only:true,trust:'untrusted-memory-data',coverage:'current'};
}
test('client lineage SDK: installable wrapper yields a verified report and closes readonly connection',async()=>{
 reset();state.onCall=route();const r=await inspectClientLineage(input,request());
 assert.equal(r.verdict.state,'matched');assert.equal(r.text_included,false);assert.equal(state.connections,1);assert.equal(state.closed,1);
 assert.ok(state.calls.every(x=>['ultra_identity','ultra_memory_read'].includes(x.name)));
 assert.equal(state.calls.filter(c=>c.name==='ultra_memory_read').length,3);
});
for(const bad of [{consent:false},{memory_id:'bad'},{include_text:'yes'},{extra:true}])test('client lineage SDK: pre-connect rejection '+JSON.stringify(bad),async()=>{
 reset();await assert.rejects(inspectClientLineage(input,{...request(),...bad}));assert.equal(state.connections,0);assert.equal(state.calls.length,0);
});
test('client lineage SDK: missing pins never start a transport',async()=>{
 reset();const p={...input};delete p.expected_actor;await assert.rejects(inspectClientLineage(p,request()),{code:'lineage_disabled'});assert.equal(state.connections,0);
});
for(const mode of ['false','async','throws'])test('client lineage SDK: connection-wide '+mode+' stops before any IO',async()=>{
 reset();const authorize=mode==='false'?()=>false:mode==='async'?async()=>true:()=>{throw Error('declined');};
 await assert.rejects(inspectClientLineage(input,request(),{authorize}));assert.equal(state.connections,0);
});
test('client lineage runtime: method-specific false authority stops before rechecking identity',async()=>{
 reset();const c=await connectClient(input);state.calls=[];try{
 await assert.rejects(c.lineage(request(),{authorize:()=>false}),{code:'client_authorization_revoked'});assert.equal(state.calls.length,0);
 }finally{await c.close();}
});
test('client lineage runtime: method-specific async authority is never treated as approval',async()=>{
 reset();const c=await connectClient(input);state.calls=[];try{
 await assert.rejects(c.lineage(request(),{authorize:async()=>true}),{code:'invalid_params'});assert.equal(state.calls.length,0);
 }finally{await c.close();}
});
for(const boundary of ['connection','operation'])test('client lineage runtime: '+boundary+' abort reaches identity and suppresses records',async()=>{
 reset();const outer=new AbortController(),inner=new AbortController();const c=await connectClient(input,{signal:outer.signal});state.calls=[];
 state.onCall=async(req,options)=>{assert.equal(req.name,'ultra_identity');assert.ok(options.signal);(boundary==='connection'?outer:inner).abort();return identity;};
 try{await assert.rejects(c.lineage(request(),{signal:inner.signal}),{code:'aborted'});assert.equal(state.calls.length,1);}finally{await c.close();}
});
test('client lineage runtime: identity mismatch after first read refuses source following',async()=>{
 reset();const c=await connectClient(input);const base=route();let checks=0;state.calls=[];
 state.onCall=req=>req.name==='ultra_identity'&&++checks===2?{...identity,actor_key:'b'.repeat(64)}:base(req);
 try{await assert.rejects(c.lineage(request()),{code:'identity_mismatch'});assert.equal(state.calls.filter(x=>x.name==='ultra_memory_read').length,1);}finally{await c.close();}
});
test('client lineage SDK: request input is snapshotted before transport handshake',async()=>{
 reset();const base=route(),r=request();state.onCall=req=>{if(req.name==='ultra_identity'){r.include_text=true;r.memory_id=uuid(9);}return base(req);};
 const result=await inspectClientLineage(input,r);assert.equal(result.memory.id,uuid(1));assert.equal(result.text,undefined);
});
test('client lineage SDK: operation failure closes transport and does not echo untrusted exception',async()=>{
 reset();state.onCall=req=>{if(req.name!=='ultra_identity')throw Error('PRIVATE_REMOTE_LOG');return identity;};
 await assert.rejects(inspectClientLineage(input,request()),e=>e.code==='lineage_read_unconfirmed'&&!e.message.includes('PRIVATE'));
 assert.equal(state.closed,1);
});

test('client lineage SDK: revocation during connection cleanup suppresses result delivery',async()=>{
 reset();state.onCall=route();let permit=true;
 const {Client}=await import('./fixtures/client-sdk-stub.mjs');const close=Client.prototype.close;
 Client.prototype.close=async function(){permit=false;return close.call(this);};
 try{await assert.rejects(inspectClientLineage(input,request(),{authorize:()=>permit}),e=>
  e.code==='client_authorization_revoked'&&e.read_delivery==='unconfirmed');}
 finally{Client.prototype.close=close;}
});
test('client lineage SDK: transport handshake failure never returns its raw message',async()=>{
 reset();state.onCall=()=>{throw Error('PRIVATE_HANDSHAKE_DETAILS');};
 await assert.rejects(inspectClientLineage(input,request()),e=>e.code==='lineage_read_unconfirmed'&&
  e.read_delivery==='not_started'&&!e.message.includes('PRIVATE'));
});
