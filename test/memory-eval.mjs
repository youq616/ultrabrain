/** Synthetic keyless PostgreSQL retrieval fixture; NOT a semantic-memory benchmark. */
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {connect,loadNative} from '../src/runtime.mjs';
import {evaluateRetrieval} from '../src/evaluation.mjs';
assert.equal(process.env.ULTRABRAIN_TEST_ALLOW_WRITE,'1','Isolated-test write opt-in required');
const engine=await connect({migrate:true});const {dispatchToolCall}=await loadNative('src/mcp/dispatch.ts');
const source=`eval-${Date.now().toString(36)}`;
const call=async(name,args)=>{
 const r=await dispatchToolCall(engine,name,args,{sourceId:source,remote:true,transport:'stdio'});
 assert.ok(!r.isError,JSON.stringify(r));return JSON.parse(r.content[0].text);
};
try {
 await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)',[source]);
 const u=slug=>`ultra://${source}/${slug}`;
 for(const [slug,visibility,body] of [['linux','world','copperoak chooses Linux for the server.'],
  ['database','world','silversparrow uses PostgreSQL as local storage.'],['private','private','amberfalcon private account detail.'],
  ['obsolete','world','violetotter obsolete server setting.']])
   await call('ultra_write',{uri:u(slug),content:`---\ntype: note\nvisibility: ${visibility}\n---\n${body}`});
 await call('ultra_delete',{uri:u('obsolete')});
 const cases=[
  {id:'exact-fact-recall',query:'copperoak',expected_uris:[u('linux')]},
  {id:'database-choice-recall',query:'silversparrow',expected_uris:[u('database')]},
  {id:'host-private-excluded',query:'amberfalcon',expected_uris:[],expect_empty:true,forbidden_uris:[u('private')]},
  {id:'deleted-evidence-excluded',query:'violetotter',expected_uris:[],expect_empty:true,forbidden_uris:[u('obsolete')]},
  {id:'missing-evidence-empty',query:'zyxunseenplatypus',expected_uris:[],expect_empty:true},
 ];
 const report=await evaluateRetrieval(cases,sample=>call('ultra_retrieve',{uri:u(''),query:sample.query,level:'L2',budget_bytes:8000}));
 report.fixture='synthetic-keyless-native-retrieval-v1';report.semantic_quality_evaluated=false;
 if(process.env.ULTRABRAIN_EVAL_OUTPUT)writeFileSync(process.env.ULTRABRAIN_EVAL_OUTPUT,JSON.stringify(report,null,2));
 console.log(JSON.stringify(report,null,2));assert.equal(report.all_passed,true);
} finally {await engine.disconnect();}
