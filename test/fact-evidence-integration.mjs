/** Real native fact writer, PostgreSQL, authorization dispatcher and lifecycle consumer.
 * Extraction success below is a declared controlled fixture, not an LLM quality test.
 */
import assert from 'node:assert/strict';
import {connect,loadNative} from '../src/runtime.mjs';
import {AgentMemory} from '../src/agent-memory.mjs';
import {factAdapter} from '../src/fact-plugin.mjs';
assert.equal(process.env.ULTRABRAIN_TEST_ALLOW_WRITE,'1');
const engine=await connect({migrate:true}),source='fact-'+Date.now().toString(36),root=`ultra://${source}/`;
const {dispatchToolCall,validateParams}=await loadNative('src/mcp/dispatch.ts');
const {OperationError}=await loadNative('src/core/ops/contract.ts');
const {operations}=await loadNative('src/core/operations.ts');
const {AUDIT_ROW_SOURCES:auditSources}=await loadNative('src/core/facts/audit-sources.ts');
const auth={token:'test-only',clientId:'facts-fixture',principal:{kind:'oauth_client',id:'facts-fixture'},sourceId:source,scopes:['read','write']};
const ctx={sourceId:source,remote:true,transport:'stdio',auth,engine};
let event=0,checks=0;const pass=()=>checks++;
const call=async(name,args,extra={})=>{
 const result=await dispatchToolCall(engine,name,args,{...ctx,...extra});
 const value=JSON.parse(result.content[0].text);if(result.isError)throw Object.assign(new Error(JSON.stringify(value)),{code:value.error});return value;
};
const put=(slug,content,visibility='world')=>call('put_page',{slug,content:`---\ntype: note\nvisibility: ${visibility}\n---\n${content}`},{remote:false});
const inspect=id=>call('ultra_fact_inspect',{fact_id:id});
const recall=(args={},extra={})=>call('ultra_recall',{uri:root,...args},extra);
const remember=async(fact,extra={})=>(await call('remember',{fact,provenance:'Fixture user assertion',visibility:'world',...extra})).id;
const bindArgs=async(id,slug)=>{
 const f=await inspect(id),page=await call('ultra_read',{uri:root+slug,level:'L2',memory_policy:'history'});
 return {fact_id:id,fact_sha256:f.fact_sha256,expected_revision:f.binding_revision,event_id:'bind-'+(++event),evidence_uri:root+slug,content_sha256:page.content_sha256};
};
const bind=async(id,slug)=>call('ultra_fact_bind',await bindArgs(id,slug));
const review=async(slug,extra={})=>{
 const page=await call('ultra_memory_inspect',{uri:root+slug});
 return call('ultra_memory_review',{uri:root+slug,content_sha256:page.content_sha256,expected_revision:page.memory.revision,event_id:'review-'+(++event),
  status:'active',assertion_kind:'attributed',reason:'Fixture resource review',provenance:'Fixture operator',...extra});
};
try {
 await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)',[source]);
 await put('decisions/origin','factcanary: local PostgreSQL chosen');
 const first=await remember('factcanary: local PostgreSQL chosen');
 assert.equal((await recall()).facts.length,0);pass();
 assert.equal((await recall({memory_policy:'history'})).facts[0].fact_id,first);pass();
 assert.equal((await recall({uri:root+'decisions',memory_policy:'history'})).facts.length,0);pass();
 const privateId=await remember('factcanary private assertion',{visibility:'private'});
 await assert.rejects(inspect(privateId),{code:'not_found'});pass();
 assert.ok((await recall({memory_policy:'history'})).facts.every(f=>f.fact_id!==privateId));pass();
 const args=await bindArgs(first,'decisions/origin');
 await call('ultra_fact_bind',args);
 assert.equal((await call('ultra_fact_bind',args)).replayed,true);pass();
 await assert.rejects(call('ultra_fact_bind',{...args,event_id:'stale-revision'}),{code:'revision_conflict'});pass();
 assert.equal((await recall()).facts[0].fact_id,first);pass();
 assert.equal((await recall({memory_policy:'reviewed'})).facts.length,0);pass();
 await review('decisions/origin');assert.equal((await recall({memory_policy:'reviewed'})).facts[0].fact_id,first);pass();
 assert.equal((await recall({uri:root+'outside'})).facts.length,0);pass();
 assert.equal((await recall({budget_bytes:512})).facts.length,0);pass();
 const active=await recall({budget_bytes:4096});assert.ok(active.evidence_bytes<=4096);assert.ok(active.facts[0].fact.endsWith('chosen'));pass();
 for(const extra of [{auth:{...auth,allowedOperations:[]}},{auth:{...auth,allowedSources:[source,'default']}},
  {auth:{...auth,boundSlugPrefixes:['decisions/']}},{auth:{...auth,grantProjectionDegraded:true}}])await assert.rejects(recall({},extra));pass();
 await assert.rejects(call('ultra_fact_bind',await bindArgs(first,'decisions/origin'),{auth:{...auth,scopes:['read']}}));pass();
 await assert.rejects(call('ultra_fact_inspect',{fact_id:first},{sourceId:'default',auth:{...auth,sourceId:'default'}}),{code:'not_found'});pass();
 await review('decisions/origin',{status:'retracted'});
 assert.equal((await recall()).facts.length,0);assert.equal((await recall({memory_policy:'history'})).facts.some(f=>f.fact_id===first),true);pass();
 // Governed selection changes no raw native facts.
 assert.ok((await call('recall',{grep:'factcanary'})).facts.some(f=>f.fact_id===first));pass();
 await review('decisions/origin',{reactivate:true});
 await put('decisions/origin','factcanary: new unreviewed source version');
 assert.equal((await inspect(first)).evidence.status,'review_required');assert.equal((await recall()).facts.length,0);pass();
 await review('decisions/origin');await bind(first,'decisions/origin');
 assert.equal((await recall()).facts[0].fact_id,first);pass();
 const oldArgs=await bindArgs(first,'decisions/origin');
 await engine.executeRaw("UPDATE public.facts SET fact=fact||' revised' WHERE source_id=$1 AND id=$2::bigint",[source,first]);
 await assert.rejects(call('ultra_fact_bind',{...oldArgs,event_id:'stale-fact'}),{code:'stale_fact'});pass();
 assert.equal((await recall()).facts.length,0);pass();
 await bind(first,'decisions/origin');
 const next=await bindArgs(first,'decisions/origin');
 const race=await Promise.allSettled([call('ultra_fact_bind',next),call('ultra_fact_bind',{...next,event_id:'race-two'})]);
 assert.equal(race.filter(x=>x.status==='fulfilled').length,1);assert.equal(race.find(x=>x.status==='rejected').reason.code,'revision_conflict');pass();
 // Native withdrawal, not a metadata rewrite, removes current facts.
 await call('forget_fact',{id:Number(first),reason:'Fixture withdrew assertion'});
 assert.equal((await recall()).facts.length,0);assert.equal((await inspect(first)).native_active,false);pass();
 await assert.rejects(bind(first,'decisions/origin'),{code:'stale_fact'});pass();
 // A world fact cannot disclose its now-private evidence via ANY new read mode.
 await put('decisions/protected','factcanary: privacy boundary');
 const privacy=await remember('factcanary: privacy boundary');await bind(privacy,'decisions/protected');
 await put('decisions/protected','factcanary: privacy boundary','private');
 assert.ok((await recall({memory_policy:'history'})).facts.every(f=>f.fact_id!==privacy));
 await assert.rejects(inspect(privacy),{code:'not_found'});pass();
 // Native expiry and resource-only expiry are checked independently.
 await put('decisions/expiry','factcanary: expiring evidence');const expiring=await remember('factcanary: expires');await bind(expiring,'decisions/expiry');
 await review('decisions/expiry',{valid_until:'2000-01-01T00:00:00Z'});
 assert.ok((await recall()).facts.every(f=>f.fact_id!==expiring));pass();
 // Controlled extraction invokes actual insertFact, preserving the captured origin.
 await put('sessions/fixture','factcanary: extracted on this source');
 const adapter=factAdapter(operations,{validateParams,OperationError,auditSources});
 const params={source_slug:'sessions/fixture',session_id:'fixture-session',turn_text:'factcanary: extracted on this source',visibility:'world'};
 const inserted=await adapter.extract(ctx,params,async()=>{
  const item=await engine.insertFact({fact:'factcanary: extracted on this source',context:params.source_slug,source_session:params.session_id,
   source:'mcp:extract_facts',visibility:'world'},{source_id:source});
  return {inserted:1,duplicate:0,fact_ids:[item.id]};
 });
 assert.equal(inserted.evidence_binding.linked,1);const autoId=String(inserted.fact_ids[0]);
 assert.equal((await inspect(autoId)).evidence.method,'extraction');pass();
 const replay=await adapter.extract(ctx,params,async()=>({fact_ids:inserted.fact_ids,duplicate:1}));
 assert.equal(replay.evidence_binding.linked,0);assert.equal((await inspect(autoId)).binding_revision,1);pass();
 const unbound=await remember('factcanary: unrelated duplicate');
 const duplicate=await adapter.extract(ctx,params,async()=>({fact_ids:[Number(unbound)],duplicate:1}));
 assert.equal(duplicate.evidence_binding.linked,0);assert.equal((await inspect(unbound)).evidence.status,'unlinked');pass();
 // Origin changing while a model runs cannot bind new assertions to old source text.
 const changing=await adapter.extract(ctx,params,async()=>{
  const item=await engine.insertFact({fact:'factcanary: changed origin',context:params.source_slug,source_session:params.session_id,source:'mcp:extract_facts',visibility:'world'},{source_id:source});
  await put('sessions/fixture','different origin');return {fact_ids:[item.id],inserted:1};
 });assert.equal(changing.evidence_binding.linked,0);pass();
 const mismatched=await adapter.extract(ctx,params,async()=>({fact_ids:inserted.fact_ids,duplicate:1}));
 assert.equal(mismatched.evidence_binding.status,'source_unavailable');pass();
 // Reverting source text still requires explicit re-binding after native change.
 await put('sessions/fixture',params.turn_text);assert.equal((await inspect(autoId)).evidence.status,'review_required');pass();
 await bind(autoId,'sessions/fixture');
 const memory=new AgentMemory({client:{callTool:r=>dispatchToolCall(engine,r.name,r.arguments,ctx)},rootUri:root,sessionId:'agent-facts',factRecall:{grep:'extracted'}});
 const turn=await memory.runTurn({input:'factcanary',generate:async({evidence})=>{
  assert.equal(evidence.facts.length,1);assert.equal(evidence.facts[0].fact_id,autoId);assert.ok(evidence.combined_evidence_bytes<=16000);return 'facts-and-pages';
 }});assert.equal(turn.output,'facts-and-pages');pass();
 // Metadata is linked to native fact lifetime, without a second copy of the claim.
 await engine.executeRaw('DELETE FROM public.facts WHERE source_id=$1 AND id=$2::bigint',[source,unbound]);
 await assert.rejects(inspect(unbound),{code:'not_found'});pass();
 const lastArgs=await bindArgs(autoId,'sessions/fixture');
 await call('ultra_fact_bind',{...lastArgs,dry_run:true});assert.equal((await inspect(autoId)).binding_revision,lastArgs.expected_revision);pass();
 console.log(`PASS ${checks} native fact evidence checks: scoped recall, CAS, source and fact lifecycle, explicit history, controlled extraction, Agent budgets`);
} finally {await engine.disconnect();}
