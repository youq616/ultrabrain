import test from 'node:test';import assert from 'node:assert/strict';
import {candidateSelection,evaluateCandidate,reviewReceipt,candidateFailure,CANDIDATE_WORKFLOWS} from '../src/candidate-check.mjs';
import {selection,evidence,receipt,head,base} from './helpers/candidate-fixture.mjs';
const check=(edit=()=>{},p=selection())=>{const e=evidence();edit(e);return evaluateCandidate(p,e);};
test('candidate: complete synthetic evidence meets metadata conditions, never authorizes merge',()=>{
  const r=check();assert.equal(r.status,'metadata_requirements_met');assert.deepEqual(r.blockers,[]);assert.equal(r.merge_authorized,false);
  assert.equal(r.ci.length,9);assert.ok(Object.isFrozen(r.ci[0]));assert.ok(!JSON.stringify(r).includes('SYNTHETIC-SESSION'));
  assert.ok(!JSON.stringify(r).includes('synthetic.test.mjs'));
});
for(const patch of [{repository:'other/repo'},{pr:0},{pr:'29'},{head_sha:'a'.repeat(39)},{base_sha:'A'.repeat(40)},
  {reviewer_ids:[2,2]},{reviewer_ids:[0]},{reviewer_ids:Array(1)},{reviewer_ids:Array.from({length:9},(_,i)=>i+1)},{extra:true}])
  test('candidate: invalid selection '+JSON.stringify(patch),()=>assert.throws(()=>candidateSelection({...selection(),...patch}),{code:'invalid_params'}));
for(const key of ['pr','reviewer_ids'])test('candidate: selection accessors never invoked '+key,()=>{
  const p=selection();let calls=0;Object.defineProperty(p,key,{enumerable:true,get(){calls++;return 29;}});
  assert.throws(()=>candidateSelection(p),{code:'invalid_params'});assert.equal(calls,0);
});
test('candidate: reviewer-array accessors never invoked',()=>{
  const p=selection();let calls=0;Object.defineProperty(p.reviewer_ids,0,{get(){calls++;return 2;}});
  assert.throws(()=>candidateSelection(p),{code:'invalid_params'});assert.equal(calls,0);
});
for(const patch of [{draft:true},{state:'closed'},{merged:true}])test('candidate: PR lifecycle blocks '+JSON.stringify(patch),()=>{
  assert.equal(check(e=>Object.assign(e.pull,patch)).status,'blocked');
});
for(const field of ['head','base'])test('candidate: stale pinned '+field+' throws, never a partial report',()=>{
  assert.throws(()=>check(e=>e.pull[field].sha='d'.repeat(40)),{code:'candidate_contract_invalid'});
});
for(const patch of [{event:'push'},{event:'pull_request_target'},{head_sha:'d'.repeat(40)},{repository:{id:99}},
  {head_repository:{id:99}},{path:'.github/workflows/fake.yml'},{pull_requests:[]}])test('candidate: unrelated run never substitutes '+JSON.stringify(patch),()=>{
  const r=check(e=>Object.assign(e.runs[0],patch));assert.equal(r.ci[0].state,'missing');assert.ok(r.blockers.includes('ci_not_confirmed'));
});
for(const status of ['queued','in_progress','waiting'])test('candidate: newest '+status+' overrides older green',()=>{
  const r=check(e=>{e.runs.push({...e.runs[0],id:999,status,conclusion:null});e.jobs[999]=[];});assert.equal(r.ci[0].state,'pending');
});
for(const conclusion of ['failure','cancelled','skipped','neutral','timed_out'])test('candidate: non-success run '+conclusion+' blocks',()=>{
  assert.equal(check(e=>e.runs[0].conclusion=conclusion).ci[0].state,'failed_or_incomplete');
});
for(const edit of [e=>e.jobs[100]=[],e=>e.jobs[100][0].conclusion='skipped',e=>e.jobs[100][0].run_attempt=2,e=>e.jobs[100][0].run_id=101])
  test('candidate: empty, skipped, wrong-attempt or foreign jobs cannot pass',()=>assert.notEqual(check(edit).ci[0].state,'passed'));
test('candidate: wrong base in run is visible stale-base finding',()=>assert.equal(check(e=>e.runs[0].pull_requests[0].base.sha='d'.repeat(40)).ci[0].state,'stale_base'));
for(const patch of [{state:'COMMENTED'},{state:'PENDING'},{state:'DISMISSED'},{commit_id:'d'.repeat(40)},
  {user:{id:1}},{user:{id:99}},{body:'@codex review 👍'},{body:'You have reached your usage limit'}])
  test('candidate: no false independent approval '+JSON.stringify(patch),()=>{
    assert.equal(check(e=>Object.assign(e.reviews[0],patch)).status,'blocked');
  });
for(const patch of [{independent:false},{scope:'partial'},{head_sha:'d'.repeat(40)},{base_sha:'d'.repeat(40)},{reviewer_session:''},
  {tests:[]},{tests:[{command:'fake',exit_code:1,passed:1,failed:0,skipped:0}]},
  {findings:[{severity:'blocking',path:'src/x.mjs',line:1,note:'fix'}]},{extra:'ignored?'},{pr:30}])
  test('candidate: structured review receipt refuses '+JSON.stringify(patch),()=>assert.equal(reviewReceipt(receipt(patch),selection()),null));
test('candidate: escaped duplicate receipt keys rejected',()=>{
  assert.equal(reviewReceipt(receipt().replace('"independent":true','"independent":false,"indep\\u0065ndent":true'),selection()),null);
});
test('candidate: latest decisive review revokes an older approval, even across SHAs',()=>{
  const r=check(e=>e.reviews.push({...e.reviews[0],id:2,state:'CHANGES_REQUESTED',commit_id:base}));
  assert.ok(r.blockers.includes('review_changes_requested'));assert.equal(r.reviews.matching_approvals.length,0);
});
test('candidate: another trusted change-request blocks even with a complete approval',()=>{
  const r=check(e=>e.reviews.push({...e.reviews[0],id:2,user:{id:3},state:'CHANGES_REQUESTED'}));
  assert.equal(r.reviews.matching_approvals.length,1);assert.equal(r.status,'blocked');
});
test('candidate: newer comments do not fabricate or silently dismiss a decisive review',()=>{
  const r=check(e=>e.reviews.push({...e.reviews[0],id:2,state:'COMMENTED',body:'not an approval'}));assert.equal(r.status,'metadata_requirements_met');
});
test('candidate: no reviewer configured is never approval',()=>assert.equal(check(()=>{},{...selection(),reviewer_ids:[]}).status,'blocked'));
for(const code of ['getter','proxy','primitive'])test('candidate: error messages never leak '+code,()=>{
  let reads=0,e;if(code==='getter')e={get code(){reads++;throw Error('SECRET');}};
  else if(code==='proxy'){const p=Proxy.revocable({},{});p.revoke();e=p.proxy;}else e='SECRET';
  assert.deepEqual(candidateFailure(e),{ok:false,error:'candidate_check_unconfirmed',read_only:true,merge_authorized:false});assert.equal(reads,0);
});
test('candidate: nine fixed workflow files exist; policy not supplied by an arbitrary PR body',async()=>{
  const {existsSync}=await import('node:fs');for(const name of CANDIDATE_WORKFLOWS)assert.ok(existsSync(new URL('../.github/workflows/'+name,import.meta.url)));
});
