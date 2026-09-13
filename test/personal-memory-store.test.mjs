import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeMemory,PersonalMemoryStore,personalPrincipal} from '../src/personal-memory-store.mjs';
import {normalizePersonalMemory} from '../src/personal-memory.mjs';
const base={sourceId:'personal',remote:true,transport:'http',engine:{kind:'postgres',executeRaw(){assert.fail('SQL before identity');},transaction(){assert.fail('transaction before identity');}},
  auth:{sourceId:'personal',scopes:['read','write'],principal:{kind:'oauth_client',id:'codex-owner'}}};
test('one memory normalizer is shared with the store; null confidence remains unknown',()=>{
  assert.strictEqual(normalizeMemory,normalizePersonalMemory);
  const m=normalizeMemory({type:'preference',content:'User prefers CLI workflows'});
  assert.equal(m.confidence,null);assert.equal(m.visibility,'private');assert.equal(m.importance,'normal');
  assert.match(m.content_hash,/^[a-f0-9]{64}$/);assert.ok(!Object.hasOwn(m,'status'));
});
test('unknown types, coerced confidence and injected identity/status are rejected',()=>{
  const valid={type:'preference',content:'CLI'};
  for(const p of [{type:'unknown'},{confidence:2},{confidence:NaN},{confidence:'0.9'},{confidence:Infinity},{importance:.5},
    {status:'active'},{id:'chosen-id'},{source_id:'other'},{agent_id:'impersonate'},{actor_key:'x'}])assert.throws(()=>normalizeMemory({...valid,...p}));
});
test('unauthenticated, delegated, mismatched, federated and degraded grants fail before SQL',()=>{
  for(const p of [{auth:null},{sourceId:'other'},{viaSubagent:true},{auth:{...base.auth,boundSlugPrefixes:['x/']}},
    {auth:{...base.auth,grantProjectionDegraded:true}},{auth:{...base.auth,hasSourceGrant:false}},
    {auth:{...base.auth,allowedSources:['personal','other']}},{localFederatedSourceIds:['personal','other']}])
    assert.throws(()=>new PersonalMemoryStore({...base,...p}));
});
test('changing caller agent labels cannot change authentication; different principals have different keys',()=>{
  const key=personalPrincipal(base);assert.equal(personalPrincipal({...base,agent_id:'attacker'}),key);
  assert.notEqual(personalPrincipal({...base,auth:{...base.auth,principal:{kind:'oauth_client',id:'other'}}}),key);
  assert.equal(personalPrincipal({...base,auth:{...base.auth,token:'rotated'}}),key);
});
test('write scope is required even when bypassing MCP dispatch in host tests',async()=>{
  const store=new PersonalMemoryStore({...base,auth:{...base.auth,scopes:['read']}});
  await assert.rejects(store.register({agent_id:'codex'}),{code:'permission_denied'});
  await assert.rejects(store.commit({agent_id:'codex',event_id:'e',consent:true,summary:'record'}),{code:'permission_denied'});
});
