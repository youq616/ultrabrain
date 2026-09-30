/** Separate implementer audit, not a second-agent review. */
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {join,basename} from 'node:path';import {tmpdir} from 'node:os';import {syncBuiltinESMExports} from 'node:module';
import {CaptureOutbox} from '../src/capture-outbox.mjs';
import {retireCaptureLock,RETIRED_CAPTURE_LOCK} from '../src/capture-lock-retirement.mjs';
import {captureLockDiagnostic} from '../src/capture-lock.mjs';import {sha256} from '../src/core.mjs';
function setup(t){
 const root=fs.mkdtempSync(join(tmpdir(),'ub-retire-audit-')),workspace=join(root,'work');fs.mkdirSync(workspace,{mode:0o700});
 const platform=Object.getOwnPropertyDescriptor(process,'platform');Object.defineProperty(process,'platform',{...platform,value:'win32'});
 const input={format:1,source:'synthetic',allow_capture:true,workspace,outbox_directory:join(root,'queue'),expected_actor:'a'.repeat(64),expected_instance:'11111111-1111-4111-8111-111111111111',server:{transport:'stdio',command:'NEVER_RUN',args:[]}};
 const q=new CaptureOutbox(input);t.after(()=>{Object.defineProperty(process,'platform',platform);fs.rmSync(root,{recursive:true,force:true});});return {root,input,q};
}
function patch(t,name,fn){const native=fs[name];fs[name]=(...a)=>fn(native,...a);syncBuiltinESMExports();t.after(()=>{fs[name]=native;syncBuiltinESMExports();});return ()=>{fs[name]=native;syncBuiltinESMExports();};}
test('retirement audit: cleanup error preserves evidence, later status counts it without repairing it',async t=>{
 const {q}=setup(t);const restore=patch(t,'unlinkSync',(native,p,...a)=>{if(RETIRED_CAPTURE_LOCK.test(basename(p)))throw Object.assign(Error('PRIVATE'),{code:'EPERM'});return native(p,...a);});
 await assert.rejects(q.status(),e=>captureLockDiagnostic(e).retirement.namespace_state==='released');restore();
 const names=fs.readdirSync(q.directory).filter(n=>RETIRED_CAPTURE_LOCK.test(n));assert.equal(names.length,1);
 const before=fs.readFileSync(join(q.directory,names[0]));assert.equal((await q.status()).retired_lock_files,1);
 await q.enqueue({agent_id:'fixture',event_id:'one',consent:true,transcript:'SYNTHETIC'});
 assert.equal((await q.status()).pending,1);assert.deepEqual(fs.readFileSync(join(q.directory,names[0])),before);
});
test('retirement audit: retirement residue cannot authorize rebinding an unbound directory',async t=>{
 const {q}=setup(t);const name='.retired-queue-11111111-1111-4111-8111-111111111111.lock';fs.writeFileSync(join(q.directory,name),'synthetic',{mode:0o600});
 await assert.rejects(q.status(),{code:'outbox_unbound'});assert.equal(fs.existsSync(join(q.directory,'binding.json')),false);assert.equal(fs.readFileSync(join(q.directory,name),'utf8'),'synthetic');
});
test('retirement audit: explicit recovery leaves a newly claimed same name intact',async t=>{
 const {q}=setup(t);await q.status();const path=join(q.directory,'.queue.lock'),bytes=Buffer.from('{"pid":null,"lock_id":"operator-selected"}');fs.writeFileSync(path,bytes,{mode:0o600});
 const observed=q.inspectLock('queue');const fd=fs.openSync(path,'r');
 try{const r=q.recoverLock('queue',observed.sha256,{writerStopped:true});assert.equal(r.payloads_deleted,0);await q.status();const read=Buffer.alloc(bytes.length);assert.equal(fs.readSync(fd,read,0,read.length,0),read.length);assert.deepEqual(read,bytes);}
 finally{fs.closeSync(fd);}
 assert.equal((await q.status()).retired_lock_files,0);
});
test('retirement audit: recovery still requires confirmation and unchanged lock hash',async t=>{
 const {q}=setup(t);await q.status();const path=join(q.directory,'.queue.lock'),bytes=Buffer.from('{"pid":null}');fs.writeFileSync(path,bytes,{mode:0o600});
 assert.throws(()=>q.recoverLock('queue',sha256(bytes)),{code:'invalid_params'});
 assert.throws(()=>q.recoverLock('queue','0'.repeat(64),{writerStopped:true}),{code:'conflict'});assert.deepEqual(fs.readFileSync(path),bytes);
});
test('retirement audit: private journal byte accounting does not stat disappearing retirement files',async t=>{
 const {q}=setup(t);await q.status();const path=join(q.directory,'.retired-queue-11111111-1111-4111-8111-111111111111.lock');fs.writeFileSync(path,'synthetic',{mode:0o600});
 let removed=false;patch(t,'readdirSync',(native,p,...a)=>{const names=native(p,...a);if(p===q.directory&&names.includes(basename(path))&&!removed){fs.unlinkSync(path);removed=true;}return names;});
 await q.enqueue({agent_id:'fixture',event_id:'one',consent:true,transcript:'SYNTHETIC'});assert.equal(removed,true);assert.equal((await q.status()).pending,1);
});
test('retirement audit: native permission failure on acquisition remains one attempt',async t=>{
 const {q}=setup(t);let attempts=0;patch(t,'openSync',(native,p,...a)=>{if(p===join(q.directory,'.queue.lock')){attempts++;throw Object.assign(Error('PRIVATE'),{code:'EPERM'});}return native(p,...a);});
 await assert.rejects(q.status(),e=>captureLockDiagnostic(e).phase==='create');assert.equal(attempts,1);assert.deepEqual(fs.readdirSync(q.directory),[]);
});
test('retirement audit: residue namespace is disjoint from payloads, publication temps and reusable locks',()=>{
 for(const name of ['.queue.lock','.delivery.lock','binding.json','.tmp-11111111-1111-4111-8111-111111111111','a'.repeat(64)+'.entry','.retired-queue-other.lock'])assert.equal(RETIRED_CAPTURE_LOCK.test(name),false);
});
test('retirement audit: cancellation after a critical action does not interrupt owned-lock cleanup',async t=>{
 const {q}=setup(t),controller=new AbortController();let triggered=false;
 patch(t,'renameSync',(native,a,b,...rest)=>{const value=native(a,b,...rest);if(a===join(q.directory,'.queue.lock')){triggered=true;controller.abort();}return value;});
 await q.status({signal:controller.signal});assert.equal(triggered,true);assert.ok(fs.readdirSync(q.directory).every(n=>!n.endsWith('.lock')));
});
