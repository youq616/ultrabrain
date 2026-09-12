import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {bindBridge,bridgeOptions} from '../src/lifecycle-bridge.mjs';
import {snapshotTokenFetch} from '../src/consolidation-client.mjs';
const identity={format:1,instance_id:'00000000-0000-4000-8000-000000000001',actor_key:'a'.repeat(64),source_id:'default'};
const wrap=x=>({content:[{type:'text',text:JSON.stringify(x)}]});
function client() {
 let id=identity;const calls=[];
 return {calls,setId:val=>id=val,async callTool(r){calls.push(r);return wrap(r.name==='ultra_identity'?id:
  r.name==='ultra_retrieve'?{items:[]}:{state:'queued',deferred:true,storage:'journaled',uri:'ultra://default/sessions/one'});}};
}
const options={rootUri:'ultra://default/',capture:false,visibility:'private',memoryPolicy:'current'};
function dir(t){const p=mkdtempSync(join(tmpdir(),'ub-bridge-'));t.after(()=>rmSync(p,{recursive:true,force:true}));return p;}
test('no capture without process-level opt-in, even with a crafted event',async()=>{
 const c=client(),b=await bindBridge(c,options);
 await assert.rejects(b.handle({event:'after_turn',session_id:'s',event_id:'e',transcript:'secret'}),{code:'capture_disabled'});
 assert.ok(c.calls.every(r=>r.name==='ultra_identity'));
 await assert.rejects(b.handle({event:'after_turn',session_id:'s',capture:true}),{code:'invalid_params'});
});
test('authenticated source mismatch fails before creating a local journal',async t=>{
 const c=client(),directory=dir(t);c.setId({...identity,source_id:'other'});
 await assert.rejects(bindBridge(c,{...options,capture:true,outbox:directory}),{code:'identity_mismatch'});
 assert.equal(readdirSync(directory).length,0);
});
test('identity changes stop processing before any queued transcript is delivered',async t=>{
 const c=client(),directory=dir(t),b=await bindBridge(c,{...options,capture:true,outbox:directory});
 c.setId({...identity,actor_key:'b'.repeat(64)});
 await assert.rejects(b.handle({event:'after_turn',session_id:'s',event_id:'e',transcript:'secret'}),{code:'identity_mismatch'});
 assert.ok(c.calls.every(r=>r.name==='ultra_identity'));
});
test('source and server identity cannot be supplied by an event',async()=>{
 const c=client(),b=await bindBridge(c,options);
 for(const field of ['source_id','rootUri','actor_key','command','serverId'])
  await assert.rejects(b.handle({event:'before_turn',session_id:'s',query:'q',[field]:'attacker'}),{code:'invalid_params'});
});
test('event capture uses server-confirmed binding and confirms journal delivery only',async t=>{
 const directory=dir(t),c=client(),b=await bindBridge(c,{...options,capture:true,outbox:directory});
 const r=await b.handle({event:'after_turn',session_id:'s',event_id:'e',transcript:'consented'});
 assert.equal(r.delivery.storage,'journaled');assert.equal(c.calls.at(-1).arguments.defer_extraction,true);
 // A new invocation with the same identity reuses the immutable ACK without re-sending.
 const fresh=await bindBridge(c,{...options,capture:true,outbox:directory}),n=c.calls.filter(r=>r.name==='ultra_commit_session').length;
 await fresh.handle({event:'after_turn',session_id:'s',event_id:'e',transcript:'consented'});
 assert.equal(c.calls.filter(r=>r.name==='ultra_commit_session').length,n);
});
test('read-only invocation fetches context but does not capture or invoke a model',async()=>{
 const c=client(),b=await bindBridge(c,options);
 const r=await b.handle({event:'before_turn',session_id:'s',query:'resume'});
 assert.equal(r.context.items.length,0);assert.equal(c.calls.at(-1).name,'ultra_retrieve');
});
test('CLI validates explicit capture, token files, endpoint policy and duplicate settings',()=>{
 const args=['--url','https://memory.example/mcp','--token-file','/tmp/token','--root','ultra://default/'];
 assert.equal(bridgeOptions(args).capture,false);
 assert.throws(()=>bridgeOptions([...args,'--capture']),{code:'invalid_params'});
 assert.equal(bridgeOptions([...args,'--capture','--outbox','/tmp/private']).capture,true);
 assert.throws(()=>bridgeOptions([...args,'--root','ultra://other/']),{code:'invalid_params'});
 assert.throws(()=>bridgeOptions([...args,'--memory-policy','unchecked']),{code:'invalid_params'});
});
test('credential is pinned between identity and delivery despite token-file rotation',async t=>{
 const directory=dir(t),path=join(directory,'token');writeFileSync(path,'gbrain_original_secret',{mode:0o600});
 const seen=[];const f=snapshotTokenFetch('https://memory.example/mcp',path,async(u,o)=>{seen.push(o.headers.get('Authorization'));assert.equal(o.redirect,'error');return new Response('{}');});
 await f('https://memory.example/mcp');writeFileSync(path,'gbrain_changed_secret');await f('https://memory.example/mcp');
 assert.deepEqual(seen,['Bearer gbrain_original_secret','Bearer gbrain_original_secret']);
 assert.throws(()=>f('https://other.example/mcp'),{code:'insecure_endpoint'});
});
