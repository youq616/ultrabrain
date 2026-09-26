/** Implementer adversarial pass, not an independent reviewer-agent approval. */
import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {fixture,pair,until} from './helpers/duplicate-compare-ui-fixture.mjs';
import {row} from './helpers/snapshot-audit-fixture.mjs';
import * as contract from '../src/personal-snapshot-contract.mjs';
import {startPersonalConsole} from '../src/personal-console.mjs';
for(const id of ['dupcmp-next','dupcmp-members-next'])test('review: silent filter replacement cannot retain a previous group/page '+id,async()=>{
 const f=fixture();await f.inspect();await f.scan();f.group();f.get('dupcmp-kind').value='changed';
 f.click(id);assert.equal(f.run('duplicateCompareReport'),null);assert.equal(f.get('dupcmp-members').children.length,0);
});
for(const boundary of ['left','right','parent-consent','consent','session','busy','pending'])
 test('review: changed boundary during async comparison withholds late data '+boundary,async()=>{
  let release;const f=fixture({compareMemorySnapshotDuplicates:async(...a)=>{await new Promise(r=>release=r);return contract.compareMemorySnapshotDuplicates(...a);}});
  await f.inspect();const task=f.scan();await until(()=>release);
  if(['left','right'].includes(boundary))f.get('inspector-'+boundary).files=[f.file(pair())];
  else if(boundary==='parent-consent')f.get('inspector-consent').checked=false;
  else if(boundary==='consent')f.get('dupcmp-consent').checked=false;
  else if(boundary==='session')f.run("token='other'");else f.run(boundary==='busy'?'busy=true':'pending={}');
  release();await task;assert.equal(f.run('duplicateCompareReport'),null);assert.equal(f.get('dupcmp-groups').children.length,0);
 });
for(const code of ['getter','revoked-proxy'])test('review: error projection does not invoke untrusted exception '+code,async()=>{
 let reads=0,error;if(code==='getter')error={get code(){reads++;throw Error('PRIVATE');}};
 else{const p=Proxy.revocable({},{});error=p.proxy;p.revoke();}
 const f=fixture({compareMemorySnapshotDuplicates:async()=>{throw error;}});await f.inspect();await f.scan();
 assert.equal(reads,0);assert.equal(f.run('duplicateCompareReport'),null);assert.ok(!f.get('message').textContent.includes('PRIVATE'));
});
test('review: 2000 disjoint member IDs remain reachable; each file still has at most 1000',async()=>{
 const left=Array.from({length:1000},(_,i)=>row(i+1,{content:'same'})),right=Array.from({length:1000},(_,i)=>row(i+1001,{content:'same'}));
 const f=fixture();await f.inspect(left,right);await f.scan();f.group();const ids=[];
 do{ids.push(...f.get('dupcmp-members').children.map(c=>c.dataset.memoryId));if(f.get('dupcmp-members-next').disabled)break;f.click('dupcmp-members-next');}while(true);
 assert.deepEqual(ids,[...left,...right].map(r=>r.id));assert.equal(new Set(ids).size,2000);
});
test('review: same content digest is not a UI group identifier',async()=>{
 const f=fixture({compareMemorySnapshotDuplicates:async(...a)=>{
  const r=await contract.compareMemorySnapshotDuplicates(...a);
  return {...r,groups:r.groups.map(g=>({...g,content_sha256:'0'.repeat(64)}))};
 }});await f.inspect([...pair(1,'A'),...pair(3,'B')],[...pair(1,'A'),...pair(3,'B')]);await f.scan();
 const nodes=f.get('dupcmp-groups').children;assert.notEqual(nodes[0].dataset.groupIndex,nodes[1].dataset.groupIndex);
 f.group(0);const first=f.get('dupcmp-members').children[0].dataset.memoryId;f.group(1);
 assert.notEqual(f.get('dupcmp-members').children[0].dataset.memoryId,first);
});
test('review: parent mutation observer clears rendered metadata synchronously',async()=>{
 const f=fixture();await f.inspect();await f.scan();f.group();f.get('workspace').hidden=true;f.mutate('workspace');
 assert.equal(f.get('dupcmp-panel').hidden,true);assert.equal(f.get('dupcmp-files').textContent,'');assert.equal(f.run('duplicateCompareReport'),null);
});
test('review: unknown category fails closed instead of showing all records',async()=>{
 const f=fixture();await f.inspect();await f.scan();f.filter('__proto__');assert.equal(f.run('duplicateCompareReport'),null);
 assert.equal(f.get('dupcmp-groups').children.length,0);
});
test('review: computed report does not mutate already inspected files',async()=>{
 const f=fixture();await f.inspect();const before=f.run('JSON.stringify([inspectorData.left,inspectorData.right])');await f.scan();f.group();
 f.filter('changed');f.click('dupcmp-close');assert.equal(f.run('JSON.stringify([inspectorData.left,inspectorData.right])'),before);
});
test('review: fixed metadata panel contains no body retrieval/export/storage/data IO calls',()=>{
 const code=readFileSync(new URL('../web/personal/snapshot-duplicate-compare-ui.js',import.meta.url),'utf8');
 for(const forbidden of ['readMemorySnapshotRecord','innerHTML','localStorage','sessionStorage','fetch(','api(','download(','setInterval(','include_text'])
  assert.ok(!code.includes(forbidden),forbidden);
 const html=readFileSync(new URL('../web/personal/index.html',import.meta.url),'utf8');
 assert.match(html,/<section id="dupcmp-panel" class="panel" hidden/);assert.match(html,/<input type="checkbox" id="dupcmp-consent">/);
});
test('review: fixed HTTP asset preserves CSP/no-store without database reads',async t=>{
 let calls=0;const server=await startPersonalConsole({engine:{kind:'postgres',transaction:()=>assert.fail('No DB work'),executeRaw:async()=>{calls++;return [{id:'selected'}];}},
  source:'selected',token:'a'.repeat(64),port:0});t.after(()=>server.close());
 const r=await fetch(server.origin+'/snapshot-duplicate-compare-ui.js');assert.equal(r.status,200);
 assert.equal(r.headers.get('cache-control'),'no-store');assert.match(r.headers.get('content-security-policy'),/script-src 'self'/);
 assert.equal(r.headers.get('access-control-allow-origin'),null);assert.equal(await r.text(),readFileSync(new URL('../web/personal/snapshot-duplicate-compare-ui.js',import.meta.url),'utf8'));
 for(const p of ['/snapshot-duplicate-compare-ui.js?file=other','/snapshot-duplicate-compare-ui.js/extra'])assert.equal((await fetch(server.origin+p)).status,404);
 assert.equal(calls,1);
});
test('review: group selection is visibly identified and discarded by refiltering',async()=>{
 const f=fixture();await f.inspect([...pair(1,'A'),...pair(3,'B')],[...pair(1,'A'),...pair(3,'B')]);await f.scan();
 f.group(0);assert.equal(f.get('dupcmp-groups').children[0].dataset.selected,'true');
 f.group(1);assert.equal(f.get('dupcmp-groups').children[0].dataset.selected,'false');assert.equal(f.get('dupcmp-groups').children[1].dataset.selected,'true');
 f.filter('unchanged');assert.ok(f.get('dupcmp-groups').children.every(n=>n.dataset.selected!=='true'));assert.equal(f.get('dupcmp-detail').hidden,true);
});
test('review: additive CI keeps original smoke checks and both operating systems',()=>{
 const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
 const portable=read('.github/workflows/client-portability.yml'),smoke=read('.github/workflows/personal-overview-smoke.yml');
 assert.ok(portable.includes('windows-2025')&&portable.includes('ubuntu-24.04'));
 assert.ok(portable.includes('run: node --test test/personal-snapshot-duplicate-compare-ui.test.mjs test/personal-snapshot-duplicate-compare-review.test.mjs'));
 for(const previous of ['personal-overview-http-browser','personal-snapshot-duplicates-http-browser'])
  assert.ok(smoke.indexOf('node test/'+previous+'.mjs')<smoke.indexOf('node test/personal-snapshot-duplicate-compare-http-browser.mjs'));
 for(const name of ['duplicate-compare-ui.json','duplicate-compare-ui.png','duplicate-compare-ui-mobile.png'])assert.ok(smoke.includes(name));
});
