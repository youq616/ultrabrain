import test from 'node:test';import assert from 'node:assert/strict';
import {fixture,wire,credentials,uuid,hash,defaults,request} from './helpers/n8n-memory-review-fixture.mjs';
import {automationSession,automationSettings} from '../src/automation-session.mjs';
import {automationMemoryReviewRequest,automationMemoryReviewFailure} from '../src/automation-memory-review.mjs';
const writes=f=>f.calls.filter(c=>c.name==='ultra_personal_review');
test('review: one owned activation, exact original server fields, no extra text or identity',async()=>{
 const f=fixture(),r=(await f.run())[0];assert.equal(r.json.result.write_delivery,'confirmed');assert.deepEqual(r.pairedItem,{item:0});
 assert.deepEqual(f.calls.map(c=>c.name),['ultra_identity','ultra_identity','ultra_memory_read','ultra_identity','ultra_personal_review','ultra_identity']);
 assert.deepEqual(writes(f)[0].args,{memory_id:uuid(1),expected_revision:1,event_id:'approved-event',status:'active'});
 assert.equal(r.json.result.receipt.revision,2);assert.equal(r.json.result.human_identity_verified,false);assert.equal(r.json.result.current_state_verified,false);
 assert.ok(!JSON.stringify(r).includes('PRIVATE'));assert.ok(Object.isFrozen(r.json.result.receipt));assert.equal(f.closed,1);
});
test('review: archive is independent of activation/capture permissions and accepts stale source',async()=>{
 const f=fixture({items:[{reviewAction:'archived'}],creds:{...credentials,allowMemoryActivation:false},record:{derivation_current:false}});
 assert.equal((await f.run())[0].json.result.receipt.status,'archived');assert.equal(writes(f).length,1);
});
for(const patch of [{reviewConsent:false},{reviewConsent:'true'},{reviewAcknowledgeEffects:false},{reviewAction:''},{reviewAction:'reject'},
 {reviewMode:'automatic'},{reviewMemoryId:'short'},{reviewExpectedRevision:0},{reviewExpectedRevision:2147483647},{reviewExpectedRevision:'1'},
 {reviewExpectedHash:'A'.repeat(64)},{reviewExpectedStatus:''},{reviewExpectedVisibility:''},{reviewExpectedProject:null},
 {reviewEventId:''},{reviewSharedConsent:'true'},{reviewScope:'all'}])test('review: preflight refuses '+JSON.stringify(patch),async()=>{
 const f=fixture({items:[patch]});await assert.rejects(f.run(),e=>e.write_delivery==='not_started'&&e.memory_writes_requested===false);
 assert.equal(f.connections,0);assert.equal(f.calls.length,0);
});
for(const patch of [{expectedActor:''},{expectedInstance:''},{rootUri:'ultra://selected/folder'},{allowMemoryActivation:false},
 {allowMemoryActivation:'true'},{reviewProject:'../bad'}])test('review: disabled credential refuses before connection '+JSON.stringify(patch),async()=>{
 const f=fixture({creds:{...credentials,...patch}});await assert.rejects(f.run());assert.equal(f.connections,0);
});
test('review: capture grant never grants activation or archive',async()=>{
 for(const action of ['active','archived']){const f=fixture({items:[{reviewAction:action}],creds:{...credentials,allowCapture:true,allowMemoryActivation:false,allowMemoryArchive:false}});
 await assert.rejects(f.run(),{code:'memory_review_disabled'});assert.equal(f.calls.length,0);}
});
test('review: multiple input items refused before any write or connection',async()=>{
 const f=fixture({items:[{},{}],keepGoing:true});const r=await f.run();assert.equal(r.length,2);
 assert.ok(r.every(i=>i.json.error==='memory_review_single_item_required'));assert.equal(f.connections,0);
});
for(const grant of [false,true])for(const consent of [false,true])test('review: shared activation needs both switches '+grant+'/'+consent,async()=>{
 const f=fixture({creds:{...credentials,allowSourceActivation:grant},items:[{reviewExpectedVisibility:'source',reviewSharedConsent:consent}],record:{visibility:'source'}});
 if(grant&&consent)assert.equal((await f.run())[0].json.ok,true);
 else{await assert.rejects(f.run(),{code:'memory_review_shared_consent_required'});assert.equal(f.connections,0);}
});
test('review: metadata drift to shared cannot borrow a private approval',async()=>{
 const f=fixture({record:{visibility:'source'}});await assert.rejects(f.run(),{code:'memory_review_selected_changed'});assert.equal(writes(f).length,0);
});
for(const record of [{revision:2},{status:'archived'},{content:'new',content_hash:hash('new')},{project_id:'mine'}])test('review: changed observed record refuses '+JSON.stringify(record),async()=>{
 const f=fixture({record});await assert.rejects(f.run());assert.equal(writes(f).length,0);
});
for(const [record,code]of [[{owned_by_caller:false,status:'active',visibility:'source'},'memory_inspect_not_owned'],
 [{origin_kind:'document_fragment'},'memory_inspect_document_bound'],[{derivation_current:false},'memory_review_stale_source']])test('review: forbidden target '+code,async()=>{
 const f=fixture({record});await assert.rejects(f.run(),{code});assert.equal(writes(f).length,0);
});
test('review: same-state selection does not silently advance version',async()=>{
 const f=fixture({record:{status:'active'},items:[{reviewExpectedStatus:'active'}]});await assert.rejects(f.run(),{code:'memory_review_no_change'});assert.equal(writes(f).length,0);
});
test('review: explicit credential review project, unrelated project selectors ignored',async()=>{
 const f=fixture({record:{project_id:'mine'},items:[{reviewExpectedProject:'mine',reviewScope:'global-and-project',projectId:'foreign',inspectProject:'foreign'}]});
 assert.equal((await f.run())[0].json.ok,true);assert.ok(!f.parameters.includes('projectId'));
 for(const project of ['', 'other']){const denied=fixture({items:[{reviewExpectedProject:'mine',reviewScope:'global-and-project'}],creds:{...credentials,reviewProject:project}});
 await assert.rejects(denied.run());assert.equal(denied.connections,0);}
});
test('review: replay original receipt on advanced archived revision is not current state',async()=>{
 const f=fixture({items:[{reviewMode:'replay'}],record:{revision:4,status:'archived'},ack:{replayed:true}});
 const r=(await f.run())[0].json.result;assert.equal(r.observed_revision,4);assert.equal(r.receipt.revision,2);assert.equal(r.receipt.status,'active');assert.equal(r.current_state_verified,false);
});
test('review: replay at original revision cannot make a first mutation',async()=>{
 const f=fixture({items:[{reviewMode:'replay'}]});await assert.rejects(f.run(),{code:'memory_review_replay_unavailable'});assert.equal(writes(f).length,0);
});
for(const patch of [{id:uuid(2)},{revision:3},{status:'archived'},{replayed:'true'},{assurance:42},{extra:'PRIVATE'}])test('review: invalid receipt remains unconfirmed '+JSON.stringify(patch),async()=>{
 const f=fixture({ack:patch});await assert.rejects(f.run(),{code:'memory_review_receipt_unconfirmed',write_delivery:'unconfirmed'});assert.equal(writes(f).length,1);
});
test('review: replay receipt cannot assert fresh mutation',async()=>{
 const f=fixture({record:{revision:2},items:[{reviewMode:'replay'}]});await assert.rejects(f.run(),{code:'memory_review_receipt_unconfirmed',write_delivery:'unconfirmed'});
});
for(const code of ['revision_conflict','conflict','stale_source','insufficient_scope','PRIVATE'])test('review: rejected server write preserves safe code and event without retry '+code,async()=>{
 const f=fixture({keepGoing:true,reply:(q,v)=>q.name==='ultra_personal_review'?{...wire({error:code,message:'PRIVATE_REMOTE'}),isError:true}:wire(v)});
 const r=(await f.run())[0].json;assert.equal(r.error,code==='PRIVATE'?'memory_review_receipt_unconfirmed':code);assert.equal(r.write_delivery,'unconfirmed');
 assert.equal(writes(f).length,1);assert.ok(!JSON.stringify(r).includes('PRIVATE'));
});
for(const [phase,outcome]of [['ultra_memory_read','not_started'],['ultra_personal_review','unconfirmed'],['close','confirmed']])test('review: cancellation at '+phase+' preserves '+outcome,async()=>{
 const f=fixture({phase:(name,c)=>{if(name===phase)c.abort();}});await assert.rejects(f.run(),{code:'cancelled',write_delivery:outcome});assert.equal(f.closed,1);
});
for(const point of [1,2,3,4])test('review: identity changes at checkpoint '+point,async()=>{
 let n=0;const f=fixture({reply:(q,v)=>{if(q.name==='ultra_identity'&&++n===point)v.actor_key='b'.repeat(64);return wire(v);}});
 await assert.rejects(f.run(),e=>e.code==='identity_mismatch'&&e.write_delivery===(point===4?'confirmed':'not_started'));
});
test('review: only operation-specific parameters evaluated',async()=>{
 const f=fixture();await f.run();assert.ok(f.parameters.every(k=>k==='operation'||k==='timeoutMs'||k.startsWith('review')));
});
test('review: request event/consent/action snapshotted before async identity checks',async()=>{
 const f=fixture(),s=await automationSession(f.client,automationSettings(credentials)),r=request(),p=s.run('personal_review',r);
 r.event_id='different';r.action='archived';r.consent=false;const result=await p;assert.equal(result.event_id,'approved-event');assert.equal(result.receipt.status,'active');
});
for(const key of ['reviewer_identity','reason','include_text','project_id','source_id'])test('review: unsupported claimed authority/field '+key,()=>{
 assert.throws(()=>automationMemoryReviewRequest({...request(),[key]:'untrusted'},automationSettings(credentials)));
});
test('review: errors cannot invent delivery counters',()=>{
 const r=automationMemoryReviewFailure({code:'conflict',write_delivery:'confirmed',write_attempts:100});assert.equal(r.write_delivery,'not_started');assert.equal(r.memory_writes_requested,false);
});
test('review: empty input remains no-op',async()=>{
 const f=fixture({items:[]});assert.deepEqual(await f.run(),[]);assert.equal(f.credentialReads,0);
});
