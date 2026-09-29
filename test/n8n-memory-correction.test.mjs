import test from 'node:test';import assert from 'node:assert/strict';
import {fixture,credentials,request,replacement,wire,uuid,hash} from './helpers/n8n-memory-correction-fixture.mjs';
import {automationSettings,automationSession} from '../src/automation-session.mjs';
import {automationMemoryCorrectionRequest,parseCorrectionMemory,CORRECTION_FIELDS} from '../src/automation-memory-correction.mjs';
const writes=f=>f.calls.filter(c=>c.name==='ultra_personal_update');
test('correction: exact full replacement, one write, complete receipt without body and paired item',async()=>{
 const f=fixture(),r=(await f.run())[0];assert.deepEqual(r.pairedItem,{item:0});assert.equal(r.json.operation,'personal_correct');
 assert.equal(r.json.result.receipt.status,'candidate');assert.equal(r.json.result.receipt.review_required,true);assert.equal(r.json.result.write_delivery,'confirmed');
 assert.equal(r.json.result.human_identity_verified,false);assert.equal(r.json.result.current_state_verified,false);assert.equal(r.json.result.text_included,false);
 assert.ok(!JSON.stringify(r).includes('PRIVATE'));assert.equal(f.closed,1);
 assert.deepEqual(f.calls.map(c=>c.name),['ultra_identity','ultra_identity','ultra_memory_read','ultra_identity','ultra_personal_update','ultra_identity']);
 assert.deepEqual(writes(f)[0].args,{memory_id:uuid(1),event_id:'correction-original',expected_revision:1,memory:replacement()});
});
for(const patch of [{correctConsent:false},{correctConsent:'true'},{correctAcknowledgeReset:false},{correctMode:''},{correctMode:'edit'},
 {correctMemoryId:'short'},{correctScope:'all'},{correctEventId:'space here'},{correctExpectedRevision:0},{correctExpectedRevision:2147483647},
 {correctExpectedHash:'A'.repeat(64)},{correctExpectedStatus:''},{correctExpectedVisibility:''},{correctExpectedProject:null},{correctScopeChangeConsent:null}])
 test('correction: invalid selection refused before network '+JSON.stringify(patch),async()=>{
  const f=fixture({items:[patch]});await assert.rejects(f.run(),e=>e.write_delivery==='not_started'&&e.memory_writes_requested===false);assert.equal(f.connections,0);
 });
for(const field of CORRECTION_FIELDS)test('correction: replacement cannot omit '+field,async()=>{
 const memory=replacement();delete memory[field];const f=fixture({items:[{correctReplacement:JSON.stringify(memory)}]});
 await assert.rejects(f.run(),{code:'invalid_params'});assert.equal(f.connections,0);
});
for(const memory of [replacement({importance:null}),replacement({visibility:null}),replacement({confidence:2}),replacement({confidence:'0.5'}),
 replacement({type:'unknown'}),replacement({provenance:''}),replacement({content:''}),replacement({content:'a\0b'}),replacement({project_id:'../bad'}),
 {...replacement(),derivation:{quote:'PRIVATE'}}])test('correction: replacement explicit types and enums enforced',async()=>{
 const f=fixture({items:[{correctReplacement:JSON.stringify(memory)}]});await assert.rejects(f.run(),{code:'invalid_params'});assert.equal(f.connections,0);
});
for(const text of ['', '\ufeff{}','{bad','{"type":"goal","type":"preference"}',JSON.stringify(replacement({content:'x'.repeat(65537)})), ' '.repeat(131073)])
 test('correction: bounded unambiguous JSON replacement required',async()=>{
  const f=fixture({items:[{correctReplacement:text}]});await assert.rejects(f.run(),{code:'invalid_params'});assert.equal(f.connections,0);
 });
for(const patch of [{expectedActor:''},{expectedInstance:''},{rootUri:'ultra://selected/directory'},{correctionProject:'../bad'},
 {allowMemoryCorrection:false,allowCapture:true,allowMemoryActivation:true},{allowMemoryCorrection:'true'}])
 test('correction: dedicated credential boundary '+JSON.stringify(patch),async()=>{
  const f=fixture({creds:{...credentials,...patch}});await assert.rejects(f.run());assert.equal(f.connections,0);
 });
test('correction: multiple items refused before any memory or writer request',async()=>{
 const f=fixture({items:[{},{}],keepGoing:true}),r=await f.run();assert.ok(r.every(i=>i.json.error==='memory_correction_single_item_required'));
 assert.deepEqual(r.map(i=>i.pairedItem.item),[0,1]);assert.equal(f.connections,0);assert.equal(writes(f).length,0);
});
for(const status of ['candidate','active','archived'])test('correction: owned '+status+' returns to candidate, never calls activation',async()=>{
 const f=fixture({items:[{correctExpectedStatus:status}],record:{status,derivation_current:false}}),r=await f.run();
 assert.equal(r[0].json.result.receipt.status,'candidate');assert.equal(writes(f).length,1);assert.ok(!f.calls.some(c=>c.name==='ultra_personal_review'));
});
test('correction: all seven replacement fields identical refuse no-op',async()=>{
 const f=fixture({items:[{correctReplacement:JSON.stringify(replacement({content:'PRIVATE_BODY',provenance:'PRIVATE_PROVENANCE'}))}]});
 await assert.rejects(f.run(),{code:'memory_correction_no_change'});assert.equal(writes(f).length,0);
});
for(const [key,value]of [['revision',2],['status','archived'],['visibility','source'],['content_hash','0'.repeat(64)],['content','CHANGED'],['project_id','mine']])
 test('correction: changed observation '+key+' refused without write',async()=>{
  const record={[key]:value};if(key==='content')record.content_hash=hash(value);
  const f=fixture({record});await assert.rejects(f.run());assert.equal(writes(f).length,0);
 });
for(const [record,code]of [[{owned_by_caller:false,status:'active',visibility:'source'},'memory_inspect_not_owned'],[{origin_kind:'document_fragment'},'memory_inspect_document_bound']])
 test('correction: nonowned and document records refused',async()=>{
  const f=fixture({record});await assert.rejects(f.run(),{code});assert.equal(writes(f).length,0);
 });
test('correction: missing configured project, foreign source or destination cannot borrow scope',async()=>{
 for(const [creds,items]of [[{...credentials,correctionProject:''},{correctScope:'global-and-project'}],
  [credentials,{correctScope:'global-and-project',correctExpectedProject:'other'}],
  [credentials,{correctScope:'global-and-project',correctReplacement:JSON.stringify(replacement({project_id:'other'}))}]]){
  const f=fixture({creds,items:[items]});await assert.rejects(f.run());assert.equal(f.connections,0);
 }
});
for(const target of [{project_id:'mine'},{visibility:'source'}])test('correction: scope change requires both grant and explicit consent',async()=>{
 for(const [grant,consent]of [[false,false],[true,false],[false,true]]){
  const f=fixture({creds:{...credentials,allowCorrectionScopeChange:grant},items:[{correctScope:'global-and-project',correctScopeChangeConsent:consent,correctReplacement:JSON.stringify(replacement(target))}]});
  await assert.rejects(f.run(),{code:'memory_correction_scope_consent_required'});assert.equal(f.connections,0);
 }
 const f=fixture({creds:{...credentials,allowCorrectionScopeChange:true},items:[{correctScope:'global-and-project',correctScopeChangeConsent:true,correctReplacement:JSON.stringify(replacement(target))}]});
 assert.equal((await f.run())[0].json.result.receipt.status,'candidate');assert.equal(writes(f)[0].args.memory.project_id,target.project_id??null);
});
test('correction: replay after movement uses destination not old project and never returns current state',async()=>{
 const f=fixture({creds:{...credentials,allowCorrectionScopeChange:true},items:[{correctMode:'replay',correctScope:'global-and-project',correctScopeChangeConsent:true,
  correctReplacement:JSON.stringify(replacement({project_id:'mine'}))}],record:{revision:4,status:'active',project_id:'mine'},ack:{replayed:true}});
 const r=(await f.run())[0].json.result;assert.equal(r.receipt.status,'candidate');assert.equal(r.observed_revision,4);assert.equal(r.current_state_verified,false);
});
test('correction: replay with unchanged current revision cannot generate a first update',async()=>{
 const f=fixture({items:[{correctMode:'replay'}]});await assert.rejects(f.run(),{code:'memory_correction_replay_unavailable'});assert.equal(writes(f).length,0);
});
for(const ack of [{id:uuid(2)},{status:'active'},{revision:3},{review_required:false},{replayed:'true'},{extra:'PRIVATE'}])
 test('correction: malformed receipt is unconfirmed, not success',async()=>{
  const f=fixture({ack});await assert.rejects(f.run(),{code:'memory_correction_receipt_unconfirmed',write_delivery:'unconfirmed'});assert.equal(writes(f).length,1);
 });
test('correction: replay cannot accept a fresh-mutation receipt',async()=>{
 const f=fixture({items:[{correctMode:'replay'}],record:{revision:2}});await assert.rejects(f.run(),{code:'memory_correction_receipt_unconfirmed',write_delivery:'unconfirmed'});
});
for(const code of ['revision_conflict','conflict','permission_denied','insufficient_scope','not_found','PRIVATE_ERROR'])
 test('correction: rejected update safely reports '+code,async()=>{
  const f=fixture({keepGoing:true,reply:(q,v)=>q.name==='ultra_personal_update'?{...wire({error:code,message:'PRIVATE_MESSAGE'}),isError:true}:wire(v)});
  const r=(await f.run())[0].json;assert.equal(r.error,code==='PRIVATE_ERROR'?'memory_correction_receipt_unconfirmed':code);assert.equal(r.write_delivery,'unconfirmed');assert.ok(!JSON.stringify(r).includes('PRIVATE'));
 });
for(const checkpoint of [1,2,3,4])test('correction: identity mismatch at '+checkpoint+' retains accurate delivery',async()=>{
 let n=0;const f=fixture({reply:(q,v)=>{if(q.name==='ultra_identity'&&++n===checkpoint)v.actor_key='b'.repeat(64);return wire(v);}});
 await assert.rejects(f.run(),e=>e.code==='identity_mismatch'&&e.write_delivery===(checkpoint===4?'confirmed':'not_started'));
});
for(const stage of ['read','pre-write','write','post-write','close'])test('correction: cancellation at '+stage,async()=>{
 let identities=0;const f=fixture({phase:(name,c)=>{if(name==='ultra_identity')identities++;
  if(stage==='read'&&name==='ultra_memory_read'||stage==='pre-write'&&name==='ultra_identity'&&identities===3||
   stage==='write'&&name==='ultra_personal_update'||stage==='post-write'&&name==='ultra_identity'&&identities===4||stage==='close'&&name==='close')c.abort();}});
 await assert.rejects(f.run(),e=>e.code==='cancelled'&&e.write_delivery===(['post-write','close'].includes(stage)?'confirmed':stage==='write'?'unconfirmed':'not_started'));
});
test('correction: request data is copied and frozen before first asynchronous identity check',async()=>{
 const f=fixture(),s=await automationSession(f.client,automationSettings(credentials)),q=request();const result=s.run('personal_correct',q);
 q.memory.content='PRIVATE_REPLACED';q.event_id='another';q.consent=false;assert.equal((await result).event_id,'correction-original');assert.equal(writes(f)[0].args.memory.content,'PRIVATE_CORRECTED');
});
test('correction: only explicit correction parameters evaluated, no hidden query or input JSON',async()=>{
 const f=fixture();await f.run();assert.ok(f.parameters.every(n=>n==='operation'||n==='timeoutMs'||n.startsWith('correct')));
});
for(const field of ['reviewer_identity','reason','status','source_id','actor_key'])test('correction: extra authority field rejected '+field,()=>{
 assert.throws(()=>automationMemoryCorrectionRequest({...request(),[field]:'untrusted'},automationSettings(credentials)));
});
for(const field of ['content','provenance','confidence'])test('correction: replacement getter refused without invocation '+field,()=>{
 let calls=0;const r=request();Object.defineProperty(r.memory,field,{enumerable:true,get(){calls++;return 'PRIVATE';}});
 assert.throws(()=>automationMemoryCorrectionRequest(r,automationSettings(credentials)));assert.equal(calls,0);
});
test('correction: empty execution and pre-cancel do not open transport',async()=>{
 const empty=fixture({items:[]});assert.deepEqual(await empty.run(),[]);assert.equal(empty.credentialReads,0);
 const f=fixture();f.controller.abort();await assert.rejects(f.run(),{code:'cancelled',write_delivery:'not_started'});assert.equal(f.connections,0);
});
