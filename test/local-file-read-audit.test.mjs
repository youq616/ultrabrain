/** Implementer review probes; not separate-agent approval. */
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {readLocalFileBytes,localFileReadDiagnostic,localDeviceCompatible} from '../src/local-file-read.mjs';
function setup(t){const dir=fs.mkdtempSync(join(tmpdir(),'ub-file-audit-')),path=join(dir,'record');fs.writeFileSync(path,'PRIVATE',{mode:0o600});
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
 const before=fs.lstatSync(path,{bigint:true}),fd=fs.openSync(path,'r');let handles;
 try{handles=process.platform==='win32'&&!localDeviceCompatible(before.dev,fs.fstatSync(fd,{bigint:true}).dev)?2:1;}finally{fs.closeSync(fd);}
 return {dir,path,handles};}
function patch(name,fn){const orig=fs[name];fs[name]=(...a)=>fn(orig,...a);syncBuiltinESMExports();return()=>{fs[name]=orig;syncBuiltinESMExports();};}
test('audit: nanosecond change invisible to integer millisecond comparison is refused',t=>{
 const f=setup(t);let primary,n=0;const restore=patch('fstatSync',(orig,...a)=>{
 const s=orig(...a);primary??=a[0];if(a[0]===primary&&++n===2)s.mtimeNs++;return s;});
 try{assert.throws(()=>readLocalFileBytes(f.path,'outbox'),e=>localFileReadDiagnostic(e).reason==='changed');}finally{restore();}
});
test('audit: Windows path device cannot change high bits while keeping low bits',t=>{
 const f=setup(t),platform=Object.getOwnPropertyDescriptor(process,'platform');Object.defineProperty(process,'platform',{...platform,value:'win32'});
 let n=0;const p=patch('lstatSync',(orig,...a)=>{const s=orig(...a);s.dev=(++n===1?0x1234567800000001n:0x2234567800000001n);return s;});
 const h=patch('fstatSync',(orig,...a)=>{const s=orig(...a);s.dev=1n;return s;});
 try{assert.throws(()=>readLocalFileBytes(f.path,'outbox'),e=>localFileReadDiagnostic(e).reason==='changed');}finally{h();p();Object.defineProperty(process,'platform',platform);}
});
test('audit: final missing path withholds bytes and closes the descriptor',t=>{
 const f=setup(t);let readStarted=false;const closed=new Set();
 const r=patch('readSync',(orig,...a)=>{readStarted=true;return orig(...a);});
 const p=patch('lstatSync',(orig,...a)=>{if(readStarted)throw Object.assign(Error('PRIVATE'),{code:'ENOENT'});return orig(...a);});
 const c=patch('closeSync',(orig,...a)=>{assert.ok(!closed.has(a[0]),'No descriptor close retry');closed.add(a[0]);return orig(...a);});
 try{assert.throws(()=>readLocalFileBytes(f.path,'outbox'),e=>localFileReadDiagnostic(e).phase==='path-after');assert.equal(readStarted,true);assert.equal(closed.size,f.handles);}finally{c();p();r();}
});
test('audit: an aliased final path does not pass on byte equality',t=>{
 const f=setup(t);let readStarted=false;
 const r=patch('readSync',(orig,...a)=>{readStarted=true;return orig(...a);});
 const p=patch('lstatSync',(orig,...a)=>{const s=orig(...a);if(readStarted)s.nlink=2n;return s;});
 try{assert.throws(()=>readLocalFileBytes(f.path,'outbox'),e=>localFileReadDiagnostic(e).reason==='aliases');assert.equal(readStarted,true);}finally{p();r();}
});
test('audit: invalid native read count cannot loop or expose an allocation',t=>{
 const f=setup(t);for(const bad of [-1,NaN,Infinity,1000000]){const r=patch('readSync',()=>bad);
  try{assert.throws(()=>readLocalFileBytes(f.path,'outbox'),e=>localFileReadDiagnostic(e).reason==='read-count');}finally{r();}}
});
test('audit: symlink metadata is refused before opening target',t=>{
 const f=setup(t);let opens=0;const p=patch('lstatSync',(orig,...a)=>{const s=orig(...a);s.isSymbolicLink=()=>true;return s;});
 const o=patch('openSync',(orig,...a)=>{opens++;return orig(...a);});
 try{assert.throws(()=>readLocalFileBytes(f.path,'outbox'));assert.equal(opens,0);}finally{o();p();}
});
test('audit: permission checks cover the opened descriptor, not just prior path metadata',t=>{
 const f=setup(t);const original=Object.getOwnPropertyDescriptor(process,'getuid');
 if(!original)Object.defineProperty(process,'getuid',{value:()=>0,configurable:true});
 const h=patch('fstatSync',(orig,...a)=>{const s=orig(...a);s.mode|=0o002n;return s;});
 try{assert.throws(()=>readLocalFileBytes(f.path,'profile'),e=>localFileReadDiagnostic(e).reason==='permissions');}
 finally{h();if(original)Object.defineProperty(process,'getuid',original);else delete process.getuid;}
});
test('audit: revoked error proxy is sanitized and not treated as local evidence',t=>{
 const f=setup(t),{proxy,revoke}=Proxy.revocable({},{});revoke();const p=patch('readSync',()=>{throw proxy;});
 try{assert.throws(()=>readLocalFileBytes(f.path,'outbox'),e=>localFileReadDiagnostic(e).system_code===null);assert.equal(localFileReadDiagnostic(proxy),null);}finally{p();}
});
