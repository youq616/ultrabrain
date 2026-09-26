/** Separate implementer audit: handle/algorithm/cancellation and independent oracle. */
import test from 'node:test';import assert from 'node:assert/strict';
import {inspectMemorySnapshotFile,compareMemorySnapshotDuplicates,DUPLICATE_COMPARE_FIELDS} from '../src/personal-snapshot-contract.mjs';
import {row,hash,envelope,encoded} from './helpers/snapshot-audit-fixture.mjs';
const checked=rows=>inspectMemorySnapshotFile(encoded(envelope(rows)),hash);
for(const side of ['left','right'])test('duplicate comparison audit: forged '+side+' never invokes snapshot getter',async()=>{
 let reads=0;const fake={get snapshot(){reads++;throw Error('PRIVATE');}},good=await checked([]);
 await assert.rejects(compareMemorySnapshotDuplicates(side==='left'?fake:good,side==='right'?fake:good),{code:'snapshot_not_inspected'});assert.equal(reads,0);
});
test('duplicate comparison audit: copying an inspected handle does not forge the capability',async()=>{
 const good=await checked([]);await assert.rejects(compareMemorySnapshotDuplicates({...good},good),{code:'snapshot_not_inspected'});
});
test('duplicate comparison audit: forced digest collision cannot join different raw strings',async()=>{
 // Only the canonical verifier injection seam; public byte/path entries use real SHA256.
 const h='0'.repeat(64),make=async labels=>inspectMemorySnapshotFile(encoded(envelope(labels.map((c,i)=>({...row(i+1,{content:c}),content_hash:h})),{memories_sha256:h})),()=>h);
 const a=await make(['A','A','B']),b=await make(['B','B','A']);
 const r=await compareMemorySnapshotDuplicates(a,b);assert.equal(r.groups.length,2);
 assert.deepEqual(r.groups.map(g=>g.kind),['left_only','right_only']);assert.equal(r.groups[0].right.member_count,1);
});
for(const content of ['__proto__','constructor','toString','','🙂'])test('duplicate comparison audit: prototype-like or empty content '+JSON.stringify(content),async()=>{
 const a=await checked([row(1,{content}),row(2,{content})]);const r=await compareMemorySnapshotDuplicates(a,a);
 assert.deepEqual(r.counts,{groups:1,left_only:0,right_only:0,changed:0,unchanged:1});
});
for(const cutoff of [2,55,230,350,500])test('duplicate comparison audit: exact checkpoint cutoff '+cutoff,async()=>{
 const a=await checked(Array.from({length:100},(_,i)=>row(i+1,{content:'same'})));let n=0;
 await assert.rejects(compareMemorySnapshotDuplicates(a,a,()=>{if(++n===cutoff)throw Error('revoked');}),/revoked/);assert.equal(n,cutoff);
});
test('duplicate comparison audit: cancellation is serviced during a giant group, not only indexing',async()=>{
 const a=await checked(Array.from({length:1000},(_,i)=>row(i+1,{content:'same'})));let n=0,scheduled=false,revoked=false;
 const work=compareMemorySnapshotDuplicates(a,a,()=>{
  if(++n>2200&&!scheduled){scheduled=true;setImmediate(()=>revoked=true);}
  if(revoked)throw Error('revoked');
 });await assert.rejects(work,/revoked/);assert.ok(scheduled);
});
test('duplicate comparison audit: final check can suppress the entire completed result',async()=>{
 const a=await checked([row(1,{content:'A'}),row(2,{content:'A'})]);let total=0;
 await compareMemorySnapshotDuplicates(a,a,()=>total++);let n=0;
 await assert.rejects(compareMemorySnapshotDuplicates(a,a,()=>{if(++n===total)throw Error('revoked');}),/revoked/);
});
test('duplicate comparison audit: independent quadratic oracle agrees on 20 deterministic pairs',async()=>{
 const labels=['A','B','C','D','__proto__','é','e\u0301',''],normalize=x=>JSON.stringify(x);
 for(let seed=0;seed<20;seed++){
  const left=Array.from({length:40},(_,i)=>row(i+1,{content:labels[(i*7+seed)%labels.length],project_id:i%3?'p':null}));
  const right=Array.from({length:43},(_,i)=>row(i+3,{content:labels[(i*5+seed)%labels.length],project_id:i%4?'p':null}));
  const a=await checked(left),b=await checked(right),r=await compareMemorySnapshotDuplicates(a,b);
  // Deliberately use filter/indexOf rather than the production Map construction.
  const contents=[...left,...right].map(v=>v.content).filter((v,i,x)=>x.indexOf(v)===i);
  const oracle=contents.map(content=>{
   const l=left.filter(v=>v.content===content),rr=right.filter(v=>v.content===content);
   if(l.length<2&&rr.length<2)return null;
   const onlyL=l.filter(v=>!rr.some(w=>v.id===w.id)).map(v=>v.id),onlyR=rr.filter(v=>!l.some(w=>w.id===v.id)).map(v=>v.id);
   const changes=l.flatMap(v=>{const w=rr.find(w=>w.id===v.id);if(!w)return [];
    const fields=DUPLICATE_COMPARE_FIELDS.filter(k=>normalize(v[k])!==normalize(w[k]));return fields.length?[{id:v.id,fields}]:[];});
   return {content_sha256:hash(content),kind:l.length<2?'right_only':rr.length<2?'left_only':onlyL.length||onlyR.length||changes.length?'changed':'unchanged',
    l:l.length,r:rr.length,onlyL,onlyR,changes};
  }).filter(Boolean);
  assert.deepEqual(r.groups.map(g=>({content_sha256:g.content_sha256,kind:g.kind,l:g.left.member_count,r:g.right.member_count,
   onlyL:g.membership.left_only,onlyR:g.membership.right_only,changes:g.shared_record_changes})),oracle);
  assert.equal(Object.entries(r.counts).filter(([k])=>k!=='groups').reduce((n,[,v])=>n+v,0),r.counts.groups);
 }
});
test('duplicate comparison audit: swapping files swaps sided counts, not record meaning',async()=>{
 const a=await checked([row(1,{content:'A'}),row(2,{content:'A'}),row(3,{content:'B'})]);
 const b=await checked([row(1,{content:'A'}),row(3,{content:'B'}),row(4,{content:'B'})]);
 const forward=await compareMemorySnapshotDuplicates(a,b),reverse=await compareMemorySnapshotDuplicates(b,a);
 assert.deepEqual(forward.left,reverse.right);assert.deepEqual(forward.right,reverse.left);
 assert.equal(forward.counts.left_only,reverse.counts.right_only);
 for(const g of forward.groups){const h=reverse.groups.find(h=>h.content_sha256===g.content_sha256);
  assert.deepEqual(g.left,h.right);assert.deepEqual(g.right,h.left);assert.deepEqual(g.membership.left_only,h.membership.right_only);}
});

test('duplicate comparison audit: both-platform CI and actual package gates stay wired',async()=>{
 const {readFileSync}=await import('node:fs');
 const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
 const portable=read('.github/workflows/client-portability.yml'),task=read('.github/workflows/task-context.yml');
 for(const n of ['duplicate-compare','duplicate-compare-boundaries','duplicate-compare-cli'])assert.ok(portable.includes('test/client-snapshot-'+n+'.test.mjs'));
 assert.ok(portable.includes('windows-2025')&&portable.includes('ubuntu-24.04'));
 const idx=task.indexOf('run: bun test/client-snapshot-duplicate-compare-integration.mjs');
 assert.ok(idx>task.indexOf('npm install --prefix'));assert.ok(idx<task.indexOf('name: Stop only isolated database'));
 assert.ok(task.slice(idx).includes('duplicate-compare-report.json'));
 assert.ok(read('test/client-snapshot-offline-package.mjs').includes("'duplicates','duplicate-compare'"));
});
