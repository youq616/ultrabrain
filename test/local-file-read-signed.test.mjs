/** Native Node stats use a BigInt64 buffer; injected sign-bit set IDs, not Windows. */
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {localDeviceCompatible,readLocalFileBytes} from '../src/local-file-read.mjs';
const full=0xf654321089abcdefn,signed=BigInt.asIntN(64,full),low=full&0xffffffffn;
test('signed stat: signed native wide path serial maps only to its unsigned low32 handle',()=>{
 assert.ok(signed<0n);assert.equal(localDeviceCompatible(signed,low,'win32'),true);
 assert.equal(localDeviceCompatible(signed,signed,'win32'),true);
 assert.equal(localDeviceCompatible(signed,full,'win32'),false);
 assert.equal(localDeviceCompatible(low,signed,'win32'),false);
 assert.equal(localDeviceCompatible(signed,low,'linux'),false);
 assert.equal(localDeviceCompatible(signed,low+1n,'win32'),false);
 assert.equal(localDeviceCompatible(-(1n<<63n)-1n,low,'win32'),false);
});
test('signed stat: real bounded read preserves signed full-width device and inode bits',t=>{
 const dir=fs.mkdtempSync(join(tmpdir(),'ub-signed-stat-')),path=join(dir,'entry'),bytes=Buffer.from('synthetic');fs.writeFileSync(path,bytes,{mode:0o600});
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
 const platform=Object.getOwnPropertyDescriptor(process,'platform'),ls=fs.lstatSync,fd=fs.fstatSync;
 Object.defineProperty(process,'platform',{...platform,value:'win32'});
 fs.lstatSync=(...a)=>{const s=ls(...a);s.dev=signed;s.ino=-(1n<<62n);return s;};
 fs.fstatSync=(...a)=>{const s=fd(...a);s.dev=low;s.ino=-(1n<<62n);return s;};syncBuiltinESMExports();
 try{assert.deepEqual(readLocalFileBytes(path,'outbox'),bytes);}finally{fs.lstatSync=ls;fs.fstatSync=fd;Object.defineProperty(process,'platform',platform);syncBuiltinESMExports();}
});
