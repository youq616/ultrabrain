/** Separate implementer review, not a second reviewer agent. */
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {sha256} from '../src/core.mjs';import {recallEvaluationRequest,recallEvaluationFailure,deliverRecallEvaluation} from '../src/client-recall-evaluation.mjs';
const workspace=mkdtempSync(join(tmpdir(),'ub-eval-review-'));process.on('exit',()=>rmSync(workspace,{recursive:true,force:true}));
const uuid=n=>String(n).padStart(8,'0')+'-1111-4111-8111-111111111111';
const profile={allowTaskContext:true,workspace,expectedInstance:uuid(90),expectedActor:'a'.repeat(64),source:'default',projectId:null,budgetBytes:8192};
const item=(more={})=>({id:'case',task:'PRIVATE_TASK',relevant_ids:[uuid(1)],forbidden_ids:[uuid(2)],...more});
const request=(more={})=>({workspace,consent:true,top_k:5,cases:[item()],...more});
const row=n=>({id:uuid(n),type:'preference',content:'PRIVATE_'+n,content_hash:sha256('PRIVATE_'+n),status:'active',owned_by_caller:true,project_id:null});
const io=rows=>({checkIdentity:async()=>{},invoke:async()=>({source_id:'default',memories:rows})});
test('review: independent loop oracle agrees on twenty rankings and annotations',async()=>{
 for(let seed=0;seed<20;seed++){
  const numbers=Array.from({length:seed%11},(_,i)=>(i*7+seed)%23),labels=[0,4,8,12,16],forbidden=[21,22],k=seed%8+1;
  const r=await deliverRecallEvaluation(request({top_k:k,cases:[item({relevant_ids:labels.map(uuid),forbidden_ids:forbidden.map(uuid)})]}),profile,io(numbers.map(row)));
  let hits=0,first=0,bad=0;for(let i=0;i<numbers.length;i++){if(forbidden.indexOf(numbers[i])!==-1)bad++;
   if(i<k&&labels.indexOf(numbers[i])!==-1){hits++;if(!first)first=i+1;}}
  assert.equal(r.cases[0].precision_at_k,hits/k);assert.equal(r.cases[0].recall_at_k,hits/labels.length);
  assert.equal(r.cases[0].reciprocal_rank_at_k,first?1/first:0);assert.equal(r.summary.forbidden_occurrences,bad);
 }
});
test('review: 32-case boundary runs sequentially without extra context reads',async()=>{
 let inflight=0,peak=0,calls=0;
 const r=await deliverRecallEvaluation(request({cases:Array.from({length:32},(_,i)=>item({id:String(i)}))}),profile,
  {checkIdentity:async()=>{},invoke:async()=>{inflight++;peak=Math.max(peak,inflight);calls++;await new Promise(r=>setImmediate(r));inflight--;return {source_id:'default',memories:[]};}});
 assert.equal(peak,1);assert.equal(calls,32);assert.equal(r.query_requests,32);assert.equal(r.summary.mean_recall_at_k,0);
});
for(const bad of ['source','hash','inactive','project','private'])test('review: invalid context withheld '+bad,async()=>{
 const result={source_id:'default',memories:[row(1)]};
 if(bad==='source')result.source_id='other';if(bad==='hash')result.memories[0].content_hash='a'.repeat(64);
 if(bad==='inactive')result.memories[0].status='candidate';if(bad==='project')result.memories[0].project_id='other';
 if(bad==='private'){result.memories[0].owned_by_caller=false;result.memories[0].visibility='private';}
 await assert.rejects(deliverRecallEvaluation(request(),profile,{checkIdentity:async()=>{},invoke:async()=>result}),
  e=>e.code==='recall_evaluation_unconfirmed'&&e.query_attempts===1&&e.completed_cases===0);
});
for(const kind of ['sparse','symbol','hidden','getter'])test('review: array anomalies rejected '+kind,()=>{
 const q=request();let called=0;if(kind==='sparse')q.cases=Array(1);if(kind==='symbol')q.cases[Symbol('private')]=1;
 if(kind==='hidden')Object.defineProperty(q.cases,'secret',{value:1});
 if(kind==='getter')Object.defineProperty(q.cases[0].relevant_ids,0,{get(){called++;return uuid(1);}});
 assert.throws(()=>recallEvaluationRequest(q,profile));assert.equal(called,0);
});
test('review: aggregate bound rejects individually valid but excessive cases before IO',async()=>{
 let calls=0;const cases=Array.from({length:32},(_,i)=>item({id:String(i),task:'x'.repeat(4096),relevant_ids:Array.from({length:100},(_,j)=>uuid(j+3))}));
 await assert.rejects(deliverRecallEvaluation(request({cases}),profile,{checkIdentity:async()=>calls++,invoke:async()=>calls++}),{code:'input_too_large'});assert.equal(calls,0);
});
test('review: original task retained, expected/forbidden IDs and workspace never transmitted',async()=>{
 const task='不可以共享\r\n🙂 E\u0301 ';let query;
 await deliverRecallEvaluation(request({cases:[item({task})]}),profile,{checkIdentity:async()=>{},invoke:async(_n,q)=>{query=q;return {source_id:'default',memories:[]};}});
 assert.equal(query.task,task);assert.deepEqual(Object.keys(query),['task','limit','budget_bytes']);
 assert.ok(!JSON.stringify(query).includes(uuid(1))&&!JSON.stringify(query).includes(workspace));
});
test('review: revoked exception Proxy cannot break safe projection',()=>{
 const p=Proxy.revocable({},{});p.revoke();const e=recallEvaluationFailure(p.proxy);assert.equal(e.code,'recall_evaluation_unconfirmed');assert.equal(e.query_attempts,0);
});
test('review: suite fingerprint binds k and labels; settings are explicit metadata',async()=>{
 const a=await deliverRecallEvaluation(request(),profile,io([])),b=await deliverRecallEvaluation(request({top_k:4}),profile,io([]));
 const c=await deliverRecallEvaluation(request({cases:[item({relevant_ids:[uuid(3)]})]}),profile,io([]));
 assert.notEqual(a.suite_sha256,b.suite_sha256);assert.notEqual(a.suite_sha256,c.suite_sha256);
 assert.equal(a.budget_bytes,8192);assert.equal(a.project_id,null);assert.equal(a.semantic_quality_verified,false);
});
test('review: package and both-platform/actual-installed CI gates stay wired',()=>{
 const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8'),build=read('scripts/build-client.mjs'),pack=read('scripts/package-client.sh');
 for(const n of ['recall-eval.cjs','recall-eval-cli.cjs']){assert.ok(build.split("'"+n+"'").length>=3);assert.ok(pack.includes('package/dist/'+n));}
 assert.equal(JSON.parse(read('packages/ultrabrain-client/package.json')).bin['ultrabrain-recall-eval'],'dist/recall-eval-cli.cjs');
 const flow=read('.github/workflows/task-context.yml'),idx=flow.indexOf('run: bun test/client-recall-evaluation-integration.mjs');
 assert.ok(idx>flow.indexOf('npm install --prefix')&&idx<flow.indexOf('name: Stop only isolated database'));assert.ok(flow.includes('recall-evaluation-report.json'));
 const portable=read('.github/workflows/client-portability.yml');assert.ok(portable.includes('windows-2025')&&portable.includes('ubuntu-24.04')&&portable.includes('test/client-recall-evaluation-review.test.mjs'));
});
