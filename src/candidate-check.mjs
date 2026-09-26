/** Candidate metadata checks, never a merge/deployment authorization. No IO. */
import {createHash} from 'node:crypto';
import {parseSnapshotJSON} from './personal-snapshot-contract.mjs';
export const CANDIDATE_WORKFLOWS=Object.freeze(['ci.yml','client-portability.yml','native-client-engines.yml',
  'personal-identity.yml','personal-overview-smoke.yml','personal-recall-preview.yml',
  'personal-services.yml','recovery.yml','task-context.yml']);
export class CandidateError extends Error {
  constructor(code){super('Candidate evidence was not confirmed');this.code=code;}
}
export const requireCandidate=(ok,code='candidate_contract_invalid')=>{if(!ok)throw new CandidateError(code);};
export const positive=v=>Number.isSafeInteger(v)&&v>0;
export const commitId=v=>typeof v==='string'&&/^[a-f0-9]{40}$/.test(v);
const text=(v,max)=>typeof v==='string'&&v.length>0&&Buffer.byteLength(v)<=max&&!/[\x00-\x1f\x7f]/.test(v);
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v,keys)=>object(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
export function freezeCandidate(v){
  if(v&&typeof v==='object'&&!Object.isFrozen(v)){Object.values(v).forEach(freezeCandidate);Object.freeze(v);}return v;
}
export function candidateSelection(input){
  let p;
  try{
    const d=Object.getOwnPropertyDescriptors(input),keys=['repository','pr','head_sha','base_sha','reviewer_ids'];
    requireCandidate(Reflect.ownKeys(d).length===keys.length&&keys.every(k=>d[k]?.enumerable&&Object.hasOwn(d[k],'value')),'invalid_params');
    p=Object.fromEntries(keys.map(k=>[k,d[k].value]));
    requireCandidate(p.repository==='youq616/ultrabrain'&&positive(p.pr)&&commitId(p.head_sha)&&commitId(p.base_sha),'invalid_params');
    requireCandidate(Array.isArray(p.reviewer_ids)&&p.reviewer_ids.length<=8,'invalid_params');
    // Reject holes, accessors and non-index extras before taking an immutable copy.
    const a=Object.getOwnPropertyDescriptors(p.reviewer_ids),names=Reflect.ownKeys(a);
    requireCandidate(names.length===p.reviewer_ids.length+1&&names.includes('length'),'invalid_params');
    p.reviewer_ids=Array.from({length:p.reviewer_ids.length},(_,i)=>{
      requireCandidate(a[i]?.enumerable&&Object.hasOwn(a[i],'value')&&positive(a[i].value),'invalid_params');return a[i].value;
    });
    requireCandidate(new Set(p.reviewer_ids).size===p.reviewer_ids.length,'invalid_params');
  }catch{throw new CandidateError('invalid_params');}
  return freezeCandidate(p);
}
/** Formal GitHub approval AND a version-bound structured receipt are required.
 * A supplied receipt is an attestation: session existence/test execution cannot
 * be cryptographically established by this parser and are never claimed as such.
 */
export function reviewReceipt(body,p){
  try{
    requireCandidate(typeof body==='string'&&Buffer.byteLength(body)<=16384);
    const r=parseSnapshotJSON(body);
    requireCandidate(exact(r,['format','repository','pr','head_sha','base_sha','scope','reviewer_session','independent','verdict','findings','tests']));
    requireCandidate(r.format==='ultrabrain-independent-review-v1'&&r.repository===p.repository&&r.pr===p.pr&&
      r.head_sha===p.head_sha&&r.base_sha===p.base_sha&&r.scope==='entire-diff'&&r.independent===true&&r.verdict==='approve');
    requireCandidate(text(r.reviewer_session,256)&&Array.isArray(r.findings)&&r.findings.length<=100&&Array.isArray(r.tests)&&r.tests.length>0&&r.tests.length<=100);
    for(const f of r.findings)requireCandidate(exact(f,['severity','path','line','note'])&&f.severity==='nonblocking'&&
      text(f.path,512)&&!f.path.startsWith('/')&&!f.path.split('/').includes('..')&&positive(f.line)&&text(f.note,2048));
    for(const t of r.tests)requireCandidate(exact(t,['command','exit_code','passed','failed','skipped'])&&
      text(t.command,2048)&&t.exit_code===0&&positive(t.passed)&&t.failed===0&&Number.isSafeInteger(t.skipped)&&t.skipped>=0);
    return createHash('sha256').update(body).digest('hex');
  }catch{return null;}
}
/** Input is a collector-owned, fully paginated snapshot; pure evaluation alone
 * does not authenticate where it came from. Unknown/incomplete inputs throw.
 */
export function evaluateCandidate(input,evidence){
  const p=candidateSelection(input),{pull,commit,runs,reviews,jobs}=evidence;
  requireCandidate(pull.number===p.pr&&pull.head?.sha===p.head_sha&&pull.base?.sha===p.base_sha&&
    pull.base.repo.full_name===p.repository&&pull.head.repo.full_name===p.repository&&positive(pull.user?.id)&&
    positive(pull.base.repo.id)&&pull.head.repo.id===pull.base.repo.id&&typeof pull.draft==='boolean'&&typeof pull.merged==='boolean'&&['open','closed'].includes(pull.state));
  requireCandidate(commit.sha===p.head_sha&&commitId(commit.tree?.sha));
  requireCandidate(Array.isArray(runs)&&Array.isArray(reviews)&&object(jobs));
  const blockers=[];
  if(pull.state!=='open'||pull.merged)blockers.push('pull_request_not_open');
  if(pull.draft!==false)blockers.push('draft_pull_request');
  const ci=CANDIDATE_WORKFLOWS.map(file=>{
    const path='.github/workflows/'+file;
    const matching=runs.filter(r=>r.path===path&&r.event==='pull_request'&&r.head_sha===p.head_sha&&
      r.repository?.id===pull.base.repo.id&&r.head_repository?.id===pull.head.repo.id&&
      r.pull_requests?.some(pr=>pr.number===p.pr&&pr.head?.sha===p.head_sha));
    matching.sort((a,b)=>a.id-b.id);
    if(!matching.length)return {workflow:file,state:'missing',runs:[],jobs:0};
    const current=matching.filter(r=>r.pull_requests.some(pr=>pr.number===p.pr&&pr.head?.sha===p.head_sha&&pr.base?.sha===p.base_sha));
    if(!current.length)return {workflow:file,state:'stale_base',runs:[],jobs:0};
    // Conservative policy: every run for these exact head/base pins must pass.
    // A rerun of an older run ID can start AFTER a newer ID; max(id) is not
    // sufficient. Reruns replace the attempt of that ID, not other run IDs.
    const observations=current.map(r=>{
      requireCandidate(positive(r.id)&&positive(r.run_attempt));
      const list=jobs[String(r.id)];requireCandidate(Array.isArray(list));
      const valid=list.length>0&&list.every(j=>positive(j.id)&&j.run_id===r.id&&j.run_attempt===r.run_attempt&&j.status==='completed'&&j.conclusion==='success');
      return {run_id:r.id,attempt:r.run_attempt,jobs:list.length,state:r.status==='completed'&&r.conclusion==='success'&&valid?'passed':
        r.status==='completed'?'failed_or_incomplete':'pending'};
    });
    return {workflow:file,state:observations.some(r=>r.state==='failed_or_incomplete')?'failed_or_incomplete':
      observations.some(r=>r.state==='pending')?'pending':'passed',runs:observations,jobs:observations.reduce((n,r)=>n+r.jobs,0)};
  });
  if(ci.some(c=>c.state!=='passed'))blockers.push('ci_not_confirmed');
  const latest=new Map(),decisive=[];
  for(const r of reviews){
    requireCandidate(positive(r.id)&&positive(r.user?.id)&&typeof r.state==='string');
    if(!p.reviewer_ids.includes(r.user.id)||r.user.id===pull.user.id||!['APPROVED','CHANGES_REQUESTED','DISMISSED'].includes(r.state))continue;
    requireCandidate(typeof r.submitted_at==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(r.submitted_at)&&
      Number.isFinite(Date.parse(r.submitted_at)));
    decisive.push(r);
  }
  // IDs are assigned when reviews are created, possibly as pending drafts.
  // Submission order, rather than largest draft ID, determines the decision.
  decisive.sort((a,b)=>Date.parse(a.submitted_at)-Date.parse(b.submitted_at)||a.id-b.id);
  for(const r of decisive)latest.set(r.user.id,r);
  const approvals=[];let changes=false,invalidReceipt=false;
  for(const r of latest.values()){
    // Even a request on an older revision remains unresolved until superseded.
    if(r.state==='CHANGES_REQUESTED'){changes=true;continue;}
    if(r.state!=='APPROVED'||r.commit_id!==p.head_sha)continue;
    const digest=reviewReceipt(r.body,p);
    if(digest)approvals.push({review_id:r.id,reviewer_id:r.user.id,receipt_sha256:digest});else invalidReceipt=true;
  }
  if(changes)blockers.push('review_changes_requested');
  if(!approvals.length)blockers.push(invalidReceipt?'review_receipt_not_confirmed':'independent_review_missing');
  return freezeCandidate({format:'ultrabrain-candidate-check-v1',repository:p.repository,pr:p.pr,head_sha:p.head_sha,
    base_sha:p.base_sha,tree_sha:commit.tree.sha,status:blockers.length?'blocked':'metadata_requirements_met',blockers,ci,
    reviews:{configured_reviewer_ids:p.reviewer_ids,matching_approvals:approvals},read_only:true,merge_authorized:false,
    limitations:['metadata-observation-not-atomic','checkout-and-test-quality-not-verified','review-independence-and-tests-attested-not-proven',
      'base-and-stacked-pr-acceptance-not-verified','branch-protection-and-user-deployment-not-verified','no-automatic-merge-or-deployment']});
}
export function candidateFailure(error){
  let code;try{code=Object.getOwnPropertyDescriptor(error,'code')?.value;}catch{}
  const safe=new Set(['invalid_params','candidate_contract_invalid','candidate_changed','candidate_response_too_large',
    'candidate_pagination_incomplete','candidate_http_failed','candidate_rate_limited','candidate_timeout','aborted','client_authorization_revoked']);
  return {ok:false,error:safe.has(code)?code:'candidate_check_unconfirmed',read_only:true,merge_authorized:false};
}
