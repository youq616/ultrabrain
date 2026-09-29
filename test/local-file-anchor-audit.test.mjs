/** Separate implementer audit. Real Linux syscalls with explicit Win32 metadata
 * seams, not a second reviewer or a native Windows certification. */
import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
import {join} from 'node:path';import {tmpdir} from 'node:os';import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readLocalFileBytes,localFileReadDiagnostic} from '../src/local-file-read.mjs';
function scope(t,inject=()=>{}){
 const dir=fs.mkdtempSync(join(tmpdir(),'ub-anchor-audit-')),path=join(dir,'selected');
 fs.writeFileSync(path,'PRIVATE_BYTES',{mode:0o600});fs.writeFileSync(join(dir,'different'),'PRIVATE_BYTES',{mode:0o600});
 const platform=Object.getOwnPropertyDescriptor(process,'platform'),original={};
 const calls={open:0,read:0,close:0,stat:0,path:0};
 for(const name of ['openSync','lstatSync','fstatSync','readSync','closeSync'])original[name]=fs[name];
 Object.defineProperty(process,'platform',{...platform,value:'win32'});
 const codes={openSync:'open',lstatSync:'path',fstatSync:'stat',readSync:'read',closeSync:'close'};
 for(const [name,method]of Object.entries(original))fs[name]=(...args)=>{
  calls[codes[name]]++;inject(name,args,calls,{...original,dir,path});
  const value=method(...args);
  if(name==='lstatSync'&&value.isFile())value.dev=typeof value.dev==='bigint'?701n:701;
  if(name==='fstatSync')value.dev=typeof value.dev==='bigint'?909n:909;
  return value;
 };syncBuiltinESMExports();
 t.after(()=>{Object.assign(fs,original);Object.defineProperty(process,'platform',platform);syncBuiltinESMExports();
  fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
 return {dir,path,original,calls};
}
test('anchor audit: real pathname replacement before second open cannot supply bytes',t=>{
 const f=scope(t,(name,_a,n,{dir,path})=>{if(name==='openSync'&&n.open===2){fs.renameSync(path,join(dir,'held-original'));fs.renameSync(join(dir,'different'),path);}});
 assert.throws(()=>readLocalFileBytes(f.path,'outbox'));assert.equal(f.calls.read,0);assert.equal(f.calls.close,2);
 assert.equal(fs.readFileSync(f.path,'utf8'),'PRIVATE_BYTES');
});
test('anchor audit: second open targeting a real different inode is rejected even with equal content',t=>{
 const f=scope(t,(name,args,n,{dir})=>{if(name==='openSync'&&n.open===2)args[0]=join(dir,'different');});
 assert.throws(()=>readLocalFileBytes(f.path,'outbox'),e=>localFileReadDiagnostic(e).reason==='identity');
 assert.equal(f.calls.read,0);assert.equal(f.calls.close,2);
});
test('anchor audit: a real replacement after witness recheck is still rejected by final path',t=>{
 const f=scope(t,(name,_a,n,{dir,path})=>{if(name==='lstatSync'&&n.path===3){fs.renameSync(path,join(dir,'held-original'));fs.renameSync(join(dir,'different'),path);}});
 assert.throws(()=>readLocalFileBytes(f.path,'outbox'));assert.ok(f.calls.read>0);assert.equal(f.calls.close,2);
});
test('anchor audit: truncation while descriptors are held cannot be successful empty data',t=>{
 const f=scope(t,(name,_a,n,{path,openSync,closeSync})=>{if(name==='readSync'&&n.read===1){const fd=openSync(path,'r+');try{fs.ftruncateSync(fd,0);}finally{closeSync(fd);}}});
 assert.throws(()=>readLocalFileBytes(f.path,'outbox'));assert.equal(f.calls.close,2);
});
test('anchor audit: full-width changed primary handle is not rescued by a matching witness',t=>{
 const f=scope(t),stat=fs.fstatSync;let n=0;
 fs.fstatSync=(...args)=>{const value=stat(...args);if(++n===3)value.dev+=0x100000000n;return value;};syncBuiltinESMExports();
 assert.throws(()=>readLocalFileBytes(f.path,'outbox'),e=>localFileReadDiagnostic(e).phase==='handle-after');assert.equal(f.calls.close,2);
});
test('anchor audit: an actual profile hardlink stays permitted but an outbox alias is refused',t=>{
 const f=scope(t);fs.linkSync(f.path,join(f.dir,'alias'));
 assert.deepEqual(readLocalFileBytes(f.path,'profile'),Buffer.from('PRIVATE_BYTES'));
 const opens=f.calls.open;assert.throws(()=>readLocalFileBytes(f.path,'outbox'),e=>localFileReadDiagnostic(e).reason==='aliases');assert.equal(f.calls.open,opens);
});
test('anchor audit: no create, unlink, rename, permission change or network side effects',t=>{
 const f=scope(t),names=['writeFileSync','unlinkSync','renameSync','chmodSync','mkdirSync','linkSync'];
 const saved=Object.fromEntries(names.map(n=>[n,fs[n]]));
 for(const name of names)fs[name]=()=>assert.fail('Read-only primitive invoked '+name);syncBuiltinESMExports();
 try{assert.deepEqual(readLocalFileBytes(f.path,'outbox'),Buffer.from('PRIVATE_BYTES'));}
 finally{Object.assign(fs,saved);syncBuiltinESMExports();}
 assert.equal(f.calls.open,2);assert.equal(f.calls.close,2);
});
test('anchor audit: unknown errors expose neither arbitrary properties nor identifiers',t=>{
 let inspected=0;const error={get code(){inspected++;throw Error('PRIVATE_DIAGNOSTIC');},message:'PRIVATE_PATH',path:'PRIVATE_PATH'};
 const f=scope(t,(name,_a,n)=>{if(name==='openSync'&&n.open===2)throw error;});
 assert.throws(()=>readLocalFileBytes(f.path,'outbox'),e=>{
  assert.deepEqual(localFileReadDiagnostic(e),{kind:'outbox',phase:'anchor-open',reason:'io',system_code:null,close_failed:false});
  assert.ok(!e.message.includes('PRIVATE'));return true;
 });assert.equal(inspected,0);assert.equal(f.calls.close,1);
});
test('anchor audit: repeated anchored reads release every opened descriptor',t=>{
 const f=scope(t);for(let i=0;i<100;i++)assert.equal(readLocalFileBytes(f.path,'outbox').length,13);
 assert.equal(f.calls.open,200);assert.equal(f.calls.close,200);
});
test('anchor audit: platform probe preserves the observed unequal relation instead of masking it',t=>{
 const dir=fs.mkdtempSync(join(tmpdir(),'ub-anchor-probe-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
 const preload=join(dir,'seam.cjs');fs.writeFileSync(preload,`
 const fs=require('node:fs'),{syncBuiltinESMExports}=require('node:module');
 const ls=fs.lstatSync,fd=fs.fstatSync;Object.defineProperty(process,'platform',{value:'win32'});
 fs.lstatSync=(...a)=>{const s=ls(...a);if(s.isFile())s.dev=typeof s.dev==='bigint'?701n:701;return s;};
 fs.fstatSync=(...a)=>{const s=fd(...a);s.dev=typeof s.dev==='bigint'?909n:909;return s;};syncBuiltinESMExports();
 `,{mode:0o600});
 const r=spawnSync(process.execPath,['--require',preload,fileURLToPath(new URL('../scripts/check-local-file-read.mjs',import.meta.url))],{encoding:'utf8',timeout:10000,env:{...process.env,TEMP:dir,TMP:dir}});
 assert.ifError(r.error);assert.equal(r.status,0,r.stderr||r.stdout);assert.equal(r.stderr,'');const data=JSON.parse(r.stdout);
 assert.equal(data.passed,true);assert.equal(data.device_relation,'unrecognized');assert.equal(data.confirmation,'dual-descriptor-required');
 assert.equal(data.reads,201);assert.ok(!r.stdout.includes(dir)&&!r.stdout.includes('701')&&!r.stdout.includes('909'));
});
test('anchor audit: existing workflow test and contention commands are retained, new cases added',()=>{
 const source=fs.readFileSync(new URL('../.github/workflows/local-file-read.yml',import.meta.url),'utf8');
 assert.ok(source.includes('ubuntu-24.04')&&source.includes('windows-2025')&&source.includes("node: ['22.16.0', '22']"));
 assert.ok(source.includes('test/local-file-read*.test.mjs test/local-file-anchor*.test.mjs'));
 assert.ok(source.includes('node scripts/check-capture-contention.mjs --rounds 25'));
 assert.ok(source.includes('node test/local-file-read-package.mjs'));assert.ok(source.includes('contents: read'));
});

// A subprocess report must not erase the newly relevant native-read phase.
import {captureLockError} from '../src/capture-lock.mjs';
import {captureProcessDiagnostic} from './helpers/capture-process-diagnostic.mjs';
import {controlWorkerReport} from './helpers/capture-control-report.mjs';
for(const sample of [2,4])test('anchor audit: worker report preserves authentic nested read diagnosis '+sample,t=>{
 const f=scope(t,(name,_args,n)=>{if(name==='fstatSync'&&n.stat===sample)throw Object.assign(Error('PRIVATE_PATH'),{code:'EIO'});});
 let failure;try{readLocalFileBytes(f.path,'outbox');assert.fail('Native fault required');}catch(e){failure=e;}
 const wrapped=captureLockError(failure,'queue','verify-release');
 const result=controlWorkerReport(JSON.stringify({ok:false,...captureProcessDiagnostic(wrapped)}));
 assert.deepEqual(result.lock.file_read,localFileReadDiagnostic(failure));assert.ok(!JSON.stringify(result).includes('PRIVATE'));
});
test('anchor audit: serialized worker details remain allowlisted, not arbitrary data or authenticated receipts',()=>{
 const report={ok:false,code:'outbox_corrupt',lock:{kind:'queue',phase:'verify-release',system_code:'EIO',file_read:{
  kind:'outbox',phase:'anchor-close',reason:'io',system_code:'EBADF',close_failed:true,path:'PRIVATE_PATH',dev:'PRIVATE_DEVICE',message:'PRIVATE'}}};
 const r=controlWorkerReport(JSON.stringify(report));
 assert.deepEqual(r.lock.file_read,{kind:'outbox',phase:'anchor-close',reason:'io',system_code:'EBADF',close_failed:true});
 assert.ok(!JSON.stringify(r).includes('PRIVATE'));assert.equal(localFileReadDiagnostic(r),null);
});
test('anchor audit: unknown nested diagnostic shape is not partially accepted',()=>{
 const base={kind:'outbox',phase:'anchor-open',reason:'io',system_code:'EIO',close_failed:false};
 for(const patch of [{phase:'PRIVATE_PHASE'},{reason:'PRIVATE_REASON'},{kind:'PRIVATE_KIND'},{close_failed:'true'}]){
  const r=controlWorkerReport(JSON.stringify({ok:false,code:'outbox_corrupt',lock:{kind:'queue',phase:'verify-release',file_read:{...base,...patch}}}));
  assert.equal(r.lock.file_read,undefined);assert.ok(!JSON.stringify(r).includes('PRIVATE'));
 }
});
