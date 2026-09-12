import test from 'node:test';
import assert from 'node:assert/strict';
import {effectivePolicy,policyAllows,normalizeReview,utcInstant,memoryPolicyTools,authorizeMemory} from '../src/memory-policy.mjs';
import {contextTools} from '../src/context.mjs';
import {AgentMemory} from '../src/agent-memory.mjs';
const hash='a'.repeat(64),now='2026-09-12T02:00:00.500Z';
const row={revision:1,status:'active',assertion_kind:'attributed',content_sha256:hash};
test('unreviewed input is labeled, not falsely declared reviewed',()=>{
 const p=effectivePolicy(null,hash,now);assert.equal(p.status,'unreviewed');assert.equal(policyAllows(p),true);assert.equal(policyAllows(p,'reviewed'),false);
});
for(const state of ['retracted','superseded','review_required'])test(`${state} stays excluded even if content matches`,()=>{
 const p=effectivePolicy({...row,status:state},hash,now);assert.equal(policyAllows(p),false);assert.equal(policyAllows(p,'history'),true);
});
test('source mismatch invalidates an otherwise active annotation',()=>assert.equal(effectivePolicy(row,'b'.repeat(64),now).status,'review_required'));
test('validity uses inclusive start and exclusive end, retaining milliseconds from Date objects',()=>{
 assert.equal(effectivePolicy({...row,valid_from:now},hash,new Date(now)).status,'active');
 assert.equal(effectivePolicy({...row,valid_until:now},hash,new Date(now)).status,'expired');
 assert.equal(effectivePolicy({...row,valid_from:'2026-09-12T02:00:00.501Z'},hash,new Date(now)).status,'not_yet_valid');
});
test('inferences never turn into verified truth labels',()=>assert.match(effectivePolicy({...row,assertion_kind:'inference'},hash,now).assurance,/inference/));
test('exact quote proof is not truth or entailment proof',()=>assert.match(effectivePolicy({...row,assertion_kind:'source_quote'},hash,now).assurance,/not truth/));
test('UTC instants reject ambiguous timezones and impossible dates',()=>{
 assert.equal(utcInstant('2026-09-12T02:00:00Z','test'),'2026-09-12T02:00:00.000Z');
 for(const t of ['today','2026-02-30T00:00:00Z','2026-09-12','2026-09-12T01:00:00','2026-09-12T01:00:00+08:00'])assert.throws(()=>utcInstant(t,'test'));
});
test('review requires attribution, explicit classification and consistent validity',()=>{
 const p={status:'active',assertion_kind:'attributed',reason:'approved',provenance:'User stated'};
 assert.equal(normalizeReview(p).reactivate,false);
 for(const bad of [{provenance:''},{assertion_kind:'verified'},{status:'superseded'},
  {valid_from:'2026-09-12T00:00:00Z',valid_until:'2026-09-11T00:00:00Z'}])assert.throws(()=>normalizeReview({...p,...bad}));
});
test('governance requires a complete source grant and current read/write scope',()=>{
 const ctx={sourceId:'default',engine:{kind:'postgres'},auth:{sourceId:'default',scopes:['read']}};
 authorizeMemory(ctx);assert.throws(()=>authorizeMemory(ctx,true));
 for(const denied of [{viaSubagent:true},{auth:{...ctx.auth,boundSlugPrefixes:['p/']}},{auth:{...ctx.auth,grantProjectionDegraded:true}},
  {auth:{...ctx.auth,sourceId:'other'}}])assert.throws(()=>authorizeMemory({...ctx,...denied}));
});
test('authorization runs before any governance database or source access',async()=>{
 let reads=0;
 const tools=memoryPolicyTools({async authorize(){throw Object.assign(new Error('denied'),{code:'permission_denied'});},async call(){reads++;},async sql(){reads++;}});
 await assert.rejects(tools.inspect({uri:'ultra://default/a'}),{code:'permission_denied'});assert.equal(reads,0);
});
test('retrieval backfills past retired top hits, while history is explicit',async()=>{
 const pages=Array.from({length:5},(_,n)=>({source_id:'default',slug:'p/'+n,content:'canary '+n,title:'canary'}));
 const store={async call(name,p){return name==='search'?pages:pages.find(x=>x.slug===p.slug);},
  async policy(p){return p.slug==='p/4'?effectivePolicy(null,hash,now):effectivePolicy({...row,status:'retracted'},hash,now);}};
 const r=await contextTools(store).retrieve({uri:'ultra://default/p',query:'canary',limit:1});
 assert.equal(r.items.length,1);assert.equal(r.items[0].uri,'ultra://default/p/4');assert.equal(r.policy_filtered,4);
 assert.equal((await contextTools(store).retrieve({uri:'ultra://default/p',query:'canary',limit:1,memory_policy:'history'})).items[0].memory.historical,true);
 await assert.rejects(contextTools(store).read({uri:'ultra://default/p/0'}),{code:'memory_not_current'});
});
test('agent declares selection policy in the actual memory request',async()=>{
 let args;
 const memory=new AgentMemory({client:{async callTool(p){args=p.arguments;return {content:[{type:'text',text:'{"items":[]}'}]};}},
  rootUri:'ultra://default/',sessionId:'s',memoryPolicy:'reviewed'});
 await memory.beforeTurn('continue');assert.equal(args.memory_policy,'reviewed');
});

test('source excerpts retain explicit historical policy and reject ineligible reviewed evidence',async()=>{
 const citation={uri:'ultra://default/a',content_sha256:'a'.repeat(64),start:0,end:4,quote:'text'};let request;
 const client={async callTool(p){request=p;return {content:[{type:'text',text:JSON.stringify({...citation,content:'text',memory:{status:'retracted',eligible:false}})}]};}};
 const history=new AgentMemory({client,rootUri:'ultra://default/',sessionId:'s',memoryPolicy:'history'});
 await history.sourceExcerpt(citation);assert.equal(request.arguments.memory_policy,'history');
 const reviewed=new AgentMemory({client,rootUri:'ultra://default/',sessionId:'s',memoryPolicy:'reviewed'});
 await assert.rejects(reviewed.sourceExcerpt(citation),{code:'memory_not_current'});
});
