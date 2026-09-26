/** Shared WeakSet authority and fixed production asset wiring, not live database tests. */
import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import * as contract from '../src/personal-snapshot-contract.mjs';
import {inspectMemorySnapshotDuplicates,DUPLICATE_METADATA_FIELDS} from '../src/snapshot-duplicates.mjs';
import {row,envelope,encoded,hash} from './helpers/snapshot-audit-fixture.mjs';
import {inspectClientSnapshotBytes} from '../src/client-snapshot.mjs';
import {startPersonalConsole} from '../src/personal-console.mjs';
const read=name=>readFileSync(new URL('../'+name,import.meta.url),'utf8');
test('duplicate review: browser and Node re-export are the exact same auditor and metadata definition',()=>{
 assert.strictEqual(inspectMemorySnapshotDuplicates,contract.inspectMemorySnapshotDuplicates);
 assert.strictEqual(DUPLICATE_METADATA_FIELDS,contract.DUPLICATE_METADATA_FIELDS);
 const text=read('src/personal-snapshot-contract.mjs');assert.ok(!/\b(?:from|import)\s*['"]node:/.test(text));
 assert.ok(!text.includes('Buffer.byteLength'));
});
test('duplicate review: same inspected handle and CLI produce identical complete reports',async()=>{
 const data=encoded(envelope([row(1,{content:'中文🙂\r\n'}),row(2,{content:'中文🙂\r\n',status:'archived'})]));
 const file=await contract.inspectMemorySnapshotFile(data,hash);
 const report=await contract.inspectMemorySnapshotDuplicates(file);
 const cli=await inspectClientSnapshotBytes({operation:'duplicates',consent:true},[{data}]);assert.deepEqual(report,cli.result);
 assert.equal(report.groups[0].content_bytes,Buffer.byteLength('中文🙂\r\n'));
});
test('duplicate review: fabricated handles do not gain local-file authority',async()=>{
 await assert.rejects(contract.inspectMemorySnapshotDuplicates({snapshot:{memories:[]}}),{code:'snapshot_not_inspected'});
});
test('duplicate review: cancellation can be observed during a large group on both runtimes',async()=>{
 const file=await contract.inspectMemorySnapshotFile(encoded(envelope(Array.from({length:1000},(_,i)=>row(i+1,{content:'same'})))),hash);
 let cancelled=false;const timer=setTimeout(()=>{cancelled=true;},1);
 try{await assert.rejects(contract.inspectMemorySnapshotDuplicates(file,()=>{if(cancelled)throw Error('cancelled');}),/cancelled/);}
 finally{clearTimeout(timer);}
});
test('duplicate review: HTML loads the panel after its containing inspector and explorer',()=>{
 const html=read('web/personal/index.html');
 assert.ok(html.indexOf('snapshot-duplicates-ui.js')>html.indexOf('snapshot-explorer-ui.js'));
 for(const id of ['duplicates-panel','duplicates-open','duplicates-consent','duplicates-group-next','duplicates-member-next','duplicates-detail-consent'])
  assert.equal(html.split('id="'+id+'"').length-1,1);
 assert.ok(html.includes('不是可删除数量'));
});
test('duplicate review: production fixed JS/contract resources retain CSP and reject path/query expansion',async t=>{
 let queries=0;const service=await startPersonalConsole({source:'selected',token:'b'.repeat(64),port:0,
  engine:{kind:'postgres',transaction:()=>assert.fail('No transaction'),executeRaw:async()=>{queries++;return [{id:'selected'}];}}});
 t.after(()=>service.close());
 for(const path of ['/snapshot-duplicates-ui.js','/snapshot-contract.mjs']){
  const res=await fetch(service.origin+path);assert.equal(res.status,200);
  assert.equal(res.headers.get('cache-control'),'no-store');assert.match(res.headers.get('content-security-policy'),/script-src 'self'/);
  assert.equal(res.headers.get('access-control-allow-origin'),null);
  const text=await res.text();assert.ok(text.includes('inspectMemorySnapshotDuplicates'));
 }
 for(const path of ['/snapshot-duplicates-ui.js?file=private','/snapshot-duplicates-ui.js/extra','/api/duplicates'])
  assert.equal((await fetch(service.origin+path)).status,404);
 assert.equal(queries,1);
});
