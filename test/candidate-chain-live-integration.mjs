/** Real read-only GitHub integration. Empty reviewer policy MUST stay blocked.
 * This tests the collector, not acceptance of either PR or of the supplied anchor.
 */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {collectCandidateChain} from '../src/candidate-chain.mjs';
const input=JSON.parse(readFileSync(new URL('../examples/candidate-chain-pr29-pr30.json',import.meta.url),'utf8'));
const result=await collectCandidateChain(input,{token:process.env.GITHUB_TOKEN});let checks=0;
assert.equal(result.format,'ultrabrain-candidate-chain-check-v1');assert.equal(result.evidence_source,'github-rest-api');checks++;
assert.equal(result.node_count,2);assert.deepEqual(result.nodes.map(n=>n.pr),[29,30]);checks++;
assert.equal(result.anchor.sha,input.anchor_sha);assert.equal(result.anchor.acceptance_verified,false);checks++;
assert.equal(result.tip_sha,input.tip_sha);assert.equal(result.selected_base_ancestry_confirmed,true);
assert.ok(result.relationships.every((r,i)=>r.base_is_ancestor&&r.base_sha===input.candidates[i].base_sha&&r.head_sha===input.candidates[i].head_sha));checks++;
assert.equal(result.status,'blocked');assert.deepEqual(result.blocked_prs,[29,30]);
assert.ok(result.nodes.every(n=>n.blockers.includes('independent_review_missing')&&n.reviews.matching_approvals.length===0));checks++;
assert.equal(result.merge_authorized,false);assert.equal(result.unselected_dependencies_verified,false);
assert.equal(result.repository_id,1365610715);assert.ok(result.nodes.every(n=>n.ci.length===9));checks++;
assert.ok(result.github_get_requests>=68);assert.ok(result.nodes.every(n=>/^[a-f0-9]{64}$/.test(n.observation_sha256)));
if(process.env.GITHUB_TOKEN)assert.ok(!JSON.stringify(result).includes(process.env.GITHUB_TOKEN));checks++;
const report={passed:true,checks,mode:'real GitHub GET, fixed PR29/PR30 and ancestor summaries',
 source:'github-rest-api',observed_at:result.observed_at,anchor_sha:result.anchor.sha,tip_sha:result.tip_sha,
 selected_prs:result.nodes.map(n=>n.pr),selection_sha256:result.selection_sha256,
 candidate_status:result.status,blocked_prs:result.blocked_prs,github_get_requests:result.github_get_requests,
 ci:result.nodes.map(n=>({pr:n.pr,states:n.ci.map(w=>({workflow:w.workflow,state:w.state}))})),
 anchor_accepted:false,independent_review_approved:false,merge_authorized:false};
if(process.env.ULTRABRAIN_CANDIDATE_CHAIN_REPORT)writeFileSync(process.env.ULTRABRAIN_CANDIDATE_CHAIN_REPORT,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
