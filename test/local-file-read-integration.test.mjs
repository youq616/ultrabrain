/** Real local files with a labelled Win32 metadata-backend seam. Not Windows execution. */
import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {readClientProfile} from '../src/client-profile-file.mjs';
import {CaptureOutbox} from '../src/capture-outbox.mjs';
function setup(t){
 const dir=fs.mkdtempSync(join(tmpdir(),'ub-file-bridge-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
 const workspace=join(dir,'work');fs.mkdirSync(workspace,{mode:0o700});
 const input={format:1,source:'synthetic',allow_capture:true,workspace,outbox_directory:join(dir,'queue'),
 expected_instance:'11111111-1111-4111-8111-111111111111',expected_actor:'a'.repeat(64),server:{transport:'stdio',command:'not-started',args:[]}};
 const path=join(dir,'profile.json');fs.writeFileSync(path,JSON.stringify(input),{mode:0o600});return {dir,input,path};
}
function backend(){
 const platform=Object.getOwnPropertyDescriptor(process,'platform'),lstat=fs.lstatSync,fstat=fs.fstatSync;
 Object.defineProperty(process,'platform',{...platform,value:'win32'});
 const wide=0x7654321089abcdefn,narrow=0x89abcdefn;
 fs.lstatSync=(...args)=>{const r=lstat(...args);if(r.isFile())r.dev=typeof r.dev==='bigint'?wide:Number(wide);return r;};
 fs.fstatSync=(...args)=>{const r=fstat(...args);r.dev=typeof r.dev==='bigint'?narrow:Number(narrow);return r;};
 syncBuiltinESMExports();return()=>{fs.lstatSync=lstat;fs.fstatSync=fstat;Object.defineProperty(process,'platform',platform);syncBuiltinESMExports();};
}
test('bridge regression: full-width path volume and narrow handle volume preserve valid profile',t=>{
 const f=setup(t),restore=backend();try{assert.deepEqual(readClientProfile(f.path).input,f.input);}finally{restore();}
});
test('bridge regression: same valid metadata permits queue write, lock release and control roundtrip',async t=>{
 const f=setup(t),restore=backend();try{
  const q=new CaptureOutbox(f.input);await q.enqueue({agent_id:'fixture',event_id:'one',consent:true,transcript:'PRIVATE_SYNTHETIC'});
  const paused=await q.pauseDelivery();assert.equal(paused.state,'paused');
  await q.resumeDelivery(paused.control_sha256,{confirm:true});const status=await q.status();assert.equal(status.pending,1);assert.equal(status.delivery.state,'running');
  assert.ok(!fs.readdirSync(q.directory).some(n=>n.endsWith('.lock')));
 }finally{restore();}
});
test('reader diagnostics: original read errno survives the queue lock wrapper',async t=>{
 const {captureLockDiagnostic}=await import('../src/capture-lock.mjs');
 const f=setup(t),q=new CaptureOutbox(f.input),open=fs.openSync,read=fs.readSync;let target,calls=0;
 fs.openSync=(path,...args)=>{const fd=open(path,...args);if(path===join(q.directory,'.queue.lock')&&!(args[0]&fs.constants.O_CREAT))target=fd;return fd;};
 fs.readSync=(fd,...args)=>{if(fd===target){calls++;throw Object.assign(Error('PRIVATE'),{code:'EIO'});}return read(fd,...args);};syncBuiltinESMExports();
 try{await assert.rejects(q.status(),error=>{const d=captureLockDiagnostic(error);assert.equal(d.system_code,'EIO');
  assert.equal(d.phase,'verify-release');assert.equal(d.file_read.reason,'io');assert.equal(d.file_read.phase,'read');return true;});assert.equal(calls,1);}
 finally{fs.openSync=open;fs.readSync=read;syncBuiltinESMExports();}
});
