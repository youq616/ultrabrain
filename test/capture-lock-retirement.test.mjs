/** Real scratch-file boundaries; mocked failures are explicitly local test seams. */
import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
import {join,basename} from 'node:path';import {tmpdir} from 'node:os';
import {retireCaptureLock,RETIRED_CAPTURE_LOCK} from '../src/capture-lock-retirement.mjs';
import {captureLockDiagnostic,acquireCaptureLock} from '../src/capture-lock.mjs';
import {sha256} from '../src/core.mjs';
import {controlWorkerReport} from './helpers/capture-control-report.mjs';
function setup(t){
 const root=fs.mkdtempSync(join(tmpdir(),'ub-retirement-')),active=join(root,'.queue.lock');
 const bytes=Buffer.from('{"format":1,"lock_id":"original","pid":0}\n');fs.writeFileSync(active,bytes,{mode:0o600});
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 return {root,active,bytes,hash:sha256(bytes),retired:()=>fs.readdirSync(root).filter(n=>RETIRED_CAPTURE_LOCK.test(n)),run:(check=()=>{})=>retireCaptureLock(root,'queue',sha256(bytes),check)};
}
function patch(t,name,fn){const original=fs[name];fs[name]=(...args)=>fn(original,...args);syncBuiltinESMExports();
 t.after(()=>{fs[name]=original;syncBuiltinESMExports();});}
const fault=code=>Object.assign(Error('PRIVATE_NATIVE_PATH'),{code,path:'PRIVATE_PATH'});
for(const kind of ['queue','delivery'])test('retirement: releases reusable name while original reader remains open '+kind,t=>{
 const f=setup(t),path=join(f.root,'.'+kind+'.lock');if(kind==='delivery')fs.renameSync(f.active,path);
 const fd=fs.openSync(path,'r');try{
  retireCaptureLock(f.root,kind,f.hash,()=>{});assert.equal(fs.existsSync(path),false);
  const next=fs.openSync(path,'wx',0o600);fs.writeSync(next,'NEXT_OWNER');fs.closeSync(next);
  assert.throws(()=>fs.openSync(path,'wx',0o600),{code:'EEXIST'});
  const b=Buffer.alloc(f.bytes.length);assert.equal(fs.readSync(fd,b,0,b.length,0),b.length);assert.deepEqual(b,f.bytes);
  assert.equal(fs.readFileSync(path,'utf8'),'NEXT_OWNER');assert.deepEqual(f.retired(),[]);
 }finally{fs.closeSync(fd);}
});
test('retirement: next owner created during cleanup is never inspected or removed',t=>{
 const f=setup(t);let moved=false;
 patch(t,'renameSync',(native,a,b,...rest)=>{const r=native(a,b,...rest);if(a===f.active){moved=true;fs.writeFileSync(f.active,'NEW_OWNER',{flag:'wx',mode:0o600});}return r;});
 f.run();assert.equal(moved,true);assert.equal(fs.readFileSync(f.active,'utf8'),'NEW_OWNER');assert.deepEqual(f.retired(),[]);
});
for(const [phase,method] of [['retire-create','openSync'],['retire-write','writeFileSync'],['retire-sync','fsyncSync'],['retire-close','closeSync'],['retire-rename','renameSync'],['retire-unlink','unlinkSync']])
 test('retirement: failure retained with precise namespace state '+phase,t=>{
  const f=setup(t);let fd,calls=0;
  if(method!=='openSync')patch(t,'openSync',(native,p,...a)=>{const value=native(p,...a);if(RETIRED_CAPTURE_LOCK.test(basename(p)))fd=value;return value;});
  patch(t,method,(native,p,...a)=>{
   const hit=method==='openSync'?typeof p==='string'&&RETIRED_CAPTURE_LOCK.test(basename(p)):method==='renameSync'?p===f.active:method==='unlinkSync'?RETIRED_CAPTURE_LOCK.test(basename(p)):p===fd;
   if(hit){calls++;if(method==='closeSync')native(p,...a);throw fault('EPERM');}return native(p,...a);
  });
  assert.throws(()=>f.run(),e=>{const d=captureLockDiagnostic(e);assert.equal(d.phase,phase);assert.equal(d.system_code,'EPERM');
   assert.equal(d.retirement.namespace_state,phase==='retire-unlink'?'released':phase==='retire-rename'?'unconfirmed':'not_released');assert.ok(!JSON.stringify(d).includes('PRIVATE'));return true;});
  assert.equal(calls,1);assert.equal(fs.existsSync(f.active),phase!=='retire-unlink');
  if(phase==='retire-unlink')assert.deepEqual(fs.readFileSync(join(f.root,f.retired()[0])),f.bytes);
 });
for(const phase of ['retire-write','retire-sync'])test('retirement: first IO error survives close failure '+phase,t=>{
 const f=setup(t);let fd,closes=0;
 patch(t,'openSync',(native,p,...a)=>{const n=native(p,...a);if(RETIRED_CAPTURE_LOCK.test(basename(p)))fd=n;return n;});
 patch(t,phase==='retire-write'?'writeFileSync':'fsyncSync',(native,n,...a)=>{if(n===fd)throw fault('ENOSPC');return native(n,...a);});
 patch(t,'closeSync',(native,n,...a)=>{const r=native(n,...a);if(n===fd){closes++;throw fault('EIO');}return r;});
 assert.throws(()=>f.run(),e=>{const d=captureLockDiagnostic(e);assert.equal(d.phase,phase);assert.equal(d.system_code,'ENOSPC');assert.equal(d.retirement.close_failed,true);return true;});assert.equal(closes,1);
});
for(const error of [undefined,null,false,0,'PRIVATE',{get code(){throw Error('PRIVATE');}}])test('retirement: opaque thrown value cannot bypass reserve failure',t=>{
 const f=setup(t);let renames=0;
 patch(t,'writeFileSync',(native,n,...a)=>{if(typeof n==='number')throw error;return native(n,...a);});
 patch(t,'renameSync',(native,...a)=>{renames++;return native(...a);});
 assert.throws(()=>f.run(),e=>captureLockDiagnostic(e).phase==='retire-write');assert.equal(renames,0);assert.deepEqual(fs.readFileSync(f.active),f.bytes);
});
test('retirement: changed active lock is not renamed',t=>{
 const f=setup(t);fs.writeFileSync(f.active,'ANOTHER_OWNER');let renamed=0;
 patch(t,'renameSync',(native,...a)=>{renamed++;return native(...a);});
 assert.throws(()=>f.run(),{code:'outbox_lock_changed'});assert.equal(renamed,0);assert.equal(f.retired().length,0);
});
test('retirement: altered exclusive reservation is not overwritten',t=>{
 const f=setup(t);let checks=0,renamed=0;
 patch(t,'renameSync',(native,...a)=>{renamed++;return native(...a);});
 assert.throws(()=>f.run(()=>{if(++checks===2)fs.writeFileSync(join(f.root,f.retired()[0]),'FOREIGN_RESERVATION');}),{code:'outbox_lock_changed'});
 assert.equal(renamed,0);assert.equal(fs.readFileSync(join(f.root,f.retired()[0]),'utf8'),'FOREIGN_RESERVATION');
});
test('retirement: moved bytes are rechecked before deletion',t=>{
 const f=setup(t);let unlinks=0;
 patch(t,'renameSync',(native,a,b,...rest)=>{const r=native(a,b,...rest);fs.writeFileSync(b,'FOREIGN_MOVED');return r;});
 patch(t,'unlinkSync',(native,...a)=>{unlinks++;return native(...a);});
 assert.throws(()=>f.run(),e=>e.code==='outbox_lock_changed'&&captureLockDiagnostic(e).retirement.namespace_state==='released');assert.equal(unlinks,0);
});
for(const field of ['active','reservation'])test('retirement: aliases refused '+field,t=>{
 const f=setup(t);let checks=0;
 const check=()=>{if(field==='reservation'&&++checks===2)fs.linkSync(join(f.root,f.retired()[0]),join(f.root,'alias'));};
 if(field==='active')fs.linkSync(f.active,join(f.root,'alias'));
 assert.throws(()=>f.run(check));assert.equal(fs.existsSync(f.active),true);
});
test('retirement: target collision is neither overwritten nor retried as contention',async t=>{
 const f=setup(t);let attempts=0,error;
 patch(t,'openSync',(native,p,...a)=>{if(RETIRED_CAPTURE_LOCK.test(basename(p))){attempts++;throw fault('EEXIST');}return native(p,...a);});
 try{f.run();}catch(e){error=e;}
 await assert.rejects(acquireCaptureLock(()=>{throw error;},{kind:'queue'}));assert.equal(attempts,1);assert.equal(captureLockDiagnostic(error).phase,'retire-create');
});
for(const result of [false,Promise.resolve(),Promise.reject(Error('PRIVATE_ASYNC'))])test('retirement: invalid directory assertion cannot reach mutation',async t=>{
 // Attach handler immediately for the deliberately rejected assertion.
 if(result?.catch)result.catch(()=>{});const f=setup(t);assert.throws(()=>f.run(()=>result));assert.deepEqual(f.retired(),[]);
});
test('retirement: reports preserve namespace facts without arbitrary fields',t=>{
 const f=setup(t);patch(t,'unlinkSync',()=>{throw fault('EPERM');});let error;try{f.run();}catch(e){error=e;}
 const lock=captureLockDiagnostic(error);assert.equal(captureLockDiagnostic({...error}),null);assert.ok(Object.isFrozen(lock.retirement));
 const r=controlWorkerReport(JSON.stringify({ok:false,code:error.code,lock:{...lock,retirement:{...lock.retirement,path:'PRIVATE'}}}));
 assert.deepEqual(r.lock.retirement,{namespace_state:'released',close_failed:false});assert.ok(!JSON.stringify(r).includes('PRIVATE'));
});
