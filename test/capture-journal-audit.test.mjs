/** Separate implementation review regressions. Not an independent-agent verdict. */
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {join} from 'node:path';
import {automaticCapture} from '../src/automatic-capture.mjs';
import {CaptureOutbox} from '../src/capture-outbox.mjs';
import {UltraError} from '../src/core.mjs';
import {captureJournalDiagnostic} from '../src/capture-journal.mjs';
import {setupJournal,patchFS,ioError,payload} from './helpers/capture-journal-fixture.mjs';
for(const action of ['enqueue','flush'])test('audit: '+action+' preserves journal cause across failed lock releases',async t=>{
 const {q}=setupJournal(t);if(action==='flush')await q.enqueue(payload);else await q.status();const attempted=[];let faulted=false;
 const restores=[patchFS(action==='flush'?'renameSync':'linkSync',()=>{faulted=true;throw ioError('ENOSPC');}),
 patchFS('unlinkSync',(native,path,...a)=>{if(faulted&&String(path).endsWith('.lock')){attempted.push(path.endsWith('.queue.lock')?'queue':'delivery');throw ioError('EPERM');}return native(path,...a);})];
 let e;try{if(action==='flush')await q.flush(()=>assert.fail('No connection'));else await q.enqueue(payload);}catch(error){e=error;}finally{restores.reverse().forEach(r=>r());}
 assert.equal(e.code,'outbox_journal_io');const d=captureJournalDiagnostic(e);assert.equal(d.phase,'publish');assert.equal(d.system_code,'ENOSPC');
 assert.deepEqual(d.lock_release.map(v=>v.kind),action==='flush'?['queue','delivery']:['queue']);assert.deepEqual(attempted,d.lock_release.map(v=>v.kind));
 assert.ok(Object.isFrozen(d.lock_release));assert.ok(d.lock_release.every(v=>Object.isFrozen(v)&&v.phase==='unlink'&&v.system_code==='EPERM'));
 assert.ok(!JSON.stringify(d).includes('PRIVATE'));assert.equal(fs.readdirSync(q.directory).filter(n=>n.endsWith('.entry')).length,action==='flush'?1:0);
});

// The automatic manager has the same receipt-preserving delivery boundary.
for(const kind of ['journal','lock','forged'])test('audit: automatic capture retains authentic '+kind+' details after enqueue',async t=>{
 const {root,input,q}=setupJournal(t);input.automatic_capture=['claude-user'];
 const profile=join(root,'profile.json');fs.writeFileSync(profile,JSON.stringify(input),{mode:0o600});
 const manager=automaticCapture(profile,()=>assert.fail('No server connection'),{authorizedProfileInput:input});
 const restores=[];
 if(kind==='journal')restores.push(patchFS('renameSync',()=>{throw ioError('ENOSPC');}));
 else if(kind==='lock')restores.push(patchFS('openSync',(native,path,...a)=>{if(String(path).endsWith('.delivery.lock'))throw ioError('EPERM');return native(path,...a);}));
 else t.mock.method(CaptureOutbox.prototype,'flush',async()=>{
  const e=new UltraError('outbox_journal_io','PRIVATE_FORGED_ERROR');Object.defineProperty(e,'journal',{get(){assert.fail('No diagnostic getters');}});throw e;
 });
 let result;try{result=await manager.submit(payload,input.workspace,'claude-user');}finally{restores.reverse().forEach(r=>r());manager.close();}
 assert.equal(result.storage,'client_journal');assert.equal(result.event_id,payload.event_id);assert.equal(result.delivery.retained,1);assert.equal(result.delivery.delivered,0);
 if(kind==='journal'){assert.equal(result.delivery.journal.phase,'publish');assert.equal(result.delivery.journal.operation,'replace');assert.equal(result.delivery.journal.system_code,'ENOSPC');}
 else if(kind==='lock')assert.deepEqual(result.delivery.lock,{kind:'delivery',phase:'create',system_code:'EPERM'});
 else{assert.equal(result.delivery.journal,undefined);assert.equal(result.delivery.lock,undefined);}
 assert.ok(!JSON.stringify(result).includes('PRIVATE'));const record=JSON.parse(fs.readFileSync(join(q.directory,fs.readdirSync(q.directory).find(n=>n.endsWith('.entry')))));
 assert.deepEqual(record.payload,payload);assert.equal(record.attempts,0);
});
