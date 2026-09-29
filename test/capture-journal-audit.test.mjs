/** Separate implementation review regressions. Not an independent-agent verdict. */
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
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
