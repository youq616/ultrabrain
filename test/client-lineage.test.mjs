/** Consented client lineage. Synthetic protocol records, never a real client/DB claim. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {clientProfile} from '../src/client-kit.mjs';
import {lineageRequest,clientLineageRecord,deliverClientLineage} from '../src/client-lineage.mjs';
import {lineagePair,row,uuid,hash} from './helpers/lineage-fixture.mjs';
const workspace=mkdtempSync(join(tmpdir(),'ub-client-lineage-'));
process.on('exit',()=>rmSync(workspace,{recursive:true,force:true}));
const inputProfile={format:1,source:'selected',workspace,expected_instance:uuid(90),expected_actor:'a'.repeat(64),
 server:{transport:'stdio',command:'not-executed',args:[]},project_id:'project-a'};
const profile=clientProfile(inputProfile);
const request=(extra={})=>({memory_id:uuid(1),workspace,consent:true,...extra});
const envelope=m=>({source_id:'selected',memory:m,trust:'untrusted-memory-data',read_only:true,coverage:'current authorized observation'});
const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function fixture({invoke,authorize,signal}={}){
 const pair=lineagePair(),calls=[],identities=[];
 const hooks={authorize,signal,checkIdentity:async s=>{identities.push(s);},invoke:async(name,args,s)=>{
  calls.push({name,args,signal:s});return invoke?invoke(name,args,pair,calls.length):envelope(args.memory_id===pair.memory.id?pair.memory:pair.source);
 }};
 return {...pair,calls,identities,hooks,run:(r=request())=>deliverClientLineage(r,profile,hooks)};
}
test('client lineage: default metadata report uses at most three ID-only reads, no body or quote',async()=>{
 const f=fixture(),report=await f.run();assert.equal(report.verdict.state,'matched');
 assert.equal(report.read_requests,3);assert.equal(report.text_included,false);assert.equal(report.text,undefined);
 assert.deepEqual(f.calls.map(c=>c.args),[{memory_id:uuid(1)},{memory_id:uuid(2)},{memory_id:uuid(1)}]);
 assert.ok(f.calls.every(c=>c.name==='ultra_memory_read'));assert.equal(f.identities.length,3);
 const text=JSON.stringify(report);for(const value of [f.memory.content,f.source.content,f.memory.derivation.quote,'provenance'])assert.ok(!text.includes(value));
 assert.equal(report.truth_verified,false);assert.equal(report.atomic_snapshot,false);assert.equal(report.memory_writes_requested,false);
 assert.ok(Object.isFrozen(report)&&Object.isFrozen(report.verdict)&&Object.isFrozen(report.reference));
});
test('client lineage: explicit text output preserves exact Unicode content and has untrusted marker',async()=>{
 const f=fixture(),report=await f.run(request({include_text:true}));assert.equal(report.text_included,true);
 assert.deepEqual(report.text,{memory:f.memory.content,quote:f.memory.derivation.quote,source:f.source.content});
 assert.equal(report.trust,'untrusted-memory-data');assert.ok(Object.isFrozen(report.text));
});
for(const [owned,state]of [[true,'unlinked'],[false,'withheld']])test('client lineage: no reference is distinct '+state,async()=>{
 const f=fixture();f.memory.derivation=null;if(!owned)Object.assign(f.memory,{owned_by_caller:false,status:'active',visibility:'source'});
 const report=await f.run();assert.equal(report.verdict.state,state);assert.equal(f.calls.length,1);assert.equal(report.reference,null);
});
for(const [state,change]of [['changed',f=>{f.source.content+=' changed';f.source.content_hash=hash(f.source.content);f.source.revision++;f.memory.derivation_current=false;}],
 ['archived',f=>{f.source.status='archived';f.memory.derivation_current=false;}],
 ['quote_mismatch',f=>{f.memory.derivation.start--;f.memory.derivation.end--;}],['inconsistent',f=>{f.memory.derivation_current=false;}]])
 test('client lineage: reuse canonical source verdict '+state,async()=>{const f=fixture();change(f);assert.equal((await f.run()).verdict.state,state);});
for(const bad of [{consent:false},{consent:undefined},{include_text:'true'},{memory_id:'bad'},{project_id:'other'},{workspace:'/missing'},
 {input_id:uuid(2)},{model:'external'},{query:'PRIVATE'}, {extra:true}])test('client lineage: invalid request rejected before any IO '+JSON.stringify(bad),async()=>{
 const f=fixture();await assert.rejects(f.run(request(bad)));assert.equal(f.calls.length,0);assert.equal(f.identities.length,0);
});
for(const missing of ['expected_instance','expected_actor','workspace'])test('client lineage: pin '+missing+' required before connection',()=>{
 const p={...inputProfile};delete p[missing];assert.throws(()=>lineageRequest(request(),clientProfile(p)),{code:'lineage_disabled'});
});
for(const permission of [()=>false,async()=>true,async()=>{throw Error('PRIVATE');}])test('client lineage: synchronous authority refuses '+permission.toString(),async()=>{
 const f=fixture({authorize:permission});await assert.rejects(f.run());assert.equal(f.calls.length,0);assert.equal(f.identities.length,0);
});
test('client lineage: source not found remains unavailable with final primary verification',async()=>{
 const f=fixture({invoke:async(_n,args,p)=>{if(args.memory_id===p.source.id)throw Object.assign(Error('Hidden'),{code:'not_found'});return envelope(p.memory);}});
 const r=await f.run();assert.equal(r.verdict.state,'unavailable');assert.equal(f.calls.length,3);assert.equal(r.original,null);
});
test('client lineage: network failure is not missing-source, and errors contain no raw server data',async()=>{
 const f=fixture({invoke:async(_n,_a,p,n)=>{if(n===2)throw Error('PRIVATE_SERVER_PATH');return envelope(p.memory);}});
 await assert.rejects(f.run(),e=>e.code==='lineage_read_unconfirmed'&&e.read_delivery==='unconfirmed'&&!e.message.includes('PRIVATE'));
 assert.equal(f.calls.length,2);
});
for(const patch of [{revision:2},{project_id:'project-a'},{content:'concurrent'},{derivation:null},{derivation_current:false},{provenance:'modified'}])
 test('client lineage: primary changes at final read are not a valid combined observation '+JSON.stringify(patch),async()=>{
  const f=fixture({invoke:async(_n,args,p,n)=>envelope(n===3?row(1,{...p.memory,...patch}):args.memory_id===p.memory.id?p.memory:p.source)});
  await assert.rejects(f.run(),{code:'lineage_selected_changed'});assert.equal(f.calls.length,3);
 });
for(const phase of [1,2,3])for(const mode of ['revoke','abort'])test('client lineage: '+mode+' fences pending response '+phase,async()=>{
 const entered=defer(),release=defer(),controller=new AbortController();let allowed=true;
 const f=fixture({signal:controller.signal,authorize:()=>allowed,invoke:async(_n,args,p,n)=>{
  if(n===phase){entered.resolve();await release.promise;}return envelope(args.memory_id===p.memory.id?p.memory:p.source);
 }});
 const work=f.run();await entered.promise;if(mode==='abort')controller.abort();else allowed=false;release.resolve();
 await assert.rejects(work);assert.equal(f.calls.length,phase);
});
test('client lineage: identity wait revocation prevents the following record transmission',async()=>{
 let allowed=true;const f=fixture({authorize:()=>allowed});f.hooks.checkIdentity=async()=>{allowed=false;};
 await assert.rejects(f.run(),{code:'client_authorization_revoked'});assert.equal(f.calls.length,0);
});
test('client lineage: caller mutation cannot widen text disclosure or change bound ID after wait',async()=>{
 const entered=defer(),release=defer(),f=fixture();let first=true;
 f.hooks.checkIdentity=async()=>{if(first){first=false;entered.resolve();await release.promise;}};
 const input=request(),work=f.run(input);await entered.promise;input.memory_id=uuid(7);input.include_text=true;release.resolve();
 const result=await work;assert.equal(result.text_included,false);assert.equal(result.memory.id,uuid(1));
});
test('client lineage: changing caller-owned first response during source wait cannot alter observation',async()=>{
 const entered=defer(),release=defer(),f=fixture();let count=0;
 f.hooks.invoke=async(_n,args)=>{count++;if(count===2){entered.resolve();await release.promise;}return envelope(args.memory_id===f.memory.id?f.memory:f.source);};
 const work=f.run();await entered.promise;f.memory.provenance='changed concurrently';release.resolve();
 await assert.rejects(work,{code:'lineage_selected_changed'});
});
for(const side of ['memory','source'])test('client lineage: other project '+side+' rejected, no body returned',async()=>{
 const f=fixture();f[side].project_id='other';await assert.rejects(f.run(),{code:'lineage_project_mismatch'});
});
const recordCases=[['hash',m=>m.content_hash='0'.repeat(64)],['null byte',m=>m.content+='\0'],['empty',m=>m.content=' '],
 ['oversize',m=>m.content='x'.repeat(65537)],['surrogate',m=>m.content='\ud800'],['nonfinite',m=>m.confidence=Infinity],
 ['shared derivation',m=>Object.assign(m,{owned_by_caller:false,status:'active',visibility:'source'})],
 ['shared inactive',m=>Object.assign(m,{owned_by_caller:false,derivation:null})],['revision',m=>m.revision=2147483648],
 ['date',m=>m.updated_at='invalid'],['agent',m=>m.agent_id='../x'],['unexpected',m=>m.secret='PRIVATE'],
 ['bad derivation',m=>m.derivation={input_id:uuid(8)}],['bad type',m=>m.type='constructor']];
for(const [name,damage]of recordCases)test('client lineage: invalid record '+name+' rejected',()=>{
 const {memory}=lineagePair();damage(memory);assert.throws(()=>clientLineageRecord(envelope(memory),uuid(1),profile));
});
test('client lineage: strict envelope and record IDs reject foreign or extra data',()=>{
 const {memory}=lineagePair();for(const bad of [{...envelope(memory),source_id:'other'},{...envelope(memory),extra:'PRIVATE'},
 {...envelope(memory),read_only:false},{...envelope(memory),trust:'trusted'},envelope({...memory,id:uuid(9)})])
 assert.throws(()=>clientLineageRecord(bad,uuid(1),profile));
});
test('client lineage: original data is owned, returned deep frozen, and never mutates caller',()=>{
 const {memory}=lineagePair(),r=clientLineageRecord(envelope(memory),uuid(1),profile);
 assert.notEqual(r,memory);assert.ok(Object.isFrozen(r)&&Object.isFrozen(r.derivation));assert.ok(!Object.isFrozen(memory));
});
