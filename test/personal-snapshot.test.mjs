/** Real shared contract/store code on synthetic adapters; PostgreSQL/Chromium are separate. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {PersonalMemoryStore,personalPrincipal} from '../src/personal-memory-store.mjs';
import {SNAPSHOT_FORMAT,SNAPSHOT_SCOPE,SNAPSHOT_EXCLUDES,SNAPSHOT_MAX_BYTES,verifyMemorySnapshot} from '../src/personal-snapshot-contract.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
const id='11111111-1111-4111-8111-111111111111',time='2026-09-21T00:00:00.000Z';
const request=()=>({request_id:id,consent:true});
const row=(changes={})=>({id,type:'preference',origin_kind:'agent',content:'不要删除。\r\n🙂',content_hash:hash('不要删除。\r\n🙂'),
 confidence:null,importance:'normal',provenance:'Explicit synthetic test',agent_id:'fixture',project_id:null,status:'candidate',
 visibility:'private',revision:1,created_at:time,updated_at:time,last_confirmed:null,owned_by_caller:true,
 derivation:null,derivation_current:true,trust:'untrusted-memory-data',...changes});
const envelope=(memories=[row()])=>({format:SNAPSHOT_FORMAT,scope:SNAPSHOT_SCOPE,source_id:'selected',request_id:id,
 snapshot_at:time,read_only:true,complete:true,record_count:memories.length,excluded:[...SNAPSHOT_EXCLUDES],memories,
 memories_sha256:hash(JSON.stringify(memories))});
function fixture({rows=[row()],size,hook}={}){
 const calls=[];let transactions=0;
 const engine={kind:'postgres',executeRaw:async()=>assert.fail('no read outside transaction'),transaction:async fn=>{
  transactions++;return fn({executeRaw:async(sql,args)=>{
   calls.push({sql,args});await hook?.(sql);
   if(sql.includes('statement_timestamp()'))return [{snapshot_at:time}];
   if(sql.includes('count(*)'))return [size??{record_count:rows.length,byte_size:String(Buffer.byteLength(JSON.stringify(rows)))}];
   if(sql.startsWith('SELECT'))return rows;return [];
  }});
 }};
 const ctx={engine,sourceId:'selected',remote:true,transport:'http',auth:{sourceId:'selected',scopes:['read'],principal:{kind:'oauth_client',id:'owner'}}};
 return {ctx,store:new PersonalMemoryStore(ctx),calls,transactions:()=>transactions};
}
for(const status of ['candidate','active','archived'])test('snapshot includes complete owned '+status+' record',async()=>{
 const r=row({status}),f=fixture({rows:[r]});const result=await f.store.snapshot(request());
 assert.deepEqual(result,envelope([r]));assert.equal(f.transactions(),1);
 assert.equal(f.calls[0].sql,'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
 assert.match(f.calls[1].sql,/SET LOCAL statement_timeout/);assert.equal(f.calls.length,5);
 for(const q of [f.calls[3],f.calls[4]]){
  assert.deepEqual(q.args,['selected',personalPrincipal(f.ctx),1001]);
  assert.match(q.sql,/m\.source_id=\$1 AND m\.actor_key=\$2/);assert.ok(!q.sql.includes("visibility='source'"));
  assert.match(q.sql,/ORDER BY m.id LIMIT \$3/);
 }
});
test('empty owned scope is a complete explicit empty snapshot',async()=>{
 const f=fixture({rows:[]});assert.deepEqual(await f.store.snapshot(request()),envelope([]));
});
for(const input of [{},{request_id:id},{request_id:id,consent:false},{request_id:'bad',consent:true},
 {request_id:id,consent:true,source_id:'foreign'},{request_id:id,consent:true,actor_key:'chosen'},
 {request_id:id,consent:true,status:'active'},{request_id:id,consent:true,offset:0},{request_id:id,consent:'true'}])
 test('invalid/unconsented export never opens a database transaction '+JSON.stringify(input),async()=>{
  const f=fixture();await assert.rejects(f.store.snapshot(input));assert.equal(f.transactions(),0);
 });
for(const [name,size]of [['count',{record_count:1001,byte_size:'1'}],['bytes',{record_count:1,byte_size:String(SNAPSHOT_MAX_BYTES+1)}],
 ['invalid count',{record_count:NaN,byte_size:'1'}],['invalid size',{record_count:1,byte_size:'-1'}]])
 test('preflight rejects '+name+' without fetching any contents',async()=>{
  const f=fixture({size});await assert.rejects(f.store.snapshot(request()),{code:'memory_snapshot_too_large'});
  assert.equal(f.calls.length,4);
 });
test('mismatching preflight count fails whole',async()=>{
 const f=fixture({size:{record_count:0,byte_size:'0'}});await assert.rejects(f.store.snapshot(request()),{code:'memory_snapshot_unconfirmed'});
});
test('storage failure is not transformed into empty successful export',async()=>{
 const f=fixture();f.ctx.engine.transaction=async()=>{throw Error('synthetic database unavailable');};
 await assert.rejects(f.store.snapshot(request()),/synthetic database unavailable/);
});
for(const boundary of ['before','after'])test('changed authenticated principal is refused '+boundary+' SQL',async()=>{
 let f;f=fixture({hook:sql=>{if(boundary==='after'&&sql.includes('count(*)'))f.ctx.auth.principal.id='replacement';}});
 if(boundary==='before')f.ctx.auth.principal.id='replacement';
 await assert.rejects(f.store.snapshot(request()),{code:'permission_denied'});
 assert.equal(f.calls.length,boundary==='before'?0:4);
});
test('caller mutation after admission cannot change the request receipt binding',async()=>{
 const input=request(),f=fixture({hook:()=>{input.request_id='MUTATED';input.consent=false;}});
 const result=await f.store.snapshot(input);assert.equal(result.request_id,id);
});
test('numeric confidence and Date objects have a stable public JSON representation',async()=>{
 const f=fixture({rows:[row({confidence:'0.25',created_at:new Date(time),updated_at:new Date(time)})]});
 const r=await f.store.snapshot(request());assert.equal(r.memories[0].confidence,0.25);assert.equal(r.memories[0].created_at,time);
});
const corruptions=[['format',r=>r.format='other'],['scope',r=>r.scope='all-users'],['source',r=>r.source_id='other'],
 ['nonce',r=>r.request_id='22222222-2222-4222-8222-222222222222'],['partial',r=>r.complete=false],['read only',r=>r.read_only=false],
 ['count',r=>r.record_count++],['hash',r=>r.memories_sha256='a'.repeat(64)],['date',r=>r.snapshot_at='2026-02-30T00:00:00.000Z'],
 ['exclusions',r=>r.excluded=[]],['extra key',r=>r.token='SECRET'],['duplicate',r=>{r.memories.push(r.memories[0]);r.record_count++;}],
 ['other owner',r=>r.memories[0].owned_by_caller=false],['altered content',r=>r.memories[0].content='CHANGED'],
 ['internal owner key',r=>r.memories[0].actor_key='x'],['missing field',r=>delete r.memories[0].status],
 ['invalid revision',r=>r.memories[0].revision=0],['invalid confidence',r=>r.memories[0].confidence=2],
 ['invalid record date',r=>r.memories[0].updated_at='yesterday'],['extra array',r=>r.documents=[]]];
for(const [name,change]of corruptions)test('shared browser/server contract rejects '+name,async()=>{
 const r=envelope();change(r);await assert.rejects(verifyMemorySnapshot(r,request(),'selected',hash),{code:'memory_snapshot_unconfirmed'});
});
test('all payload entries, not a truncated subset, are included in the checksum',async()=>{
 const rows=[row(),row({id:'22222222-2222-4222-8222-222222222222',status:'archived'})],r=envelope(rows);
 await verifyMemorySnapshot(r,request(),'selected',hash);r.memories.reverse();r.memories_sha256=hash(JSON.stringify(r.memories));
 await assert.rejects(verifyMemorySnapshot(r,request(),'selected',hash),{code:'memory_snapshot_unconfirmed'});
});
test('content and payload hashing honor cancellation even when a digest completes late',async()=>{
 let cancelled=false;await assert.rejects(verifyMemorySnapshot(envelope(),request(),'selected',async s=>{cancelled=true;return hash(s);},
 ()=>{if(cancelled)throw Error('cancelled');}),/cancelled/);
});
test('JSON escaping can exceed response budget despite a small raw text budget',async()=>{
 const r=envelope(Array.from({length:23},(_,i)=>row({id:String(i).padStart(8,'0')+'-1111-4111-8111-111111111111',
  content:'\u0001'.repeat(65536),content_hash:hash('\u0001'.repeat(65536))})));
 assert.ok(Buffer.byteLength(JSON.stringify(r))>SNAPSHOT_MAX_BYTES);
 await assert.rejects(verifyMemorySnapshot(r,request(),'selected',hash),{code:'memory_snapshot_unconfirmed'});
 const f=fixture({rows:r.memories,size:{record_count:23,byte_size:'1'}});
 await assert.rejects(f.store.snapshot(request()),{code:'memory_snapshot_too_large'});
});

// Implementation audit: capacity edges, revocation and preservation of source evidence.
test('exactly 1000 complete small records are accepted without pagination',async()=>{
 const rows=Array.from({length:1000},(_,i)=>row({id:String(i).padStart(8,'0')+'-1111-4111-8111-111111111111'}));
 const f=fixture({rows}),r=await f.store.snapshot(request());assert.equal(r.record_count,1000);assert.equal(r.complete,true);
});
test('the shared verifier independently refuses a 1001-record success envelope',async()=>{
 const rows=Array.from({length:1001},(_,i)=>row({id:String(i).padStart(8,'0')+'-1111-4111-8111-111111111111'}));
 await assert.rejects(verifyMemorySnapshot(envelope(rows),request(),'selected',hash),{code:'memory_snapshot_unconfirmed'});
});
test('revoked read permission is rechecked before retrieving content rows',async()=>{
 let f;f=fixture({hook:sql=>{if(sql.includes('count(*)'))f.ctx.auth.scopes=[];}});
 await assert.rejects(f.store.snapshot(request()),{code:'permission_denied'});assert.equal(f.calls.length,4);
});
test('malformed negative preflight count cannot initiate the content read',async()=>{
 const f=fixture({size:{record_count:-1,byte_size:'0'}});
 await assert.rejects(f.store.snapshot(request()),{code:'memory_snapshot_too_large'});assert.equal(f.calls.length,4);
});
test('snapshot preserves historical derivation and inactive rows without activating or rewriting them',async()=>{
 const r=row({status:'archived',derivation_current:false,derivation:{input_id:id,input_revision:1,quote:'不要删除。'}});
 const f=fixture({rows:[r]});assert.deepEqual((await f.store.snapshot(request())).memories[0],r);
 assert.ok(f.calls.every(q=>q.sql.startsWith('SET ')||q.sql.startsWith('SELECT ')));
});
test('snapshot integration is additive and runs after every accepted recovery stage',async()=>{
 const {readFileSync}=await import('node:fs');
 const w=readFileSync(new URL('../.github/workflows/personal-recall-preview.yml',import.meta.url),'utf8');
 const start=w.indexOf('run: bun test/personal-snapshot-integration.mjs');assert.ok(start>0);
 for(const task of ['personal-recall-browser-fixture','personal-document-module-integration','personal-job-manager-integration','personal-job-recovery-integration','personal-job-recovery-barrier-integration'])
  assert.ok(w.indexOf('run: bun test/'+task+'.mjs')>=0&&w.indexOf('run: bun test/'+task+'.mjs')<start);
 assert.ok(w.indexOf('name: personal-recall-preview-${{ github.sha }}')>start);
 const portability=readFileSync(new URL('../.github/workflows/client-portability.yml',import.meta.url),'utf8');
 for(const file of ['personal-snapshot.test','personal-snapshot-browser.test','personal-document-module.test','personal-document-read.test','personal-job-recovery-barrier.test','personal-job-recovery.test'])
  assert.ok(portability.includes('test/'+file+'.mjs'));
 assert.ok(portability.includes('windows-2025')&&portability.includes('ubuntu-24.04'));
});

// Resumed module audit: permission must still hold after data was fetched;
// serialization is a faithful logical export, not an automatic redaction service.
test('permission revoked after content retrieval prevents returning the snapshot',async()=>{
 let f;f=fixture({hook:sql=>{if(sql.startsWith('SELECT id::text'))f.ctx.auth.scopes=[];}});
 await assert.rejects(f.store.snapshot(request()),{code:'permission_denied'});
 assert.equal(f.calls.length,5);
});
for(const content of ['\ufeff原文字节\r\n🙂','\0','SYNTHETIC_PRIVATE_MARKER_NOT_A_CREDENTIAL'])test('snapshot preserves exact stored text '+JSON.stringify(content),async()=>{
 const r=row({content,content_hash:hash(content),origin_kind:'document_fragment'}),f=fixture({rows:[r]});
 const result=await f.store.snapshot(request());assert.equal(result.memories[0].content,content);
 assert.equal(result.memories[0].content_hash,hash(content));
});
