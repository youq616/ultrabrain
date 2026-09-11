/** Compare paired retrieval reports, never call a synthetic suite semantic validation. */
import {requireThat} from './core.mjs';
export function compareRetrievalReports(base,candidate,{maxRecallDrop=0,maxMrrDrop=0,maxEmptyDrop=0}={}) {
  for(const n of [maxRecallDrop,maxMrrDrop,maxEmptyDrop]) requireThat(Number.isFinite(n)&&n>=0&&n<=1,'invalid_params','Invalid allowed regression');
  const identity=['dataset_sha256','corpus_fingerprint','evaluation_kind'];
  requireThat(base&&candidate&&identity.every(k=>typeof base[k]==='string'&&base[k].length>0&&base[k]===candidate[k]) &&
    base.evaluated_cases===candidate.evaluated_cases && base.evaluated_cases>0 &&
    JSON.stringify(base.rows.map(r=>[r.id,r.expected,r.expected_empty]))===
    JSON.stringify(candidate.rows.map(r=>[r.id,r.expected,r.expected_empty])),
    'evaluation_incomparable','Use the same labeled dataset, corpus and evaluator kind for both releases');
  const checks={no_forbidden_evidence:candidate.forbidden_hits===0,all_cases_pass:candidate.all_passed===true};
  for(const [key,allowed] of [['recall_at_returned_k',maxRecallDrop],['mrr',maxMrrDrop],['empty_evidence_accuracy',maxEmptyDrop]]) {
    if(base[key]===null&&candidate[key]===null) continue;
    requireThat(Number.isFinite(base[key])&&Number.isFinite(candidate[key]),'evaluation_incomparable','Missing metric');
    checks[key]=candidate[key]>=base[key]-allowed;
  }
  return {format:1,passed:Object.values(checks).every(Boolean),checks,evaluation_kind:candidate.evaluation_kind,
    dataset_sha256:candidate.dataset_sha256,corpus_fingerprint:candidate.corpus_fingerprint,
    scope:'Paired retrieval regression only; not final-answer accuracy or proof of semantic quality',
    latency:{baseline_ms:base.average_latency_ms,candidate_ms:candidate.average_latency_ms,enforced:false}};
}
