/** Packaging contracts; actual compiled/installed execution has its own CI step. */
import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';import {resolve,dirname} from 'node:path';import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const read=path=>readFileSync(resolve(root,path),'utf8');
test('offline package: dedicated executable/library shipped and hashed without replacing live CLI',()=>{
  const pkg=JSON.parse(read('packages/ultrabrain-client/package.json'));
  assert.equal(pkg.bin['ultrabrain-snapshot'],'dist/snapshot-cli.cjs');assert.equal(pkg.bin['ultrabrain-client'],'dist/cli.cjs');
  assert.equal(pkg.dependencies['@modelcontextprotocol/sdk'],'1.29.0');
  const build=read('scripts/build-client.mjs'),pack=read('scripts/package-client.sh');
  for(const name of ['snapshot.cjs','snapshot-cli.cjs']){
    assert.ok(build.split("'"+name+"'").length>=3,'Entry must occur in build and digest loops');
    assert.ok(pack.includes("'package/dist/"+name+"'"));
  }
  assert.ok(build.includes('Online capability leaked into offline bundle'));assert.ok(build.includes('Server code leaked into client'));
});
test('offline package: static import closure contains only approved builtins and local modules',()=>{
  const pending=['packages/ultrabrain-client/src/snapshot.mjs','packages/ultrabrain-client/src/snapshot-cli.mjs'].map(p=>resolve(root,p));
  const seen=new Set(),builtins=new Set(['node:fs','node:fs/promises','node:path','node:crypto','node:timers/promises']);
  while(pending.length){
    const file=pending.pop();if(seen.has(file))continue;seen.add(file);const code=readFileSync(file,'utf8');
    assert.ok(!code.includes('process.env'),'Offline runtime must not load credentials or environment profiles');
    for(const match of code.matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]/g)){
      const name=match[1];if(name.startsWith('.'))pending.push(resolve(dirname(file),name));else assert.ok(builtins.has(name),name);
    }
  }
  // Exact independent membership, not a count that could hide module substitution.
  const expected=['packages/ultrabrain-client/src/snapshot-cli.mjs','packages/ultrabrain-client/src/snapshot.mjs',
    'src/client-authorization.mjs','src/client-snapshot-files.mjs','src/client-snapshot.mjs','src/core.mjs',
    'src/personal-lineage-contract.mjs','src/personal-snapshot-contract.mjs','src/snapshot-duplicates.mjs',
    'src/snapshot-impact.mjs','src/snapshot-lineage-audit.mjs'];
  assert.deepEqual([...seen].sort(),expected.map(p=>resolve(root,p)).sort());
});
test('offline package: portability includes all new suites without dropping lineage or Windows',()=>{
  const flow=read('.github/workflows/client-portability.yml');
  for(const name of ['client-snapshot-impact','client-snapshot-impact-boundaries','client-snapshot-impact-cli','client-snapshot-navigation','client-snapshot-trace','client-snapshot-trace-cli','client-snapshot-audit','client-snapshot-audit-cli','client-snapshot','client-snapshot-files','client-snapshot-races','client-snapshot-cli','client-snapshot-package','client-lineage','personal-snapshot-inspector'])
    assert.ok(flow.includes('test/'+name+'.test.mjs'),name);
  assert.ok(flow.includes('windows-2025'));
});
