/** Shared algorithm identity, browser-loadability and real console fixed assets. */
import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import * as contract from '../src/personal-snapshot-contract.mjs';
import * as legacy from '../src/snapshot-duplicates.mjs';
import {hash,encoded,envelope,row} from './helpers/snapshot-audit-fixture.mjs';
import {startPersonalConsole} from '../src/personal-console.mjs';
const code=readFileSync(new URL('../src/personal-snapshot-contract.mjs',import.meta.url),'utf8');
test('duplicate shared: wrapper and browser contract expose the same function and fields',()=>{
 assert.equal(legacy.inspectMemorySnapshotDuplicates,contract.inspectMemorySnapshotDuplicates);
 assert.equal(legacy.DUPLICATE_METADATA_FIELDS,contract.DUPLICATE_METADATA_FIELDS);
});
test('duplicate shared: canonical module loads from a URL with no Node builtins or Buffer',async()=>{
 assert.ok(!/node:|\bBuffer\b|\bfetch\(/.test(code));
 const browser=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
 const data=encoded(envelope([row(1,{content:'same'}),row(2,{content:'same'}),row(3)]));
 const file=await browser.inspectMemorySnapshotFile(data,hash);
 const report=await browser.inspectMemorySnapshotDuplicates(file);
 const nodeFile=await contract.inspectMemorySnapshotFile(data,hash);
 assert.deepEqual(report,await legacy.inspectMemorySnapshotDuplicates(nodeFile));
 await assert.rejects(legacy.inspectMemorySnapshotDuplicates(file),{code:'snapshot_not_inspected'});
});
test('duplicate shared: every previous canonical browser operation remains exported',()=>{
 for(const name of ['verifyMemorySnapshot','inspectMemorySnapshotFile','compareMemorySnapshots','queryMemorySnapshot','readMemorySnapshotRecord','parseSnapshotJSON'])
  assert.equal(typeof contract[name],'function');
});
test('duplicate shared: original input and inspected files remain unchanged',async()=>{
 const data=encoded(envelope([row(1,{content:'same'}),row(2,{content:'same'})])),before=hash(data);
 const file=await contract.inspectMemorySnapshotFile(data,hash),json=JSON.stringify(file);
 await contract.inspectMemorySnapshotDuplicates(file);
 assert.equal(hash(data),before);assert.equal(JSON.stringify(file),json);assert.ok(Object.isFrozen(file));
});
test('duplicate HTTP: only fixed script and shared contract are served under original CSP',async t=>{
 let calls=0;const service=await startPersonalConsole({engine:{kind:'postgres',transaction:()=>assert.fail('No static resource transaction'),executeRaw:async()=>{calls++;return [{id:'selected'}];}},source:'selected',token:'a'.repeat(64),port:0});
 t.after(()=>service.close());
 for(const path of ['/snapshot-duplicates-ui.js','/snapshot-contract.mjs']){
  const response=await fetch(service.origin+path);assert.equal(response.status,200);
  assert.equal(response.headers.get('cache-control'),'no-store');assert.match(response.headers.get('content-security-policy'),/script-src 'self'/);
  assert.equal(response.headers.get('access-control-allow-origin'),null);
  const text=await response.text();for(const forbidden of ['innerHTML','localStorage','sessionStorage','unsafe-eval'])assert.ok(!text.includes(forbidden));
 }
 for(const path of ['/snapshot-duplicates-ui.js?file=other','/snapshot-duplicates-ui.js/extra'])assert.equal((await fetch(service.origin+path)).status,404);
 const html=await (await fetch(service.origin)).text();assert.ok(html.includes('id="duplicates-panel"'));
 const scripts=[...html.matchAll(/<script src="([^"]+)" defer>/g)].map(m=>m[1]);
 assert.deepEqual(scripts,['/app.js','/snapshot-ui.js','/snapshot-inspector-ui.js','/snapshot-explorer-ui.js','/snapshot-duplicates-ui.js','/snapshot-duplicate-compare-ui.js','/lineage-ui.js','/overview-ui.js']);
 assert.equal(calls,1,'Static loads must not call the database');
});
