/** Actual native dispatcher/hot-memory module with a real PostgreSQL source.
 * Verify both the data envelope and side-channel metadata, including warmed cache.
 */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {connect,loadNative,ROOT} from '../src/runtime.mjs';
import {sha256} from '../src/core.mjs';
import {META_HOOK_SHA256} from '../src/adapters/response-metadata.mjs';
import {GOVERNED_TOOLS} from '../src/enterprise-policy.mjs';
assert.equal(process.env.ULTRABRAIN_TEST_ALLOW_WRITE,'1');
const engine=await connect(),source='metadata-'+Date.now().toString(36),uri=`ultra://${source}/origin`;
const {dispatchToolCall}=await loadNative('src/mcp/dispatch.ts');
const {getBrainHotMemoryMeta}=await loadNative('src/core/facts/meta-hook.ts');
const auth={sourceId:source,principal:{kind:'oauth_client',id:'metadata'},clientId:'metadata',scopes:['read','write']};
const opts={sourceId:source,remote:true,transport:'http',auth,takesHoldersAllowList:['world'],metaHook:getBrainHotMemoryMeta};
let checks=0;const pass=()=>checks++;
const call=async(name,p,extra={})=>{
 const r=await dispatchToolCall(engine,name,p,{...opts,...extra});assert.ok(!r.isError,'fixture operation rejected');return {envelope:r,data:JSON.parse(r.content[0].text)};};
try {
 await engine.executeRaw('INSERT INTO public.sources(id,name) VALUES($1,$1)',[source]);
 await call('put_page',{slug:'origin',content:'---\ntype: note\nvisibility: world\n---\nretiredcanary old decision'},{remote:false});
 const fact=(await call('remember',{fact:'retiredcanary old decision',provenance:'Synthetic source',visibility:'world'})).data.id;
 const info=(await call('ultra_fact_inspect',{fact_id:String(fact)})).data;
 const page=(await call('ultra_read',{uri,level:'L2'})).data;
 await call('ultra_fact_bind',{fact_id:String(fact),fact_sha256:info.fact_sha256,evidence_uri:uri,content_sha256:page.content_sha256,expected_revision:0,event_id:'bind'});
 await call('ultra_memory_review',{uri,content_sha256:page.content_sha256,expected_revision:0,event_id:'retire',status:'retracted',assertion_kind:'attributed',reason:'Retired fixture',provenance:'Synthetic fixture'});
 // Raw compatibility API still demonstrates the old native data channel.
 const raw=await getBrainHotMemoryMeta('get_page',{...opts,engine});assert.ok(JSON.stringify(raw).includes('retiredcanary'));pass();
 const identity=await call('ultra_identity',{});assert.ok(!identity.envelope._meta?.brain_hot_memory);assert.ok(!JSON.stringify(identity.envelope).includes('retiredcanary'));pass();
 const governed=await call('ultra_recall',{uri:`ultra://${source}/`});assert.equal(governed.data.facts.length,0);assert.ok(!governed.envelope._meta?.brain_hot_memory);pass();
 const context=await call('ultra_retrieve',{uri:`ultra://${source}/outside`,query:'retiredcanary'});assert.equal(context.data.items.length,0);assert.ok(!JSON.stringify(context.envelope).includes('retiredcanary'));pass();
 // All reviewed tools are suppressed before a cache lookup or database call.
 const hostileEngine={listFactsBySession(){throw Error('must not read');},listFactsSince(){throw Error('must not read');}};
 for(const name of GOVERNED_TOOLS)assert.equal(await getBrainHotMemoryMeta(name,{...opts,engine:hostileEngine}),undefined);pass();
 assert.equal(sha256(readFileSync(`${ROOT}/vendor/gbrain/src/core/facts/meta-hook.ts`,'utf8')),META_HOOK_SHA256);pass();
 console.log(`PASS ${checks} response-metadata checks: real facts, retired origin, warmed native cache, governed context and unchanged vendor bytes`);
}finally{await engine.disconnect();}
