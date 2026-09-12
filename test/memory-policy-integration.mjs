/** Actual PostgreSQL + pinned authorization dispatcher. No semantic model quality claims. */
import assert from 'node:assert/strict';
import {connect,loadNative} from '../src/runtime.mjs';
import {AgentMemory} from '../src/agent-memory.mjs';
assert.equal(process.env.ULTRABRAIN_TEST_ALLOW_WRITE,'1');
const engine=await connect({migrate:true});
const {dispatchToolCall}=await loadNative('src/mcp/dispatch.ts');
const source='policy-'+Date.now().toString(36),prefix=`ultra://${source}/`,event=()=>`event-${++sequence}`;
let sequence=0,checks=0;const ok=()=>checks++;
const auth={token:'fixture',clientId:'policy-reader',principal:{kind:'oauth_client',id:'policy-reader'},sourceId:source,scopes:['read','write']};
const opts={sourceId:source,remote:true,transport:'stdio',auth};
const invoke=(name,p,overrides={})=>dispatchToolCall(engine,name,p,{...opts,...overrides});
const call=async(name,p,overrides={})=>{
 const r=await invoke(name,p,overrides);const data=JSON.parse(r.content[0].text);
 if(r.isError)throw Object.assign(new Error(data.error),{code:data.error});return data;
};
const put=(slug,body,visibility='world')=>call('put_page',{slug,content:`---\ntype: note\nvisibility: ${visibility}\n---\n${body}`},{remote:false});
const inspect=(slug)=>call('ultra_memory_inspect',{uri:prefix+slug});
const reviewArgs=async(slug,extra={})=>{
 const view=await inspect(slug);
 return {uri:prefix+slug,event_id:event(),expected_revision:view.memory.revision,content_sha256:view.content_sha256,
  status:'active',assertion_kind:'attributed',reason:'A reviewed project decision',provenance:'Explicit fixture statement',...extra};
};
const review=async(slug,extra={})=>call('ultra_memory_review',await reviewArgs(slug,extra));
const query=p=>call('ultra_retrieve',{uri:prefix+'decisions',query:'policycanary',limit:10,...p});
try {
 await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)',[source]);
 await put('decisions/old','policycanary olduniqueterm: choose database A');await put('decisions/new','policycanary: choose database B');
 assert.equal((await inspect('decisions/old')).memory.status,'unreviewed');ok();
 assert.equal((await query({memory_policy:'reviewed'})).items.length,0);ok();
 assert.equal((await query({})).items.length,2);ok();
 const oldArgs=await reviewArgs('decisions/old');const first=await call('ultra_memory_review',oldArgs);
 assert.equal(first.revision,1);assert.equal((await call('ultra_memory_review',oldArgs)).replayed,true);ok();
 await assert.rejects(call('ultra_memory_review',{...oldArgs,reason:'different'}),{code:'conflict'});ok();
 await assert.rejects(call('ultra_memory_review',await reviewArgs('decisions/new'),{auth:{...auth,scopes:['read']}}));ok();
 await assert.rejects(call('ultra_memory_inspect',{uri:prefix+'decisions/old'},{auth:{...auth,boundSlugPrefixes:['decisions/']}}));ok();
 await assert.rejects(call('ultra_memory_inspect',{uri:prefix+'decisions/old'},{sourceId:'default',auth:{...auth,sourceId:'default'}}));ok();
 await assert.rejects(call('ultra_memory_inspect',{uri:prefix+'decisions/old'},{auth:{...auth,allowedOperations:[]}}));ok();
 const new0=await inspect('decisions/new');
 const correction={uri:prefix+'decisions/old',event_id:event(),expected_revision:1,content_sha256:first.content_sha256??oldArgs.content_sha256,
  replacement_uri:prefix+'decisions/new',replacement_sha256:new0.content_sha256,replacement_revision:0,
  reason:'Later decision replaces A with B',provenance:'Approved new decision'};
 await assert.rejects(call('ultra_memory_supersede',correction),{code:'replacement_not_reviewed'});ok();
 await review('decisions/new');
 await call('ultra_memory_supersede',{...correction,event_id:event(),replacement_revision:1});ok();
 assert.equal((await inspect('decisions/old')).memory.status,'superseded');ok();
 await assert.rejects(call('ultra_read',{uri:prefix+'decisions/old',level:'L2'}),{code:'memory_not_current'});ok();
 const history=await call('ultra_read',{uri:prefix+'decisions/old',level:'L2',memory_policy:'history'});
 assert.match(history.content,/database A/);assert.equal(history.memory.historical,true);ok();
 const redirected=await query({query:'olduniqueterm'});assert.equal(redirected.items[0].uri,prefix+'decisions/new');assert.equal(redirected.items[0].redirected_from,prefix+'decisions/old');ok();
 const current=await query({});assert.equal(current.items.length,1);assert.match(current.items[0].content,/database B/);ok();
 const listing=await call('ultra_ls',{uri:prefix+'decisions'});assert.ok(!listing.entries.some(x=>x.uri.endsWith('/old')));ok();
 await assert.rejects(call('ultra_excerpt',{uri:prefix+'decisions/old',content_sha256:history.content_sha256,start:0,end:8}),{code:'memory_not_current'});ok();
 await assert.rejects(review('decisions/old'),{code:'reactivation_required'});ok();
 // Native writes invalidate a previous review rather than silently trusting the edited text.
 await put('decisions/new','policycanary: unreviewed rewrite database C');
 const edited=await inspect('decisions/new');assert.equal(edited.memory.status,'review_required');assert.equal(edited.memory.revision,2);ok();
 assert.equal((await query({})).items.length,0);ok();
 await assert.rejects(call('ultra_memory_review',{...await reviewArgs('decisions/new'),content_sha256:new0.content_sha256}),{code:'stale_source'});ok();
 const raceA=await reviewArgs('decisions/new'),raceB={...raceA,event_id:event(),assertion_kind:'inference'};
 const race=await Promise.allSettled([call('ultra_memory_review',raceA),call('ultra_memory_review',raceB)]);
 assert.equal(race.filter(x=>x.status==='fulfilled').length,1);assert.equal(race.find(x=>x.status==='rejected').reason.code,'revision_conflict');ok();
 // Time windows are explicit UTC; SQL time is used by server selection.
 await review('decisions/new',{valid_until:'2000-01-01T00:00:00Z'});
 assert.equal((await inspect('decisions/new')).memory.status,'expired');assert.equal((await query({})).items.length,0);ok();
 await review('decisions/new',{valid_from:'2099-01-01T00:00:00Z'});
 assert.equal((await inspect('decisions/new')).memory.status,'not_yet_valid');ok();
 await review('decisions/new');
 // Source references are checked, and their locations are not declared truth proofs.
 const page=await call('ultra_read',{uri:prefix+'decisions/new',level:'L2'});
 const start=page.content.indexOf('policycanary');
 await review('decisions/new',{assertion_kind:'source_quote',evidence:{uri:prefix+'decisions/new',content_sha256:page.content_sha256,start,end:start+12}});
 assert.match((await inspect('decisions/new')).memory.assurance,/not truth/);ok();
 await assert.rejects(review('decisions/new',{assertion_kind:'source_quote',evidence:{uri:prefix+'decisions/new',content_sha256:'0'.repeat(64),start:0,end:1}}),{code:'stale_source'});ok();
 // Free-form review details of another principal are not inherited by a remote reader.
 const other={auth:{...auth,principal:{kind:'oauth_client',id:'another'}}};
 const otherHistory=await call('ultra_memory_history',{uri:prefix+'decisions/new'},other);
 assert.ok(otherHistory.revisions.every(x=>!x.review));ok();
 const ownHistory=await call('ultra_memory_history',{uri:prefix+'decisions/new'});
 assert.ok(ownHistory.revisions.some(x=>x.review));ok();
 // Explicit retirement survives a native edit, soft deletion and restoration.
 await review('decisions/old',{status:'retracted'});
 await put('decisions/old','policycanary stale import');assert.equal((await inspect('decisions/old')).memory.status,'retracted');ok();
 await call('delete_page',{slug:'decisions/old'});await call('restore_page',{slug:'decisions/old'});
 assert.equal((await inspect('decisions/old')).memory.status,'retracted');ok();
 await put('private/hidden','confidential','private');
 await assert.rejects(inspect('private/hidden'));ok();
 // No changes in dry run; no model called by reviews.
 const dry=await reviewArgs('decisions/new');
 await call('ultra_memory_review',{...dry,dry_run:true});assert.equal((await inspect('decisions/new')).memory.revision,dry.expected_revision);ok();
 // Round-trip through the Agent lifecycle receives only the replacement evidence.
 const memory=new AgentMemory({client:{callTool:r=>invoke(r.name,r.arguments)},rootUri:prefix+'decisions',sessionId:'policy-turn'});
 const turn=await memory.runTurn({input:'policycanary',generate:async({evidence})=>{
  assert.ok(evidence.items.every(x=>x.uri!==prefix+'decisions/old'));return 'Replacement only';}});
 assert.equal(turn.output,'Replacement only');ok();
 // A retired URL must not revive after a physical purge and stale import at the same address.
 await put('decisions/purge','policycanary purged source');await review('decisions/purge',{status:'retracted'});
 await engine.executeRaw('DELETE FROM public.pages WHERE source_id=$1 AND slug=$2',[source,'decisions/purge']);
 await put('decisions/purge','policycanary purged source');assert.equal((await inspect('decisions/purge')).memory.status,'retracted');ok();
 // Replacement traversal is constrained to the requested directory before reading target content.
 await put('outside/new','Replacement outside requested directory');await review('outside/new');
 await put('decisions/boundary','boundaryoldtoken');
 const boundary=await inspect('decisions/boundary'),outside=await inspect('outside/new');
 await call('ultra_memory_supersede',{uri:prefix+'decisions/boundary',event_id:event(),expected_revision:0,content_sha256:boundary.content_sha256,
  replacement_uri:prefix+'outside/new',replacement_sha256:outside.content_sha256,replacement_revision:1,reason:'New location',provenance:'Fixture'});
 assert.equal((await query({query:'boundaryoldtoken'})).items.length,0);ok();
 const whole=await call('ultra_retrieve',{uri:prefix,query:'boundaryoldtoken'});
 assert.equal(whole.items[0].uri,prefix+'outside/new');ok();
 // Two-step history follows only declared hash-bound links and exposes the current terminal.
 await put('chain/a','chainoldtoken');await put('chain/b','intermediate');await put('chain/c','current endpoint');
 for(const slug of ['chain/b','chain/c'])await review(slug);
 for(const [a,b] of [['chain/a','chain/b'],['chain/b','chain/c']]){
  const av=await inspect(a),bv=await inspect(b);
  await call('ultra_memory_supersede',{uri:prefix+a,event_id:event(),expected_revision:av.memory.revision,content_sha256:av.content_sha256,
   replacement_uri:prefix+b,replacement_sha256:bv.content_sha256,replacement_revision:bv.memory.revision,reason:'New revision',provenance:'Fixture'});
 }
 const chain=await call('ultra_retrieve',{uri:prefix+'chain',query:'chainoldtoken'});
 assert.equal(chain.items[0].uri,prefix+'chain/c');assert.equal(chain.items[0].replacement_hops,2);ok();
 console.log(`PASS ${checks} resource governance checks: current/history, correction CAS, native invalidation, validity, citations, authorization, Agent lifecycle`);
} finally {await engine.disconnect();}
