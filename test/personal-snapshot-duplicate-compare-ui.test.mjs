/** Production comparison UI with synthetic DOM, actual canonical local snapshots. */
import test from 'node:test';import assert from 'node:assert/strict';
import {fixture,pair,until} from './helpers/duplicate-compare-ui-fixture.mjs';
import {row,uuid} from './helpers/snapshot-audit-fixture.mjs';
import * as contract from '../src/personal-snapshot-contract.mjs';
function four(){
 return {left:[...pair(1,'PRIVATE_A'),row(3,{content:'PRIVATE_B'}),...pair(4,'PRIVATE_C'),...pair(6,'PRIVATE_D')],
  right:[row(1,{content:'PRIVATE_A'}),...pair(2,'PRIVATE_B'),...pair(4,'PRIVATE_C',{status:'archived'}),...pair(6,'PRIVATE_D')]};
}
test('comparison UI: missing second verified file cannot open a comparison',async()=>{
 const f=fixture();f.click('dupcmp-open');assert.equal(f.get('dupcmp-panel').hidden,true);
 await f.inspect(pair(),null);assert.equal(f.get('dupcmp-open').disabled,true);f.click('dupcmp-open');
 assert.equal(f.get('dupcmp-panel').hidden,true);assert.equal(f.run('duplicateCompareReport'),null);
});
test('comparison UI: opening is not a scan; explicit consent required',async()=>{
 let calls=0;const f=fixture({compareMemorySnapshotDuplicates:async(...a)=>{calls++;return contract.compareMemorySnapshotDuplicates(...a);}});
 await f.inspect();f.click('dupcmp-open');assert.equal(calls,0);await f.click('dupcmp-run');
 assert.equal(calls,0);assert.equal(f.run('duplicateCompareReport'),null);assert.equal(f.get('dupcmp-run').disabled,true);
});
test('comparison UI: four categories, left/right identity metadata and no body/IO/draft changes',async()=>{
 const f=fixture(),{left,right}=four();await f.inspect(left,right);await f.scan();
 assert.deepEqual(JSON.parse(f.run('JSON.stringify(duplicateCompareReport.counts)')),{groups:4,left_only:1,right_only:1,changed:1,unchanged:1});
 assert.equal(f.get('dupcmp-groups').children.length,4);assert.match(f.get('dupcmp-files').textContent,/左侧/);assert.match(f.get('dupcmp-files').textContent,/SHA-256/);
 assert.equal(f.get('dupcmp-detail').hidden,true);f.group();
 assert.equal(f.get('dupcmp-members').children.length,2);assert.match(f.get('dupcmp-detail-summary').textContent,/右侧 1 条/);
 assert.match(f.text(f.get('dupcmp-members')),/该内容组内仅左/);
 for(const id of ['dupcmp-groups','dupcmp-members','dupcmp-files'])assert.ok(!f.text(f.get(id)).includes('PRIVATE_'));
 assert.equal(f.get('content').value,'UNSAVED_PRIVATE_DRAFT');assert.equal(f.reads.length,2);assert.equal(f.run('pending'),null);
});
for(const kind of ['left_only','right_only','changed','unchanged'])test('comparison UI: category filter '+kind+' never rereads files or recomputes',async()=>{
 let calls=0;const f=fixture({compareMemorySnapshotDuplicates:async(...a)=>{calls++;return contract.compareMemorySnapshotDuplicates(...a);}}),d=four();
 await f.inspect(d.left,d.right);await f.scan();f.group();f.filter(kind);
 assert.equal(f.get('dupcmp-groups').children.length,1);assert.equal(f.get('dupcmp-groups').children[0].dataset.kind,kind);
 assert.equal(f.get('dupcmp-detail').hidden,true);assert.equal(f.get('dupcmp-members').children.length,0);
 f.filter('all');assert.equal(f.get('dupcmp-groups').children.length,4);assert.equal(calls,1);assert.equal(f.reads.length,2);
});
test('comparison UI: group and member pages reach all results with bounded rendering',async()=>{
 const rows=Array.from({length:48},(_,i)=>row(i+1,{content:'PRIVATE_'+Math.floor(i/2)}));
 const f=fixture();await f.inspect(rows,rows);await f.scan();assert.equal(f.get('dupcmp-groups').children.length,20);
 f.click('dupcmp-next');assert.equal(f.get('dupcmp-groups').children.length,4);assert.equal(f.get('dupcmp-next').disabled,true);
 f.click('dupcmp-next');assert.equal(f.get('dupcmp-groups').children.length,4);f.click('dupcmp-prev');
 assert.equal(f.get('dupcmp-groups').children.length,20);assert.equal(f.get('dupcmp-prev').disabled,true);
 const big=Array.from({length:1000},(_,i)=>row(i+1,{content:'PRIVATE_BIG'}));
 await f.inspect(big,big);await f.scan();f.group();const ids=[];
 do{const cards=f.get('dupcmp-members').children;assert.ok(cards.length<=20);ids.push(...cards.map(c=>c.dataset.memoryId));
  if(f.get('dupcmp-members-next').disabled)break;f.click('dupcmp-members-next');}while(true);
 assert.deepEqual(ids,big.map(r=>r.id));assert.equal(f.reads.length,4);
});
test('comparison UI: changed shared fields are names only; no source text/reference/HTML',async()=>{
 const left=pair(1,'PRIVATE_BODY'),right=pair(1,'PRIVATE_BODY',{provenance:'PRIVATE_SOURCE <script>x</script>',derivation:{quote:'PRIVATE_QUOTE'}});
 const f=fixture();await f.inspect(left,right);await f.scan();f.group();const text=f.text(f.get('dupcmp-members'));
 assert.match(text,/来源说明/);assert.match(text,/结构化引用/);assert.ok(!text.includes('PRIVATE_'));
 assert.ok(f.get('dupcmp-members').children.every(c=>c.children.every(n=>n.children.length===0)));
});
test('comparison UI: no matching category differs from a zero-group complete comparison',async()=>{
 const f=fixture();await f.inspect([],[]);await f.scan();assert.notEqual(f.run('duplicateCompareReport'),null);
 assert.match(f.get('dupcmp-summary').textContent,/完整比较/);assert.match(f.get('dupcmp-summary').textContent,/共 0 组/);
 await f.inspect();await f.scan();f.filter('changed');assert.match(f.get('dupcmp-summary').textContent,/筛选匹配 0 组/);
 assert.match(f.get('dupcmp-summary').textContent,/共 1 组/);assert.equal(f.get('dupcmp-next').disabled,true);
});
test('comparison UI: unequal source labels reject comparison without zero success',async()=>{
 const f=fixture();await f.inspect(pair(),pair(),{},{source_id:'other'});await f.scan();
 assert.equal(f.run('duplicateCompareReport'),null);assert.equal(f.get('dupcmp-groups').children.length,0);
 assert.match(f.get('dupcmp-summary').textContent,/来源不同/);
});
test('comparison UI: raw scan errors sanitized and never return a partial report',async()=>{
 const f=fixture({compareMemorySnapshotDuplicates:async()=>{throw Error('PRIVATE_INTERNAL');}});
 await f.inspect();await f.scan();assert.equal(f.run('duplicateCompareReport'),null);
 assert.match(f.get('dupcmp-summary').textContent,/未确认/);assert.ok(!f.get('message').textContent.includes('PRIVATE'));
});
for(const boundary of ['left','right','parent-consent','session','source','view','navigation','busy','pending','workspace','parent-panel','panel','consent'])
 test('comparison UI: current member/page action refuses changed boundary '+boundary,async()=>{
  const f=fixture();await f.inspect();await f.scan();f.group();
  if(['left','right'].includes(boundary))f.get('inspector-'+boundary).files=[f.file(pair())];
  else if(boundary==='parent-consent')f.get('inspector-consent').checked=false;
  else if(boundary==='session')f.run("token='different'");else if(boundary==='source')f.run("sourceId='different'");
  else if(boundary==='view')f.run("view='jobs'");else if(boundary==='navigation')f.run('loadVersion++');
  else if(boundary==='busy')f.run('busy=true');else if(boundary==='pending')f.run('pending={}');
  else if(boundary==='workspace')f.get('workspace').hidden=true;else if(boundary==='parent-panel')f.get('inspector-panel').hidden=true;
  else if(boundary==='panel')f.get('dupcmp-panel').hidden=true;else f.get('dupcmp-consent').checked=false;
  f.click('dupcmp-members-next');assert.equal(f.run('duplicateCompareReport'),null);assert.equal(f.get('dupcmp-members').children.length,0);
 });
for(const id of ['inspector-left','inspector-right','inspector-cancel','inspector-run','inspector-open'])
 test('comparison UI: parent resets synchronously on '+id,async()=>{
  const f=fixture();await f.inspect();await f.scan();f.group();
  const task=f.click(id,id==='inspector-left'||id==='inspector-right'?'change':'click');
  assert.equal(f.run('duplicateCompareReport'),null);assert.equal(f.get('dupcmp-panel').hidden,true);
  assert.equal(f.get('dupcmp-members').children.length,0);if(task?.then)await task;
 });
for(const id of ['refresh','logout','save','snapshot-open','explorer-open','duplicates-open','overview-open','lineage-open','inspector-compare'])
 test('comparison UI: workspace transition clears displayed data before '+id,async()=>{
  const f=fixture();await f.inspect();await f.scan();f.group();f.capture(id);
  assert.equal(f.get('dupcmp-panel').hidden,true);assert.equal(f.run('duplicateCompareReport'),null);
 });
test('comparison UI: consent withdrawal clears result; reopening needs new consent',async()=>{
 const f=fixture();await f.inspect();await f.scan();f.group();f.get('dupcmp-consent').checked=false;f.click('dupcmp-consent','change');
 assert.equal(f.run('duplicateCompareReport'),null);assert.equal(f.get('dupcmp-members').children.length,0);
 f.click('dupcmp-close');f.click('dupcmp-open');assert.equal(f.get('dupcmp-consent').checked,false);assert.equal(f.get('dupcmp-run').disabled,true);
});
test('comparison UI: double click starts one comparison and close fences late success',async()=>{
 let release,calls=0;const f=fixture({compareMemorySnapshotDuplicates:async(...a)=>{calls++;await new Promise(r=>release=r);return contract.compareMemorySnapshotDuplicates(...a);}});
 await f.inspect();f.click('dupcmp-open');f.get('dupcmp-consent').checked=true;const first=f.click('dupcmp-run'),second=f.click('dupcmp-run');
 await until(()=>release);f.click('dupcmp-close');release();await Promise.all([first,second]);
 assert.equal(calls,1);assert.equal(f.run('duplicateCompareReport'),null);assert.equal(f.get('dupcmp-panel').hidden,true);
});
test('comparison UI: stale failure cannot erase a newer successful comparison',async()=>{
 let reject,calls=0;const f=fixture({compareMemorySnapshotDuplicates:async(...a)=>{if(calls++===0)await new Promise((_,r)=>reject=r);return contract.compareMemorySnapshotDuplicates(...a);}});
 await f.inspect();const old=f.scan();await until(()=>reject);f.click('dupcmp-close');await f.scan();const report=f.run('duplicateCompareReport');
 reject(Error('PRIVATE_OLD'));await old;assert.equal(f.run('duplicateCompareReport'),report);assert.ok(!f.get('message').textContent.includes('PRIVATE'));
});
test('comparison UI: detached group button cannot select old group or erase new result',async()=>{
 const rows=Array.from({length:44},(_,i)=>row(i+1,{content:'PRIVATE_'+Math.floor(i/2)}));
 const f=fixture();await f.inspect(rows,rows);await f.scan();const old=f.get('dupcmp-groups').children[0].children.at(-1).handlers.get('click');
 f.click('dupcmp-next');old();assert.equal(f.get('dupcmp-detail').hidden,true);
 await f.scan();const report=f.run('duplicateCompareReport');old();assert.equal(f.run('duplicateCompareReport'),report);
});
test('comparison UI: opening drops old body previews but preserves parent files and draft',async()=>{
 const f=fixture();await f.inspect();f.get('explorer-detail-text').textContent='PRIVATE_PREVIEW';f.get('inspector-detail-left').textContent='PRIVATE_PREVIEW';
 f.get('duplicates-detail-text').textContent='PRIVATE_PREVIEW';const data=f.run('inspectorData');f.click('dupcmp-open');
 for(const id of ['explorer-detail-text','inspector-detail-left','duplicates-detail-text'])assert.equal(f.get(id).textContent,'');
 assert.equal(f.run('inspectorData'),data);assert.equal(f.get('content').value,'UNSAVED_PRIVATE_DRAFT');assert.equal(f.reads.length,2);
});
