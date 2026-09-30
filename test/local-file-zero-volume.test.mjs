/** Native CI observed path dev=0 and a nonzero handle device on Windows22.16.
 * Real Linux files with explicit stat seams here are NOT native Windows evidence. */
import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {readLocalFileBytes,localFileReadDiagnostic,localDeviceCompatible} from '../src/local-file-read.mjs';
import {CaptureOutbox} from '../src/capture-outbox.mjs';
import {readClientProfile} from '../src/client-profile-file.mjs';
function setup(t,{platform='win32',handle=211n,change=()=>{}}={}){
 const dir=fs.mkdtempSync(join(tmpdir(),'ub-zero-volume-')),path=join(dir,'selected');fs.writeFileSync(path,'PRIVATE_SELECTED',{mode:0o600});
 const descriptor=Object.getOwnPropertyDescriptor(process,'platform');
 const orig=Object.fromEntries(['lstatSync','fstatSync','openSync','readSync','closeSync'].map(k=>[k,fs[k]]));
 const counts={lstatSync:0,fstatSync:0,openSync:0,readSync:0,closeSync:0};
 Object.defineProperty(process,'platform',{...descriptor,value:platform});
 for(const k of Object.keys(orig))fs[k]=(...a)=>{const value=orig[k](...a);counts[k]++;
  if(k==='lstatSync'&&value.isFile())value.dev=typeof value.dev==='bigint'?0n:0;
  if(k==='fstatSync')value.dev=typeof value.dev==='bigint'?handle:Number(handle);
  change(k,value,counts,a,orig);return value;};syncBuiltinESMExports();
 t.after(()=>{Object.assign(fs,orig);Object.defineProperty(process,'platform',descriptor);syncBuiltinESMExports();fs.rmSync(dir,{recursive:true,force:true});});
 return {dir,path,counts,orig};
}
test('zero path device: nonzero matching descriptors confirm exact bounded bytes',t=>{
 const f=setup(t);assert.equal(localDeviceCompatible(0n,211n,'win32'),false);
 assert.equal(readLocalFileBytes(f.path,'outbox').toString(),'PRIVATE_SELECTED');
 assert.equal(f.counts.openSync,2);assert.equal(f.counts.closeSync,2);assert.equal(f.counts.fstatSync,4);
});
test('zero path device: real profile and journal consumers finish without retained locks',async t=>{
 const f=setup(t),workspace=join(f.dir,'work');fs.mkdirSync(workspace,{mode:0o700});
 const input={format:1,source:'synthetic',workspace,outbox_directory:join(f.dir,'queue'),allow_capture:true,
  expected_instance:'11111111-1111-4111-8111-111111111111',expected_actor:'a'.repeat(64),server:{transport:'stdio',command:'NEVER_START_SERVER',args:[]}};
 fs.writeFileSync(f.path,JSON.stringify(input));assert.deepEqual(readClientProfile(f.path).input,input);
 const q=new CaptureOutbox(input);const pause=await q.pauseDelivery();
 await q.enqueue({agent_id:'synthetic',event_id:'zero-volume',consent:true,transcript:'PRIVATE_SELECTED'});
 await q.resumeDelivery(pause.control_sha256,{confirm:true});const status=await q.status();
 assert.equal(status.pending,1);assert.equal(status.delivery.state,'running');
 assert.ok(!fs.readdirSync(q.directory).some(n=>n.endsWith('.lock')||n.startsWith('.tmp-')));
});
for(const platform of ['linux','darwin'])test('zero path device: no cross-domain fallback on '+platform,t=>{
 const f=setup(t,{platform});assert.throws(()=>readLocalFileBytes(f.path,'outbox'));assert.equal(f.counts.readSync,0);
});
for(const field of ['dev','ino','mode','nlink','uid','gid','size','mtimeNs','ctimeNs','birthtimeNs'])
 test('zero path device: second handle mismatch rejected '+field,t=>{
  const f=setup(t,{change:(k,s,n)=>{if(k==='fstatSync'&&n[k]===2)s[field]+=1n;}});
  assert.throws(()=>readLocalFileBytes(f.path,'outbox'));assert.equal(f.counts.readSync,0);assert.equal(f.counts.closeSync,2);
 });
for(const sample of [2,3])test('zero path device: path-domain change is not ignored at sample '+sample,t=>{
 const f=setup(t,{change:(k,s,n)=>{if(k==='lstatSync'&&n[k]===sample)s.dev=9n;}});
 assert.throws(()=>readLocalFileBytes(f.path,'outbox'));assert.equal(f.counts.closeSync,2);
});
for(const field of ['dev','ino','size','ctimeNs'])test('zero path device: changed witness after reading is rejected '+field,t=>{
 const f=setup(t,{change:(k,s,n)=>{if(k==='fstatSync'&&n[k]===4)s[field]+=1n;}});
 assert.throws(()=>readLocalFileBytes(f.path,'outbox'));assert.equal(f.counts.closeSync,2);
});
test('zero path device: unavailable handle identity cannot anchor an unmatched path',t=>{
 const f=setup(t,{handle:0n,change:(k,s)=>{if(k==='lstatSync'&&s.isFile())s.dev=99n;}});
 assert.throws(()=>readLocalFileBytes(f.path,'outbox'),e=>localFileReadDiagnostic(e).reason==='identity');
 assert.equal(f.counts.openSync,1);assert.equal(f.counts.readSync,0);
});
test('zero path device: no arithmetic permission for 0/nonzero or inverse',()=>{
 assert.equal(localDeviceCompatible(0n,211n,'win32'),false);assert.equal(localDeviceCompatible(211n,0n,'win32'),false);
});
