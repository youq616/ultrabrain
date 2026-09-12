import test from 'node:test';
import assert from 'node:assert/strict';
import {factId,factHash,activeFact,authorizeFacts,extractWithEvidence} from '../src/fact-evidence.mjs';
import {AgentMemory} from '../src/agent-memory.mjs';
const row={fact_id:'1',source_id:'default',fact:'Statement',kind:'fact',visibility:'world',source:'User said',valid_from:'2026-01-01T00:00:00Z',created_at:'2026-01-01T00:00:00Z'};
const wrap=value=>({content:[{type:'text',text:JSON.stringify(value)}]});
test('fact IDs are exact positive bigint strings, not floating-point numbers or SQL',()=>{
 assert.equal(factId('9223372036854775807'),'9223372036854775807');
 for(const id of [1,'0','01','1.1','1 OR 1=1','9223372036854775808','-1'])assert.throws(()=>factId(id));
});
test('fingerprint changes with assertion, provenance, visibility, entity or lifecycle',()=>{
 const base=factHash(row);
 for(const change of [{fact:'Changed'},{source:'Another'},{context:'page'},{visibility:'private'},{valid_until:'2026-02-01T00:00:00Z'},
  {entity_slug:'another'},{expired_at:'2026-02-01T00:00:00Z'},{superseded_by:2},{source_session:'s'}])assert.notEqual(factHash({...row,...change}),base);
 assert.equal(factHash({...row,valid_from:new Date(row.valid_from),created_at:new Date(row.created_at)}),base);
});
test('native validity uses expiry not future event dates as automatic censorship',()=>{
 const now='2026-06-01T00:00:00Z';assert.equal(activeFact({...row,valid_from:'2099-01-01T00:00:00Z'},now),true);
 for(const changed of [{valid_until:now},{expired_at:now},{superseded_by:'3'}])assert.equal(activeFact({...row,...changed},now),false);
});
test('federated, delegated, prefix-bound, mismatched and read-only writes fail closed',()=>{
 const ctx={sourceId:'default',engine:{kind:'postgres'},auth:{sourceId:'default',scopes:['read']}};
 authorizeFacts(ctx);assert.throws(()=>authorizeFacts(ctx,true));
 for(const auth of [{allowedSources:['other']},{allowedSources:['default','other']},{boundSlugPrefixes:['p/']},
  {grantProjectionDegraded:true},{sourceId:'other'}])assert.throws(()=>authorizeFacts({...ctx,auth:{...ctx.auth,...auth}}));
 assert.throws(()=>authorizeFacts({...ctx,viaSubagent:true}));
});
test('automatic association never invents usable sources when page authorization fails',async()=>{
 const store={async authorize(){throw new Error('Denied');}};
 let calls=0;const result=await extractWithEvidence(store,{source_slug:'secret'},async()=>{calls++;return {fact_ids:[1],inserted:1};});
 assert.equal(calls,1);assert.equal(result.evidence_binding.linked,0);assert.equal(result.evidence_binding.status,'source_unavailable');
});
test('missing model is not reported as linked or extracted',async()=>{
 const result=await extractWithEvidence({async authorize(){}},{},async()=>({skipped:'extraction_unavailable',fact_ids:[]}));
 assert.equal(result.skipped,'extraction_unavailable');assert.equal(result.evidence_binding,undefined);
});
test('Agent facts remain opt-in, total combined JSON evidence stays bounded',async()=>{
 const calls=[],item={fact_id:'1',source_id:'default',fact:'bounded',native_active:true,evidence:{current:true,reviewed:true,source_uri:'ultra://default/project/a'}};
 const client={async callTool(p){calls.push(p);return wrap(p.name==='ultra_retrieve'?{items:[]}:
  {source_id:'default',facts:[item],memory_policy:'current',candidate_limit:100,candidates:1});}};
 const memory=new AgentMemory({client,rootUri:'ultra://default/project',sessionId:'s',factRecall:{grep:'bounded'},budgetBytes:2048});
 const result=await memory.beforeTurn('question');assert.equal(result.facts[0].fact,'bounded');assert.ok(result.combined_evidence_bytes<=2048);
 assert.equal(calls[1].arguments.grep,'bounded');assert.ok(calls[0].arguments.budget_bytes+calls[1].arguments.budget_bytes<2048);
 calls.length=0;await new AgentMemory({client,rootUri:'ultra://default/',sessionId:'s'}).beforeTurn('q');assert.equal(calls.length,1);
});
test('Agent rejects foreign origins, unlinked current facts and stale facts',async()=>{
 const original={fact_id:'1',source_id:'default',fact:'text',native_active:true,evidence:{current:true,source_uri:'ultra://default/a'}};
 for(const change of [{source_id:'other'},{evidence:{current:true,source_uri:'ultra://other/a'}},{evidence:{status:'unlinked'}},{native_active:false}]) {
  const client={async callTool(){return wrap({source_id:'default',facts:[{...original,...change}],memory_policy:'current'});}};
  await assert.rejects(new AgentMemory({client,rootUri:'ultra://default/',sessionId:'s'}).recallFacts());
 }
});
test('Agent disallows source overrides in constructor fact selection and undersized combined budget',()=>{
 const base={client:{callTool(){}},rootUri:'ultra://default/',sessionId:'s'};
 assert.throws(()=>new AgentMemory({...base,factRecall:{uri:'ultra://other/'}}));
 assert.throws(()=>new AgentMemory({...base,factRecall:{},budgetBytes:512}));
});
