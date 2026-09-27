/** Metadata-only candidate pages, synthetic DB and canonical contract boundaries. */
import test from 'node:test';import assert from 'node:assert/strict';
import {PersonalCandidates,PERSONAL_CANDIDATES_SQL} from '../src/personal-candidates.mjs';
import {candidatePageRequest,verifyCandidatePage} from '../src/personal-candidates-contract.mjs';
import {row,uuid} from './helpers/snapshot-audit-fixture.mjs';
const meta=n=>{const r=row(n);return Object.fromEntries(['id','type','agent_id','project_id','importance','confidence','visibility','revision','content_hash','status','origin_kind','created_at','updated_at','derivation_current'].map(k=>[k,r[k]]));};
const request=(extra={})=>({request_id:uuid(99),limit:2,...extra});
function fixture(items=[meta(1),meta(2),meta(3)]){
 const calls=[],ctx={sourceId:'selected',remote:false,transport:'stdio'};
 ctx.engine={kind:'postgres',executeRaw:()=>assert.fail('Transaction required'),transaction:async fn=>fn({executeRaw:async(sql,args)=>{
  calls.push({sql,args});return sql===PERSONAL_CANDIDATES_SQL?[{memories:items,observed_at:'2026-09-27T00:00:00.000Z'}]:[];
 }})};return {ctx,calls,store:new PersonalCandidates(ctx)};
}
test('candidates: owned metadata page retains continuation sentinel but returns limit rows',async()=>{
 const f=fixture(),r=await f.store.list(request());assert.equal(r.memories.length,2);assert.equal(r.has_more,true);assert.equal(r.next_after,uuid(2));
 assert.ok(Object.isFrozen(r.memories[0]));assert.equal(r.read_only,true);assert.equal(r.snapshot,false);
 assert.ok(!JSON.stringify(r).includes('provenance'));assert.deepEqual(f.calls.at(-1).args,['selected',f.store.actor,null,null,3]);
 assert.match(f.calls[0].sql,/read_only/);assert.match(PERSONAL_CANDIDATES_SQL,/actor_key=\$2/);
 assert.ok(!/\b(?:content|source AS provenance)\b/.test(PERSONAL_CANDIDATES_SQL));
});
test('candidates: an empty terminal page is explicit, not a truncated failure',async()=>{
 const r=await fixture([]).store.list(request({after_id:uuid(5)}));assert.equal(r.has_more,false);assert.equal(r.next_after,null);assert.equal(r.returned,0);
});
test('candidates: exact-full terminal page has no invented next cursor',async()=>{
 const r=await fixture([meta(1),meta(2)]).store.list(request());assert.equal(r.has_more,false);assert.equal(r.next_after,null);
});
for(const change of [{limit:0},{limit:51},{limit:1.5},{limit:'20'},{after_id:''},{project_id:'../x'},{request_id:'short'},{status:'active'},{include_text:true},{project_id:null}])
 test('candidates: invalid selector rejected before DB '+JSON.stringify(change),async()=>{
  const f=fixture();await assert.rejects(f.store.list(request(change)),{code:'invalid_params'});assert.equal(f.calls.length,0);
 });
test('candidates: request descriptor accessor is not run',()=>{
 let count=0;const r=request();Object.defineProperty(r,'project_id',{enumerable:true,get(){count++;return 'x';}});
 assert.throws(()=>candidatePageRequest(r));assert.equal(count,0);
});
for(const mutate of [m=>m.status='active',m=>m.origin_kind='document_fragment',m=>m.project_id='foreign',m=>m.id=uuid(0),m=>m.content='PRIVATE',m=>m.revision=0])
 test('candidates: corrupt page member withheld as a whole',async()=>{
  const rows=[meta(1),meta(2)],f=fixture(rows);mutate(rows[1]);await assert.rejects(f.store.list(request({after_id:uuid(0)})),{code:'personal_candidates_unconfirmed'});
 });
test('candidates: wrong-source response and arbitrary continuation rejected',async()=>{
 const r=await fixture().store.list(request());
 for(const patch of [{source_id:'foreign'},{request_id:uuid(98)},{next_after:uuid(99)},{has_more:false},{returned:0},{limit:3},{after_id:uuid(1)}])
  assert.throws(()=>verifyCandidatePage({...r,...patch},request(),'selected'));
});
test('candidates: duplicate and unsorted IDs are not valid keyset pages',async()=>{
 for(const rows of [[meta(1),meta(1)],[meta(2),meta(1)]])await assert.rejects(fixture(rows).store.list(request()));
});
test('candidates: global plus specified project, never an all-project default',async()=>{
 const m=meta(2);m.project_id='mine';const f=fixture([meta(1),m]);const r=await f.store.list(request({project_id:'mine'}));
 assert.equal(r.project_id,'mine');assert.equal(f.calls.at(-1).args[2],'mine');assert.match(PERSONAL_CANDIDATES_SQL,/project_id IS NULL OR m.project_id=\$3/);
});
test('candidates: authority changed during query does not deliver metadata',async()=>{
 const f=fixture();const original=f.ctx.engine.transaction;f.ctx.engine.transaction=async fn=>{const r=await original(fn);f.ctx.sourceId='other';return r;};
 await assert.rejects(f.store.list(request()),{code:'permission_denied'});
});
test('candidates: SQL failures are errors, not a successful empty list',async()=>{
 const f=fixture();f.ctx.engine.transaction=async()=>{throw Error('synthetic DB unavailable');};await assert.rejects(f.store.list(request()));
});
