/** Offline public byte entry. Real parser/hashes; synthetic exported data. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as turn} from 'node:timers/promises';
import {inspectClientSnapshotBytes,snapshotRequest} from '../src/client-snapshot.mjs';
import {SNAPSHOT_FILE_MAX_BYTES} from '../src/personal-snapshot-contract.mjs';
import {encoded,envelope,row,uuid,hash} from './helpers/snapshot-audit-fixture.mjs';
const privateRow = () => row(1,{content:'PRIVATE_BODY 🙂\r\n不要用 Docker Hub',provenance:'PRIVATE_PROVENANCE',
  derivation:{quote:'PRIVATE_QUOTE',nested:{instructions:'PRIVATE_INSTRUCTION'}}});
const file = () => ({data:encoded(envelope([privateRow(),row(2,{status:'active',project_id:'one'})]))});
const request = (operation='inspect',extra={}) => ({operation,consent:true,...extra});
const run = (op='inspect',extra={},inputs=[file()],options={}) => inspectClientSnapshotBytes(request(op,extra),inputs,options);
const noText = result => {
  for (const secret of ['PRIVATE_BODY','PRIVATE_PROVENANCE','PRIVATE_QUOTE','PRIVATE_INSTRUCTION'])
    assert.ok(!JSON.stringify(result).includes(secret),secret);
};
test('offline snapshot: inspect verifies complete files and emits counts without text',async()=>{
  const f=file(),r=await run('inspect',{},[f]);
  assert.equal(r.format,'ultrabrain-client-snapshot-v1');assert.equal(r.operation,'inspect');
  assert.deepEqual(r.result.states,{candidate:1,active:1,archived:0});assert.equal(r.result.record_count,2);
  assert.equal(r.files[0].file_sha256,hash(f.data));assert.equal(r.files[0].expected_hash_verified,false);
  assert.equal(r.local_only,true);assert.equal(r.read_only,true);assert.equal(r.identity_verified,false);
  assert.equal(r.truth_verified,false);assert.equal(r.network_requests,0);assert.equal(r.memory_writes_requested,false);
  assert.equal(r.trust,'untrusted-memory-data');noText(r);
});
test('offline snapshot: pinned file bytes are verified including BOM and trailing whitespace',async()=>{
  const data=Buffer.concat([Buffer.from('\ufeff'),Buffer.from(file().data),Buffer.from('\n ')]);
  const r=await run('inspect',{},[{data,expected_sha256:hash(data)}]);
  assert.equal(r.files[0].expected_hash_verified,true);assert.equal(r.files[0].file_sha256,hash(data));
  await assert.rejects(run('inspect',{},[{data,expected_sha256:hash(file().data)}]),{code:'snapshot_hash_mismatch'});
});
test('offline snapshot: compare metadata includes all states and projects without deletion inference',async()=>{
  const a={data:encoded(envelope([privateRow(),row(2),row(3)]))};
  const b={data:encoded(envelope([privateRow(),row(3,{status:'archived',revision:2}),row(4)]))};
  const r=await run('compare',{},[a,b]);
  assert.deepEqual(r.result.counts,{left_only:1,right_only:1,changed:1,unchanged:1});
  assert.deepEqual(r.result.differences[1],{id:uuid(3),kind:'changed',fields:['revision','status']});
  assert.ok(r.limitations.includes('absence-is-not-deletion'));noText(r);
});
test('offline snapshot: object key order is ignored while array order remains meaningful',async()=>{
  const pair=(a,b)=>[a,b].map(derivation=>({data:encoded(envelope([row(1,{derivation})]))}));
  assert.equal((await run('compare',{},pair({a:1,b:2},{b:2,a:1}))).result.counts.unchanged,1);
  assert.equal((await run('compare',{},pair({a:[1,2]},{a:[2,1]}))).result.counts.changed,1);
});
test('offline snapshot: page uses canonical literal filters and never echoes the query',async()=>{
  const r=await run('page',{options:{query:'PRIVATE_BODY',project_scope:'global'}});
  assert.deepEqual(r.result.rows.map(r=>r.id),[uuid(1)]);assert.equal(r.result.matched_count,1);noText(r);
});
test('offline snapshot: complete pagination, fixed page size and last-page rejection',async()=>{
  const f={data:encoded(envelope(Array.from({length:43},(_,i)=>row(i))))};let seen=[];
  for(const offset of [0,20,40]){const r=await run('page',{options:{offset}},[f]);seen.push(...r.result.rows.map(x=>x.id));}
  assert.equal(new Set(seen).size,43);
  await assert.rejects(run('page',{options:{offset:60}},[f]),{code:'snapshot_page_out_of_range'});
});
test('offline snapshot: exact record defaults to metadata; explicit text retains full original values',async()=>{
  const safe=await run('record',{memory_id:uuid(1)});assert.equal(safe.result.text_included,false);noText(safe);
  const r=await run('record',{memory_id:uuid(1),include_text:true});
  assert.deepEqual(r.result.text,{content:privateRow().content,provenance:privateRow().provenance,derivation:privateRow().derivation});
  assert.ok(Object.isFrozen(r)&&Object.isFrozen(r.files)&&Object.isFrozen(r.result.text.derivation.nested));
});
test('offline snapshot: missing ID and different sources are errors rather than fallback data',async()=>{
  await assert.rejects(run('record',{memory_id:uuid(9)}),{code:'snapshot_record_missing'});
  await assert.rejects(run('compare',{},[file(),{data:encoded(envelope([],{source_id:'other'}))}]),{code:'snapshot_source_mismatch'});
});
for(const bad of [null,[],{}, {operation:'constructor',consent:true},{operation:'__proto__',consent:true},
  request('inspect',{extra:true}),request('inspect',{include_text:false}),request('compare',{options:{}}),
  request('record',{memory_id:'bad'}),request('record',{memory_id:uuid(1),include_text:'true'}),
  request('page',{options:{offset:1}}),request('page',{options:{query:'\0'}}),request('page',{options:null})])
  test('offline snapshot: strict request rejects '+JSON.stringify(bad),async()=>{
    await assert.rejects(inspectClientSnapshotBytes(bad,[file()]));
  });
for(const consent of [undefined,false,1,'true',null])test('offline snapshot: exact consent required '+String(consent),async()=>{
  await assert.rejects(inspectClientSnapshotBytes({operation:'inspect',consent},[file()]),{code:'snapshot_consent_required'});
});
for(const inputs of [[],[file(),file()],null,[{}],[{data:new DataView(new ArrayBuffer(16))}],
  [{data:new SharedArrayBuffer(16)}],[{data:new Uint8Array(new SharedArrayBuffer(16))}],
  [{data:encoded(),extra:true}],[{data:encoded(),expected_sha256:'WRONG'}]])
  test('offline snapshot: invalid inputs are rejected '+String(inputs?.length),async()=>{
    await assert.rejects(inspectClientSnapshotBytes(request(),inputs));
  });
test('offline snapshot: request and BOTH input buffers are copied before first async wait',async()=>{
  const a=file(),b=file(),q=request('compare');const work=inspectClientSnapshotBytes(q,[a,b]);
  a.data.fill(0);b.data.fill(0);q.operation='record';q.include_text=true;q.memory_id=uuid(1);
  const r=await work;assert.equal(r.operation,'compare');assert.equal(r.result.counts.unchanged,2);noText(r);
});
test('offline snapshot: buffer slice boundaries are honored and caller memory is not frozen',async()=>{
  const data=file().data,wrapped=Buffer.concat([Buffer.from('prefix'),data,Buffer.from('suffix')]);
  const f={data:wrapped.subarray(6,6+data.length)};const r=await run('inspect',{},[f]);
  assert.equal(r.files[0].file_sha256,hash(data));assert.ok(!Object.isFrozen(f));
});
for(const mode of ['revoke','abort'])test('offline snapshot: real event-loop '+mode+' interrupts digest delivery',async()=>{
  const controller=new AbortController();let allow=true;
  const work=run('record',{memory_id:uuid(1),include_text:true},[file()],{signal:controller.signal,authorize:()=>allow});
  if(mode==='abort')controller.abort();else allow=false;
  await assert.rejects(work,{code:mode==='abort'?'aborted':'client_authorization_revoked'});await turn();
});
for(const authorize of [()=>false,async()=>true,async()=>{throw Error('PRIVATE_AUTH_ERROR');}])
  test('offline snapshot: false or asynchronous authority is not accepted',async()=>{
    await assert.rejects(run('inspect',{},[file()],{authorize}));
  });
test('offline snapshot: unexpected authority errors are sanitized',async()=>{
  await assert.rejects(run('inspect',{},[file()],{authorize:()=>{throw Error('PRIVATE_PATH /tmp/token');}}),
    e=>e.code==='snapshot_operation_unconfirmed'&&!e.message.includes('PRIVATE')&&!e.message.includes('/tmp'));
});
for(const [name,data,code] of [
  ['duplicate',Buffer.from('{"x":1,"\\u0078":2}'),'snapshot_file_duplicate_key'],
  ['parse fragment',Buffer.from('{"PRIVATE_JSON_BODY": '),'snapshot_file_invalid_json'],
  ['utf8',new Uint8Array([0xc3,0x28]),'snapshot_file_invalid_utf8'],
  ['empty',new Uint8Array(),'snapshot_file_size'],
  ['oversize',new Uint8Array(SNAPSHOT_FILE_MAX_BYTES+1),'snapshot_file_size'],
  ['depth',Buffer.from('['.repeat(33)+'0'+']'.repeat(33)),'snapshot_file_too_deep'],
])test('offline snapshot: bounded validation '+name,async()=>{
  await assert.rejects(run('inspect',{},[{data}]),e=>e.code===code&&!e.message.includes('PRIVATE'));
});
test('offline snapshot: altered body, partial export, forged count and digest are rejected',async()=>{
  for(const patch of [{complete:false},{record_count:999},{memories_sha256:'0'.repeat(64)},
    {memories:[{...privateRow(),content:'changed'}]}]){
    await assert.rejects(run('inspect',{},[{data:encoded(envelope([privateRow()],patch))}]),{code:'memory_snapshot_unconfirmed'});
  }
});
test('offline snapshot: empty complete snapshot and identical snapshots are valid',async()=>{
  const empty={data:encoded(envelope([]))};assert.equal((await run('inspect',{},[empty])).result.record_count,0);
  assert.deepEqual((await run('compare',{},[empty,empty])).result.counts,{left_only:0,right_only:0,changed:0,unchanged:0});
});
test('offline snapshot: operation must be a primitive string, not a coercible selector',()=>{
  for(const operation of [['inspect'],['page'],new String('inspect')])
    assert.throws(()=>snapshotRequest({operation,consent:true}),{code:'invalid_params'});
});
