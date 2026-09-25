/** Real executor/session logic; synthetic MCP transport, not a live n8n host. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {executeN8n} from '../src/n8n-executor.mjs';
import {automationSession,automationSettings,validateAutomationRequest} from '../src/automation-session.mjs';
import {automationOverviewRequest} from '../src/automation-overview.mjs';
import {overviewReceipt} from './helpers/overview-fixture.mjs';
const identity={format:1,instance_id:'11111111-1111-4111-8111-111111111111',actor_key:'a'.repeat(64),source_id:'selected'};
const creds={endpoint:'https://memory.invalid/mcp',token:'PRIVATE_CREDENTIAL_TOKEN',rootUri:'ultra://selected/',
 expectedInstance:identity.instance_id,expectedActor:identity.actor_key,allowCapture:false};
const selection=()=>({scope:'owned-all-projects',consent:true});
const defaults={operation:'personal_overview',overviewScope:'owned-all-projects',overviewConsent:true,timeoutMs:10000};
function fixture({rows=[{}],credentials=creds,keepGoing=false,phase=()=>{},response}={}){
 const calls=[],parameters=[],connections=[],controller=new AbortController();let closed=0,credentialCalls=0;
 const items=rows.map(()=>({json:{PRIVATE_BODY:'not-for-output'},binary:{PRIVATE_ATTACHMENT:{}}}));
 const context={getInputData:()=>items,getExecutionCancelSignal:()=>controller.signal,
  getCredentials:async()=>{credentialCalls++;return credentials;},continueOnFail:()=>keepGoing,
  getNodeParameter:(name,i,fallback)=>{parameters.push(name);return Object.hasOwn(rows[i],name)?rows[i][name]:Object.hasOwn(defaults,name)?defaults[name]:fallback;}};
 const client={callTool:async(req,_,options)=>{
  calls.push({name:req.name,args:structuredClone(req.arguments),signal:options.signal});
  await phase(req.name,controller,calls);
  const value=req.name==='ultra_identity'?identity:overviewReceipt(req.arguments.request_id,'selected');
  return response?response(req,value):{content:[{type:'text',text:JSON.stringify(value)}]};
 }};
 const connect=async(c,{signal})=>{connections.push(c);return {
  session:(settings,options)=>automationSession(client,settings,options),
  close:async()=>{closed++;await phase('close',controller,calls);},
 }};
 return {context,calls,parameters,connections,controller,items,run:()=>executeN8n(context,connect),get closed(){return closed;},get credentialCalls(){return credentialCalls;}};
}
test('explicit read returns validated metadata and correct input pairing',async()=>{
 const f=fixture(),before=JSON.stringify(f.items),r=await f.run();
 assert.equal(r[0].json.operation,'personal_overview');assert.equal(r[0].json.result.overview.memories.total,12);
 assert.equal(r[0].json.result.memory_writes_requested,false);assert.deepEqual(r[0].pairedItem,{item:0});
 assert.ok(Object.isFrozen(r[0].json.result.overview.jobs));assert.equal(JSON.stringify(f.items),before);
 assert.deepEqual(f.calls.map(c=>c.name),['ultra_identity','ultra_identity','ultra_personal_overview','ultra_identity']);
 assert.deepEqual(Object.keys(f.calls[2].args),['request_id']);assert.equal(f.closed,1);
 for(const text of ['PRIVATE_BODY','PRIVATE_ATTACHMENT','PRIVATE_CREDENTIAL',identity.actor_key])assert.ok(!JSON.stringify(r).includes(text));
});
for(const patch of [{overviewConsent:false},{overviewConsent:'true'},{overviewConsent:null},{overviewScope:''},{overviewScope:'project'}])
 test('invalid selection never opens a connection '+JSON.stringify(patch),async()=>{
  const f=fixture({rows:[patch]});await assert.rejects(f.run(),e=>e.read_delivery==='not_started'&&e.memory_writes_requested===false);
  assert.equal(f.connections.length,0);assert.deepEqual(f.calls,[]);
 });
for(const patch of [{expectedActor:''},{expectedInstance:''},{rootUri:'ultra://selected/private'},{expectedActor:'bad'}])
 test('required credential boundary refused before IO '+JSON.stringify(patch),async()=>{
  const f=fixture({credentials:{...creds,...patch}});await assert.rejects(f.run());assert.equal(f.connections.length,0);
 });
test('two input items are two explicit reads with distinct UUIDs, not a cache',async()=>{
 const f=fixture({rows:[{},{}]}),r=await f.run();assert.equal(r.length,2);assert.equal(f.connections.length,1);
 assert.notEqual(r[0].json.result.overview.request_id,r[1].json.result.overview.request_id);
 assert.deepEqual(r.map(x=>x.pairedItem),[{item:0},{item:1}]);
});
test('continue-on-fail preserves item pairing and never returns an empty success on failure',async()=>{
 const f=fixture({rows:[{overviewConsent:false},{}],keepGoing:true}),r=await f.run();
 assert.equal(r[0].json.ok,false);assert.equal(r[0].json.read_delivery,'not_started');assert.equal(r[0].json.delivery,undefined);
 assert.equal(r[1].json.ok,true);assert.equal(f.calls.filter(x=>x.name==='ultra_personal_overview').length,1);
});
for(const damage of [v=>v.source_id='other',v=>v.request_id='22222222-2222-4222-8222-222222222222',v=>v.jobs.total++,v=>v.body='PRIVATE_BODY',v=>v.read_only=false])
 test('whole invalid response withheld without fallback or retry',async()=>{
  const f=fixture({keepGoing:true,response:(req,v)=>{
   if(req.name==='ultra_personal_overview')damage(v);return {content:[{type:'text',text:JSON.stringify(v)}]};
  }}),r=await f.run();assert.equal(r[0].json.error,'personal_overview_unconfirmed');assert.equal(r[0].json.read_delivery,'unconfirmed');
  assert.equal(r[0].json.result,undefined);assert.equal(f.calls.filter(c=>c.name==='ultra_personal_overview').length,1);
 });
for(const wire of [{isError:true,content:[]},{content:[{type:'text',text:'invalid'}]},
 {content:[{type:'image',data:'PRIVATE_BODY'}]},{content:[],_meta:{PRIVATE:'secret'}}])
 test('MCP bad envelope is rejected '+JSON.stringify(wire),async()=>{
  const f=fixture({response:(req,v)=>req.name==='ultra_personal_overview'?wire:{content:[{type:'text',text:JSON.stringify(v)}]}});
  await assert.rejects(f.run(),{code:'personal_overview_unconfirmed',read_delivery:'unconfirmed'});
 });
for(const stage of [1,2,3])test('identity pin change at observation '+stage,async()=>{
 let n=0;const f=fixture({response:(req,v)=>{
  if(req.name==='ultra_identity'&&++n===stage)v={...v,actor_key:'b'.repeat(64)};
  return {content:[{type:'text',text:JSON.stringify(v)}]};
 }});await assert.rejects(f.run(),e=>e.code==='identity_mismatch'&&e.read_delivery===(stage===3?'unconfirmed':'not_started'));
});
for(const name of ['ultra_identity','ultra_personal_overview'])test('cancel while awaiting '+name+' withholds data',async()=>{
 const f=fixture({phase:(op,c)=>{if(op===name)c.abort();}});
 await assert.rejects(f.run(),e=>e.code==='cancelled'&&e.memory_writes_requested===false);
 assert.equal(f.closed,1);
});
test('credentials are snapshotted, not adopted from mutable upstream objects',async()=>{
 const c={...creds},f=fixture({credentials:c,phase:()=>{c.expectedActor='b'.repeat(64);c.token='PRIVATE_OTHER_TOKEN';}});
 assert.equal((await f.run())[0].json.ok,true);assert.equal(f.connections[0].token,creds.token);assert.ok(Object.isFrozen(f.connections[0]));
});
test('unexpected transport errors never echo private messages',async()=>{
 const f=fixture({keepGoing:true,phase:op=>{if(op==='ultra_personal_overview')throw Error('PRIVATE_SQL_TOKEN');}}),r=await f.run();
 assert.equal(r[0].json.read_delivery,'unconfirmed');assert.ok(!JSON.stringify(r).includes('PRIVATE'));assert.equal(f.closed,1);
});
for(const key of ['actor_key','source_id','project_id','include_text','request_id'])test('core refuses caller selector '+key,()=>{
 const settings=automationSettings(creds);assert.throws(()=>validateAutomationRequest('personal_overview',{...selection(),[key]:'other'},settings));
});
for(const key of ['scope','consent'])test('selection accessor rejected without executing it '+key,()=>{
 const value=selection();let called=0;Object.defineProperty(value,key,{enumerable:true,get(){called++;return true;}});
 assert.throws(()=>automationOverviewRequest(value,automationSettings(creds)));assert.equal(called,0);
});
test('empty node execution makes no network or credential access',async()=>{
 const f=fixture({rows:[]});assert.deepEqual(await f.run(),[]);assert.equal(f.credentialCalls,0);
});

// Separate self-review probes: these must fail on the first implementation.
test('self-review: overview never reads hidden context/capture parameters',async()=>{
 const f=fixture(),get=f.context.getNodeParameter;
 f.context.getNodeParameter=(name,...args)=>{
  assert.ok(['operation','timeoutMs','overviewScope','overviewConsent'].includes(name),'Hidden parameter read: '+name);
  return get(name,...args);
 };
 assert.equal((await f.run())[0].json.ok,true);
});
for(const keepGoing of [true,false])test('self-review: cancellation during cleanup suppresses completed overview '+keepGoing,async()=>{
 const f=fixture({keepGoing,phase:(op,c)=>{if(op==='close')c.abort();}});
 if(keepGoing){const r=await f.run();assert.equal(r[0].json.ok,false);assert.equal(r[0].json.read_delivery,'unconfirmed');assert.equal(r[0].json.result,undefined);}
 else await assert.rejects(f.run(),{code:'cancelled',read_delivery:'unconfirmed',memory_writes_requested:false});
});
test('self-review: cancellation on later item clears earlier private overview',async()=>{
 let reads=0;const f=fixture({keepGoing:true,rows:[{},{}],phase:(op,c)=>{if(op==='ultra_personal_overview'&&++reads===2)c.abort();}});
 const r=await f.run();assert.equal(r.length,2);assert.ok(r.every(x=>x.json.ok===false));assert.ok(r.every(x=>!x.json.result));
});
test('pre-cancelled read retains read-only semantics and never connects',async()=>{
 const f=fixture();f.controller.abort();await assert.rejects(f.run(),{code:'cancelled',read_delivery:'not_started',memory_writes_requested:false});assert.equal(f.connections.length,0);
});
test('valid directory root is denied by scope, not by a malformed URI',async()=>{
 const f=fixture({credentials:{...creds,rootUri:'ultra://selected/private'}});
 await assert.rejects(f.run(),{code:'scope_denied',read_delivery:'not_started'});assert.equal(f.connections.length,0);
});
