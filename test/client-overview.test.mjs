/** Delivery contract with synthetic IO; production transport is tested separately. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {clientOverviewRequest,deliverClientOverview,clientOverviewFailure} from '../src/client-overview.mjs';
import {overviewReceipt} from './helpers/overview-fixture.mjs';
const workspace=mkdtempSync(join(tmpdir(),'ub-overview-'));
process.on('exit',()=>rmSync(workspace,{recursive:true,force:true}));
const profile=Object.freeze({source:'selected',workspace,expectedInstance:'11111111-1111-4111-8111-111111111111',expectedActor:'a'.repeat(64),projectId:'a-project'});
const request=()=>({workspace,consent:true,scope:'owned-all-projects'});
function fixture(){
 const calls=[];return {calls,io:{checkIdentity:async()=>{calls.push('identity');},invoke:async(name,args)=>{calls.push({name,args});return overviewReceipt(args.request_id);}}};
}
test('overview selection is explicit, exact and frozen',()=>{
 const input=request(),result=clientOverviewRequest(input,profile);
 assert.deepEqual(result,input);assert.notEqual(result,input);assert.ok(Object.isFrozen(result));
});
for(const patch of [{consent:false},{consent:'true'},{consent:undefined},{scope:undefined},{scope:'project'},{workspace:'relative'},
 {source_id:'other'},{actor_key:'other'},{project_id:'project'},{request_id:'id'},{include_text:true},{retry:true},{limit:10}])
 test('overview rejects selection before IO '+JSON.stringify(patch),async()=>{
  const f=fixture();await assert.rejects(deliverClientOverview({...request(),...patch},profile,f.io));assert.deepEqual(f.calls,[]);
 });
for(const field of ['expectedActor','expectedInstance','workspace'])test('overview pins required before IO '+field,async()=>{
 const f=fixture();await assert.rejects(deliverClientOverview(request(),{...profile,[field]:null},f.io),{code:'overview_disabled'});assert.deepEqual(f.calls,[]);
});
for(const field of ['workspace','consent','scope'])test('selection getter never invoked '+field,()=>{
 const input=request();let reads=0;Object.defineProperty(input,field,{enumerable:true,get(){reads++;return true;}});
 assert.throws(()=>clientOverviewRequest(input,profile),{code:'invalid_params'});assert.equal(reads,0);
});
for(const name of ['hidden','symbol'])test('hidden selection field rejected '+name,()=>{
 const input=request();Object.defineProperty(input,name==='symbol'?Symbol('secret'):'secret',{value:'private'});
 assert.throws(()=>clientOverviewRequest(input,profile),{code:'invalid_params'});
});
test('one UUID-only overview with before/after identity checks, no project selector or bodies',async()=>{
 const f=fixture(),r=await deliverClientOverview(request(),profile,f.io);
 assert.deepEqual(f.calls.map(c=>typeof c==='string'?c:c.name),['identity','ultra_personal_overview','identity']);
 assert.deepEqual(Object.keys(f.calls[1].args),['request_id']);assert.equal(r.overview.request_id,f.calls[1].args.request_id);
 assert.equal(r.read_requests,1);assert.equal(r.memory_writes_requested,false);assert.equal(r.overview.memories.total,12);
 assert.equal(r.format,'ultrabrain-client-overview-v1');assert.ok(Object.isFrozen(r)&&Object.isFrozen(r.overview.jobs));
 assert.ok(!JSON.stringify(r).includes(workspace));assert.ok(!JSON.stringify(r).includes(profile.expectedActor));
});
test('each explicit read uses a different UUID, no cache',async()=>{
 const f=fixture();const one=await deliverClientOverview(request(),profile,f.io),two=await deliverClientOverview(request(),profile,f.io);
 assert.notEqual(one.overview.request_id,two.overview.request_id);assert.equal(f.calls.filter(c=>c.name).length,2);
});
for(const patch of [r=>r.source_id='other',r=>r.request_id='22222222-2222-4222-8222-222222222222',r=>r.memories.total++,r=>r.body='PRIVATE',r=>r.model_calls=1])
 test('entire invalid aggregate withheld without retry',async()=>{
  const f=fixture();f.io.invoke=async(name,args)=>{f.calls.push(name);const r=overviewReceipt(args.request_id);patch(r);return r;};
  await assert.rejects(deliverClientOverview(request(),profile,f.io),e=>e.code==='personal_overview_unconfirmed'&&e.read_delivery==='unconfirmed'&&e.read_attempts===1);
  assert.deepEqual(f.calls,['identity','ultra_personal_overview']);
 });
for(const phase of ['before','identity','response','final-identity'])test('revocation fences '+phase,async()=>{
 let allowed=phase!=='before',ids=0;const f=fixture();f.io.authorize=()=>allowed;
 f.io.checkIdentity=async()=>{f.calls.push('identity');if(++ids===(phase==='final-identity'?2:1)&&phase!=='response')allowed=false;};
 f.io.invoke=async(name,args)=>{f.calls.push(name);if(phase==='response')allowed=false;return overviewReceipt(args.request_id);};
 await assert.rejects(deliverClientOverview(request(),profile,f.io),e=>e.code==='client_authorization_revoked'&&e.read_delivery===(['response','final-identity'].includes(phase)?'unconfirmed':'not_started'));
 assert.equal(f.calls.filter(c=>c==='ultra_personal_overview').length,['response','final-identity'].includes(phase)?1:0);
});
test('cancellation during read reaches transport and denies delivery',async()=>{
 const f=fixture(),controller=new AbortController();f.io.signal=controller.signal;
 f.io.invoke=async(name,args,signal)=>{assert.equal(signal,controller.signal);controller.abort();return overviewReceipt(args.request_id);};
 await assert.rejects(deliverClientOverview(request(),profile,f.io),e=>e.code==='aborted'&&e.read_delivery==='unconfirmed');
});
test('async authorization cannot authorize a read',async()=>{
 const f=fixture();f.io.authorize=async()=>true;await assert.rejects(deliverClientOverview(request(),profile,f.io),{code:'invalid_params'});assert.deepEqual(f.calls,[]);
});
test('selection snapshot survives caller changes across identity wait',async()=>{
 const input=request(),f=fixture();f.io.checkIdentity=async()=>{input.scope='foreign';input.workspace='changed';input.consent=false;};
 const r=await deliverClientOverview(input,profile,f.io);assert.equal(r.overview.scope,'owned-all-projects');
});
test('untrusted transport failure cannot forge success, attempts or leak diagnostics',async()=>{
 const f=fixture();f.io.invoke=async()=>{throw Object.assign(Error('PRIVATE_BEARER_SQL'),{read_attempts:999,code:'PRIVATE'});};
 await assert.rejects(deliverClientOverview(request(),profile,f.io),e=>e.code==='overview_read_unconfirmed'&&e.read_attempts===1&&!e.message.includes('PRIVATE'));
 const forged=clientOverviewFailure({code:'PRIVATE',read_attempts:1,read_delivery:'unconfirmed'});
 assert.equal(forged.read_delivery,'not_started');assert.equal(forged.read_attempts,0);
});

test('self-review: thrown error code getter is never evaluated',()=>{
 let reads=0;const error={get code(){reads++;throw Error('PRIVATE_GETTER_ERROR');}};
 const failure=clientOverviewFailure(error,1);assert.equal(failure.code,'overview_read_unconfirmed');assert.equal(failure.read_attempts,1);assert.equal(reads,0);
});
test('self-review: revoked error proxy reflection is sanitized',()=>{
 const {proxy,revoke}=Proxy.revocable({},{});revoke();const error=clientOverviewFailure(proxy,1);
 assert.equal(error.code,'overview_read_unconfirmed');assert.equal(error.read_delivery,'unconfirmed');
});
