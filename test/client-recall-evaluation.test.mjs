/** Scoring and delivery with explicit synthetic IO; not a live-model evaluation. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {sha256} from '../src/core.mjs';
import {recallEvaluationRequest,deliverRecallEvaluation,recallEvaluationFailure} from '../src/client-recall-evaluation.mjs';
const workspace=mkdtempSync(join(tmpdir(),'ub-recall-evaluation-'));
process.on('exit',()=>rmSync(workspace,{recursive:true,force:true}));
const uuid=n=>String(n).padStart(8,'0')+'-1111-4111-8111-111111111111';
const profile=Object.freeze({source:'default',projectId:'project',budgetBytes:8192,allowTaskContext:true,
 workspace,expectedInstance:uuid(99),expectedActor:'a'.repeat(64)});
const row=n=>({id:uuid(n),type:'preference',content:'PRIVATE_MEMORY_'+n,content_hash:sha256('PRIVATE_MEMORY_'+n),
 status:'active',project_id:'project',owned_by_caller:true,derivation_current:true});
const item=(id='one',more={})=>({id,task:'PRIVATE_TASK_'+id,relevant_ids:[uuid(2),uuid(4)],forbidden_ids:[uuid(9)],...more});
const request=(cases=[item()])=>({workspace,consent:true,top_k:3,cases});
function fixture(ids=[1,2,9,4]){const calls=[];return {calls,checkIdentity:async()=>calls.push('identity'),
 invoke:async(name,args,signal)=>{calls.push({name,args,signal});return {source_id:'default',memories:ids.map(row)};}};}
test('evaluation: exact frozen selection, labels and task bytes preserved',()=>{
 const r=recallEvaluationRequest(request(),profile);assert.equal(r.cases[0].task,'PRIVATE_TASK_one');
 assert.ok(Object.isFrozen(r.cases[0].relevant_ids));assert.ok(Object.isFrozen(r));
});
for(const patch of [{consent:false},{top_k:0},{top_k:21},{top_k:1.5},{workspace:'relative'},{scope:'all'},
 {cases:[]},{cases:Array.from({length:33},(_,i)=>item(String(i)))}, {cases:[item(),item()]}])
 test('evaluation: invalid selection never reaches IO '+Object.keys(patch),async()=>{
  const f=fixture();await assert.rejects(deliverRecallEvaluation({...request(),...patch},profile,f));assert.deepEqual(f.calls,[]);
 });
for(const patch of [{task:''},{task:'x'.repeat(4097)},{task:'\ud800'},{task:'x\0y'},{relevant_ids:[uuid(2),uuid(2)]},
 {relevant_ids:[uuid(9)]},{forbidden_ids:['bad']},{relevant_ids:[],forbidden_ids:[]},{id:'bad id'}, {include_text:true}])
 test('evaluation: invalid case is rejected before any case sends '+Object.keys(patch),async()=>{
  const f=fixture();await assert.rejects(deliverRecallEvaluation(request([item('first'),item('second',patch)]),profile,f));assert.deepEqual(f.calls,[]);
 });
for(const field of ['allowTaskContext','workspace','expectedActor','expectedInstance'])test('evaluation: profile boundary '+field,async()=>{
 const f=fixture();await assert.rejects(deliverRecallEvaluation(request(),{...profile,[field]:null},f));assert.deepEqual(f.calls,[]);
});
test('evaluation: exact top-k formulas; forbidden IDs counted across the whole response',async()=>{
 const f=fixture([1,2,4,9]);const r=await deliverRecallEvaluation(request(),profile,f);
 const c=r.cases[0];assert.equal(c.precision_at_k,2/3);assert.equal(c.recall_at_k,1);assert.equal(c.reciprocal_rank_at_k,1/2);
 assert.deepEqual(c.top_ids,[uuid(1),uuid(2),uuid(4)]);assert.deepEqual(c.forbidden_ids_seen,[uuid(9)]);
 assert.equal(r.summary.forbidden_case_count,1);assert.equal(r.summary.positive_case_count,1);
 assert.equal(r.summary.mean_recall_at_k,1);assert.equal(r.query_requests,1);assert.equal(r.memory_writes_requested,false);
 assert.deepEqual(f.calls.map(c=>typeof c==='string'?c:c.name),['identity','ultra_personal_context','identity']);
 assert.deepEqual(f.calls[1].args,{task:'PRIVATE_TASK_one',limit:20,budget_bytes:8192,project_id:'project'});
 assert.ok(!JSON.stringify(r).includes('PRIVATE_'));assert.ok(!JSON.stringify(r).includes(workspace));
});
test('evaluation: underfilled k retains fixed denominator; no hits is zero, not null',async()=>{
 const r=await deliverRecallEvaluation(request(),profile,fixture([2]));
 assert.equal(r.cases[0].precision_at_k,1/3);assert.equal(r.cases[0].recall_at_k,1/2);
 const empty=await deliverRecallEvaluation(request(),profile,fixture([]));assert.equal(empty.cases[0].recall_at_k,0);
 assert.equal(empty.cases[0].reciprocal_rank_at_k,0);assert.equal(empty.summary.hit_rate_at_k,0);
});
test('evaluation: negative-only annotations do not fabricate positive-quality scores',async()=>{
 const r=await deliverRecallEvaluation(request([item('negative',{relevant_ids:[]})]),profile,fixture([1]));
 for(const k of ['precision_at_k','recall_at_k','reciprocal_rank_at_k'])assert.equal(r.cases[0][k],null);
 assert.equal(r.summary.positive_case_count,0);assert.equal(r.summary.mean_recall_at_k,null);
 assert.equal(r.summary.hit_rate_at_k,null);assert.equal(r.summary.forbidden_case_count,0);
});
test('evaluation: macro averages are case-weighted and exclude negative-only labels',async()=>{
 const f=fixture([2]);const r=await deliverRecallEvaluation(request([item('a'),item('b',{relevant_ids:[uuid(2)]}),item('c',{relevant_ids:[]})]),profile,f);
 assert.equal(r.summary.mean_recall_at_k,0.75);assert.equal(r.summary.mean_precision_at_k,1/3);
 assert.equal(r.summary.mean_reciprocal_rank_at_k,1);assert.equal(r.summary.case_count,3);assert.equal(r.query_requests,3);
});
for(const ids of [[2,2],Array.from({length:21},(_,i)=>i)])test('evaluation: duplicate IDs or oversized result cannot inflate score',async()=>{
 await assert.rejects(deliverRecallEvaluation(request(),profile,fixture(ids)),e=>e.code==='recall_evaluation_unconfirmed'&&e.query_attempts===1);
});
for(const phase of ['before','identity','response','final-identity'])test('evaluation: revocation fences '+phase,async()=>{
 let allowed=phase!=='before',ids=0;const f=fixture();const original=f.invoke;
 f.authorize=()=>allowed;f.checkIdentity=async()=>{if(++ids===(phase==='identity'?1:2)&&phase!=='response')allowed=false;};
 f.invoke=async(...a)=>{const r=await original(...a);if(phase==='response')allowed=false;return r;};
 await assert.rejects(deliverRecallEvaluation(request(),profile,f),e=>e.code==='client_authorization_revoked'&&e.query_attempts===(['response','final-identity'].includes(phase)?1:0));
});
test('evaluation: second failure withholds completed first case, no retry or fallback',async()=>{
 let n=0;const f=fixture(),original=f.invoke;f.invoke=async(...a)=>{if(++n===2)throw Error('PRIVATE_SECRET');return original(...a);};
 await assert.rejects(deliverRecallEvaluation(request([item('a'),item('b'),item('c')]),profile,f),e=>
  e.query_attempts===2&&e.completed_cases===1&&e.query_delivery==='unconfirmed'&&!e.message.includes('PRIVATE')&&!('cases' in e));assert.equal(n,2);
});
test('evaluation: cancellation reaches invocation and stops remaining cases',async()=>{
 const c=new AbortController(),f=fixture();f.signal=c.signal;
 f.invoke=async(_n,_a,signal)=>{assert.equal(signal,c.signal);c.abort();return {source_id:'default',memories:[]};};
 await assert.rejects(deliverRecallEvaluation(request([item('a'),item('b')]),profile,f),{code:'aborted'});
});
test('evaluation: caller mutations after first await cannot alter selected task or labels',async()=>{
 const input=request(),f=fixture([2]);f.checkIdentity=async()=>{input.cases[0].task='CHANGED';input.cases[0].relevant_ids=[];};
 const r=await deliverRecallEvaluation(input,profile,f);assert.equal(r.cases[0].relevant_count,2);assert.equal(f.calls[0].args.task,'PRIVATE_TASK_one');
});
test('evaluation: getters and extra hidden fields rejected without execution',()=>{
 let n=0;const input=request();Object.defineProperty(input.cases[0],'task',{enumerable:true,get(){n++;return 'private';}});
 assert.throws(()=>recallEvaluationRequest(input,profile));assert.equal(n,0);
 const extra=request();extra[Symbol('secret')]=true;assert.throws(()=>recallEvaluationRequest(extra,profile));
});
test('evaluation: errors cannot forge attempts or invoke code getters',()=>{
 let n=0;const e=recallEvaluationFailure({query_attempts:9,get code(){n++;throw Error('PRIVATE');}});
 assert.equal(e.query_attempts,0);assert.equal(e.query_delivery,'not_started');assert.equal(n,0);
});
