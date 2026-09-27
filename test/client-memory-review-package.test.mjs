/** Wiring checks complement actual compiled/installed tests; they are not execution proof. */
import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
test('review package: new binary and library built, hashed and required in private tarball',()=>{
 const pkg=JSON.parse(read('packages/ultrabrain-client/package.json'));
 assert.equal(pkg.bin['ultrabrain-memory-review'],'dist/memory-review-cli.cjs');assert.equal(pkg.bin['ultrabrain-client'],'dist/cli.cjs');
 for(const name of ['memory-review.cjs','memory-review-cli.cjs']){assert.ok(read('scripts/build-client.mjs').split("'"+name+"'").length>=3);
  assert.ok(read('scripts/package-client.sh').includes('package/dist/'+name));}
 assert.equal(pkg.dependencies['@modelcontextprotocol/sdk'],'1.29.0');assert.equal(pkg.private,true);
});
test('review package: exact Windows/Linux unit step and installed-package integration are additive',()=>{
 const p=read('.github/workflows/client-portability.yml'),t=read('.github/workflows/task-context.yml');
 assert.ok(p.includes('windows-2025')&&p.includes('ubuntu-24.04'));assert.ok(p.includes('test/client-memory-review-boundaries.test.mjs test/client-memory-review-package.test.mjs'));
 const n=t.indexOf('run: bun test/client-memory-review-integration.mjs');assert.ok(n>t.indexOf('npm install --prefix'));assert.ok(n<t.indexOf('name: Stop only isolated database'));
 assert.ok(t.includes('memory-review-report.json'));
});
test('review package: core uses canonical exact-read validator, no direct DB/Agent/model/bulk writes',()=>{
 const s=read('src/client-memory-review.mjs');assert.ok(s.includes('clientLineageRecord('));
 assert.deepEqual([...s.matchAll(/invoke\('([^']+)'/g)].map(m=>m[1]),['ultra_memory_read','ultra_personal_review']);
 for(const x of ['executeRaw','PersonalMemoryStore','setInterval(','ultra_agent_register','ultra_memory_commit'])assert.ok(!s.includes(x));
});
