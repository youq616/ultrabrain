/** Explicit, bounded stacked-PR observation. No branch discovery, code execution,
 * merge or deployment. The supplied anchor's acceptance is deliberately unverified.
 */
import {createHash} from 'node:crypto';
import {candidateSelection,candidateFailure,commitId,positive,requireCandidate,CandidateError,freezeCandidate} from './candidate-check.mjs';
import {candidateReader,collectCandidate} from './candidate-github.mjs';
import {assertClientAuthorized} from './client-authorization.mjs';
const ROOT='/repos/youq616/ultrabrain';
export const CANDIDATE_CHAIN_MAX_NODES=8;
export const CANDIDATE_CHAIN_MAX_REQUESTS=320;
export const CANDIDATE_CHAIN_TIMEOUT_MS=180000;

function dataObject(value,keys){
  requireCandidate(value!==null&&typeof value==='object'&&!Array.isArray(value),'invalid_params');
  const descriptors=Object.getOwnPropertyDescriptors(value);
  requireCandidate(Reflect.ownKeys(descriptors).length===keys.length&&keys.every(k=>
    descriptors[k]?.enumerable&&Object.hasOwn(descriptors[k],'value')),'invalid_params');
  return Object.fromEntries(keys.map(k=>[k,descriptors[k].value]));
}
function dataArray(value,min,max){
  requireCandidate(Array.isArray(value),'invalid_params');
  const d=Object.getOwnPropertyDescriptors(value),n=d.length?.value;
  requireCandidate(Number.isSafeInteger(n)&&n>=min&&n<=max&&Reflect.ownKeys(d).length===n+1,'invalid_params');
  return Array.from({length:n},(_,i)=>{
    requireCandidate(d[i]?.enumerable&&Object.hasOwn(d[i],'value'),'invalid_params');return d[i].value;
  });
}
/** Pin the entire topology and reviewer policy before IO. No sorting, auto-following
 * or dropping malformed nodes; unknown fields, accessors and sparse arrays refuse.
 */
export function candidateChainSelection(input){
  try{
    const p=dataObject(input,['format','repository','anchor_sha','tip_sha','reviewer_ids','candidates']);
    requireCandidate(p.format==='ultrabrain-candidate-chain-selection-v1'&&p.repository==='youq616/ultrabrain'&&
      commitId(p.anchor_sha)&&commitId(p.tip_sha),'invalid_params');
    p.reviewer_ids=dataArray(p.reviewer_ids,0,8);
    const seenPRs=new Set(),seenHeads=new Set([p.anchor_sha]);let expectedBase=p.anchor_sha;
    p.candidates=dataArray(p.candidates,1,CANDIDATE_CHAIN_MAX_NODES).map(item=>{
      const node=dataObject(item,['pr','base_sha','head_sha']);
      const checked=candidateSelection({repository:p.repository,...node,reviewer_ids:p.reviewer_ids});
      requireCandidate(node.base_sha===expectedBase&&!seenHeads.has(node.head_sha)&&!seenPRs.has(node.pr),'invalid_params');
      seenHeads.add(node.head_sha);seenPRs.add(node.pr);expectedBase=node.head_sha;
      // candidateSelection owns validation of the shared reviewer configuration.
      p.reviewer_ids=checked.reviewer_ids;
      return {pr:node.pr,base_sha:node.base_sha,head_sha:node.head_sha};
    });
    requireCandidate(expectedBase===p.tip_sha,'invalid_params');return freezeCandidate(p);
  }catch{throw new CandidateError('invalid_params');}
}
export function candidateChainFailure(error){
  let code;try{code=Object.getOwnPropertyDescriptor(error,'code')?.value;}catch{}
  const own=new Set(['candidate_chain_changed','candidate_chain_ancestry_unconfirmed','candidate_chain_request_limit',
    'candidate_input_invalid','candidate_input_too_large']);
  return own.has(code)?{ok:false,error:code,read_only:true,merge_authorized:false}:candidateFailure(error);
}
function gitAnchor(commit,sha){
  requireCandidate(commit?.sha===sha&&commitId(commit.tree?.sha),'candidate_chain_ancestry_unconfirmed');
  return {sha,tree_sha:commit.tree.sha,acceptance_verified:false};
}
function ancestrySummary(response,node){
  requireCandidate(response?.base_commit?.sha===node.base_sha&&response.merge_base_commit?.sha===node.base_sha&&
    response.status==='ahead'&&response.behind_by===0&&positive(response.ahead_by)&&
    response.total_commits===response.ahead_by,'candidate_chain_ancestry_unconfirmed');
  return {base_sha:node.base_sha,head_sha:node.head_sha,ahead_by:response.ahead_by,base_is_ancestor:true};
}
function stableCandidate(report){
  // The collector remains the sole CI/review evaluator. Remove observation-clock
  // and transport bookkeeping, never the conditions or review receipt digests.
  const {observed_at,github_get_requests,evidence_source,...stable}=report;
  return stable;
}
export async function collectCandidateChain(input,{get,token,signal,authorize=()=>{}}={}){
  try{
    const selection=candidateChainSelection(input);
    const active=AbortSignal.any([signal,AbortSignal.timeout(CANDIDATE_CHAIN_TIMEOUT_MS)].filter(Boolean));
    const allowed=()=>assertClientAuthorized(authorize,active);
    allowed();const read=get??candidateReader({token,signal:active,allowCompare:true});let requests=0,repositoryId;
    const pullPaths=new Set(selection.candidates.map(n=>ROOT+'/pulls/'+n.pr));
    const call=async path=>{
      allowed();requireCandidate(++requests<=CANDIDATE_CHAIN_MAX_REQUESTS,'candidate_chain_request_limit');
      const result=await read(path);allowed();
      if(pullPaths.has(path)){
        const id=result?.base?.repo?.id;
        requireCandidate(positive(id)&&result.head?.repo?.id===id,'candidate_chain_changed');
        if(repositoryId===undefined)repositoryId=id;
        requireCandidate(id===repositoryId,'candidate_chain_changed');
      }
      return result;
    };
    const anchor=gitAnchor(await call(ROOT+'/git/commits/'+selection.anchor_sha),selection.anchor_sha);
    const relationships=[],nodes=[];
    for(const node of selection.candidates){
      allowed();
      // Page 2 keeps GitHub's first-page file patches out of this metadata read.
      // Only relation summary is used: this is NOT a complete commit-list scan.
      const relation=await call(ROOT+'/compare/'+node.base_sha+'...'+node.head_sha+'?per_page=1&page=2');
      relationships.push(ancestrySummary(relation,node));
      nodes.push(stableCandidate(await collectCandidate({repository:selection.repository,...node,reviewer_ids:selection.reviewer_ids},
        {get:call,signal:active,authorize:allowed,includeEvidenceFingerprint:true})));
    }
    // Reverse reobservation lets an early ancestor be checked AFTER its child.
    // Two passes detect observed drift; they cannot make REST reads atomic.
    for(let i=selection.candidates.length-1;i>=0;i--){
      const current=stableCandidate(await collectCandidate({repository:selection.repository,...selection.candidates[i],reviewer_ids:selection.reviewer_ids},
        {get:call,signal:active,authorize:allowed,includeEvidenceFingerprint:true}));
      requireCandidate(JSON.stringify(current)===JSON.stringify(nodes[i]),'candidate_chain_changed');
    }
    const finalAnchor=gitAnchor(await call(ROOT+'/git/commits/'+selection.anchor_sha),selection.anchor_sha);
    requireCandidate(JSON.stringify(anchor)===JSON.stringify(finalAnchor),'candidate_chain_changed');
    const blocked=nodes.filter(n=>n.status!=='metadata_requirements_met').map(n=>n.pr);
    const report=freezeCandidate({format:'ultrabrain-candidate-chain-check-v1',repository:selection.repository,repository_id:repositoryId,
      scope:'explicitly-selected-chain',selection_sha256:createHash('sha256').update(JSON.stringify(selection)).digest('hex'),
      anchor,tip_sha:selection.tip_sha,node_count:nodes.length,selected_chain_contiguous:true,selected_base_ancestry_confirmed:true,
      status:blocked.length?'blocked':'metadata_requirements_met',blocked_prs:blocked,nodes,relationships,
      observed_at:new Date().toISOString(),github_get_requests:requests,evidence_source:get?'caller-supplied-transport':'github-rest-api',
      read_only:true,merge_authorized:false,unselected_dependencies_verified:false,
      limitations:['explicit-selection-not-all-repository-dependencies','anchor-acceptance-not-verified','rest-observations-not-atomic',
        'checkout-and-test-quality-not-verified','review-independence-and-tests-attested-not-proven',
        'branch-protection-and-user-deployment-not-verified','no-automatic-merge-or-deployment']});
    allowed();return report;
  }catch(error){throw new CandidateError(candidateChainFailure(error).error);}
}
