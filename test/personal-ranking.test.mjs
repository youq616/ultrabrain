/** Pure ranking-contract tests: canonical SQL/JS rules, no database required. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {taskTerms,rankMemory,buildPersonalContext} from '../src/personal-context-engine.mjs';
const active=over=>({status:'active',project_id:null,...over});
test('task terms split on Unicode whitespace, deduplicate and cap at 32 distinct terms',()=>{
  assert.deepEqual(taskTerms('docker'),['docker']);
  assert.deepEqual(taskTerms('  docker\tk8s\n'),['docker','k8s']);
  assert.deepEqual(taskTerms('全角　空格　test\u3000test\u00A0nbsp'),['全角','空格','test','nbsp']); // U+3000/U+00A0 are whitespace
  assert.deepEqual(taskTerms('docker docker DOCKER'),['docker']);
  assert.equal(taskTerms(Array.from({length:40},(_,i)=>'w'+i).join(' ')).length,32);
  assert.deepEqual(taskTerms(''),[]);
});
test('only ASCII A–Z is folded; other scripts match exactly as written',()=>{
  assert.deepEqual(taskTerms('DOCKER K8s'),['docker','k8s']);
  assert.deepEqual(taskTerms('ЖУРНАЛ журнал'),['ЖУРНАЛ','журнал']); // Cyrillic case is NOT folded
  assert.notEqual(rankMemory(active({content:'журнал отладки',importance:'normal'}),{task:'ЖУРНАЛ'}),3); // no caseless match
  assert.equal(rankMemory(active({content:'Use DOCKER Hub never',importance:'low'}),{task:'docker'}),2); // ASCII folds
  // Turkish İ and dotless ı stay as-is; no full Unicode casefolding.
  assert.deepEqual(taskTerms('İstanbul ıspanak'),['İstanbul','ıspanak']);
});
test('importance scores 3/2/1 plus one point per distinct matched term',()=>{
  const memory=active({content:'prefer full CLI commands, not editors',importance:'high'});
  assert.equal(rankMemory(memory,{task:''}),3);
  assert.equal(rankMemory(memory,{task:'full commands'}),5);
  assert.equal(rankMemory(memory,{task:'full commands commands commands'}),5); // duplicates count once
  assert.equal(rankMemory(active({content:'plain',importance:'low'}),{task:'absent'}),1);
  assert.equal(rankMemory(active({content:'plain',importance:'unknown'},{importance:'odd'}),{}),0);
});
test('ties break on true millisecond time descending, then full UUID ascending',()=>{
  const rows=[
    active({id:'00000000-0000-0000-0000-00000000000b',type:'preference',content:'B',importance:'normal',updated_at:new Date('2024-01-04T10:00:00.000Z')}),
    active({id:'00000000-0000-0000-0000-00000000000a',type:'preference',content:'A',importance:'normal',updated_at:new Date('2024-01-03T09:00:00.000Z')}),
  ];
  // Date objects: the newer entry wins; String(Date) weekday-name comparison must not apply.
  assert.equal(buildPersonalContext(rows,{limit:10,budget_bytes:8000}).memories[0].id,rows[0].id);
  const isoRows=[
    active({id:'00000000-0000-0000-0000-00000000000b',type:'preference',content:'B',importance:'normal',updated_at:'2026-01-02T00:00:00.250Z'}),
    active({id:'00000000-0000-0000-0000-00000000000a',type:'preference',content:'A',importance:'normal',updated_at:'2026-01-02T00:00:00.750Z'}),
  ];
  assert.equal(buildPersonalContext(isoRows,{limit:10,budget_bytes:8000}).memories[0].id,isoRows[1].id); // ISO strings compare numerically
  const sameTime=[
    active({id:'bbbbbbbb-0000-0000-0000-000000000001',type:'preference',content:'uuid-late',importance:'normal',updated_at:new Date('2026-01-01T00:00:00.000Z')}),
    active({id:'aaaaaaaa-0000-0000-0000-000000000002',type:'preference',content:'uuid-early',importance:'normal',updated_at:new Date('2026-01-01T00:00:00.000Z')}),
  ];
  assert.equal(buildPersonalContext(sameTime,{limit:10,budget_bytes:8000}).memories[0].id,'aaaaaaaa-0000-0000-0000-000000000002');
});
test('a high-importance entry older than 110 newer entries ranks first when present in candidates',()=>{
  const all=[active({id:'old-high',type:'preference',content:'Always prefer full CLI commands',importance:'high',updated_at:new Date('2023-06-01T00:00:00.000Z')}),
    ...Array.from({length:110},(_,i)=>active({id:'new-'+i,type:'experience',content:'routine note '+i,importance:'normal',updated_at:new Date('2026-09-01T00:00:00.000Z')}))];
  const ctx=buildPersonalContext(all,{limit:100,budget_bytes:131072,task:'full CLI commands'});
  assert.equal(ctx.memories[0].id,'old-high');
  assert.ok(ctx.memories.length<=100);
});
test('assembler excludes non-active, stale derivations and other projects; keeps whole entries and flags',()=>{
  const rows=[
    active({id:'1',type:'preference',content:'keep negations: 不要 Docker',importance:'high',updated_at:new Date()}),
    active({id:'2',type:'preference',content:'candidate dropped',importance:'high',status:'candidate',updated_at:new Date()}),
    active({id:'3',type:'preference',content:'archived dropped',importance:'high',status:'archived',updated_at:new Date()}),
    active({id:'4',type:'preference',content:'stale derivation dropped',importance:'high',derivation_current:false,updated_at:new Date()}),
    active({id:'5',type:'preference',content:'other project dropped',importance:'high',project_id:'elsewhere',updated_at:new Date()}),
  ];
  const ctx=buildPersonalContext(rows,{limit:10,budget_bytes:131072,project_id:null});
  assert.equal(ctx.memories.length,1);
  assert.equal(ctx.memories[0].content,'keep negations: 不要 Docker'); // never shortened
  assert.equal(ctx.exhaustive,false);
  assert.equal(ctx.trust,'untrusted-memory-data');
  // Budget drops whole entries only; a single oversized entry is dropped, not truncated.
  const big=active({id:'6',content:'x'.repeat(5000),importance:'high',updated_at:new Date()});
  const tight=buildPersonalContext([big],{limit:10,budget_bytes:512});
  assert.ok(tight.memories.length===0||JSON.stringify(tight.memories[0]).length<600);
  assert.ok(!JSON.stringify(tight).includes('xxxx')); // nothing partially truncated into output
});
test('task text is treated as literals: SQL metacharacters never form query fragments',()=>{
  const hostile="'; DROP TABLE personal_memories; -- /* */ % _ \u0000escaped";
  const terms=taskTerms(hostile);
  assert.ok(Array.isArray(terms)&&terms.every(t=>typeof t==='string'&&t!==''));
  assert.ok(terms.some(t=>t.includes('drop'))); // folded ASCII only
  const memory=active({type:'experience',content:"'; DROP TABLE personal_memories; -- literal",importance:'normal'});
  assert.ok(rankMemory(memory,{task:hostile})>=2); // matched as literal substrings only
});
test('selection marker documents the canonical rule and bounded recall',()=>{
  const ctx=buildPersonalContext([],{budget_bytes:1000});
  assert.equal(ctx.selection,'bounded-literal-and-importance-v2');
  assert.match(ctx.confidence_semantics,/not truth/);
});
