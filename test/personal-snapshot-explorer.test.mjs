/** Local snapshot record browser; no IO, server authority or model fixtures. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as contract from '../src/personal-snapshot-contract.mjs';
import {hash,uuid,row,envelope,encoded} from './helpers/snapshot-audit-fixture.mjs';
const inspect=async(rows=[row()])=>contract.inspectMemorySnapshotFile(encoded(envelope(rows)),hash);
const query=(file,options={})=>contract.queryMemorySnapshot(file,options);
const dataset=()=>[row(1,{status:'candidate',type:'preference',project_id:null,importance:'low',content:'不要删除 Alpha %_*[] 🙂'}),
 row(2,{status:'active',type:'goal',project_id:'project-a',importance:'high',agent_id:'second',content:'不要删除 alpha %_*[] 🙂'}),
 row(3,{status:'archived',type:'environment',project_id:'project-b',origin_kind:'document_fragment',content:'UNIQUE_BODY_ONLY',provenance:'UNIQUE_PROVENANCE_ONLY'})];
test('snapshot browser: single verified file browses every state and project without body disclosure',async()=>{
 const f=await inspect(dataset()),p=query(f);
 assert.equal(p.record_count,3);assert.equal(p.matched_count,3);assert.equal(p.offset,0);assert.equal(p.next_offset,null);
 assert.equal(p.previous_offset,null);assert.equal(p.read_only,true);assert.equal(p.identity_verified,false);
 assert.deepEqual(p.rows.map(r=>r.id),[uuid(1),uuid(2),uuid(3)]);
 for(const secret of ['UNIQUE_BODY_ONLY','UNIQUE_PROVENANCE_ONLY','content_hash','derivation'])assert.ok(!JSON.stringify(p).includes(secret));
 assert.ok(Object.isFrozen(p)&&Object.isFrozen(p.rows)&&Object.isFrozen(p.rows[0]));
});
for(const [options,ids] of [
 [{status:'active'},[2]],[{status:'candidate'},[1]],[{status:'archived'},[3]],
 [{type:'goal'},[2]],[{type:'unknown_valid_type'},[]],[{importance:'high'},[2]],
 [{origin_kind:'document_fragment'},[3]],[{origin_kind:'agent'},[1,2]],
 [{agent_id:'second'},[2]],[{agent_id:'missing'},[]],
 [{project_scope:'global'},[1]],[{project_scope:'exact',project_id:'project-a'},[2]],
 [{project_scope:'exact',project_id:'none'},[]],[{query:'Alpha'},[1]],[{query:'alpha'},[2]],
 [{query:'%_*[] 🙂'},[1,2]],[{query:'UNIQUE_PROVENANCE_ONLY'},[]],
 [{query:'不要删除',status:'active',type:'goal',importance:'high',origin_kind:'agent',agent_id:'second',project_scope:'exact',project_id:'project-a'},[2]],
 [{status:'archived',project_scope:'global'},[]]
])test('snapshot browser: AND literal/exact filter '+JSON.stringify(options),async()=>{
 assert.deepEqual(query(await inspect(dataset()),options).rows.map(r=>r.id),ids.map(uuid));
});
test('snapshot browser: valid Unicode, whitespace and regular-expression characters stay literal',async()=>{
 const f=await inspect([row(1,{content:' a\r\n🙂%_.* [x] '}),row(2,{content:'a b'})]);
 for(const text of [' a','\r\n🙂','%_.* [x]',' '])assert.ok(query(f,{query:text}).rows.some(r=>r.id===uuid(1)));
 assert.equal(query(f,{query:'^a'}).matched_count,0);assert.equal(query(f,{query:'a\\s+b'}).matched_count,0);
});
test('snapshot browser: stable sorting uses ID tie-break, does not mutate the verified array',async()=>{
 const f=await inspect([row(1,{importance:'low',updated_at:'2026-09-20T00:00:00.000Z'}),row(2,{importance:'high'}),row(3,{importance:'high',created_at:'2026-09-20T00:00:00.000Z'})]);
 assert.deepEqual(query(f,{sort:'importance_desc'}).rows.map(r=>r.id),[2,3,1].map(uuid));
 assert.deepEqual(query(f,{sort:'updated_desc'}).rows.map(r=>r.id),[2,3,1].map(uuid));
 assert.deepEqual(query(f,{sort:'created_desc'}).rows.map(r=>r.id),[1,2,3].map(uuid));
 assert.deepEqual(f.snapshot.memories.map(r=>r.id),[1,2,3].map(uuid));
});
test('snapshot browser: all 1000 rows are reachable exactly once through fixed pages',async()=>{
 const f=await inspect(Array.from({length:1000},(_,i)=>row(i)));const ids=[];
 for(let offset=0;offset<1000;offset+=20){
  const p=query(f,{offset});assert.equal(p.rows.length,20);assert.equal(p.page_size,20);assert.equal(p.matched_count,1000);
  assert.equal(p.previous_offset,offset?offset-20:null);assert.equal(p.next_offset,offset<980?offset+20:null);ids.push(...p.rows.map(r=>r.id));
 }
 assert.equal(new Set(ids).size,1000);assert.deepEqual(ids,f.snapshot.memories.map(r=>r.id));
 assert.throws(()=>query(f,{offset:1000}),/snapshot_page_out_of_range/);
});
test('snapshot browser: zero results and exact final page are honest counts',async()=>{
 const f=await inspect(Array.from({length:23},(_,i)=>row(i)));
 assert.equal(query(f,{offset:20}).rows.length,3);assert.equal(query(f,{offset:20}).next_offset,null);
 assert.equal(query(f,{query:'not present'}).matched_count,0);
 assert.equal(query(await inspect([])).rows.length,0);
 assert.throws(()=>query(f,{query:'not present',offset:20}),/snapshot_page_out_of_range/);
});
for(const bad of [null,[],42,{extra:true},{status:'all'},{type:'x-y'},{type:'x'.repeat(33)},
 {importance:'urgent'},{origin_kind:'pdf'},{project_scope:'default'},{project_scope:'exact'},
 {project_id:'x'},{project_scope:'global',project_id:'x'},{project_scope:'exact',project_id:'../x'},
 {agent_id:'x/y'},{agent_id:'x'.repeat(97)},{query:'x\0'},{query:'\ud800'},
 {query:'中'.repeat(1366)},{query:12},{sort:'__proto__'},{sort:'constructor'},
 {offset:-20},{offset:1},{offset:20.5},{offset:'20'},{offset:Infinity},{offset:1020}])
 test('snapshot browser: strict options reject '+JSON.stringify(bad),async()=>{
  assert.throws(()=>query(awaitedFile,bad),/snapshot_query_invalid/);
 });
const awaitedFile=await inspect();
test('snapshot browser: metadata and record access require authentic inspected handles',async()=>{
 for(const f of [null,{},envelope(),{...awaitedFile}]){
  assert.throws(()=>query(f),/snapshot_not_inspected/);
  assert.throws(()=>contract.readMemorySnapshotRecord(f,uuid(1)),/snapshot_not_inspected/);
 }
});
test('snapshot browser: exact ID access returns frozen original without normalizing content',async()=>{
 const f=await inspect(dataset()),r=contract.readMemorySnapshotRecord(f,uuid(3));
 assert.equal(r,f.snapshot.memories[2]);assert.ok(Object.isFrozen(r));
 assert.equal(r.content,'UNIQUE_BODY_ONLY');assert.equal(r.provenance,'UNIQUE_PROVENANCE_ONLY');
 assert.throws(()=>contract.readMemorySnapshotRecord(f,'../x'),/snapshot_record_missing/);
 assert.throws(()=>contract.readMemorySnapshotRecord(f,uuid(9)),/snapshot_record_missing/);
});
