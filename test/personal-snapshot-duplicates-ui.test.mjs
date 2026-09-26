/** Production duplicate review UI and parent lifecycle, synthetic DOM/transport only. */
import test from 'node:test';import assert from 'node:assert/strict';
import {fixture,until} from './helpers/duplicate-review-ui-fixture.mjs';
import {row,uuid} from './helpers/snapshot-audit-fixture.mjs';
import * as contract from '../src/personal-snapshot-contract.mjs';
const pair=(n=1,content='PRIVATE_DUPLICATE')=>[row(n,{content}),row(n+1,{content})];
test('duplicates UI: opening or missing consent never scans or reveals metadata',async()=>{
 const f=fixture();f.click('duplicates-open');assert.equal(f.get('duplicates-panel').hidden,true);
 await f.inspect();f.click('duplicates-open');await f.click('duplicates-run');
 assert.equal(f.run('duplicateReport'),null);assert.equal(f.get('duplicates-groups').children.length,0);assert.equal(f.get('duplicates-run').disabled,true);
});
test('duplicates UI: full-file exact groups, metadata first, source states and draft retained',async()=>{
 const f=fixture();await f.inspect([...pair(),row(3,{content:'UNIQUE'}),row(4,{content:'PRIVATE_DUPLICATE',status:'archived',project_id:'other'})]);await f.scan();
 assert.equal(f.run('duplicateReport.counts.groups'),1);assert.equal(f.run('duplicateReport.counts.records_in_groups'),3);
 assert.equal(f.get('duplicates-groups').children.length,1);assert.equal(f.get('duplicates-detail').hidden,true);
 assert.ok(!JSON.stringify(f.get('duplicates-groups')).includes('PRIVATE_DUPLICATE'));
 f.group();assert.equal(f.get('duplicates-members').children.length,3);assert.equal(f.get('duplicates-detail-text').textContent,'');
 f.show();assert.equal(f.get('duplicates-detail-text').textContent,'');
 f.textConsent();f.show();assert.deepEqual(JSON.parse(f.get('duplicates-detail-text').textContent),row(1,{content:'PRIVATE_DUPLICATE'}));
 assert.equal(f.get('content').value,'UNSAVED_PRIVATE_DRAFT');assert.equal(f.reads.length,1);assert.equal(f.run('pending'),null);
});
test('duplicates UI: literal text is never inserted as markup',async()=>{
 const body='<img src=x onerror=bad()> PRIVATE_DUPLICATE';const f=fixture();await f.inspect(pair(1,body));await f.scan();f.group();f.textConsent();f.show();
 assert.equal(JSON.parse(f.get('duplicates-detail-text').textContent).content,body);assert.equal(f.get('duplicates-detail-text').children.length,0);
 f.click('duplicates-detail-clear');assert.equal(f.get('duplicates-detail-text').textContent,'');assert.equal(f.get('duplicates-detail').hidden,true);
});
test('duplicates UI: exact matching does not trim, case-fold or normalize Unicode',async()=>{
 const f=fixture();await f.inspect(['x','X','x ','é','e\u0301'].map((content,i)=>row(i,{content})));await f.scan();
 assert.equal(f.run('duplicateReport.counts.groups'),0);assert.match(f.get('duplicates-summary').textContent,/0 组/);
 assert.equal(f.get('duplicates-next').disabled,true);
});
test('duplicates UI: empty verified file differs from unopened and failed audit',async()=>{
 const f=fixture();await f.inspect([]);await f.scan();assert.equal(f.run('duplicateReport.scanned_records'),0);
 assert.match(f.get('duplicates-summary').textContent,/扫描 0 条/);assert.match(f.get('duplicates-summary').textContent,/0 组/);
});
test('duplicates UI: all 23 groups reachable 20+3, no additional file reads',async()=>{
 const f=fixture();await f.inspect(Array.from({length:23},(_,i)=>pair(i*2,'PRIVATE_'+i)).flat());await f.scan();
 assert.equal(f.get('duplicates-groups').children.length,20);f.group();f.textConsent();f.show();f.click('duplicates-next');
 assert.equal(f.get('duplicates-groups').children.length,3);assert.equal(f.get('duplicates-detail-text').textContent,'');
 assert.equal(f.get('duplicates-next').disabled,true);f.click('duplicates-next');assert.equal(f.get('duplicates-groups').children.length,3);
 f.click('duplicates-prev');assert.equal(f.get('duplicates-groups').children.length,20);assert.equal(f.reads.length,1);
});
test('duplicates UI: all 1000 members reachable exactly once with bounded pages',async()=>{
 const f=fixture();await f.inspect(Array.from({length:1000},(_,i)=>row(i,{content:'PRIVATE_LARGE_GROUP'})));await f.scan();f.group();const ids=[];
 do{
  const cards=f.get('duplicates-members').children;assert.ok(cards.length<=20);ids.push(...cards.map(c=>c.dataset.memoryId));
  if(f.get('duplicates-members-next').disabled)break;f.click('duplicates-members-next');
 }while(true);
 assert.deepEqual(ids,Array.from({length:1000},(_,i)=>uuid(i)));assert.equal(f.reads.length,1);
});
test('duplicates UI: right file selection requires new consent and never compares across files',async()=>{
 const f=fixture();await f.inspect(pair(),pair(7,'RIGHT_BODY'));await f.scan();f.group();f.textConsent();f.show();
 f.get('duplicates-side').value='right';f.click('duplicates-side','change');assert.equal(f.get('duplicates-consent').checked,false);
 assert.equal(f.get('duplicates-detail-text').textContent,'');await f.click('duplicates-run');assert.equal(f.run('duplicateReport'),null);
 f.get('duplicates-consent').checked=true;await f.click('duplicates-run');f.group();f.textConsent();f.show();
 assert.equal(JSON.parse(f.get('duplicates-detail-text').textContent).content,'RIGHT_BODY');assert.equal(f.run('duplicateReport.scanned_records'),2);
});
test('duplicates UI: absent right side cannot be manufactured',async()=>{
 const f=fixture();await f.inspect();f.click('duplicates-open');f.get('duplicates-side').value='right';f.get('duplicates-consent').checked=true;
 await f.click('duplicates-run');assert.equal(f.run('duplicateReport'),null);assert.equal(f.get('duplicates-side-right').disabled,true);
});
for(const kind of ['text','scan','parent'])test('duplicates UI: consent withdrawal clears the appropriate private display '+kind,async()=>{
 const f=fixture();await f.inspect();await f.scan();f.group();f.textConsent();f.show();
 const id={text:'duplicates-text-consent',scan:'duplicates-consent',parent:'inspector-consent'}[kind];
 f.get(id).checked=false;f.click(id,'change');assert.equal(f.get('duplicates-detail-text').textContent,'');
 assert.equal(f.run('duplicateReport')===null,kind!=='text');
});
for(const boundary of ['file','session','source','navigation','view','busy','pending','workspace','parent-panel','panel','side','consent'])
 test('duplicates UI: changed authority blocks a current detail action '+boundary,async()=>{
 const f=fixture();await f.inspect();await f.scan();f.group();f.textConsent();
 if(boundary==='file')f.get('inspector-left').files=[f.file(pair())];
 else if(boundary==='session')f.run("token='other'");else if(boundary==='source')f.run("sourceId='other'");
 else if(boundary==='navigation')f.run('loadVersion++');else if(boundary==='view')f.run("view='jobs'");
 else if(boundary==='busy')f.run('busy=true');else if(boundary==='pending')f.run('pending={}');
 else if(boundary==='workspace')f.get('workspace').hidden=true;else if(boundary==='parent-panel')f.get('inspector-panel').hidden=true;
 else if(boundary==='panel')f.get('duplicates-panel').hidden=true;else if(boundary==='side')f.get('duplicates-side').value='right';
 else f.get('duplicates-consent').checked=false;
 f.show();assert.equal(f.get('duplicates-detail-text').textContent,'');assert.equal(f.run('duplicateReport'),null);
});
for(const action of ['inspector-left','inspector-right','inspector-cancel','inspector-run','inspector-open'])
 test('duplicates UI: parent lifecycle clears results synchronously '+action,async()=>{
 const f=fixture();await f.inspect();await f.scan();f.group();f.textConsent();f.show();
 const work=f.click(action,action==='inspector-left'||action==='inspector-right'?'change':'click');
 assert.equal(f.get('duplicates-detail-text').textContent,'');assert.equal(f.get('duplicates-panel').hidden,true);assert.equal(f.run('duplicateReport'),null);
 if(work?.then)await work;
});
for(const id of ['refresh','logout','save','snapshot-open','explorer-open','overview-open','lineage-open'])
 test('duplicates UI: capture-phase workspace switch clears private data '+id,async()=>{
 const f=fixture();await f.inspect();await f.scan();f.group();f.textConsent();f.show();f.capture(id);
 assert.equal(f.get('duplicates-detail-text').textContent,'');assert.equal(f.get('duplicates-panel').hidden,true);
});
test('duplicates UI: close stops pending scan, late success cannot resurrect it',async()=>{
 let release,started=false;const f=fixture({inspectMemorySnapshotDuplicates:async(file,allowed)=>{started=true;await new Promise(r=>release=r);return contract.inspectMemorySnapshotDuplicates(file,allowed);}});
 await f.inspect();const work=f.scan();await until(()=>started);f.click('duplicates-close');release();await work;
 assert.equal(f.run('duplicateReport'),null);assert.equal(f.get('duplicates-panel').hidden,true);assert.equal(f.get('duplicates-run').disabled,true);
});
test('duplicates UI: late failure cannot erase a newer successful scan',async()=>{
 let reject,started=false,n=0;const f=fixture({inspectMemorySnapshotDuplicates:async(file,allowed)=>{
  if(n++===0){started=true;await new Promise((_,r)=>reject=r);}return contract.inspectMemorySnapshotDuplicates(file,allowed);
 }});
 await f.inspect();const old=f.scan();await until(()=>started);f.click('duplicates-close');await f.scan();const report=f.run('duplicateReport');
 reject(Error('PRIVATE_INTERNAL'));await old;assert.equal(f.run('duplicateReport'),report);assert.ok(!f.get('message').textContent.includes('PRIVATE_INTERNAL'));
});
test('duplicates UI: exception returns no partial or successful empty audit',async()=>{
 const f=fixture({inspectMemorySnapshotDuplicates:async()=>{throw Error('PRIVATE_INTERNAL');}});await f.inspect();await f.scan();
 assert.equal(f.run('duplicateReport'),null);assert.equal(f.get('duplicates-groups').children.length,0);assert.ok(!f.get('message').textContent.includes('PRIVATE_INTERNAL'));
 assert.match(f.get('duplicates-summary').textContent,/未确认/);
});
test('duplicates UI: double-click starts one audit only',async()=>{
 let release,n=0;const f=fixture({inspectMemorySnapshotDuplicates:async(file,allowed)=>{n++;await new Promise(r=>release=r);return contract.inspectMemorySnapshotDuplicates(file,allowed);}});
 await f.inspect();f.click('duplicates-open');f.get('duplicates-consent').checked=true;const one=f.click('duplicates-run');const two=f.click('duplicates-run');
 await until(()=>!!release);release();await Promise.all([one,two]);assert.equal(n,1);
});
test('duplicates UI: detached group/member buttons do not modify a newer page or report',async()=>{
 const f=fixture();await f.inspect(Array.from({length:23},(_,i)=>pair(i*2,'PRIVATE_'+i)).flat());await f.scan();
 const oldGroup=f.get('duplicates-groups').children[0].children.at(-1).handlers.get('click');f.group();f.textConsent();
 const oldMember=f.get('duplicates-members').children[0].children.at(-1).handlers.get('click');f.click('duplicates-next');
 oldGroup();oldMember();assert.equal(f.get('duplicates-detail-text').textContent,'');assert.equal(f.get('duplicates-groups').children.length,3);
 await f.scan();const report=f.run('duplicateReport');oldGroup();oldMember();assert.equal(f.run('duplicateReport'),report);
});
test('duplicates UI: other inspector consents and drafts remain separate',async()=>{
 const f=fixture();await f.inspect(pair(),pair(5));f.get('inspector-compare-consent').checked=true;f.click('inspector-compare');const comparison=f.run('inspectorReport');
 await f.scan();f.group();f.textConsent();f.show();f.click('duplicates-close');
 assert.equal(f.run('inspectorReport'),comparison);assert.notEqual(f.run('inspectorData'),null);assert.equal(f.get('content').value,'UNSAVED_PRIVATE_DRAFT');
});
