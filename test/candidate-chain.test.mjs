import test from 'node:test';import assert from 'node:assert/strict';
import {candidateChainSelection,collectCandidateChain} from '../src/candidate-chain.mjs';
import {chainSelection,chainTransport,shas} from './helpers/candidate-chain-fixture.mjs';

test('chain: a complete synthetic two-layer observation never authorizes merge or accepts anchor',async()=>{
 const t=chainTransport(),r=await collectCandidateChain(t.selection,t);
 assert.equal(r.status,'metadata_requirements_met');assert.equal(r.nodes.length,2);assert.equal(r.selected_base_ancestry_confirmed,true);
 assert.equal(r.merge_authorized,false);assert.equal(r.anchor.acceptance_verified,false);assert.equal(r.unselected_dependencies_verified,false);
 assert.deepEqual(r.blocked_prs,[]);assert.equal(r.evidence_source,'caller-supplied-transport');
 assert.equal(r.github_get_requests,68);assert.ok(Object.isFrozen(r.nodes[0].ci));assert.match(r.selection_sha256,/^[a-f0-9]{64}$/);
 for(const privateText of ['SYNTHETIC-SESSION','synthetic.test.mjs','PRIVATE_BODY'])assert.ok(!JSON.stringify(r).includes(privateText));
});
for(const n of [1,8])test('chain: bounded explicit '+n+' layers keep order and inspect each twice',async()=>{
 const t=chainTransport(n),r=await collectCandidateChain(t.selection,t);
 assert.equal(r.nodes.length,n);assert.deepEqual(r.nodes.map(v=>v.pr),t.selection.candidates.map(v=>v.pr));
 assert.equal(r.tip_sha,t.selection.tip_sha);assert.equal(r.github_get_requests,33*n+2);
 for(const p of t.selection.candidates)assert.equal(t.counts.get('/repos/youq616/ultrabrain/pulls/'+p.pr),4);
});
for(const edit of [p=>p.candidates=[],p=>p.candidates=Array(1),p=>p.candidates.push(p.candidates[0]),p=>p.candidates.reverse(),
 p=>p.candidates[1].base_sha=shas[0],p=>p.tip_sha=shas[0],p=>p.anchor_sha=shas[1],p=>p.candidates[1].pr=29,
 p=>p.candidates[1].head_sha=shas[0],p=>p.extra=true,p=>p.candidates[0].reviewer_ids=[99],p=>p.repository='other/repo',
 p=>p.format='future-format',p=>p.reviewer_ids=[2,2],p=>p.candidates[0].head_sha='main'])test('chain: invalid chain rejected before any IO',async()=>{
 const t=chainTransport();edit(t.selection);await assert.rejects(collectCandidateChain(t.selection,t),{code:'invalid_params'});assert.equal(t.calls.length,0);
});
test('chain: nine layers refused before reading',()=>{
 const p=chainSelection(8);p.candidates.push({pr:50,base_sha:p.tip_sha,head_sha:'9'.repeat(40)});p.tip_sha='9'.repeat(40);
 assert.throws(()=>candidateChainSelection(p),{code:'invalid_params'});
});
for(const target of ['root','node','array'])test('chain: '+target+' accessor is never evaluated',()=>{
 const p=chainSelection();let calls=0;
 const obj=target==='root'?p:target==='node'?p.candidates[0]:p.candidates,key=target==='root'?'candidates':target==='node'?'head_sha':'0';
 Object.defineProperty(obj,key,{enumerable:true,get(){calls++;throw Error('PRIVATE');}});
 assert.throws(()=>candidateChainSelection(p),{code:'invalid_params'});assert.equal(calls,0);
});
for(const target of ['root','node','array'])test('chain: hidden or symbol extra field rejected '+target,()=>{
 const p=chainSelection(),obj=target==='root'?p:target==='node'?p.candidates[0]:p.candidates;
 Object.defineProperty(obj,Symbol('private'),{value:'private'});assert.throws(()=>candidateChainSelection(p),{code:'invalid_params'});
});
test('chain: copied complete selection is frozen before the first await',async()=>{
 const t=chainTransport();const input=structuredClone(t.selection);let first=true;
 const get=async path=>{if(first){first=false;input.candidates.reverse();input.reviewer_ids.push(99);input.tip_sha=shas[0];}return t.get(path);};
 const r=await collectCandidateChain(input,{get});assert.equal(r.nodes[0].pr,29);assert.deepEqual(r.nodes[0].reviews.configured_reviewer_ids,[2,3]);
});
for(const layer of [0,1])test('chain: missing independent review at layer '+layer+' blocks complete selection',async()=>{
 const t=chainTransport();t.data[layer].reviews=[];const r=await collectCandidateChain(t.selection,t);
 assert.equal(r.status,'blocked');assert.deepEqual(r.blocked_prs,[29+layer]);assert.equal(r.nodes[1-layer].status,'metadata_requirements_met');
});
for(const defect of ['draft','ci','changes-requested','empty-reviewers'])test('chain: ancestor '+defect+' is not hidden by leaf success',async()=>{
 const t=chainTransport();
 if(defect==='draft')t.data[0].pull.draft=true;else if(defect==='ci')t.data[0].jobs[100][0].conclusion='failure';
 else if(defect==='changes-requested')t.data[0].reviews[0].state='CHANGES_REQUESTED';else t.selection.reviewer_ids=[];
 const r=await collectCandidateChain(t.selection,t);assert.equal(r.status,'blocked');assert.ok(r.blocked_prs.includes(29));
});
for(const edit of [r=>r.status='diverged',r=>r.behind_by=1,r=>r.merge_base_commit.sha=shas[8],r=>r.base_commit.sha=shas[8],
 r=>r.ahead_by=0,r=>r.total_commits=2,r=>r.status='identical',r=>delete r.merge_base_commit])test('chain: unconfirmed ancestry never becomes a green chain',async()=>{
 const t=chainTransport();const get=async p=>{const r=await t.get(p);if(p.includes('/compare/'))edit(r);return r;};
 await assert.rejects(collectCandidateChain(t.selection,{get}),{code:'candidate_chain_ancestry_unconfirmed'});
});
test('chain: reobserves ancestor after inspecting the leaf',async()=>{
 const t=chainTransport();let leafStarted=false;
 const get=async p=>{
  if(p.endsWith('/pulls/30')&&!leafStarted){leafStarted=true;t.data[0].reviews=[];}return t.get(p);
 };
 await assert.rejects(collectCandidateChain(t.selection,{get}),{code:'candidate_chain_changed'});
});
test('chain: pin change during second pass is never adopted',async()=>{
 const t=chainTransport();let count=0;
 const get=async p=>{const r=await t.get(p);if(p.endsWith('/pulls/29')&&++count===3)r.head.sha=shas[8];return r;};
 await assert.rejects(collectCandidateChain(t.selection,{get}),{code:'candidate_changed'});
});
test('chain: input anchor must resolve to exact Git identity',async()=>{
 const t=chainTransport();const get=async p=>{const r=await t.get(p);if(p.endsWith('/git/commits/'+shas[0]))r.sha=shas[8];return r;};
 await assert.rejects(collectCandidateChain(t.selection,{get}),{code:'candidate_chain_ancestry_unconfirmed'});
});
test('chain: cancellation and synchronous authority are checked before IO',async()=>{
 const t=chainTransport(),c=new AbortController();c.abort();
 await assert.rejects(collectCandidateChain(t.selection,{...t,signal:c.signal}),{code:'aborted'});
 await assert.rejects(collectCandidateChain(t.selection,{...t,authorize:()=>false}),{code:'client_authorization_revoked'});
 await assert.rejects(collectCandidateChain(t.selection,{...t,authorize:async()=>true}),{code:'invalid_params'});
 assert.equal(t.calls.length,0);
});
test('chain: exception diagnostics from a trusted seam are sanitized',async()=>{
 const t=chainTransport();await assert.rejects(collectCandidateChain(t.selection,{get:async()=>{throw Error('PRIVATE_TOKEN');}}),
  e=>e.code==='candidate_check_unconfirmed'&&!e.message.includes('PRIVATE'));
});
