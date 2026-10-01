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

test('search binds optional time predicates before unchanged pagination and authorization',async()=>{
  const calls=[];
  const engine={kind:'postgres',executeRaw:async(q,p)=>{calls.push({q,p});return [];},transaction:()=>assert.fail('unexpected write/transaction')};
  const store=new PersonalMemoryStore({...base,engine});
  for(const input of [{},{updated_from:'2024-01-01T00:00:00.000001Z'},{updated_before:'2024-01-02T00:00:00Z'},
    {updated_from:'2024-01-01T00:00:00.000001Z',updated_before:'2024-01-02T00:00:00Z'}]){
    const result=await store.search({...input,limit:2,offset:3,query:'literal',status:'candidate',types:['goal'],project_id:'proj',agent_id:'label'});
    const {q,p}=calls.at(-1);
    assert.equal(p[0],'personal');assert.equal(p[1],personalPrincipal(base));assert.equal(p[2],'candidate');assert.deepEqual(p[3],['goal']);
    assert.deepEqual(p.slice(4,9),['proj','label','literal',2,3]);
    assert.deepEqual(p.slice(9),[input.updated_from??null,input.updated_before?'2024-01-02T00:00:00.000000Z':null]);
    assert.match(q,/source_id=\$1 AND \(actor_key=\$2 OR \(visibility='source' AND status='active'\)\)/);
    assert.match(q,/status!='active' OR actor_key=\$2 OR/);
    assert.match(q,/\$10::text IS NULL OR updated_at >= \$10::text::timestamptz/);
    assert.match(q,/\$11::text IS NULL OR updated_at < \$11::text::timestamptz/);
    assert.ok(q.indexOf('updated_at <')<q.indexOf('ORDER BY updated_at DESC,id LIMIT $8 OFFSET $9'));
    assert.ok(!q.includes('2024-'));assert.equal(result.coverage,'bounded live page, not a snapshot');assert.equal(result.next_offset,null);
  }
  assert.equal(calls.length,4);assert.ok(calls.every(x=>x.q===calls[0].q));
});
test('invalid time input and context/profile time fields fail before any SQL',async()=>{
  const store=new PersonalMemoryStore(base);
  for(const input of [null,[],{updated_from:null},{updated_before:42},{updated_from:'2024-01-01T00:00:00.1234567Z'},
    {updated_from:'2024-01-01T00:00:00Z',updated_before:'2024-01-01T00:00:00Z'}])
    await assert.rejects(store.search(input),{code:'invalid_params'});
  for(const method of ['context','profile'])for(const field of ['updated_from','updated_before'])
    await assert.rejects(store[method]({[field]:'2024-01-01T00:00:00Z'}),{code:'invalid_params'});
});


test('search keeps inherited and non-enumerable filters in bound SQL parameters',async()=>{
  const calls=[],engine={kind:'postgres',executeRaw:async(q,p)=>{calls.push(p);return [];},transaction:()=>assert.fail('unexpected transaction')};
  const store=new PersonalMemoryStore({...base,engine});
  const fields={query:'hidden query',status:'archived',limit:7};
  const inputs=[Object.create(fields),Object.defineProperties({},Object.fromEntries(Object.entries(fields).map(([key,value])=>[key,{value}])) )];
  for(const input of inputs){
    await store.search(input);const p=calls.at(-1);
    assert.equal(p[2],'archived');assert.equal(p[6],'hidden query');assert.equal(p[7],7);
    assert.deepEqual(p.slice(9),[null,null]);
    input.unknown=true;await assert.rejects(store.search(input),{code:'invalid_params'});
  }
  assert.equal(calls.length,2);
});
