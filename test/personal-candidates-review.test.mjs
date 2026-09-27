/** Separate implementer adversarial pass, not an independent reviewer agent. */
import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {candidateData,candidatePageRequest,verifyCandidatePage,CANDIDATES_FORMAT,CANDIDATES_SCOPE} from '../src/personal-candidates-contract.mjs';
import {candidatesFailure,deliverCandidates} from '../src/client-candidates.mjs';
import {registerPersonalPlugin,PERSONAL_TOOL_NAMES} from '../src/personal-plugin.mjs';
import {row,uuid} from './helpers/snapshot-audit-fixture.mjs';
const request={request_id:uuid(99),limit:1};
const r=row(1);const member=Object.fromEntries(['id','type','agent_id','project_id','importance','confidence','visibility','revision','content_hash','status','origin_kind','created_at','updated_at','derivation_current'].map(k=>[k,r[k]]));
const page=()=>({format:CANDIDATES_FORMAT,scope:CANDIDATES_SCOPE,source_id:'selected',request_id:request.request_id,project_id:null,after_id:null,
 limit:1,observed_at:'2026-09-27T00:00:00.000Z',memories:[{...member}],returned:1,has_more:false,next_after:null,read_only:true,
 model_calls:0,trust:'untrusted-memory-metadata',snapshot:false});
for(const where of ['outer','row','array'])test('candidate review: getters refused without execution '+where,()=>{
 const p=page();let n=0;const [v,key]=where==='outer'?[p,'source_id']:where==='row'?[p.memories[0],'id']:[p.memories,'0'];
 Object.defineProperty(v,key,{enumerable:true,get(){n++;throw Error('PRIVATE');}});
 assert.throws(()=>verifyCandidatePage(p,request,'selected'));assert.equal(n,0);
});
for(const key of ['hidden',Symbol('hidden')])test('candidate review: hidden/Symbol extras refused on every boundary',()=>{
 for(const [make,verify] of [[()=>({...request}),v=>candidatePageRequest(v)],[page,v=>verifyCandidatePage(v,request,'selected')]]){
  const v=make();Object.defineProperty(v,key,{value:'PRIVATE'});assert.throws(()=>verify(v));
 }
 const p=page();Object.defineProperty(p.memories,key,{value:'PRIVATE'});assert.throws(()=>verifyCandidatePage(p,request,'selected'));
});
test('candidate review: sparse array and fake too-large array rejected before iterating',()=>{
 for(const a of [Array(1),Array(1000000)])assert.throws(()=>verifyCandidatePage({...page(),memories:a},request,'selected'));
});
test('candidate review: synthetic metadata marker never becomes a false empty list',()=>{
 for(const change of [{memories:[],returned:0,has_more:true,next_after:uuid(1)},
  {memories:[member,member],returned:2},{scope:'all-records'},{model_calls:1},{snapshot:true},{read_only:false}])
  assert.throws(()=>verifyCandidatePage({...page(),...change},request,'selected'));
});
test('candidate review: exact ISO dates not Date.parse normalization',()=>{
 const p=page();p.memories[0].updated_at='2026-02-30T00:00:00.000Z';assert.throws(()=>verifyCandidatePage(p,request,'selected'));
});
test('candidate review: stale derivations stay in list but cannot imply activation authority',()=>{
 const p=page();p.memories[0].derivation_current=false;assert.equal(verifyCandidatePage(p,request,'selected').memories[0].derivation_current,false);
});
test('candidate review: exception getters and revoked proxies are sanitized',()=>{
 let n=0;const p=Proxy.revocable({},{});p.revoke();for(const e of [{get code(){n++;throw Error('PRIVATE');}},p.proxy])
  assert.equal(candidatesFailure(e).read_delivery,'not_started');assert.equal(n,0);
});
test('candidate review: plugin is additive read-only and never configures a model',async()=>{
 class E extends Error{constructor(code,msg){super(msg);this.code=code;}}
 const ops=[];registerPersonalPlugin(ops,{OperationError:E},()=>assert.fail('No model'));
 const op=ops.find(o=>o.name==='ultra_personal_candidates');assert.equal(op.scope,'read');assert.equal(op.mutating,false);
 assert.equal(ops.length,PERSONAL_TOOL_NAMES.length);assert.ok(ops.some(o=>o.name==='ultra_personal_review'));
 await assert.rejects(op.handler({sourceId:'selected',remote:false,transport:'stdio',engine:{kind:'postgres',transaction:()=>assert.fail('No query')}},{request_id:'bad'}),{code:'invalid_params'});
});
test('candidate review: package, runtime and cross-platform wiring are explicit',()=>{
 const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
 assert.equal(JSON.parse(read('packages/ultrabrain-client/package.json')).bin['ultrabrain-candidates'],'dist/candidates-cli.cjs');
 for(const f of ['candidates.cjs','candidates-cli.cjs'])assert.ok(read('scripts/build-client.mjs').includes(f)&&read('scripts/package-client.sh').includes(f));
 const flow=read('.github/workflows/client-portability.yml');assert.ok(flow.includes('test/personal-candidates-review.test.mjs'));
 assert.ok(flow.includes('windows-2025')&&flow.includes('ubuntu-24.04'));
 const ci=read('.github/workflows/task-context.yml');assert.ok(ci.indexOf('run: bun test/client-candidates-integration.mjs')>ci.indexOf('npm install --prefix'));
});
for(const place of ['observed_at','memories','aggregate'])test('candidate review: adapter aggregate accessors cannot execute before canonical verification '+place,async()=>{
 const {PersonalCandidates}=await import('../src/personal-candidates.mjs');let n=0;
 const aggregate={observed_at:'2026-09-27T00:00:00.000Z',memories:[member]},rows=[aggregate];
 Object.defineProperty(place==='aggregate'?rows:aggregate,place==='aggregate'?'0':place,{enumerable:true,get(){n++;return place==='aggregate'?aggregate:place==='memories'?[member]:'2026-09-27T00:00:00.000Z';}});
 const ctx={sourceId:'selected',remote:false,transport:'stdio',engine:{kind:'postgres',transaction:async fn=>fn({executeRaw:async sql=>sql.startsWith('WITH page')?rows:[]})}};
 await assert.rejects(new PersonalCandidates(ctx).list(request),{code:'personal_candidates_unconfirmed'});assert.equal(n,0);
});
