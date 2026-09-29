import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
const cli=fileURLToPath(new URL('../packages/ultrabrain-client/src/queue-audit-cli.mjs',import.meta.url));
for(const args of [['--help'],[],['--repair'],['--profile','PRIVATE_MISSING'],['--profile','x','--force']])test('standalone audit argument boundary '+JSON.stringify(args),()=>{
 const r=spawnSync(process.execPath,[cli,...args],{encoding:'utf8',timeout:5000});assert.ifError(r.error);assert.equal(r.stderr,'');
 assert.equal(r.status,args[0]==='--help'?0:1);assert.ok(!r.stdout.includes('PRIVATE_MISSING'));
 if(args[0]!=='--help'){const value=JSON.parse(r.stdout);assert.equal(value.read_only,true);assert.equal(value.server_confirmation,false);}
});
test('standalone bin and build artifact are wired without weakening snapshot offline gate',()=>{
 const pkg=JSON.parse(readFileSync(new URL('../packages/ultrabrain-client/package.json',import.meta.url)));
 assert.equal(pkg.bin['ultrabrain-queue-audit'],'dist/queue-audit-cli.cjs');
 const build=readFileSync(new URL('../scripts/build-client.mjs',import.meta.url),'utf8');
 assert.ok(build.includes("['queue-audit-cli.mjs','queue-audit-cli.cjs']"));
 assert.ok(build.includes("name.startsWith('snapshot')?['readClientProfile']:[]"));
});
