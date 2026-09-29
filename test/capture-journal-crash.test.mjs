import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {join} from 'node:path';import {fileURLToPath} from 'node:url';import {spawnSync} from 'node:child_process';
import {CaptureOutbox} from '../src/capture-outbox.mjs';import {sha256} from '../src/core.mjs';
import {setupJournal,payload} from './helpers/capture-journal-fixture.mjs';
const worker=fileURLToPath(new URL('./fixtures/capture-journal-crash-worker.mjs',import.meta.url));
const phases=['create','write','file-sync','close','publish','temporary-unlink',...(process.platform==='win32'?[]:['directory-sync'])];
for(const phase of phases)test('journal crash: independent process exits after '+phase+'; reopening never invents a confirmation',async t=>{
 const {root,input,q}=setupJournal(t);await q.status();const manifest=fs.readFileSync(join(q.directory,'binding.json'));
 const profile=join(root,'profile.json');fs.writeFileSync(profile,JSON.stringify(input),{mode:0o600});
 const child=spawnSync(process.execPath,[worker,profile,phase,'create'],{timeout:10000,encoding:'utf8'});
 assert.ifError(child.error);assert.equal(child.status,73,child.stderr);assert.equal(child.stdout,'');assert.equal(child.stderr,'');
 const reopened=new CaptureOutbox(input),lock=reopened.inspectLock('queue');
 assert.equal(lock.pid,child.pid);assert.equal(lock.requires_writer_stopped,true);
 const before=fs.readdirSync(q.directory).sort();assert.ok(before.includes('.queue.lock'));
 assert.equal(reopened.recoverLock('queue',lock.sha256,{writerStopped:true}).payloads_deleted,0);
 assert.deepEqual(fs.readFileSync(join(q.directory,'binding.json')),manifest);
 const entry=join(q.directory,sha256(payload.event_id)+'.entry'),visible=['publish','temporary-unlink','directory-sync'].includes(phase);
 assert.equal(fs.existsSync(entry),visible);
 if(visible){const record=JSON.parse(fs.readFileSync(entry));assert.deepEqual(record.payload,payload);assert.equal(record.attempts,0);}
 if(phase==='publish'){
  // Two hard-link names are deliberately rejected. No automatic unlink/promote.
  assert.equal(fs.statSync(entry).nlink,2);const preserved=fs.readdirSync(q.directory).sort();
  await assert.rejects(reopened.status(),{code:'outbox_corrupt'});assert.deepEqual(fs.readdirSync(q.directory).sort(),preserved);
 }else{
  const status=await reopened.status();assert.equal(status.pending,visible?1:0);assert.equal(status.blocked,0);
  assert.equal(status.temporary_files,visible?0:1);
  if(visible){assert.equal((await reopened.enqueue(payload)).replayed,true);await assert.rejects(reopened.enqueue({...payload,transcript:'CHANGED'}),{code:'conflict'});}
 }
});
for(const phase of ['file-sync','publish'])test('journal crash: interrupted replacement at '+phase+' preserves immutable event and attempt boundary',async t=>{
 const {root,input,q}=setupJournal(t);await q.enqueue(payload);const profile=join(root,'profile.json');fs.writeFileSync(profile,JSON.stringify(input),{mode:0o600});
 const child=spawnSync(process.execPath,[worker,profile,phase,'replace'],{timeout:10000,encoding:'utf8'});
 assert.ifError(child.error);assert.equal(child.status,73,child.stderr);assert.equal(child.stdout,'');assert.equal(child.stderr,'');
 const reopened=new CaptureOutbox(input);
 for(const kind of ['queue','delivery']){const lock=reopened.inspectLock(kind);assert.equal(lock.pid,child.pid);reopened.recoverLock(kind,lock.sha256,{writerStopped:true});}
 const entry=join(q.directory,sha256(payload.event_id)+'.entry'),r=JSON.parse(fs.readFileSync(entry));
 assert.deepEqual(r.payload,payload);assert.equal(r.attempts,phase==='publish'?1:0);assert.equal((await reopened.status()).pending,1);
 if(phase==='publish'){let connections=0;const result=await reopened.flush(()=>{connections++;throw Error('NO_SEND');});assert.equal(result.skipped,1);assert.equal(connections,0);}
});
