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

// Independent review 5348163898 / discussion4130007887: the inner delivery
// catch must preserve the local enqueue receipt AND authentic failure detail.
for(const mode of ['attempt','attempt-release','delivery-lock','forged'])test('journal CLI: post-enqueue '+mode+' preserves queued receipt and diagnostic provenance',async t=>{
 const {root,input,q}=setupJournal(t);const file=join(root,'profile.json');
 fs.writeFileSync(file,JSON.stringify(input),{mode:0o600});
 const child=spawnSync(process.execPath,['--import',preload,cli,'queue-capture','--profile',file],{
  input:JSON.stringify(payload),encoding:'utf8',timeout:10000,env:{...process.env,ULTRABRAIN_JOURNAL_FIXTURE:mode}});
 assert.ifError(child.error);assert.equal(child.status,1);assert.equal(child.stderr,'');const out=JSON.parse(child.stdout);
 assert.equal(out.ok,false);assert.equal(out.result.queued.storage,'client_journal');assert.equal(out.result.queued.event_id,payload.event_id);
 assert.equal(out.result.queued.replayed,false);const d=out.result.delivery;assert.equal(d.delivered,0);assert.equal(d.retained,1);
 assert.equal(d.last_error,mode==='delivery-lock'?'outbox_lock_io':'outbox_journal_io');
 if(mode.startsWith('attempt')){
  assert.equal(d.journal.target,'entry');assert.equal(d.journal.operation,'replace');assert.equal(d.journal.phase,'publish');
  assert.equal(d.journal.system_code,'ENOSPC');assert.equal(d.journal.publication,'unconfirmed');assert.equal(d.journal.directory_sync,'not_attempted');
  if(mode==='attempt-release')assert.deepEqual(d.journal.lock_release.map(x=>x.kind),['queue','delivery']);
  else assert.equal(d.journal.lock_release,undefined);
  assert.equal(d.lock,undefined);
 }else if(mode==='delivery-lock'){
  assert.deepEqual(d.lock,{kind:'delivery',phase:'create',system_code:'EPERM'});assert.equal(d.journal,undefined);
 }else{assert.equal(d.journal,undefined);assert.equal(d.lock,undefined);}
 assert.ok(!child.stdout.includes(root)&&!child.stdout.includes('PRIVATE'));
 const names=fs.readdirSync(q.directory),records=names.filter(n=>n.endsWith('.entry'));assert.equal(records.length,1);
 const r=JSON.parse(fs.readFileSync(join(q.directory,records[0])));assert.deepEqual(r.payload,payload);assert.equal(r.attempts,0);
 assert.equal(names.filter(n=>n.startsWith('.tmp-')).length,mode.startsWith('attempt')?1:0);
 assert.equal(names.filter(n=>n.endsWith('.lock')).length,mode==='attempt-release'?2:0);
});
