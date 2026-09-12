/** Real PostgreSQL + native MCP dispatcher; explicitly controlled model fixture, not quality scoring. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {connect,loadNative,HOME} from '../src/runtime.mjs';
assert.equal(process.env.ULTRABRAIN_TEST_ALLOW_WRITE,'1');
const engine=await connect({migrate:true});
const {dispatchToolCall}=await loadNative('src/mcp/dispatch.ts');
const gateway=await loadNative('src/core/ai/gateway.ts');
const configPath=join(HOME,'gbrain/.gbrain/config.json'),original=readFileSync(configPath,'utf8');
const config=JSON.parse(original);
const profile={enabled:true,model:'openai:fixture-only',revision:'fixture-v1',chunk_bytes:1024,max_chunks:16,timeout_ms:2000};
const configure=(value)=>writeFileSync(configPath,JSON.stringify({...config,ultrabrain_semantics:value}),{mode:0o600});
const source=`sem-${Date.now().toString(36)}`,slug='project/design',uri=`ultra://${source}/${slug}`;
const auth={clientId:'semantic-fixture',token:'not-a-real-token',principal:{kind:'oauth_client',id:'semantic-fixture'},sourceId:source,scopes:['read','write']};
const call=async(name,args,extra={})=>{
  const r=await dispatchToolCall(engine,name,args,{sourceId:source,remote:true,transport:'stdio',auth,...extra});
  const value=JSON.parse(r.content[0].text);if(r.isError)throw Object.assign(new Error(value.error),{code:value.error});return value;
};
const put=(value)=>call('put_page',{slug,content:'---\ntype: note\nvisibility: world\n---\n'+value});
let modelCalls=0,checks=0;const check=()=>checks++;
const respond=async opts=>{
  modelCalls++;
  const prompt=JSON.parse(opts.messages[0].content);
  if(prompt.segment) {
    const quote=prompt.segment.text.slice(-120);
    return {text:JSON.stringify({claims:[{text:quote,quote}]}),model:'openai:fixture-only',stopReason:'end',usage:{input_tokens:1,output_tokens:1}};
  }
  const c=prompt.claims.at(-1);
  return {text:JSON.stringify({abstract:{text:'Fixture: source-grounded abstract.',evidence_ids:[c.id]},overview:[{text:c.text,evidence_ids:[c.id]}]}),model:'openai:fixture-only',stopReason:'end',usage:{input_tokens:1,output_tokens:1}};
};
try {
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)',[source]);
  await put('background '.repeat(250)+'\nDecision: PostgreSQL must remain local; do not connect externally.');
  configure(undefined);
  await assert.rejects(call('ultra_summarize',{uri,allow_model_call:true}),{code:'model_unavailable'});check();
  configure(profile);gateway.__setChatTransportForTests(respond);
  await assert.rejects(call('ultra_summarize',{uri}),{code:'model_consent_required'});assert.equal(modelCalls,0);check();
  assert.equal((await call('ultra_summarize',{uri,allow_model_call:true,dry_run:true})).dry_run,true);assert.equal(modelCalls,0);check();
  const generated=await call('ultra_summarize',{uri,allow_model_call:true});
  assert.equal(generated.state,'ready');assert.ok(modelCalls>2);assert.ok(generated.document.overview[0].text.includes('do not connect externally'));check();
  const count=modelCalls;
  assert.equal((await call('ultra_summarize',{uri})).cached,true);assert.equal(modelCalls,count);check();
  const summary=await call('ultra_read',{uri,level:'L1',summary:'require'});
  assert.equal(summary.summary_method,'grounded-map-reduce-v1');assert.ok(summary.citations.length>0);check();
  const cite=summary.citations[0];
  const excerpt=await call('ultra_excerpt',{uri,content_sha256:cite.content_sha256,start:cite.start,end:cite.end});
  assert.equal(excerpt.content,cite.quote);assert.equal(modelCalls,count);check();
  const readOnly={auth:{...auth,scopes:['read']}};
  assert.equal((await call('ultra_read',{uri,summary:'require'},readOnly)).summary_status,'ready');check();
  await assert.rejects(call('ultra_summarize',{uri,allow_model_call:true},readOnly));check();
  await assert.rejects(call('ultra_summary_status',{uri},{auth:{...auth,sourceId:'default'},sourceId:'default'}));check();
  await assert.rejects(call('ultra_summary_status',{uri},{auth:{...auth,boundSlugPrefixes:['project/']}}));check();
  // Another actor may read the original, but never inherits this actor's cached derived view.
  await assert.rejects(call('ultra_read',{uri,summary:'require'},{auth:{...auth,principal:{kind:'oauth_client',id:'another'}}}),{code:'summary_unavailable'});check();
  const retrieval=await call('ultra_retrieve',{uri:`ultra://${source}/project`,query:'PostgreSQL',summary:'require'});
  assert.ok(retrieval.items.some(i=>i.summary_method==='grounded-map-reduce-v1'));assert.equal(modelCalls,count);check();
  await put('Revised decision: local PostgreSQL only.');
  assert.equal((await engine.executeRaw('SELECT count(*)::integer AS n FROM ultrabrain.summary_cache WHERE source_id=$1',[source]))[0].n,0);check();
  await assert.rejects(call('ultra_excerpt',{uri,content_sha256:cite.content_sha256,start:cite.start,end:cite.end}),{code:'stale_source'});check();
  assert.equal((await call('ultra_summary_status',{uri})).state,'not_cached_or_stale');check();
  await assert.rejects(call('ultra_read',{uri,summary:'require'}),{code:'summary_unavailable'});assert.equal(modelCalls,count);check();
  // Concurrent generation: one lease, no duplicate provider work.
  let release,started;const begin=new Promise(r=>started=r);const wait=new Promise(r=>release=r);
  gateway.__setChatTransportForTests(async opts=>{started();await wait;return respond(opts);});
  const building=call('ultra_summarize',{uri,allow_model_call:true});await begin;
  await assert.rejects(call('ultra_summarize',{uri,allow_model_call:true}),{code:'busy'});release();await building;check();
  gateway.__setChatTransportForTests(respond);
  configure({...profile,revision:'changed-profile'});
  assert.equal((await call('ultra_summary_status',{uri})).state,'not_cached_or_stale');check();
  configure(profile);
  await engine.executeRaw("UPDATE ultrabrain.summary_cache SET expires_at=now()-interval '1 second' WHERE source_id=$1",[source]);
  assert.equal((await call('ultra_summary_status',{uri})).state,'not_cached_or_stale');check();
  await call('ultra_summary_forget',{uri});
  gateway.__setChatTransportForTests(async()=>({text:'{"claims":[{"text":"invented","quote":"not in the original anywhere"}]}',stopReason:'end',model:'openai:fixture-only',usage:{input_tokens:1,output_tokens:1}}));
  await assert.rejects(call('ultra_summarize',{uri,allow_model_call:true}),{code:'invalid_summary'});check();
  assert.equal((await engine.executeRaw('SELECT state,document FROM ultrabrain.summary_cache WHERE source_id=$1',[source]))[0].document,null);check();
  gateway.__setChatTransportForTests(async()=>{throw new Error('SECRET provider failure');});
  await assert.rejects(call('ultra_summarize',{uri,allow_model_call:true}),{code:'summary_generation_failed'});
  assert.ok(!JSON.stringify(await engine.executeRaw('SELECT * FROM ultrabrain.summary_cache WHERE source_id=$1',[source])).includes('SECRET'));check();
  // Original changed after model input: publication must be rejected.
  let changed=false;
  gateway.__setChatTransportForTests(async opts=>{if(!changed){changed=true;await put('source changed during summary');}return respond(opts);});
  await assert.rejects(call('ultra_summarize',{uri,allow_model_call:true}),{code:'stale_summary'});check();
  gateway.__setChatTransportForTests(respond);
  await call('ultra_summarize',{uri,allow_model_call:true});
  await call('delete_page',{slug});
  await assert.rejects(call('ultra_read',{uri,summary:'require'}));
  assert.equal((await engine.executeRaw('SELECT count(*)::integer AS n FROM ultrabrain.summary_cache WHERE source_id=$1',[source]))[0].n,0);check();
  await call('restore_page',{slug});
  // Host-private source cannot leak through a derived cache.
  await call('put_page',{slug:'private/secret',content:'---\ntype: note\nvisibility: private\n---\nprivate-canary'},{remote:false});
  await call('ultra_summarize',{uri:`ultra://${source}/private/secret`,allow_model_call:true},{remote:false});
  await assert.rejects(call('ultra_summary_status',{uri:`ultra://${source}/private/secret`}));check();
  // Leave a real derived JSONB record to include in backup/restore verification.
  await call('ultra_summarize',{uri,allow_model_call:true});
  const policy=await call('ultra_memory_inspect',{uri});
  const beforePolicyCalls=modelCalls;
  await call('ultra_memory_review',{uri,event_id:'retract-summary-source',expected_revision:0,content_sha256:policy.content_sha256,
    status:'retracted',assertion_kind:'attributed',reason:'Superseded decision',provenance:'Fixture review'});
  assert.equal((await engine.executeRaw('SELECT count(*)::integer AS n FROM ultrabrain.summary_cache WHERE source_id=$1 AND slug=$2',[source,slug]))[0].n,0);check();
  await assert.rejects(call('ultra_summarize',{uri,allow_model_call:true}),{code:'memory_not_current'});
  assert.equal(modelCalls,beforePolicyCalls);check();
  assert.equal((await call('ultra_summary_status',{uri})).state,'excluded_by_memory_policy');check();
  await call('ultra_memory_review',{uri,event_id:'reactivate-summary-source',expected_revision:1,content_sha256:policy.content_sha256,
    status:'active',assertion_kind:'attributed',reason:'Explicitly reactivated',provenance:'Fixture review',reactivate:true});
  await call('ultra_summarize',{uri,allow_model_call:true});check();
  console.log(`PASS ${checks} semantic pipeline DB/dispatcher checks; controlled model output, not real model quality`);
} finally {
  gateway.__setChatTransportForTests(null);writeFileSync(configPath,original,{mode:0o600});await engine.disconnect();
}
