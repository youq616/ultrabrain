/** Canonical single-record read; synthetic adapter checks, not PostgreSQL proof. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {PersonalMemoryStore,personalPrincipal} from '../src/personal-memory-store.mjs';
import {registerPersonalPlugin} from '../src/personal-plugin.mjs';
const id='11111111-1111-4111-8111-111111111111';
const record={id,content:'Synthetic memory',confidence:null,revision:2,status:'active'};
function fixture(rows=[record]){
 const calls=[];const engine={kind:'postgres',executeRaw:async()=>assert.fail('Read outside transaction'),transaction:async fn=>fn({executeRaw:async(sql,args)=>{calls.push({sql,args});return sql.startsWith('SELECT')?rows:[];}})};
 const ctx={engine,sourceId:'selected',remote:true,transport:'http',auth:{sourceId:'selected',scopes:['read'],principal:{kind:'oauth_client',id:'owner'}}};
 return {store:new PersonalMemoryStore(ctx),ctx,calls};
}
test('exact read uses source/principal/UUID parameters in a bounded read-only transaction',async()=>{
 const f=fixture(),r=await f.store.read({memory_id:id});
 assert.equal(r.source_id,'selected');assert.equal(r.memory.id,id);assert.equal(r.memory.confidence,null);assert.equal(r.read_only,true);
 assert.equal(r.trust,'untrusted-memory-data');assert.equal(f.calls.length,3);
 assert.match(f.calls[0].sql,/transaction_read_only=on/);assert.match(f.calls[1].sql,/statement_timeout='5s'/);
 const q=f.calls[2];assert.deepEqual(q.args,['selected',personalPrincipal(f.ctx),id]);
 assert.match(q.sql,/m\.source_id=\$1/);assert.match(q.sql,/m\.id=\$3::uuid/);assert.match(q.sql,/LIMIT 1/);
 assert.match(q.sql,/visibility='source'.*status='active'/s);assert.match(q.sql,/origin\.content_hash/);
 assert.ok(!q.sql.includes(id));assert.equal(Object.hasOwn(r.memory,'actor_key'),false);
});
for(const input of [{},{memory_id:'bad'},{memory_id:id.toUpperCase().replace('1','A')},{memory_id:id,source_id:'other'},
 {memory_id:id,actor_key:'chosen'},{memory_id:id,status:'any'},{memory_id:id,query:'%'},{memory_id:id,budget_bytes:512}])
 test('exact read rejects noncanonical arguments before SQL '+JSON.stringify(input),async()=>{
  const f=fixture();await assert.rejects(f.store.read(input),{code:'invalid_params'});assert.deepEqual(f.calls,[]);
 });
test('unavailable ID is not an empty success and discloses no existence reason',async()=>{
 const f=fixture([]);await assert.rejects(f.store.read({memory_id:id}),{code:'not_found'});
});
test('storage errors propagate instead of pretending the record is absent',async()=>{
 const f=fixture();f.store.engine.transaction=async()=>{throw Error('synthetic adapter outage');};
 await assert.rejects(f.store.read({memory_id:id}),/synthetic adapter outage/);
});
test('single read returns a complete large entry, not a trimmed search window',async()=>{
 const f=fixture([{...record,content:'\u0001'.repeat(65000)+' DO NOT DELETE'}]);
 const r=await f.store.read({memory_id:id});assert.equal(r.memory.content.length,65014);assert.ok(r.memory.content.endsWith('DO NOT DELETE'));
});
test('implausibly large stored record fails whole instead of returning partial content',async()=>{
 const f=fixture([{...record,content:'x'.repeat(1048576)}]);
 await assert.rejects(f.store.read({memory_id:id}),{code:'memory_read_too_large'});
});
test('exact read is a real read-only MCP handler with required memory_id',async()=>{
 class E extends Error{constructor(code,message){super(message);this.code=code;}}
 const ops=[];registerPersonalPlugin(ops,{OperationError:E});const op=ops.find(x=>x.name==='ultra_memory_read');assert.ok(op);
 assert.equal(op.scope,'read');assert.equal(op.mutating,false);assert.equal(op.params.memory_id.required,true);
 const f=fixture();assert.equal((await op.handler(f.ctx,{memory_id:id})).memory.id,id);
 await assert.rejects(op.handler(f.ctx,{memory_id:id,source_id:'foreign'}),{code:'invalid_params'});
});
