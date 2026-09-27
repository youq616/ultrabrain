/** Additional adversarial pass by the implementer; not a separate reviewer agent. */
import test from 'node:test';import assert from 'node:assert/strict';
import {collectCandidateChain,candidateChainSelection,CANDIDATE_CHAIN_MAX_REQUESTS} from '../src/candidate-chain.mjs';
import {chainTransport,chainSelection,shas} from './helpers/candidate-chain-fixture.mjs';

test('chain review: same name with different repository IDs between layers is not one repository',async()=>{
 const t=chainTransport();
 // Each layer is individually consistent, but the name resolved to distinct IDs.
 t.data[1].pull.base.repo.id=77;t.data[1].pull.head.repo.id=77;
 t.data[1].runs.forEach(r=>{r.repository.id=77;r.head_repository.id=77;});
 await assert.rejects(collectCandidateChain(t.selection,t),{code:'candidate_chain_changed'});
});
test('chain review: metadata-preserving review edits across passes must not be missed',async()=>{
 const t=chainTransport();let leaf=false;
 const get=async path=>{
  if(path.endsWith('/pulls/30')&&!leaf){leaf=true;
   // Keeps the matching approval list empty in both passes but changes a trusted decision.
   t.data[0].reviews[0].body='PRIVATE_CHANGED_INVALID_RECEIPT';
  }return t.get(path);
 };
 t.data[0].reviews[0].body='PRIVATE_ORIGINAL_INVALID_RECEIPT';
 await assert.rejects(collectCandidateChain(t.selection,{get}),{code:'candidate_chain_changed'});
});
test('chain review: root details and credential are never echoed by ancestry failure',async()=>{
 const t=chainTransport();const get=async path=>{const r=await t.get(path);if(path.includes('/compare/')){
  r.status='PRIVATE_TOKEN';r.patch_url='https://hostile.invalid/PRIVATE';}return r;};
 await assert.rejects(collectCandidateChain(t.selection,{get}),e=>e.code==='candidate_chain_ancestry_unconfirmed'&&!e.message.includes('PRIVATE'));
});
test('chain review: an older ancestor run rerun between passes invalidates whole observation',async()=>{
 const t=chainTransport();let leaf=false;const get=async path=>{
  if(path.endsWith('/pulls/30')&&!leaf){leaf=true;t.data[0].runs[0].run_attempt=2;t.data[0].runs[0].conclusion='failure';
   t.data[0].jobs[100][0].run_attempt=2;t.data[0].jobs[100][0].conclusion='failure';}return t.get(path);};
 await assert.rejects(collectCandidateChain(t.selection,{get}),{code:'candidate_chain_changed'});
});
test('chain review: total request budget covers reobservation, not only first pass',async()=>{
 const t=chainTransport(8);
 for(const e of t.data){const extra=e.runs.map(r=>({...structuredClone(r),id:r.id+50}));
  e.runs.push(...extra);for(const r of extra)e.jobs[r.id]=[{id:r.id+1000,run_id:r.id,run_attempt:1,status:'completed',conclusion:'success'}];}
 await assert.rejects(collectCandidateChain(t.selection,t),{code:'candidate_chain_request_limit'});
 assert.equal(t.calls.length,CANDIDATE_CHAIN_MAX_REQUESTS);
});
test('chain review: anchor reobservation fences the final return',async()=>{
 const t=chainTransport();let count=0;const get=async path=>{
  const r=await t.get(path);if(path.endsWith('/git/commits/'+shas[0])&&++count===2)r.tree.sha='9'.repeat(40);return r;};
 await assert.rejects(collectCandidateChain(t.selection,{get}),{code:'candidate_chain_changed'});
});
test('chain review: authority withdrawal in final anchor response suppresses report',async()=>{
 const t=chainTransport();let count=0,permit=true;const get=async path=>{
  const r=await t.get(path);if(path.endsWith('/git/commits/'+shas[0])&&++count===2)permit=false;return r;};
 await assert.rejects(collectCandidateChain(t.selection,{get,authorize:()=>permit}),{code:'client_authorization_revoked'});
});
for(const val of [null,undefined,1,'SECRET'])test('chain review: nonobject manifest '+typeof val+' never enters IO',async()=>{
 const t=chainTransport();await assert.rejects(collectCandidateChain(val,t),{code:'invalid_params'});assert.equal(t.calls.length,0);
});
test('chain review: revoked manifest proxy is sanitized without trapping outward',()=>{
 const p=Proxy.revocable(chainSelection(),{});p.revoke();assert.throws(()=>candidateChainSelection(p.proxy),{code:'invalid_params'});
});
test('chain review: delayed caller cancellation on a pending native response',async()=>{
 const t=chainTransport(),c=new AbortController();let release;
 const get=async path=>{if(!release)await new Promise(r=>release=r);return t.get(path);};
 const work=collectCandidateChain(t.selection,{get,signal:c.signal});
 while(!release)await new Promise(r=>setImmediate(r));c.abort();release();
 await assert.rejects(work,{code:'aborted'});assert.equal(t.calls.length,1);
});

test('chain review: changed job identity with same counts/status cannot masquerade as unchanged evidence',async()=>{
 const t=chainTransport();let leaf=false;const get=async path=>{
  if(path.endsWith('/pulls/30')&&!leaf){leaf=true;t.data[0].jobs[100][0].id=98765;}return t.get(path);};
 await assert.rejects(collectCandidateChain(t.selection,{get}),{code:'candidate_chain_changed'});
});
test('chain review: default single-candidate response stays unchanged; evidence fingerprint is opt-in',async()=>{
 const {collectCandidate}=await import('../src/candidate-github.mjs');
 const t=chainTransport(1),p={repository:t.selection.repository,...t.selection.candidates[0],reviewer_ids:t.selection.reviewer_ids};
 const normal=await collectCandidate(p,t);assert.equal(Object.hasOwn(normal,'observation_sha256'),false);
 const withHash=await collectCandidate(p,{...t,includeEvidenceFingerprint:true});assert.match(withHash.observation_sha256,/^[a-f0-9]{64}$/);
 assert.equal(withHash.status,normal.status);assert.deepEqual(withHash.ci,normal.ci);
});
test('chain review: fingerprint ignores collection ordering but binds job/review identities',async()=>{
 const {collectCandidate}=await import('../src/candidate-github.mjs');
 const t=chainTransport(1),p={repository:t.selection.repository,...t.selection.candidates[0],reviewer_ids:t.selection.reviewer_ids};
 const a=await collectCandidate(p,{...t,includeEvidenceFingerprint:true});t.data[0].runs.reverse();
 const b=await collectCandidate(p,{...t,includeEvidenceFingerprint:true});assert.equal(a.observation_sha256,b.observation_sha256);
 t.data[0].jobs[100][0].id++;
 const c=await collectCandidate(p,{...t,includeEvidenceFingerprint:true});assert.notEqual(c.observation_sha256,a.observation_sha256);
});
test('chain review: candidate/chain CI wiring remains additive with both native platforms',async()=>{
 const {readFileSync}=await import('node:fs');const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
 const flow=read('.github/workflows/candidate-evidence.yml'),portable=read('.github/workflows/client-portability.yml');
 assert.ok(flow.includes('node test/candidate-live-integration.mjs'));
 assert.ok(flow.includes('node test/candidate-chain-live-integration.mjs'));
 assert.ok(flow.includes('candidate-chain-live.json'));
 for(const file of ['candidate-chain.test.mjs','candidate-chain-cli.test.mjs','candidate-chain-review.test.mjs'])assert.ok(portable.includes(file));
 assert.ok(portable.includes('windows-2025')&&portable.includes('ubuntu-24.04'));
 assert.ok(flow.includes('actions: read')&&flow.includes('pull-requests: read'));
 assert.ok(!/^\s*(contents|actions|pull-requests): write$/m.test(flow));
 assert.equal(JSON.parse(read('package.json')).scripts['candidate:chain'],'node scripts/candidate-chain-check.mjs');
});
