import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateRetrieval} from '../src/evaluation.mjs';
import {compareRetrievalReports} from '../src/evaluation-gate.mjs';
const cases=[{id:'a',query:'canary',expected_uris:['ultra://default/a']},{id:'b',query:'missing',expected_uris:[],expect_empty:true}];
const options={corpusFingerprint:'fixture-sha',evaluationKind:'synthetic-keyword-v1'};
async function good(){return evaluateRetrieval(cases,s=>({items:s.id==='a'?[{uri:'ultra://default/a'}]:[]}),options);}
test('paired reports pass only with equivalent identity and no regression',async()=>{
  const a=await good();assert.equal(compareRetrievalReports(a,await good()).passed,true);
  assert.throws(()=>compareRetrievalReports(a,{...a,corpus_fingerprint:'other'}),{code:'evaluation_incomparable'});
  assert.throws(()=>compareRetrievalReports(a,{...a,evaluation_kind:'semantic'}),{code:'evaluation_incomparable'});
  assert.equal(compareRetrievalReports(a,{...a,forbidden_hits:1}).passed,false);
  assert.equal(compareRetrievalReports(a,{...a,mrr:0.5}).passed,false);
});
test('reports without a declared corpus and evaluator cannot pretend to be comparable',async()=>{
  const a=await evaluateRetrieval(cases,s=>({items:[]}));
  assert.throws(()=>compareRetrievalReports(a,a),{code:'evaluation_incomparable'});
});
