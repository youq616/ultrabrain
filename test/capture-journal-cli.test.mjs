import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {join} from 'node:path';import {fileURLToPath} from 'node:url';import {spawnSync} from 'node:child_process';
import {setupJournal,payload} from './helpers/capture-journal-fixture.mjs';
const cli=fileURLToPath(new URL('../packages/ultrabrain-client/src/cli.mjs',import.meta.url));
const preload=new URL('./fixtures/capture-journal-cli-preload.mjs',import.meta.url).href;
for(const command of ['queue-capture','queue-status'])test('journal CLI: '+command+' emits safe publication facts, no plaintext or paths',async t=>{
 const {root,input,q}=setupJournal(t);if(command==='queue-capture')await q.status();
 const file=join(root,'profile.json');fs.writeFileSync(file,JSON.stringify(input),{mode:0o600});
 const result=spawnSync(process.execPath,['--import',preload,cli,command,'--profile',file],{input:JSON.stringify(payload),encoding:'utf8',timeout:10000,
  env:{...process.env,ULTRABRAIN_JOURNAL_FIXTURE:command==='queue-status'?'binding':'entry'}});
 assert.ifError(result.error);assert.equal(result.status,1);assert.equal(result.stderr,'');const r=JSON.parse(result.stdout);
 assert.equal(r.error,'outbox_journal_io');assert.equal(r.journal.target,command==='queue-status'?'binding':'entry');
 assert.equal(r.journal.phase,'publish');assert.equal(r.journal.system_code,'EPERM');assert.equal(r.journal.publication,'unconfirmed');
 assert.equal(r.delivery,command==='queue-status'?'not_submitted':'unconfirmed');assert.equal(r.lock,undefined);
 assert.ok(!result.stdout.includes(root)&&!result.stdout.includes('PRIVATE'));assert.equal(fs.readdirSync(q.directory).filter(n=>n.endsWith('.entry')).length,0);
 assert.equal(fs.readdirSync(q.directory).filter(n=>n.startsWith('.tmp-')).length,1);
});
