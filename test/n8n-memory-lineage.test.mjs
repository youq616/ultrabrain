import test from 'node:test';import assert from 'node:assert/strict';
import {fixture,credentials,uuid,hash,wire,reference,request} from './helpers/n8n-memory-lineage-fixture.mjs';
import {automationMemoryLineageRequest} from '../src/automation-memory-lineage.mjs';
import {automationSession,automationSettings} from '../src/automation-session.mjs';
const reads=f=>f.calls.filter(c=>c.name==='ultra_memory_read');
test('lineage: complete matched direct evidence, three ID-only reads and final identity',async()=>{
 const f=fixture(),out=await f.run(),r=out[0].json.result;
 assert.equal(r.verdict.state,'matched');assert.equal(r.read_requests,3);assert.equal(r.truth_verified,false);assert.equal(r.atomic_snapshot,false);
 assert.equal(r.memory_writes_requested,false);assert.deepEqual(out[0].pairedItem,{item:0});assert.equal(f.closed,1);
 assert.deepEqual(reads(f).map(c=>c.args),[{memory_id:uuid(1)},{memory_id:uuid(2)},{memory_id:uuid(1)}]);
 assert.equal(f.calls.at(-1).name,'ultra_identity');assert.ok(!JSON.stringify(out).includes('PRIVATE'));
 assert.ok(Object.isFrozen(r.reference)&&Object.isFrozen(r.verdict));
});
test('lineage: separate output consent preserves exact memory, quote and source text',async()=>{
 const f=fixture({rows:[{lineageIncludeText:true}]}),r=(await f.run())[0].json.result;
 assert.deepEqual(r.text,{memory:'PRIVATE_CHILD',quote:'PRIVATE',source:'PRIVATE_SOURCE'});assert.ok(Object.isFrozen(r.text));
});
for(const [name,opts,state]of [
 ['changed revision',{source:{revision:2}},'changed'],['changed content',{source:{content:'NEW_SOURCE'}},'changed'],
 ['archived source',{source:{status:'archived'}},'archived'],
 ['wrong quote',{child:{derivation:{...reference(),quote:'MISSING'}}},'quote_mismatch'],
 ['inconsistent current flag',{child:{derivation_current:false}},'inconsistent'],
 ['no stored reference',{child:{derivation:null}},'unlinked']])test('lineage: '+name+' is evidence, not an exception or approval',async()=>{
 const f=fixture(opts),r=(await f.run())[0].json.result;assert.equal(r.verdict.state,state);
 assert.equal(reads(f).length,state==='unlinked'?1:3);assert.equal(r.verdict.truth_verified,false);
});
test('lineage: not-found source is unavailable but parent is still rechecked',async()=>{
 const f=fixture({reply:(q,v)=>q.arguments.memory_id===uuid(2)?{...wire({error:'not_found',message:'PRIVATE'}),isError:true}:wire(v)});
 const r=(await f.run())[0].json.result;assert.equal(r.verdict.state,'unavailable');assert.equal(r.original,null);assert.equal(r.read_requests,3);
});
for(const code of ['permission_denied','insufficient_scope','unexpected_error'])test('lineage: '+code+' is not disguised as missing source',async()=>{
 const f=fixture({keepGoing:true,reply:(q,v)=>q.arguments.memory_id===uuid(2)?{...wire({error:code,message:'PRIVATE'}),isError:true}:wire(v)});
 const r=(await f.run())[0].json;assert.equal(r.ok,false);assert.equal(r.result,undefined);assert.equal(r.read_attempts,2);assert.ok(!JSON.stringify(r).includes('PRIVATE'));
});
for(const patch of [{lineageConsent:false},{lineageFollowConsent:false},{lineageFollowConsent:'true'},{lineageIncludeText:'false'},
 {lineageMemoryId:'bad'},{lineageScope:''}])test('lineage: preflight refuses '+JSON.stringify(patch),async()=>{
 const f=fixture({rows:[patch]});await assert.rejects(f.run(),e=>e.read_delivery==='not_started');assert.equal(f.connections,0);
});
for(const patch of [{expectedActor:''},{expectedInstance:''},{rootUri:'ultra://selected/subfolder'},{lineageProject:'../other'}])test('lineage: credential preflight '+JSON.stringify(patch),async()=>{
 const f=fixture({creds:{...credentials,...patch}});await assert.rejects(f.run());assert.equal(f.connections,0);
});
test('lineage: project is independently credential-bound and applies to both records',async()=>{
 const f=fixture({rows:[{lineageScope:'global-and-project',projectId:'other'}],child:{project_id:'mine'},source:{project_id:'mine'}});
 const r=(await f.run())[0].json.result;assert.equal(r.project_id,'mine');assert.equal(r.verdict.state,'matched');assert.ok(!f.parameters.includes('projectId'));
 for(const selected of ['child','source']){
  const bad=fixture({rows:[{lineageScope:'global-and-project'}],[selected]:{project_id:'different'}});
  await assert.rejects(bad.run(),{code:'memory_inspect_project_mismatch'});
 }
});
test('lineage: global-only cannot borrow any configured project; empty credential project refuses expanded scope',async()=>{
 await assert.rejects(fixture({source:{project_id:'mine'}}).run(),{code:'memory_inspect_project_mismatch'});
 const f=fixture({creds:{...credentials,lineageProject:''},rows:[{lineageScope:'global-and-project'}]});await assert.rejects(f.run());assert.equal(f.connections,0);
});
for(const target of ['child','source'])for(const patch of [{origin_kind:'document_fragment'},
 {owned_by_caller:false,visibility:'source',status:'active',derivation:null}])test('lineage: owned agent boundary on '+target,async()=>{
 const f=fixture({[target]:patch});await assert.rejects(f.run());
});
for(const field of ['revision','derivation_current','provenance','derivation'])test('lineage: parent '+field+' change invalidates entire observation',async()=>{
 let childReads=0;const f=fixture({keepGoing:true,reply:(q,v)=>{
  if(q.arguments.memory_id===uuid(1)&&++childReads===2){
   if(field==='revision')v.memory.revision++;else if(field==='derivation_current')v.memory.derivation_current=false;
   else if(field==='provenance')v.memory.provenance='OTHER';else v.memory.derivation={...v.memory.derivation,profile_hash:'d'.repeat(64)};
  }return wire(v);
 }});const r=(await f.run())[0].json;assert.equal(r.error,'memory_lineage_selected_changed');assert.equal(r.result,undefined);assert.equal(r.read_attempts,3);
});
test('lineage: corrupt source hash cannot be used in comparison',async()=>{
 const f=fixture({reply:(q,v)=>{if(q.arguments.memory_id===uuid(2))v.memory.content_hash='0'.repeat(64);return wire(v);}});
 await assert.rejects(f.run(),{code:'memory_inspect_unconfirmed',read_attempts:2});
});
for(const checkpoint of [1,2,3,4,5])test('lineage: identity changed at checkpoint '+checkpoint+' withholds everything',async()=>{
 let n=0;const f=fixture({reply:(q,v)=>{if(q.name==='ultra_identity'&&++n===checkpoint)v.actor_key='b'.repeat(64);return wire(v);}});
 await assert.rejects(f.run(),{code:'identity_mismatch',read_attempts:Math.max(0,checkpoint-2)});
});
for(const stage of [1,2,3])test('lineage: cancel at read '+stage+' stops next calls and output',async()=>{
 let n=0;const f=fixture({phase:(q,c)=>{if(q.name==='ultra_memory_read'&&++n===stage)c.abort();}});
 await assert.rejects(f.run(),{code:'cancelled',read_attempts:stage});assert.equal(reads(f).length,stage);
});
test('lineage: multiple items preserve pairing and only lineage-specific parameters are evaluated',async()=>{
 const f=fixture({rows:[{lineageFollowConsent:false},{},{}],keepGoing:true}),r=await f.run();
 assert.deepEqual(r.map(i=>i.pairedItem.item),[0,1,2]);assert.equal(r[0].json.ok,false);assert.ok(r.slice(1).every(i=>i.json.ok));
 assert.ok(f.parameters.every(p=>p==='operation'||p==='timeoutMs'||p.startsWith('lineage')));assert.equal(f.connections,1);
});
test('lineage: request and credential mutation cannot add text output or redirect source selection',async()=>{
 const f=fixture(),s=await automationSession(f.client,automationSettings(credentials)),q=request();const result=s.run('personal_lineage',q);
 q.include_text=true;q.memory_id=uuid(3);q.follow_consent=false;const r=await result;assert.equal(r.memory.id,uuid(1));assert.equal(r.text,undefined);
});
for(const key of ['source_memory_id','source_id','project_id','expected_actor','extra'])test('lineage: unsupported override '+key,()=>{
 assert.throws(()=>automationMemoryLineageRequest({...request(),[key]:'other'},automationSettings(credentials)));
});
test('lineage: empty items and cancellation never open a connection',async()=>{
 const f=fixture({rows:[]});assert.deepEqual(await f.run(),[]);assert.equal(f.credentialReads,0);
 const g=fixture();g.controller.abort();await assert.rejects(g.run(),{code:'cancelled'});assert.equal(g.connections,0);
});
