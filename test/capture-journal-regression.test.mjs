/** Regression evidence against the prior exact snapshot. All data are synthetic. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CaptureOutbox} from '../src/capture-outbox.mjs';
function setup(t){
 const root=fs.mkdtempSync(join(tmpdir(),'ub-journal-regression-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const workspace=join(root,'work');fs.mkdirSync(workspace,{mode:0o700});
 return new CaptureOutbox({format:1,source:'synthetic',allow_capture:true,workspace,outbox_directory:join(root,'queue'),
 expected_actor:'a'.repeat(64),expected_instance:'11111111-1111-4111-8111-111111111111',server:{transport:'stdio',command:'never-started',args:[]}});
}
const payload={agent_id:'fixture',event_id:'stable',consent:true,transcript:'PRIVATE_SYNTHETIC_BYTES'};
function patch(method,fn){const original=fs[method];fs[method]=(...a)=>fn(original,...a);syncBuiltinESMExports();return()=>{fs[method]=original;syncBuiltinESMExports();};}
const failure=code=>Object.assign(Error('PRIVATE_NATIVE_PATH_AND_BODY'),{code});
test('journal regression: a write failure is not replaced by a close failure',async t=>{
 const q=setup(t);await q.status();let fd,closed=false;
 const restores=[patch('openSync',(native,path,...a)=>{const n=native(path,...a);if(String(path).includes('.tmp-'))fd=n;return n;}),
 patch('writeFileSync',(native,n,...a)=>{if(n===fd)throw failure('ENOSPC');return native(n,...a);}),
 patch('closeSync',(native,n,...a)=>{const v=native(n,...a);if(n===fd&&!closed){closed=true;fd=undefined;throw failure('EIO');}return v;})];
 let e;try{await q.enqueue(payload);}catch(error){e=error;}finally{restores.reverse().forEach(f=>f());}
 assert.ok(e);assert.equal(e.code,'outbox_journal_io');assert.ok(!e.message.includes('PRIVATE'));assert.equal(closed,true);
 assert.equal(fs.readdirSync(q.directory).filter(x=>x.endsWith('.entry')).length,0);
});
test('journal regression: failed temporary unlink after publication is not retried',async t=>{
 const q=setup(t);await q.status();let unlinks=0;
 const restore=patch('unlinkSync',(native,path,...a)=>{if(String(path).includes('.tmp-')){unlinks++;throw failure('EPERM');}return native(path,...a);});
 let e;try{await q.enqueue(payload);}catch(error){e=error;}finally{restore();}
 assert.ok(e);assert.equal(unlinks,1);assert.equal(e.code,'outbox_journal_io');
 assert.equal(fs.readdirSync(q.directory).filter(x=>x.endsWith('.entry')).length,1);
});
test('journal regression: publish failure preserves its prepared bytes for explicit inspection',async t=>{
 const q=setup(t);await q.status();let calls=0;
 const restore=patch('linkSync',()=>{calls++;throw failure('EACCES');});let e;
 try{await q.enqueue(payload);}catch(error){e=error;}finally{restore();}
 assert.ok(e);assert.equal(calls,1);assert.equal(fs.readdirSync(q.directory).filter(x=>x.startsWith('.tmp-')).length,1);
 assert.equal(e.code,'outbox_journal_io');assert.ok(!e.message.includes('PRIVATE'));
});
