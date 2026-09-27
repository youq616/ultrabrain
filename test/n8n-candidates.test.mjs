import test from 'node:test';import assert from 'node:assert/strict';
import {automationSettings,automationSession,validateAutomationRequest} from '../src/automation-session.mjs';
import {automationCandidatesRequest} from '../src/automation-candidates.mjs';
import {fixture,creds,selection,identity,uuid,page} from './helpers/n8n-candidates-fixture.mjs';
test('n8n candidates: paired metadata, one candidate request and identity fences, no input body access',async()=>{
 const f=fixture(),r=await f.run();assert.equal(r[0].json.operation,'personal_candidates');assert.deepEqual(r[0].pairedItem,{item:0});
 assert.equal(r[0].json.result.page.returned,2);assert.equal(r[0].json.result.memory_writes_requested,false);
 assert.ok(Object.isFrozen(r[0].json.result.page.memories[0]));assert.equal(f.closed,1);
 assert.deepEqual(f.calls.map(c=>c.name),['ultra_identity','ultra_identity','ultra_personal_candidates','ultra_identity']);
 assert.deepEqual(Object.keys(f.calls[2].args),['request_id','limit']);assert.ok(!JSON.stringify(r).includes('PRIVATE'));
});
for(const patch of [{candidateConsent:false},{candidateConsent:'true'},{candidateScope:''},{candidateScope:'all-projects'},
 {candidateLimit:0},{candidateLimit:51},{candidateLimit:1.5},{candidateLimit:'2'},{candidateAfter:null},{candidateAfter:'bad'}])
 test('n8n candidates: invalid selection preflight '+JSON.stringify(patch),async()=>{
  const f=fixture({rows:[patch]});await assert.rejects(f.run(),e=>e.read_delivery==='not_started'&&e.memory_writes_requested===false);
  assert.equal(f.connections.length,0);assert.equal(f.calls.length,0);
 });
for(const patch of [{expectedActor:''},{expectedInstance:''},{rootUri:'ultra://selected/private'},{candidateProject:'../secret'}])
 test('n8n candidates: trusted credential boundary '+JSON.stringify(patch),async()=>{
  const f=fixture({credentials:{...creds,...patch}});await assert.rejects(f.run());assert.equal(f.connections.length,0);
 });
test('n8n candidates: source-root fixed project, no item-level project override',async()=>{
 const f=fixture({rows:[{candidateScope:'global-and-project',projectId:'foreign'}]}),r=await f.run();
 assert.equal(r[0].json.result.page.project_id,'mine');assert.equal(f.calls[2].args.project_id,'mine');assert.ok(!f.parameters.includes('projectId'));
});
test('n8n candidates: project selection without configured project refuses, global-only remains valid',async()=>{
 const f=fixture({rows:[{candidateScope:'global-and-project'}],credentials:{...creds,candidateProject:''}});
 await assert.rejects(f.run(),{code:'candidates_project_required'});assert.equal(f.calls.length,0);
 assert.equal((await fixture({credentials:{...creds,candidateProject:''}}).run())[0].json.ok,true);
});
test('n8n candidates: cursor explicitly forwarded once, never automatically continued',async()=>{
 const f=fixture({rows:[{candidateAfter:uuid(10)}],response:(req,v)=>({content:[{type:'text',text:JSON.stringify(req.name==='ultra_personal_candidates'?{
  ...v,has_more:true,next_after:v.memories.at(-1).id}:v)}]})});
 const r=await f.run();assert.equal(r[0].json.result.page.next_after,uuid(12));assert.equal(f.calls[2].args.after_id,uuid(10));
 assert.equal(f.calls.filter(c=>c.name==='ultra_personal_candidates').length,1);
});
test('n8n candidates: input pairing on continued preflight failure plus two successful reads',async()=>{
 const f=fixture({rows:[{candidateConsent:false},{},{}],keepGoing:true}),r=await f.run();
 assert.deepEqual(r.map(x=>x.pairedItem),[{item:0},{item:1},{item:2}]);assert.equal(r[0].json.ok,false);assert.equal(r[0].json.result,undefined);
 assert.ok(r.slice(1).every(x=>x.json.ok));assert.notEqual(r[1].json.result.page.request_id,r[2].json.result.page.request_id);
 assert.equal(f.connections.length,1);assert.equal(f.credentialCalls,1);
});
for(const change of [v=>v.source_id='other',v=>v.request_id=uuid(98),v=>v.project_id='foreign',v=>v.memories[0].content='PRIVATE_BODY',
 v=>v.memories[0].status='active',v=>v.memories[0].origin_kind='document_fragment',v=>v.memories[1].id=v.memories[0].id,
 v=>v.returned=0,v=>v.next_after=uuid(9),v=>v.read_only=false])test('n8n candidates: full-page invalidity never successful emptiness',async()=>{
 const f=fixture({keepGoing:true,response:(req,v)=>{if(req.name==='ultra_personal_candidates')change(v);return {content:[{type:'text',text:JSON.stringify(v)}]};}});
 const r=(await f.run())[0].json;assert.equal(r.error,'personal_candidates_unconfirmed');assert.equal(r.read_delivery,'unconfirmed');assert.equal(r.result,undefined);
 assert.equal(f.calls.filter(c=>c.name==='ultra_personal_candidates').length,1);
});
test('n8n candidates: valid empty result distinct from failed query',async()=>{
 const f=fixture({response:(req,v)=>({content:[{type:'text',text:JSON.stringify(req.name==='ultra_personal_candidates'?{
  ...v,memories:[],returned:0,has_more:false,next_after:null}:v)}]})});const r=(await f.run())[0];assert.equal(r.json.ok,true);assert.equal(r.json.result.page.returned,0);
});
for(const wire of [{isError:true,content:[]},{content:[],_meta:{}},{content:[],structuredContent:{PRIVATE:1}},
 {content:[{type:'image',data:'PRIVATE'}]},{content:[{type:'text',text:'{bad'}]},
 {content:[{type:'text',text:'x'.repeat(65537)}]},{content:[{type:'text',text:'{}'},{type:'text',text:'{}'}]}])
 test('n8n candidates: strict bounded single-channel MCP response',async()=>{
  const f=fixture({response:(req,v)=>req.name==='ultra_personal_candidates'?wire:{content:[{type:'text',text:JSON.stringify(v)}]}});
  await assert.rejects(f.run(),{code:'personal_candidates_unconfirmed',read_delivery:'unconfirmed'});
 });
test('n8n candidates: duplicate JSON keys refused before canonical projection',async()=>{
 const f=fixture({response:(req,v)=>({content:[{type:'text',text:req.name==='ultra_personal_candidates'?
  JSON.stringify(v).replace('"read_only":true','"read_only":false,"read_o\\u006ely":true'):JSON.stringify(v)}]})});
 await assert.rejects(f.run(),{code:'personal_candidates_unconfirmed'});
});
for(const stage of [1,2,3])test('n8n candidates: pinned identity drift at '+stage,async()=>{
 let n=0;const f=fixture({response:(req,v)=>{if(req.name==='ultra_identity'&&++n===stage)v={...v,actor_key:'b'.repeat(64)};
  return {content:[{type:'text',text:JSON.stringify(v)}]};}});
 await assert.rejects(f.run(),e=>e.code==='identity_mismatch'&&e.read_delivery===(stage===3?'unconfirmed':'not_started'));
});
for(const phase of ['ultra_identity','ultra_personal_candidates','close'])test('n8n candidates: cancel during '+phase,async()=>{
 const f=fixture({phase:(op,c)=>{if(op===phase)c.abort();}});await assert.rejects(f.run(),{code:'cancelled',memory_writes_requested:false});assert.equal(f.closed,1);
});
test('n8n candidates: pre-cancel makes no connection',async()=>{
 const f=fixture();f.controller.abort();await assert.rejects(f.run(),{code:'cancelled',read_delivery:'not_started'});assert.equal(f.connections.length,0);
});
test('n8n candidates: no hidden context/transcript settings evaluated',async()=>{
 const f=fixture(),get=f.context.getNodeParameter;f.context.getNodeParameter=(name,...a)=>{
  assert.ok(['operation','timeoutMs','candidateScope','candidateConsent','candidateLimit','candidateAfter'].includes(name),name);return get(name,...a);};
 assert.equal((await f.run())[0].json.ok,true);
});
test('n8n candidates: credential and request snapshots precede asynchronous checks',async()=>{
 const c={...creds},f=fixture({credentials:c,rows:[{candidateScope:'global-and-project'}],phase:()=>{c.candidateProject='foreign';}});
 assert.equal((await f.run())[0].json.result.page.project_id,'mine');assert.equal(f.connections[0].candidateProject,'mine');
 const q=selection(),session=await automationSession(f.client,automationSettings(creds));const work=session.run('personal_candidates',q);q.scope='global-and-project';
 assert.equal((await work).page.project_id,null);
});
for(const key of ['source_id','actor_key','project_id','include_text','request_id','offset'])test('n8n candidates: disallowed override '+key,()=>{
 assert.throws(()=>validateAutomationRequest('personal_candidates',{...selection(),[key]:'other'},automationSettings(creds)));
});
for(const key of ['scope','consent','after_id'])test('n8n candidates: request getters never evaluated '+key,()=>{
 const q=selection();let n=0;Object.defineProperty(q,key,{enumerable:true,get(){n++;return true;}});
 assert.throws(()=>automationCandidatesRequest(q,automationSettings(creds)));assert.equal(n,0);
});
test('n8n candidates: empty execution needs no credentials or network',async()=>{
 const f=fixture({rows:[]});assert.deepEqual(await f.run(),[]);assert.equal(f.credentialCalls,0);
});
