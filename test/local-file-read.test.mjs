import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {localDeviceCompatible,readLocalFileBytes,localFileReadDiagnostic} from '../src/local-file-read.mjs';
const wide=0x7654321089abcdefn,narrow=0x89abcdefn;
for(const [name,p,h,platform,expected]of [
 ['exact linux',19n,19n,'linux',true],['exact windows',wide,wide,'win32',true],['documented direction',wide,narrow,'win32',true],
 ['not Linux',wide,narrow,'linux',false],['not Darwin',wide,narrow,'darwin',false],['not reversed',narrow,wide,'win32',false],
 ['different narrow',wide,narrow+1n,'win32',false],['wide collision',wide,wide+0x100000000n,'win32',false],
 ['32-bit collision',narrow,1n,'win32',false],['below native signed64',-0x8000000000000001n,0xffffffffn,'win32',false],
 ['too wide',2n**64n,0n,'win32',false],['rounded number',Number(wide),Number(wide),'win32',false],
 ['missing handle device',0x100000000n,0n,'win32',false],
 ['undefined',undefined,undefined,'win32',false],['string','19','19','win32',false],['nan',NaN,NaN,'win32',false]])
 test('device identity: '+name,()=>assert.equal(localDeviceCompatible(p,h,platform),expected));
function setup(t,bytes=Buffer.from('PRIVATE_TEST_BYTES')){
 const dir=fs.mkdtempSync(join(tmpdir(),'ub-file-read-')),path=join(dir,'record');fs.writeFileSync(path,bytes,{mode:0o600});
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
 // Observe the native stat domains before installing fault hooks. The production
 // reader must use exactly one descriptor, or two for a Win32 anchored path.
 const before=fs.lstatSync(path,{bigint:true}),fd=fs.openSync(path,'r');let handles;
 try{handles=process.platform==='win32'&&!localDeviceCompatible(before.dev,fs.fstatSync(fd,{bigint:true}).dev)?2:1;}finally{fs.closeSync(fd);}
 return {dir,path,bytes,handles};
}
function patch(method,fn){const orig=fs[method];fs[method]=(...args)=>fn(orig,...args);syncBuiltinESMExports();return()=>{fs[method]=orig;syncBuiltinESMExports();};}
function refused(fn,reason,phase){assert.throws(fn,e=>{const d=localFileReadDiagnostic(e);assert.equal(d?.reason,reason);if(phase)assert.equal(d.phase,phase);
 assert.ok(!JSON.stringify(d).includes('PRIVATE'));assert.ok(!e.message.includes('PRIVATE'));return true;});}
for(const [kind,len]of [['profile',0],['outbox',0],['profile',16384],['outbox',220000]])test('bounded read: '+kind+' size '+len,t=>{
 const f=setup(t,Buffer.alloc(len,42));assert.deepEqual(readLocalFileBytes(f.path,kind),f.bytes);
});
for(const kind of ['profile','outbox'])test('bounded read: oversized '+kind+' fails before open',t=>{
 const f=setup(t,Buffer.alloc(kind==='profile'?16385:220001));let opens=0;const restore=patch('openSync',(orig,...a)=>{opens++;return orig(...a);});
 try{refused(()=>readLocalFileBytes(f.path,kind),'bounds','path-before');assert.equal(opens,0);}finally{restore();}
});
for(const invalid of [['relative','profile'],['/no-such','unknown'],['/no-such','outbox',0],['/no-such','outbox',220001],['/no-such','profile',20000]])
 test('invalid API arguments: '+invalid.join(' '),()=>assert.throws(()=>readLocalFileBytes(...invalid),{code:'invalid_params'}));
test('read loop: short native reads use explicit offsets and terminate at EOF',t=>{
 const f=setup(t);let calls=0,offsets=[];const restore=patch('readSync',(orig,fd,b,off,len,pos)=>{calls++;offsets.push(pos);return orig(fd,b,off,Math.min(2,len),pos);});
 try{assert.deepEqual(readLocalFileBytes(f.path,'outbox'),f.bytes);assert.ok(calls>2);assert.deepEqual(offsets,[...offsets].sort((a,b)=>a-b));}finally{restore();}
});
test('read loop: large growth consumes at most original size plus one byte',t=>{
 const f=setup(t);let first=true,total=0;const restore=patch('readSync',(orig,...args)=>{if(first){first=false;fs.appendFileSync(f.path,Buffer.alloc(1000000));}
 const n=orig(...args);total+=n;return n;});
 try{refused(()=>readLocalFileBytes(f.path,'outbox'),'bounds','handle-after');assert.equal(total,f.bytes.length+1);}finally{restore();}
});
test('read loop: shrink is refused',t=>{
 const f=setup(t);let first=true;const restore=patch('readSync',(orig,...args)=>{if(first){first=false;fs.truncateSync(f.path,1);}return orig(...args);});
 try{refused(()=>readLocalFileBytes(f.path,'outbox'),'changed');}finally{restore();}
});
for(const field of ['dev','ino','size','mtimeNs','ctimeNs','birthtimeNs','mode','nlink','uid','gid'])test('handle changes are not normalized away: '+field,t=>{
 const f=setup(t);let primary,calls=0;const restore=patch('fstatSync',(orig,...args)=>{
 const r=orig(...args);primary??=args[0];if(args[0]===primary&&++calls===2)r[field]+=field==='mode'?0o100n:1n;return r;});
 try{assert.throws(()=>readLocalFileBytes(f.path,'outbox'));}finally{restore();}
});
test('BigInt inode must distinguish values rounded to the same Number',t=>{
 const f=setup(t),a=2n**54n,b=a+1n;assert.equal(Number(a),Number(b));
 const r1=patch('lstatSync',(orig,...args)=>{const r=orig(...args);r.ino=a;return r;});
 const r2=patch('fstatSync',(orig,...args)=>{const r=orig(...args);r.ino=b;return r;});
 try{refused(()=>readLocalFileBytes(f.path,'outbox'),'identity');}finally{r2();r1();}
});
test('metadata uses BigInt on every path and handle sample',t=>{
 const f=setup(t);let path=0;const handles=new Map();
 const r1=patch('lstatSync',(orig,p,o)=>{path++;assert.equal(o.bigint,true);return orig(p,o);});
 const r2=patch('fstatSync',(orig,fd,o)=>{handles.set(fd,(handles.get(fd)??0)+1);assert.equal(o.bigint,true);return orig(fd,o);});
 try{readLocalFileBytes(f.path,'outbox');assert.equal(path,f.handles+1);assert.equal(handles.size,f.handles);assert.ok([...handles.values()].every(n=>n===2));}finally{r2();r1();}
});
test('path replaced before open is not accepted even with identical contents',t=>{
 const f=setup(t);const replacement=join(f.dir,'other');fs.writeFileSync(replacement,f.bytes,{mode:0o600});let once=true;
 const restore=patch('openSync',(orig,p,...args)=>{if(once){once=false;fs.renameSync(f.path,join(f.dir,'old'));fs.renameSync(replacement,f.path);}return orig(p,...args);});
 try{refused(()=>readLocalFileBytes(f.path,'outbox'),'identity');}finally{restore();}
});
test('path identity is checked again after descriptor read',t=>{
 const f=setup(t);let readStarted=false;
 const r=patch('readSync',(orig,...a)=>{readStarted=true;return orig(...a);});
 const restore=patch('lstatSync',(orig,...a)=>{const s=orig(...a);if(readStarted)s.ino+=1n;return s;});
 try{refused(()=>readLocalFileBytes(f.path,'outbox'),'changed','path-after');assert.equal(readStarted,true);}finally{restore();r();}
});
test('hard-link aliases rejected by outbox but existing profile policy preserved',t=>{
 const f=setup(t);fs.linkSync(f.path,join(f.dir,'alias'));
 refused(()=>readLocalFileBytes(f.path,'outbox'),'aliases');assert.deepEqual(readLocalFileBytes(f.path,'profile'),f.bytes);
});
test('a link added between path check and open is rejected',t=>{
 const f=setup(t);let first=true;const restore=patch('openSync',(orig,...a)=>{if(first){first=false;fs.linkSync(f.path,join(f.dir,'alias'));}return orig(...a);});
 try{refused(()=>readLocalFileBytes(f.path,'outbox'),'aliases','handle-before');}finally{restore();}
});
test('directories rejected without any read',t=>{const f=setup(t);refused(()=>readLocalFileBytes(f.dir,'outbox'),'type');});
for(const method of ['lstatSync','openSync','fstatSync','readSync','closeSync'])test('native failure safe, no retries: '+method,t=>{
 const f=setup(t);let calls=0;const closed=new Set();
 const restore=patch(method,(orig,...args)=>{calls++;if(method==='closeSync'){assert.ok(!closed.has(args[0]),'No descriptor close retry');closed.add(args[0]);orig(...args);}throw Object.assign(Error('PRIVATE_SYSTEM_PATH'),{code:'EPERM',path:f.path});});
 try{assert.throws(()=>readLocalFileBytes(f.path,'outbox'),e=>{assert.equal(localFileReadDiagnostic(e).system_code,'EPERM');assert.ok(!e.message.includes(f.path));return true;});assert.equal(calls,method==='closeSync'?f.handles:1);}finally{restore();}
});
test('read failure remains primary when close also fails; diagnostic is authentic only',t=>{
 const f=setup(t);const closed=new Set();
 const r1=patch('readSync',()=>{throw Object.assign(Error('PRIVATE_READ'),{code:'EIO'});});
 const r2=patch('closeSync',(orig,...a)=>{assert.ok(!closed.has(a[0]),'No descriptor close retry');closed.add(a[0]);orig(...a);throw Object.assign(Error('PRIVATE_CLOSE'),{code:'EBADF'});});
 try{assert.throws(()=>readLocalFileBytes(f.path,'outbox'),e=>{assert.deepEqual(localFileReadDiagnostic(e),{
  kind:'outbox',phase:'read',reason:'io',system_code:'EIO',close_failed:true});assert.equal(localFileReadDiagnostic({...e}),null);return true;});assert.equal(closed.size,f.handles);}finally{r2();r1();}
});
test('unknown and accessor diagnostics do not execute or leak',t=>{
 const f=setup(t);let n=0;const r=patch('readSync',()=>{throw {get code(){n++;return 'PRIVATE';},message:'PRIVATE'};});
 try{assert.throws(()=>readLocalFileBytes(f.path,'outbox'),e=>localFileReadDiagnostic(e).system_code===null);assert.equal(n,0);}finally{r();}
});
