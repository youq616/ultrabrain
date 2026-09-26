/** Additional implementer review probes; this test runner is not a reviewer agent. */
import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {fixture,until} from './helpers/duplicate-review-ui-fixture.mjs';
import {row,envelope,encoded,hash} from './helpers/snapshot-audit-fixture.mjs';
import * as contract from '../src/personal-snapshot-contract.mjs';
const pair=()=>[row(1,{content:'SAME_PRIVATE'}),row(2,{content:'SAME_PRIVATE'})];
for(const boundary of ['file','side','parent-consent','busy','pending','session'])test('review: revocation while scan waits refuses entire report '+boundary,async()=>{
 let release;const f=fixture({inspectMemorySnapshotDuplicates:async(file,allowed)=>{
  await new Promise(r=>release=r);return contract.inspectMemorySnapshotDuplicates(file,allowed);
 }});
 await f.inspect();const work=f.scan();await until(()=>!!release);
 if(boundary==='file')f.get('inspector-left').files=[f.file(pair())];else if(boundary==='side')f.get('duplicates-side').value='right';
 else if(boundary==='parent-consent')f.get('inspector-consent').checked=false;else if(boundary==='session')f.run("token='replaced'");
 else f.run(boundary==='busy'?'busy=true':'pending={}');
 release();await work;assert.equal(f.run('duplicateReport'),null);assert.equal(f.get('duplicates-groups').children.length,0);
 assert.equal(f.get('duplicates-detail-text').textContent,'');
});
test('review: reopened panel cannot reuse a completed report or old disclosure approval',async()=>{
 const f=fixture();await f.inspect();await f.scan();f.group();f.textConsent();f.show();f.click('duplicates-close');f.click('duplicates-open');
 assert.equal(f.run('duplicateReport'),null);assert.equal(f.get('duplicates-text-consent').checked,false);assert.equal(f.get('duplicates-consent').checked,false);
 assert.equal(f.get('duplicates-detail-text').textContent,'');
});
test('review: selected group and member pages discard old text-consent state',async()=>{
 const f=fixture();await f.inspect(Array.from({length:30},(_,i)=>row(i,{content:i<25?'A':'B'})));await f.scan();f.group();f.textConsent();f.show();
 f.click('duplicates-members-next');assert.equal(f.get('duplicates-text-consent').checked,false);assert.equal(f.get('duplicates-detail-text').textContent,'');
 f.textConsent();f.show();f.group(1);assert.equal(f.get('duplicates-text-consent').checked,false);assert.equal(f.get('duplicates-detail-text').textContent,'');
});
test('review: prototype-like and Unicode bodies group by exact text with an independent oracle',async()=>{
 const texts=['__proto__','constructor','hasOwnProperty','A','a','a ','é','e\u0301','🙂\r\n','🙂\n',''];
 for(let seed=0;seed<12;seed++){
  const rows=Array.from({length:60},(_,i)=>row(i,{content:texts[(i*i+seed*7+i*3)%texts.length],project_id:i%2?'one':null,
   status:['active','archived','candidate'][(i+seed)%3]}));
  const file=await contract.inspectMemorySnapshotFile(encoded(envelope(rows)),hash);
  const result=await contract.inspectMemorySnapshotDuplicates(file);
  const oracle=[];
  for(const r of rows){let group=oracle.find(g=>g[0].content===r.content);if(!group){group=[];oracle.push(group);}group.push(r);}
  const repeated=oracle.filter(g=>g.length>1);
  assert.deepEqual(result.groups.map(g=>g.members.map(m=>m.id)),repeated.map(g=>g.map(m=>m.id)));
  assert.equal(result.counts.groups,repeated.length);assert.equal(result.counts.records_outside_groups,oracle.filter(g=>g.length===1).length);
  assert.equal(result.scanned_records,60);assert.equal(result.counts.records_in_groups+result.counts.records_outside_groups,60);
 }
});
test('review: shared scan yields for real timer cancellation and never returns a partial group',async()=>{
 const file=await contract.inspectMemorySnapshotFile(encoded(envelope(Array.from({length:1000},(_,i)=>row(i,{content:'same'})))),hash);
 let revoked=false;const task=contract.inspectMemorySnapshotDuplicates(file,()=>{if(revoked)throw Error('revoked');});
 const timer=setTimeout(()=>revoked=true,0);
 try{await assert.rejects(task,/revoked/);}finally{clearTimeout(timer);}
});
test('review: no body, source text, write controls or data APIs are introduced into panel defaults',()=>{
 const code=readFileSync(new URL('../web/personal/snapshot-duplicates-ui.js',import.meta.url),'utf8');
 for(const bad of ['innerHTML','localStorage','sessionStorage','fetch(','api(','download(','writeFile','setInterval(','include_text'])assert.ok(!code.includes(bad),bad);
 const html=readFileSync(new URL('../web/personal/index.html',import.meta.url),'utf8');
 assert.match(html,/<input type="checkbox" id="duplicates-consent">/);
 assert.match(html,/<input type="checkbox" id="duplicates-text-consent">/);
 assert.match(html,/<section id="duplicates-panel" class="panel" hidden/);
});
test('review: new CI steps are additive and keep the previous exact suite prefix',()=>{
 const flow=readFileSync(new URL('../.github/workflows/client-portability.yml',import.meta.url),'utf8');
 assert.ok(flow.includes('test/personal-snapshot-duplicates-review.test.mjs'));
 assert.ok(flow.includes('test/client-snapshot-duplicates-boundaries.test.mjs'));
 assert.ok(flow.includes('windows-2025')&&flow.includes('ubuntu-24.04'));
 const smoke=readFileSync(new URL('../.github/workflows/personal-overview-smoke.yml',import.meta.url),'utf8');
 assert.ok(smoke.indexOf('node test/personal-snapshot-duplicates-http-browser.mjs')>smoke.indexOf('node test/personal-overview-http-browser.mjs'));
 assert.ok(smoke.includes('duplicate-review-browser.json'));
});
