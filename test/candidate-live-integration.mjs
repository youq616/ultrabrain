/** Real GitHub read-only integration against explicitly pinned baseline PR29.
 * Collection success is NOT approval of that candidate. No memory/database IO. */
import assert from 'node:assert/strict';
import {collectCandidate} from '../src/candidate-github.mjs';
const input={repository:'youq616/ultrabrain',pr:29,
  head_sha:'ddc75d0e5688289fe1722e616f8503269b293a4d',base_sha:'d5e3c3c322e68e06405f511580d36a48b64ca577',reviewer_ids:[]};
const r=await collectCandidate(input,{token:process.env.GITHUB_TOKEN});
assert.equal(r.evidence_source,'github-rest-api');assert.equal(r.head_sha,input.head_sha);
assert.equal(r.ci.length,9);assert.equal(r.merge_authorized,false);
assert.equal(r.status,'blocked');assert.ok(r.blockers.includes('independent_review_missing'));
assert.equal(r.reviews.matching_approvals.length,0);
console.log(JSON.stringify({passed:true,mode:'real GitHub GET, pinned PR29, no reviewer configured',
  observed_head:r.head_sha,ci_states:r.ci.map(c=>({workflow:c.workflow,state:c.state})),
  candidate_status:r.status,merge_authorized:false,github_get_requests:r.github_get_requests}));
