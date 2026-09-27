import test from 'node:test';import assert from 'node:assert/strict';
import {fixture,envelope,credentials,uuid} from './helpers/n8n-memory-inspect-fixture.mjs';
import {automationSettings,automationSession} from '../src/automation-session.mjs';
import {automationMemoryInspectRequest} from '../src/automation-memory-inspect.mjs';
import {sha256} from '../src/core.mjs';
const wire=value=>({content:[{type:'text',text:JSON.stringify(value)}]});
const request=()=>({memory_id:uuid(1),scope:'global-only',consent:true,include_text:false});
test('inspect: one ID-only read with identity checks, metadata only and paired input',async()=>{
 const f=fixture(),r=await f.run();assert.equal(r[0].json.ok,true);assert.deepEqual(r[0].pairedItem,{item:0});
 assert.equal(r[0].json.result.text_included,false);assert.ok(!JSON.stringify(r).includes('PRIVATE'));
 assert.ok(Object.isFrozen(r[0].json.result.memory));assert.equal(f.closed,1);
 assert.deepEqual(f.calls.map(c=>c.name),['ultra_identity','ultra_identity','ultra_memory_read','ultra_identity']);
 assert.deepEqual(f.calls[2].args,{memory_id:uuid(1)});assert.equal(r[0].json.result.memory_writes_requested,false);
});
test('inspect: separately enabled text returns exact data, not executed or followed',async()=>{
 const f=fixture({items:[{inspectIncludeText:true}]}),r=(await f.run())[0].json.result;
 assert.equal(r.text.content,envelope().memory.content);assert.equal(r.text.provenance,'PRIVATE_PROVENANCE');assert.equal(r.read_requests,1);
 assert.ok(Object.isFrozen(r.text));assert.equal(r.truth_verified,false);assert.equal(r.model_calls,0);
});
for(const patch of [{inspectConsent:false},{inspectConsent:'true'},{inspectMemoryId:'short'},
 {inspectScope:''},{inspectScope:'all'},{inspectIncludeText:'true'},{inspectIncludeText:null}])test('inspect: invalid selector before connection '+JSON.stringify(patch),async()=>{
 const f=fixture({items:[patch]});await assert.rejects(f.run());assert.equal(f.connections,0);assert.equal(f.calls.length,0);
});
for(const patch of [{expectedInstance:''},{expectedActor:''},{rootUri:'ultra://selected/folder'},{inspectProject:'../bad'}])
 test('inspect: invalid credential boundary '+JSON.stringify(patch),async()=>{
  const f=fixture({creds:{...credentials,...patch}});await assert.rejects(f.run());assert.equal(f.connections,0);
 });
test('inspect: explicit project fixed in separate trusted credential, not item projectId or candidateProject',async()=>{
 const f=fixture({items:[{inspectScope:'global-and-project',projectId:'evil',candidateProject:'evil'}],
 reply:(q,v)=>wire(q.name==='ultra_memory_read'?envelope({project_id:'mine'}):v)});
 const r=(await f.run())[0].json.result;assert.equal(r.project_id,'mine');assert.equal(r.memory.project_id,'mine');
 assert.ok(!f.parameters.includes('projectId'));assert.equal(f.calls[2].args.project_id,undefined);
});
test('inspect: global-only does not borrow configured project',async()=>{
 const f=fixture({reply:(q,v)=>wire(q.name==='ultra_memory_read'?envelope({project_id:'mine'}):v)});
 await assert.rejects(f.run(),{code:'memory_inspect_project_mismatch',read_delivery:'unconfirmed'});
});
test('inspect: requested project requires explicit credential configuration',async()=>{
 const f=fixture({items:[{inspectScope:'global-and-project'}],creds:{...credentials,inspectProject:''}});
 await assert.rejects(f.run(),{code:'memory_inspect_project_required'});assert.equal(f.connections,0);
});
for(const status of ['candidate','active','archived'])test('inspect: owned '+status+' can be observed without write permission',async()=>{
 const f=fixture({reply:(q,v)=>wire(q.name==='ultra_memory_read'?envelope({status}):v)});
 assert.equal((await f.run())[0].json.result.memory.status,status);
});
for(const [name,patch,code] of [['shared',{owned_by_caller:false,status:'active',visibility:'source'},'memory_inspect_not_owned'],
 ['fragment',{origin_kind:'document_fragment'},'memory_inspect_document_bound']])test('inspect: '+name+' withheld despite server visibility',async()=>{
 const f=fixture({reply:(q,v)=>wire(q.name==='ultra_memory_read'?envelope(patch):v)});await assert.rejects(f.run(),{code,read_delivery:'unconfirmed'});
});
for(const [name,change] of [['ID',v=>v.memory.id=uuid(2)],['hash',v=>v.memory.content_hash='0'.repeat(64)],['source',v=>v.source_id='other'],
 ['extra',v=>v.extra='PRIVATE'],['null',v=>v.memory=null],['revision',v=>v.memory.revision=0],['visibility',v=>v.memory.visibility='all'],
 ['provenance',v=>v.memory.provenance=42],['derivation',v=>v.memory.derivation={quote:'PRIVATE'}],['trust',v=>v.trust='trusted']])
 test('inspect: complete invalid read withheld '+name,async()=>{
  const f=fixture({keepGoing:true,reply:(q,v)=>{if(q.name==='ultra_memory_read')change(v);return wire(v);}});
  const r=(await f.run())[0].json;assert.equal(r.error,'memory_inspect_unconfirmed');assert.equal(r.result,undefined);assert.equal(r.read_delivery,'unconfirmed');
 });
for(const payload of [{content:[]},{content:[],_meta:{}},{content:[],structuredContent:{}},{isError:'false',content:[]},
 {content:[{type:'image',data:'PRIVATE'}]},{content:[{type:'text',text:'x'.repeat(1048577)}]},
 {content:[{type:'text',text:'{}'},{type:'text',text:'{}'}]},wire({memory:{}})])test('inspect: bounded single-channel wire contract',async()=>{
 const f=fixture({reply:(q,v)=>q.name==='ultra_memory_read'?payload:wire(v)});await assert.rejects(f.run(),{code:'memory_inspect_unconfirmed'});
});
for(const code of ['not_found','insufficient_scope','permission_denied','PRIVATE_CODE'])test('inspect: server error '+code+' projected without text',async()=>{
 const f=fixture({keepGoing:true,reply:(q,v)=>q.name==='ultra_memory_read'?{...wire({error:code,message:'PRIVATE_DIAGNOSTICS'}),isError:true}:wire(v)});
 const r=(await f.run())[0].json;assert.equal(r.error,code==='PRIVATE_CODE'?'memory_inspect_unconfirmed':code);assert.ok(!JSON.stringify(r).includes('PRIVATE'));
});
test('inspect: duplicate JSON keys do not silently replace a record field',async()=>{
 const f=fixture({reply:(q,v)=>{const r=wire(v);if(q.name==='ultra_memory_read')r.content[0].text=r.content[0].text.replace('"read_only":true','"read_only":false,"read_o\\u006ely":true');return r;}});
 await assert.rejects(f.run(),{code:'memory_inspect_unconfirmed'});
});
test('inspect: exact maximum-size body validates, no truncation or byte/character confusion',async()=>{
 const content='测'.repeat(21845)+'a',f=fixture({items:[{inspectIncludeText:true}],reply:(q,v)=>wire(q.name==='ultra_memory_read'?envelope({content,content_hash:sha256(content)}):v)});
 assert.equal(Buffer.byteLength(content),65536);assert.equal((await f.run())[0].json.result.text.content,content);
});
for(const phase of ['ultra_identity','ultra_memory_read','close'])test('inspect: cancellation during '+phase,async()=>{
 const f=fixture({phase:(name,c)=>{if(name===phase)c.abort();}});await assert.rejects(f.run(),{code:'cancelled',memory_writes_requested:false});assert.equal(f.closed,1);
});
test('inspect: pre-cancel reads neither credentials network nor memory',async()=>{
 const f=fixture();f.controller.abort();await assert.rejects(f.run(),{code:'cancelled',read_delivery:'not_started'});assert.equal(f.connections,0);
});
for(const checkpoint of [1,2,3])test('inspect: identity mismatch at checkpoint '+checkpoint,async()=>{
 let n=0;const f=fixture({reply:(q,v)=>{if(q.name==='ultra_identity'&&++n===checkpoint)v.actor_key='b'.repeat(64);return wire(v);}});
 await assert.rejects(f.run(),e=>e.code==='identity_mismatch'&&e.read_delivery===(checkpoint===3?'unconfirmed':'not_started'));
});
test('inspect: mixed per-item failures preserve pairing and never read hidden parameters',async()=>{
 const f=fixture({items:[{inspectConsent:false},{},{inspectIncludeText:true}],keepGoing:true}),r=await f.run();
 assert.deepEqual(r.map(x=>x.pairedItem.item),[0,1,2]);assert.equal(r[0].json.ok,false);assert.equal(r[1].json.result.text,undefined);assert.ok(r[2].json.result.text);
 assert.ok(f.parameters.every(k=>['operation','timeoutMs','inspectMemoryId','inspectScope','inspectConsent','inspectIncludeText'].includes(k)));
 assert.equal(f.connections,1);assert.equal(f.credentialReads,1);
});
test('inspect: credential and request changes across awaits cannot broaden scope or disclose text',async()=>{
 const c={...credentials},f=fixture({creds:c,phase:()=>{c.inspectProject='other';}});await f.run();
 const s=await automationSession(f.client,automationSettings(credentials)),q=request(),work=s.run('personal_inspect',q);q.include_text=true;q.memory_id=uuid(2);
 const result=await work;assert.equal(result.text_included,false);assert.equal(result.memory.id,uuid(1));
});
for(const key of ['project_id','source_id','actor_key','expected_revision','limit'])test('inspect: unauthorized extra selector '+key,()=>{
 assert.throws(()=>automationMemoryInspectRequest({...request(),[key]:'other'},automationSettings(credentials)));
});
for(const key of ['scope','memory_id','consent','include_text'])test('inspect: selector getters refused without execution '+key,()=>{
 let n=0;const r=request();Object.defineProperty(r,key,{enumerable:true,get(){n++;return true;}});
 assert.throws(()=>automationMemoryInspectRequest(r,automationSettings(credentials)));assert.equal(n,0);
});
test('inspect: empty execution needs no credentials, transport or output',async()=>{
 const f=fixture({items:[]});assert.deepEqual(await f.run(),[]);assert.equal(f.credentialReads,0);
});
