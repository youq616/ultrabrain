import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const pkg=JSON.parse(readFileSync(new URL('../packages/ultrabrain-client/package.json',import.meta.url),'utf8'));
const expected=`ultrabrain-client-${pkg.version}.tgz`;
for(const path of ['docs/CLIENT-KIT.md','docs/NATIVE-AGENT-ADAPTERS.md','docs/AUTOMATIC-CAPTURE.md']) {
  test('current installation recipe names the actual client archive: '+path,()=>{
    const source=readFileSync(new URL('../'+path,import.meta.url),'utf8');
    const archives=source.match(/ultrabrain-client-[0-9][A-Za-z0-9.\-]*\.tgz/g)??[];
    assert.ok(archives.length>0,'Installation recipe must name the generated archive');
    assert.ok(archives.every(name=>name===expected),'Stale archive reference; expected '+expected);
  });
}
