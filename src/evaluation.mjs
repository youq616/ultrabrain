/** Retrieval evaluation, not an LLM judge. Never mistakes missing expectations for a pass. */
import {performance} from 'node:perf_hooks';
import {requireThat,text} from './core.mjs';
export async function evaluateRetrieval(cases,retrieve) {
  requireThat(Array.isArray(cases)&&cases.length>0&&typeof retrieve==='function','invalid_params','Nonempty cases and retrieve callback required');
  const rows=[];
  for(const sample of cases) {
    text(sample.id,'case id',128);text(sample.query,'query',4096);
    requireThat(Array.isArray(sample.expected_uris)&&Array.isArray(sample.forbidden_uris??[])&&
      (sample.expected_uris.length>0||sample.expect_empty===true),'invalid_params','Define expected URIs or explicit expected-empty evidence');
    const start=performance.now();const result=await retrieve(sample);
    requireThat(Array.isArray(result.items),'invalid_result','Retriever must return an evidence array');
    const returned=result.items.map(x=>x.uri), expected=[...new Set(sample.expected_uris)];
    const found=expected.filter(uri=>returned.includes(uri));
    const ranks=expected.map(uri=>returned.indexOf(uri)+1).filter(n=>n>0);
    const leaks=(sample.forbidden_uris??[]).filter(uri=>returned.includes(uri));
    rows.push({id:sample.id,latency_ms:performance.now()-start,expected:expected.length,found:found.length,
      recall:expected.length?found.length/expected.length:null,reciprocal_rank:ranks.length?1/Math.min(...ranks):0,
      expected_empty:sample.expect_empty===true,empty:returned.length===0,forbidden_hits:leaks.length,
      passed:(sample.expect_empty?returned.length===0:found.length===expected.length)&&leaks.length===0});
  }
  const positive=rows.filter(r=>r.expected>0),negative=rows.filter(r=>r.expected_empty);
  const mean=xs=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null;
  return {format:1,evaluated_cases:rows.length,all_passed:rows.every(r=>r.passed),
    recall_at_returned_k:mean(positive.map(r=>r.recall)),mrr:mean(positive.map(r=>r.reciprocal_rank)),
    empty_evidence_accuracy:mean(negative.map(r=>r.empty?1:0)),forbidden_hits:rows.reduce((n,r)=>n+r.forbidden_hits,0),
    average_latency_ms:mean(rows.map(r=>r.latency_ms)),rows,
    scope:'retrieval evidence only; not generation accuracy, model abstention or long-term semantic understanding'};
}
