/** Static packaging/wiring gates; real installed-package IO has a separate fixture. */
import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
test('overview library is built, hashed and required in the private tarball',()=>{
 const build=read('scripts/build-client.mjs'),pack=read('scripts/package-client.sh');
 assert.ok(build.includes("['overview.mjs','overview.cjs']"));assert.ok(build.split("'overview.cjs'").length>=3);
 assert.ok(pack.includes("'package/dist/overview.cjs'"));assert.ok(build.includes('Server code leaked into client'));
 assert.ok(build.includes('Online capability leaked into offline bundle'));
 const pkg=JSON.parse(read('packages/ultrabrain-client/package.json'));
 assert.equal(pkg.dependencies['@modelcontextprotocol/sdk'],'1.29.0');assert.equal(pkg.private,true);
});
test('existing portability command stays intact; overview has a separate additive step',()=>{
 const flow=read('.github/workflows/client-portability.yml');
 assert.ok(flow.includes('run: node --test test/client-overview.test.mjs test/client-overview-runtime.test.mjs test/client-overview-cli.test.mjs test/client-overview-package.test.mjs'));
 assert.ok(flow.indexOf('run: node --test test/client-overview.test.mjs test/client-overview-runtime.test.mjs test/client-overview-cli.test.mjs test/client-overview-package.test.mjs')>flow.indexOf('test/personal-overview-boundaries.test.mjs'));
 assert.ok(flow.includes('windows-2025')&&flow.includes('ubuntu-24.04'));
});
test('installed overview checks run after package installation and before database shutdown',()=>{
 const flow=read('.github/workflows/task-context.yml'),idx=flow.indexOf('run: bun test/client-overview-integration.mjs');
 assert.ok(idx>flow.indexOf('npm install --prefix'));assert.ok(idx<flow.indexOf('name: Stop only isolated database'));
 assert.ok(flow.slice(idx).includes('client-overview-report.json'));
});
test('new read core never dispatches context, files, writes or models',()=>{
 const core=read('src/client-overview.mjs');
 assert.deepEqual([...core.matchAll(/invoke\('([^']+)'/g)].map(m=>m[1]),['ultra_personal_overview']);
 for(const forbidden of ['executeRaw','PersonalMemoryStore','setInterval','configuredPersonalModel','writeFile'])assert.ok(!core.includes(forbidden));
});
