/** Explicit annotated recall benchmark. No writes, model calls or automatic retries.
 * Scores concern caller-labelled IDs, not semantic relevance or truth certification. */
import {sha256,requireThat,UltraError} from './core.mjs';
import {taskContextRequest,requireTaskProfile} from './client-task-context.mjs';
import {clientContext} from './client-kit.mjs';
import {matchingWorkspace} from './client-profile-file.mjs';
import {assertClientAuthorized} from './client-authorization.mjs';
export const RECALL_EVALUATION_MAX_BYTES=131072;
export const RECALL_EVALUATION_MAX_CASES=32;
const attempts=new WeakMap();
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x);
const freeze=v=>{if(v&&typeof v==='object'&&!Object.isFrozen(v)){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
/** Exact own data fields, including hidden/Symbol rejection; never execute getters. */
function fields(v,names){
 const d=Object.getOwnPropertyDescriptors(v);
 requireThat(v&&typeof v==='object'&&!Array.isArray(v)&&Reflect.ownKeys(d).length===names.length&&
  names.every(k=>d[k]?.enumerable&&Object.hasOwn(d[k],'value')),'invalid_params','Exact evaluation fields required');
 return Object.fromEntries(names.map(k=>[k,d[k].value]));
}
function array(v,max,copy){
 requireThat(Array.isArray(v),'invalid_params','Evaluation array required');
 const d=Object.getOwnPropertyDescriptors(v),n=d.length?.value;
 requireThat(Number.isSafeInteger(n)&&n>=0&&n<=max&&Reflect.ownKeys(d).length===n+1,'invalid_params','Bounded dense array required');
 return Array.from({length:n},(_,i)=>{
  requireThat(d[i]?.enumerable&&Object.hasOwn(d[i],'value'),'invalid_params','Array data values required');return copy(d[i].value);
 });
}
function ids(v){const result=array(v,100,x=>{requireThat(uuid(x),'invalid_params','Full memory ID required');return x;});
 requireThat(new Set(result).size===result.length,'invalid_params','Duplicate annotation ID');return result;}
const workspaceCheck=(profile,workspace)=>{
 try{matchingWorkspace(profile,workspace);}catch{throw new UltraError('workspace_mismatch','Evaluation workspace unavailable or changed');}
};
export function recallEvaluationRequest(input,profile){
 requireTaskProfile(profile);
 let r;
 try{
  r=fields(input,['workspace','consent','top_k','cases']);
  requireThat(r.consent===true,'recall_evaluation_consent_required','Explicit evaluation consent required');
  requireThat(Number.isSafeInteger(r.top_k)&&r.top_k>=1&&r.top_k<=20,'invalid_params','top_k must be 1..20');
  workspaceCheck(profile,r.workspace);
  r.cases=array(r.cases,RECALL_EVALUATION_MAX_CASES,c=>{
   const v=fields(c,['id','task','relevant_ids','forbidden_ids']);
   requireThat(typeof v.id==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(v.id),'invalid_params','Case label required');
   v.relevant_ids=ids(v.relevant_ids);v.forbidden_ids=ids(v.forbidden_ids);
   requireThat(v.relevant_ids.length+v.forbidden_ids.length>0&&!v.relevant_ids.some(id=>v.forbidden_ids.includes(id)),
    'invalid_params','Nonempty disjoint annotations required');
   // Same task and disclosure boundary as actual task-context; no alternate ranker.
   taskContextRequest({workspace:r.workspace,consent:r.consent,task:v.task},profile);return v;
  });
  requireThat(r.cases.length>0&&new Set(r.cases.map(c=>c.id)).size===r.cases.length,'invalid_params','Unique case labels required');
  requireThat(Buffer.byteLength(JSON.stringify(r))<=RECALL_EVALUATION_MAX_BYTES,'input_too_large','Evaluation selection too large');
 }catch(error){
  if(error instanceof UltraError)throw error;
  throw new UltraError('invalid_params','Evaluation selection must contain data fields');
 }
 workspaceCheck(profile,r.workspace);return freeze(r);
}
export function recallEvaluationFailure(error,local){
 const progress=local??attempts.get(error)??{attempted:0,completed:0};
 let code;try{code=Object.getOwnPropertyDescriptor(error,'code')?.value;}catch{}
 const safe=new Set(['invalid_params','invalid_profile','insecure_profile','missing_credentials','input_too_large',
  'task_context_disabled','recall_evaluation_consent_required','workspace_mismatch','identity_mismatch',
  'client_authorization_revoked','aborted','permission_denied']);
 const result=Object.assign(new UltraError(safe.has(code)?code:'recall_evaluation_unconfirmed','Recall evaluation was not confirmed'),{
  query_attempts:progress.attempted,completed_cases:progress.completed,
  query_delivery:progress.attempted?'unconfirmed':'not_started',memory_writes_requested:false});
 attempts.set(result,{...progress});return result;
}
function score(c,context,k,profile){
 clientContext(context,profile);
 const returned=context.memories.map(m=>m.id);
 requireThat(returned.length<=20&&new Set(returned).size===returned.length,'recall_evaluation_unconfirmed','Invalid returned ID ranking');
 const top=returned.slice(0,k),relevant=new Set(c.relevant_ids),matched=top.filter(id=>relevant.has(id));
 const first=top.findIndex(id=>relevant.has(id)),positive=relevant.size>0;
 return {case_id:c.id,relevant_count:relevant.size,forbidden_count:c.forbidden_ids.length,
  returned_count:returned.length,top_ids:top,matched_ids:matched,missing_ids:c.relevant_ids.filter(id=>!top.includes(id)),
  forbidden_ids_seen:returned.filter(id=>c.forbidden_ids.includes(id)),
  precision_at_k:positive?matched.length/k:null,recall_at_k:positive?matched.length/relevant.size:null,
  reciprocal_rank_at_k:positive?(first<0?0:1/(first+1)):null};
}
export async function deliverRecallEvaluation(input,profile,{checkIdentity,invoke,signal,authorize=()=>{}}){
 const progress={attempted:0,completed:0};
 try{
  assertClientAuthorized(authorize,signal);const r=recallEvaluationRequest(input,profile);
  const allowed=()=>{assertClientAuthorized(authorize,signal);workspaceCheck(profile,r.workspace);};
  const results=[];
  for(const c of r.cases){
   allowed();const query=taskContextRequest({workspace:r.workspace,consent:true,task:c.task},profile);
   await checkIdentity(signal);allowed();
   // Conservative: entering the invocation is uncertain even if no bytes left.
   progress.attempted++;
   const response=await invoke('ultra_personal_context',query,signal);allowed();
   const result=score(c,response,r.top_k,profile);allowed();
   await checkIdentity(signal);allowed();results.push(result);progress.completed++;
  }
  const positives=results.filter(c=>c.relevant_count>0),mean=field=>positives.length?
   positives.reduce((n,c)=>n+c[field],0)/positives.length:null;
  const report=freeze({format:'ultrabrain-recall-evaluation-v1',source_id:profile.source,project_id:profile.projectId,
   suite_sha256:sha256(JSON.stringify({top_k:r.top_k,cases:r.cases})),top_k:r.top_k,query_limit:20,budget_bytes:profile.budgetBytes,
   query_requests:progress.attempted,cases:results,summary:{case_count:results.length,positive_case_count:positives.length,
    negative_only_case_count:results.length-positives.length,
    hit_rate_at_k:positives.length?positives.filter(c=>c.matched_ids.length>0).length/positives.length:null,
    mean_precision_at_k:mean('precision_at_k'),mean_recall_at_k:mean('recall_at_k'),mean_reciprocal_rank_at_k:mean('reciprocal_rank_at_k'),
    forbidden_case_count:results.filter(c=>c.forbidden_ids_seen.length>0).length,
    forbidden_occurrences:results.reduce((n,c)=>n+c.forbidden_ids_seen.length,0)},
   read_only:true,memory_writes_requested:false,model_calls_requested:0,semantic_quality_verified:false,truth_verified:false,
   limitations:['caller-labels-not-exhaustive-relevance','id-ranking-not-answer-quality','fixed-k-precision-denominator',
    'negative-only-cases-excluded-from-positive-metrics','forbidden-checked-across-entire-response',
    'sequential-reads-not-a-database-snapshot','missing-id-not-proof-of-deletion','tasks-sent-to-selected-server',
    'metadata-and-suite-fingerprint-are-private','no-automatic-retry-or-acceptance']});
  allowed();return report;
 }catch(error){throw recallEvaluationFailure(error,progress);}
}
