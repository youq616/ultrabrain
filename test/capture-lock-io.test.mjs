/** Actual lock IO with individually injected native failures; no real Windows claim. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {CaptureOutbox} from '../src/capture-outbox.mjs';
import {captureLockDiagnostic} from '../src/capture-lock.mjs';
function setup(t){
 const root=fs.mkdtempSync(join(tmpdir(),'ub-lock-io-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const workspace=join(root,'work');fs.mkdirSync(workspace,{mode:0o700});
 const q=new CaptureOutbox({format:1,source:'personal',allow_capture:true,workspace,outbox_directory:join(root,'queue'),
  expected_actor:'a'.repeat(64),expected_instance:'11111111-1111-4111-8111-111111111111',server:{transport:'stdio',command:'not-started',args:[]}});
 return {q,lock:join(q.directory,'.queue.lock')};
}
function patch(method,handler){const original=fs[method];fs[method]=(...args)=>handler(original,...args);syncBuiltinESMExports();
 return ()=>{fs[method]=original;syncBuiltinESMExports();};}
for(const code of ['EPERM','EACCES','EBUSY'])test('lock IO: exclusive-open '+code+' remains a failure, not silent retry',async t=>{
 const {q,lock}=setup(t);let calls=0;const restore=patch('openSync',(native,path,...args)=>{
  if(path===lock){calls++;throw Object.assign(Error('PRIVATE_PATH'),{code});}return native(path,...args);
 });
 try{await assert.rejects(q.status(),e=>{assert.deepEqual(captureLockDiagnostic(e),{kind:'queue',phase:'create',system_code:code});return e.code==='outbox_lock_io';});}
 finally{restore();}
 assert.equal(calls,1);assert.deepEqual(fs.readdirSync(q.directory),[]);
});
for(const phase of ['write','file-sync','close'])test('lock IO: failed initialization preserves incomplete lock '+phase,async t=>{
 const {q,lock}=setup(t);let fd,opens=0,triggered=0;
 const restoreOpen=patch('openSync',(native,path,...args)=>{const n=native(path,...args);if(path===lock){fd=n;opens++;}return n;});
 const method=phase==='write'?'writeFileSync':phase==='file-sync'?'fsyncSync':'closeSync';
 const restore=patch(method,(native,n,...args)=>{
  if(n===fd&&!triggered++){
   // Close the real descriptor even for a simulated close error, then report it.
   if(phase==='close')native(n,...args);
   throw Object.assign(Error('PRIVATE_NATIVE'),{code:'EIO'});
  }return native(n,...args);
 });
 try{await assert.rejects(q.status(),e=>e.code==='outbox_lock_io'&&captureLockDiagnostic(e).phase===phase);}
 finally{restore();restoreOpen();}
 assert.equal(opens,1);assert.equal(fs.existsSync(lock),true);assert.equal(fs.existsSync(join(q.directory,'binding.json')),false);
 assert.equal(fs.readdirSync(q.directory).filter(x=>x.endsWith('.entry')).length,0);
});
test('lock IO: replaced lock is preserved on release; no foreign unlink',async t=>{
 const {q,lock}=setup(t);let opens=0,originalBytes;
 const restore=patch('openSync',(native,path,...args)=>{
  // First open creates lock; second reads it for release verification.
  if(path===lock&&++opens===2){originalBytes=fs.readFileSync(path);fs.writeFileSync(path,JSON.stringify({pid:process.pid,lock_id:'OTHER_LOCK'}));}
  return native(path,...args);
 });
 try{await assert.rejects(q.status(),e=>e.code==='outbox_lock_changed'||e.code==='outbox_corrupt');}
 finally{restore();}
 assert.ok(originalBytes);assert.match(fs.readFileSync(lock,'utf8'),/OTHER_LOCK/);
});
test('lock IO: failed unlink is not retried and preserves complete lock',async t=>{
 const {q,lock}=setup(t);let n=0;const restore=patch('unlinkSync',(native,path,...args)=>{
  if(path===lock){n++;throw Object.assign(Error('PRIVATE'),{code:'EPERM'});}return native(path,...args);
 });
 try{await assert.rejects(q.status(),e=>e.code==='outbox_lock_io'&&captureLockDiagnostic(e).phase==='unlink');}finally{restore();}
 assert.equal(n,1);assert.ok(fs.existsSync(lock));assert.ok(fs.existsSync(join(q.directory,'binding.json')));
});
