import test from 'node:test';import assert from 'node:assert/strict';
import {evaluateRetrieval} from '../src/evaluation.mjs';
test('retrieval evaluator reports misses and forbidden results rather than only transport success',async()=>{
 const r=await evaluateRetrieval([{id:'miss',query:'x',expected_uris:['a']},{id:'leak',query:'y',expected_uris:[],expect_empty:true,forbidden_uris:['secret']}],
  async sample=>({items:sample.id==='miss'?[]:[{uri:'secret'}]}));
 assert.equal(r.all_passed,false);assert.equal(r.recall_at_returned_k,0);assert.equal(r.forbidden_hits,1);assert.equal(r.empty_evidence_accuracy,0);
});
test('an unlabelled case is not silently accepted',async()=>{
 await assert.rejects(evaluateRetrieval([{id:'unknown',query:'x',expected_uris:[]}],async()=>({items:[]})),{code:'invalid_params'});
});
test('rank metrics use the returned order',async()=>{
 const r=await evaluateRetrieval([{id:'rank',query:'x',expected_uris:['correct']}],async()=>({items:[{uri:'other'},{uri:'correct'}]}));
 assert.equal(r.mrr,0.5);assert.equal(r.recall_at_returned_k,1);
});
