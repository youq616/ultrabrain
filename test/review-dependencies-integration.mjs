/** Exact source dependencies on real PostgreSQL; no model or truth/entailment judgment. */
import assert from 'node:assert/strict';
import {connect,loadNative} from '../src/runtime.mjs';
assert.equal(process.env.ULTRABRAIN_TEST_ALLOW_WRITE,'1');
const engine=await connect({migrate:true});
const {dispatchToolCall}=await loadNative('src/mcp/dispatch.ts');
const source=`dep-${Date.now().toString(36)}`,root=`ultra://${source}/`;
const auth={token:'synthetic',sourceId:source,clientId:'dep',scopes:['read','write'],principal:{kind:'oauth_client',id:'dep'}};
let sequence=0,checks=0;const check=()=>checks++;
const call=async(name,args)=>{
 const r=await dispatchToolCall(engine,name,args,{sourceId:source,remote:true,transport:'stdio',auth});
 const value=JSON.parse(r.content[0].text);if(r.isError)throw Object.assign(new Error(value.error),{code:value.error});return value;
};
const put=(slug,body)=>call('put_page',{slug,content:`---\ntype: note\nvisibility: world\n---\n${body}`});
const inspect=slug=>call('ultra_memory_inspect',{uri:root+slug});
const review=async(slug,proof=null,extra={})=>{
 const v=await inspect(slug);
 const args={uri:root+slug,event_id:`review-${++sequence}`,expected_revision:v.memory.revision,
  content_sha256:v.content_sha256,status:'active',assertion_kind:proof?'source_quote':'attributed',reason:'Synthetic review',provenance:'Synthetic source',...extra};
 if(proof){const e=await inspect(proof);args.evidence={uri:root+proof,content_sha256:e.content_sha256,start:0,end:10};}
 return call('ultra_memory_review',args);
};
try {
 await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)',[source]);
 for(const slug of ['raw','derived','chain','unrelated','newraw'])await put(slug,`Source ${slug} revision one`);
 await review('raw');await review('derived','raw');await review('chain','derived');await review('unrelated');
 assert.equal((await inspect('derived')).memory.status,'active');check();
 assert.equal((await engine.executeRaw('SELECT count(*)::integer AS n FROM ultrabrain.review_dependencies WHERE source_id=$1',[source]))[0].n,2);check();
 await put('raw','Source raw revision two');
 for(const slug of ['derived','chain']){
  const v=await inspect(slug);assert.equal(v.memory.status,'review_required');assert.equal(v.memory.revision,2);
  const h=await call('ultra_memory_history',{uri:root+slug});assert.equal(h.revisions[0].status,'review_required');
 }
 assert.equal((await inspect('unrelated')).memory.status,'active');check();
 await assert.rejects(review('derived','raw'),{code:'evidence_not_current'});check();
 await review('raw');await review('derived','raw');await review('chain','derived');
 await review('raw',null,{status:'retracted'});
 assert.equal((await inspect('derived')).memory.status,'review_required');assert.equal((await inspect('chain')).memory.status,'review_required');check();
 await review('raw',null,{reactivate:true});await review('derived','raw');await review('chain','derived');
 // Switching evidence removes the old edge; future updates of old evidence must not retire the new review.
 await review('derived','newraw');
 const rev=(await inspect('derived')).memory.revision;
 await put('raw','Third revision of no-longer-referenced source');
 assert.equal((await inspect('derived')).memory.revision,rev);assert.equal((await inspect('derived')).memory.status,'active');check();
 await put('newraw','Changed current evidence');assert.equal((await inspect('derived')).memory.status,'review_required');check();
 // Soft-delete and restore do not silently re-approve a dependent resource.
 await review('derived','newraw');await call('delete_page',{slug:'newraw'});
 assert.equal((await inspect('derived')).memory.status,'review_required');check();
 await call('restore_page',{slug:'newraw'});assert.equal((await inspect('derived')).memory.status,'review_required');check();
 // A source may be unreviewed, but cannot already be retracted at review commit time.
 await review('derived','newraw');await engine.executeRaw('DELETE FROM public.pages WHERE source_id=$1 AND slug=$2',[source,'newraw']);
 assert.equal((await inspect('derived')).memory.status,'review_required');check();
 // Self quotes do not recurse or generate duplicate revision increments on a native update.
 await put('self','Self quote test');await review('self','self');
 await put('self','Changed self');assert.equal((await inspect('self')).memory.revision,2);check();
 // A cyclic citation graph terminates via UNION and changes each active review only once.
 await put('cycle/a','cycle a');await put('cycle/b','cycle b');
 await review('cycle/a','cycle/b');await review('cycle/b','cycle/a');
 await put('cycle/a','cycle a changed');
 assert.equal((await inspect('cycle/a')).memory.revision,2);assert.equal((await inspect('cycle/b')).memory.revision,2);check();
 // Dependent review and evidence update cannot leave an old quote approved after both finish.
 await put('raceraw','race one');await put('racederived','race review');await review('racederived','raceraw');
 const race=await Promise.allSettled([review('racederived','raceraw'),put('raceraw','race two')]);
 assert.ok(race.some(x=>x.status==='fulfilled'));
 assert.equal((await inspect('racederived')).memory.status,'review_required');check();
 // Expiry needs no source-page edit: selection evaluates the current evidence window.
 await put('timed','Time-limited evidence');await put('timederived','Quote from time-limited source');
 await put('timechain','Quote from derived source');
 await review('timed');await review('timederived','timed');await review('timechain','timederived');
 await review('timed',null,{valid_until:'2000-01-01T00:00:00Z'});
 assert.equal((await inspect('timederived')).memory.status,'review_required');
 assert.equal((await inspect('timechain')).memory.status,'review_required');check();
 await assert.rejects(review('timechain','timederived'),{code:'evidence_not_current'});check();
 await put('old-decision','Old decision');
 const old=await inspect('old-decision'),target=await inspect('timederived');
 await assert.rejects(call('ultra_memory_supersede',{uri:root+'old-decision',event_id:`replace-${++sequence}`,
  expected_revision:old.memory.revision,content_sha256:old.content_sha256,replacement_uri:root+'timederived',
  replacement_revision:target.memory.revision,replacement_sha256:target.content_sha256,reason:'Replacement test',provenance:'Synthetic'}),
  {code:'replacement_not_reviewed'});check();
 // The additive migration does not need to rewrite original documents.
 assert.match((await call('get_page',{slug:'derived',include_content:true})).content,/Source derived revision one/);check();
 console.log(`PASS ${checks} real citation-dependency checks: transitive invalidation, retirement, edge replacement, delete/restore, cycles, concurrency`);
} finally {await engine.disconnect();}
