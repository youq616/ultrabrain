import test from 'node:test';
import assert from 'node:assert/strict';
import {automationSession,automationSettings,validateAutomationRequest,validateJournalReceipt} from '../src/automation-session.mjs';
import {automationEndpoint,credentialFetch} from '../src/automation-transport.mjs';
import {UltraError} from '../src/core.mjs';
const who={format:1,instance_id:'00000000-0000-4000-8000-000000000001',actor_key:'a'.repeat(64),source_id:'default'};
const receipt={state:'queued',deferred:true,storage:'journaled',uri:'ultra://default/sessions/deferred/a'};
const wrap=x=>({content:[{type:'text',text:JSON.stringify(x)}]});
const settings={rootUri:'ultra://default/'};
function fixture(){let identity=who;const calls=[];return {calls,setIdentity:x=>identity=x,async callTool(p){calls.push(p);return wrap(p.name==='ultra_identity'?identity:p.name==='ultra_retrieve'?{items:[]}:receipt);}};}
const event={session_id:'s',event_id:'e',transcript:'consented',consent:true};
test('automation is read-only by default; preflight rejects string consent',()=>{
 const s=automationSettings(settings);assert.equal(s.allowCapture,false);
 assert.throws(()=>validateAutomationRequest('after_turn',event,s),{code:'capture_disabled'});
 assert.throws(()=>validateAutomationRequest('after_turn',{...event,consent:'true'},automationSettings({...settings,allowCapture:true})),{code:'capture_disabled'});
});
for(const bad of ['http://other.example/mcp','https://user:password@memory.example/mcp','https://memory.example/mcp?token=x','https://memory.example/mcp#x','file:///tmp/key'])
 test('reject insecure endpoint '+bad,()=>assert.throws(()=>automationEndpoint(bad),{code:'insecure_endpoint'}));
test('loopback HTTP and HTTPS are explicit accepted transports',()=>{
 assert.equal(automationEndpoint('http://127.0.0.1:3131/mcp'),'http://127.0.0.1:3131/mcp');
 assert.equal(automationEndpoint('https://memory.example/mcp'),'https://memory.example/mcp');
});
test('identity pins are checked before memory access',async()=>{
 const c=fixture();await assert.rejects(automationSession(c,{...settings,expectedActor:'b'.repeat(64)}),{code:'identity_mismatch'});
 assert.deepEqual(c.calls.map(x=>x.name),['ultra_identity']);
});
test('identity is checked again before each item',async()=>{
 const c=fixture(),s=await automationSession(c,{...settings,allowCapture:true});c.setIdentity({...who,actor_key:'b'.repeat(64)});
 await assert.rejects(s.run('after_turn',event),{code:'identity_mismatch',delivery:'not_submitted'});
 assert.ok(c.calls.every(x=>x.name==='ultra_identity'));
});
test('source, endpoint, command and arbitrary tools are not request fields',()=>{
 const s=automationSettings(settings);
 for(const key of ['source_id','token','endpoint','command','operation','tool'])
 assert.throws(()=>validateAutomationRequest('before_turn',{session_id:'s',query:'q',[key]:'injected'},s));
 assert.throws(()=>validateAutomationRequest('execute',{},s));
});
test('shared capture and directory escape are refused before submission',()=>{
 const s=automationSettings({...settings,allowCapture:true});
 assert.throws(()=>validateAutomationRequest('after_turn',{...event,visibility:'world'},s),{code:'scope_denied'});
 assert.throws(()=>validateAutomationRequest('after_turn',event,automationSettings({...settings,allowCapture:true,rootUri:'ultra://default/p'})),{code:'scope_denied'});
});
test('capture must have stable IDs; no timestamps or random fallback is generated',()=>{
 const s=automationSettings({...settings,allowCapture:true});
 for(const id of ['',null,'../x','a'.repeat(97)])assert.throws(()=>validateAutomationRequest('after_turn',{...event,event_id:id},s));
});
test('capture succeeds only with a structured same-source journal ACK',async()=>{
 const c=fixture(),s=await automationSession(c,{...settings,allowCapture:true});
 const r=await s.run('after_turn',event);assert.equal(r.confirmed,true);assert.equal(r.delivery.state,'queued');
 assert.equal(c.calls.at(-1).arguments.defer_extraction,true);assert.equal(c.calls.at(-1).arguments.visibility,'private');
 assert.ok(!JSON.stringify(r).includes(event.transcript));
});
for(const r of [{},{...receipt,state:'made_up'},{...receipt,storage:'stored'},{...receipt,deferred:false}])
 test('incomplete or mismatched delivery is never confirmed '+JSON.stringify(r),()=>assert.throws(()=>validateJournalReceipt(r,'default')));
test('transport exceptions do not leak credential or provider text; writes remain unconfirmed',async()=>{
 const c=fixture(),s=await automationSession(c,{...settings,allowCapture:true});
 const old=c.callTool.bind(c);c.callTool=async p=>p.name==='ultra_identity'?old(p):Promise.reject(new Error('SECRET token transcript'));
 await assert.rejects(s.run('after_turn',event),e=>e.code==='transport_error'&&e.delivery==='unconfirmed'&&!e.message.includes('SECRET'));
});
test('same structured search options survive normalization twice',()=>{
 const s=automationSettings({...settings,includeFacts:true,factEntity:'project'});
 assert.deepEqual(automationSettings(s),s);
});
test('before turn has no capture or model tools',async()=>{
 const c=fixture(),s=await automationSession(c,settings);await s.run('before_turn',{session_id:'s',query:'q'});
 assert.ok(c.calls.every(x=>['ultra_identity','ultra_retrieve'].includes(x.name)));
});
test('fixed credentials reject cross-origin targets and redirects, retain authorization across calls',async()=>{
 const calls=[],f=credentialFetch('https://memory.example/mcp','gbrain_fixture_token',{fetchImpl:async(u,o)=>{
  calls.push(o);return new Response('{}',{headers:{'content-type':'application/json'}});
 }});
 await (await f('https://memory.example/mcp')).text();
 await assert.rejects(f('https://other.example/mcp'),{code:'insecure_endpoint'});
 assert.equal(calls[0].headers.get('Authorization'),'Bearer gbrain_fixture_token');assert.equal(calls[0].redirect,'error');
});
test('response envelope limits apply to both advertised and streamed body sizes',async()=>{
 const f=credentialFetch('https://memory.example/mcp','gbrain_fixture_token',{maxResponseBytes:1024,
  fetchImpl:async()=>new Response('a'.repeat(1025))});
 await assert.rejects(async()=>{const r=await f('https://memory.example/mcp');await r.text();},/limit/);
 const g=credentialFetch('https://memory.example/mcp','gbrain_fixture_token',{maxResponseBytes:1024,
  fetchImpl:async()=>new Response('x',{headers:{'content-length':'1025'}})});
 await assert.rejects(g('https://memory.example/mcp'),{code:'response_too_large'});
});
test('cancellation stops requests before identity or capture',async()=>{
 const c=fixture(),controller=new AbortController();controller.abort();
 await assert.rejects(automationSession(c,settings,{signal:controller.signal}),{code:'cancelled'});assert.equal(c.calls.length,0);
});
