/** Real PostgreSQL and dispatcher. One controlled extraction fixture tests cleanup, NOT LLM quality. */
import assert from 'node:assert/strict';
import {connect,loadNative} from '../src/runtime.mjs';
import {processSessions,deferredSlug} from '../src/deferred-sessions.mjs';
import {sha256} from '../src/core.mjs';
assert.equal(process.env.ULTRABRAIN_TEST_ALLOW_WRITE,'1');
const engine=await connect({migrate:true});
const {dispatchToolCall}=await loadNative('src/mcp/dispatch.ts');
const source=`deferred-${Date.now().toString(36)}`;
const auth={token:'test-only',clientId:'deferred-client',principal:{kind:'oauth_client',id:'deferred-client'},sourceId:source,scopes:['read','write']};
const actorText='oauth_client:deferred-client:',actor=sha256(actorText);
const call=async(name,args,overrides={})=>{
  const r=await dispatchToolCall(engine,name,args,{sourceId:source,remote:true,transport:'stdio',auth,...overrides});
  const value=JSON.parse(r.content[0].text);if(r.isError)throw Object.assign(new Error(value.error),{code:value.error});return value;
};
const payload={session_id:'S1',event_id:'E1',transcript:'consented-private-canary',visibility:'private',defer_extraction:true};
const status=()=>call('ultra_session_status',{session_id:'S1',event_id:'E1'});
const drain=opts=>call('ultra_process_sessions',{expected_source:source,...opts});
const due=()=>engine.executeRaw("UPDATE ultrabrain.session_receipts SET next_attempt_at=now()-interval '1 second' WHERE source_id=$1",[source]);
let checks=0;const check=()=>checks++;
try {
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)',[source]);
  const captured=await call('ultra_commit_session',payload);
  assert.equal(captured.storage,'journaled');assert.equal(captured.state,'queued');assert.equal(captured.canonical_state,'pending');check();
  assert.equal((await engine.executeRaw('SELECT count(*)::integer AS n FROM pages WHERE source_id=$1',[source]))[0].n,0);check();
  assert.equal((await call('ultra_commit_session',payload)).replayed,true);check();
  await assert.rejects(call('ultra_commit_session',{...payload,transcript:'changed'}),{code:'conflict'});check();
  await assert.rejects(call('ultra_commit_session',{...payload,defer_extraction:false}),{code:'conflict'});check();
  assert.equal((await status()).state,'queued');assert.ok(!JSON.stringify(await status()).includes(payload.transcript));check();
  const other={auth:{...auth,principal:{kind:'oauth_client',id:'other'}}};
  await assert.rejects(call('ultra_session_status',{session_id:'S1',event_id:'E1'},other),{code:'not_found'});check();
  assert.equal((await call('ultra_process_sessions',{expected_source:source},other)).processed,0);check();
  await assert.rejects(drain({expected_source:'default'}),{code:'scope_denied'});check();
  await assert.rejects(call('ultra_process_sessions',{expected_source:source},{auth:{...auth,scopes:['read']}}));check();
  await assert.rejects(call('ultra_process_sessions',{expected_source:source},{auth:{...auth,allowedOperations:[]}}));check();
  for(const restricted of [{boundSlugPrefixes:['limited/']},{fenceProjectionDegraded:true}]) {
    await assert.rejects(call('ultra_commit_session',{...payload,event_id:'restricted'}, {auth:{...auth,...restricted}}));
    await assert.rejects(call('ultra_process_sessions',{expected_source:source},{auth:{...auth,...restricted}}));
  }check();
  assert.equal((await status()).attempts,0);check();
  const both=await Promise.all([drain({}),drain({})]);
  assert.equal(both.reduce((n,r)=>n+r.processed,0),1);check();
  const missing=await status();assert.equal(missing.state,'needs_model');assert.equal(missing.canonical_state,'stored');check();
  await assert.rejects(call('ultra_read',{uri:captured.uri,level:'L2'}));check();
  await due();assert.equal((await drain({})).processed,0);check();
  assert.equal((await drain({retry:true})).results[0].attempts,2);check();
  await engine.executeRaw("UPDATE ultrabrain.session_receipts SET state='processing',lease_until=now()-interval '1 minute' WHERE source_id=$1",[source]);
  await due();assert.equal((await drain({})).processed,1);check();
  // Controlled success fixture on real DB. Do not claim a real model was called.
  await due();let nativeCalls=0;
  const store={source,actor:actorText,sql:(q,p)=>engine.executeRaw(q,p),async assertSessionAccess(){},async assertWrite(){},
    async call(name,p){nativeCalls++;assert.equal(name,'extract_facts');assert.equal(p.visibility,'private');return {inserted:0,duplicate:0};}};
  assert.equal((await processSessions(store,{expected_source:source,retry:true})).results[0].state,'completed');
  assert.equal(nativeCalls,1);check();
  assert.equal((await engine.executeRaw('SELECT pending_payload FROM ultrabrain.session_receipts WHERE source_id=$1',[source]))[0].pending_payload,null);check();
  assert.equal((await call('ultra_commit_session',payload)).state,'completed');check();
  assert.notEqual(deferredSlug(actor,'S1','E1'),deferredSlug(actor,'s1','e1'));check();
  const failed={...payload,event_id:'cap'};await call('ultra_commit_session',failed);
  await engine.executeRaw("UPDATE ultrabrain.session_receipts SET attempts=5,state='processing',lease_until=now()-interval '1 minute' WHERE source_id=$1 AND event_id='cap'",[source]);
  assert.equal((await drain({retry:true})).processed,0);
  assert.equal((await call('ultra_session_status',{session_id:'S1',event_id:'cap'})).state,'failed');check();
  await call('ultra_commit_session',{...payload,event_id:'keep-pending'});
  const before=(await engine.executeRaw('SELECT count(*)::integer AS n FROM ultrabrain.session_receipts WHERE source_id=$1',[source]))[0].n;
  await call('ultra_commit_session',{...payload,event_id:'dry',dry_run:true});
  assert.equal((await engine.executeRaw('SELECT count(*)::integer AS n FROM ultrabrain.session_receipts WHERE source_id=$1',[source]))[0].n,before);check();
  console.log(`PASS ${checks} deferred-session DB checks (keyless + explicitly controlled success fixture, not LLM quality)`);
} finally {await engine.disconnect();}
