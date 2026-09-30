/** Real scratch files with explicit Win32 stat-domain doubles. Not native Windows. */
import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {readLocalFileBytes,localFileReadDiagnostic,localDeviceCompatible} from '../src/local-file-read.mjs';
import {readClientProfile} from '../src/client-profile-file.mjs';import {CaptureOutbox} from '../src/capture-outbox.mjs';
function setup(t,options={}){
 const root=fs.mkdtempSync(join(tmpdir(),'ub-anchor-')),path=join(root,'file'),bytes=Buffer.from('PRIVATE_ANCHOR_BYTES');
 fs.writeFileSync(path,bytes,{mode:0o600});
 const platform=Object.getOwnPropertyDescriptor(process,'platform');
 const original=Object.fromEntries(['lstatSync','openSync','fstatSync','readSync','closeSync'].map(k=>[k,fs[k]]));
 const state={paths:0,opens:0,stats:0,reads:0,closes:[],fds:[]};
 Object.defineProperty(process,'platform',{...platform,value:options.platform??'win32'});
 for(const name of Object.keys(original))fs[name]=(...args)=>{
  if(name==='lstatSync')state.paths++;
  if(name==='openSync')state.opens++;
  if(name==='fstatSync')state.stats++;
  if(name==='readSync')state.reads++;
  if(name==='closeSync')state.closes.push(args[0]);
  options.before?.(name,args,state,original);
  const value=original[name](...args);
  if(name==='openSync')state.fds.push(value);
  if(name==='lstatSync'&&value.isFile())value.dev=typeof value.dev==='bigint'?(options.pathDev??101n):Number(options.pathDev??101n);
  if(name==='fstatSync')value.dev=typeof value.dev==='bigint'?(options.handleDev??303n):Number(options.handleDev??303n);
  options.after?.(name,value,args,state,original);return value;
 };
 syncBuiltinESMExports();
 t.after(()=>{Object.assign(fs,original);Object.defineProperty(process,'platform',platform);syncBuiltinESMExports();
  fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
 return {root,path,bytes,state,original};
}
test('anchor: same-file unequal32 native domains read the complete profile',t=>{
 const f=setup(t);assert.equal(localDeviceCompatible(101n,303n,'win32'),false);
 assert.deepEqual(readLocalFileBytes(f.path,'profile'),f.bytes);
 assert.equal(f.state.opens,2);assert.equal(f.state.closes.length,2);
 assert.equal(new Set(f.state.closes).size,2);assert.equal(f.state.paths,3);assert.equal(f.state.stats,4);
});
test('anchor: actual profile and outbox consumers keep their permissions and control binding',async t=>{
 const f=setup(t);const workspace=join(f.root,'work');fs.mkdirSync(workspace,{mode:0o700});
 const input={format:1,source:'synthetic',allow_capture:true,workspace,outbox_directory:join(f.root,'queue'),
  expected_instance:'11111111-1111-4111-8111-111111111111',expected_actor:'a'.repeat(64),server:{transport:'stdio',command:'NEVER_START_SERVER',args:[]}};
 fs.writeFileSync(f.path,JSON.stringify(input));assert.deepEqual(readClientProfile(f.path).input,input);
 const q=new CaptureOutbox(input);await q.enqueue({agent_id:'synthetic',event_id:'one',consent:true,transcript:'PRIVATE_ANCHOR_BYTES'});
 const pause=await q.pauseDelivery();await q.resumeDelivery(pause.control_sha256,{confirm:true});
 const result=await q.status();assert.equal(result.pending,1);assert.equal(result.delivery.state,'running');
 assert.ok(!fs.readdirSync(q.directory).some(n=>n.endsWith('.lock')||n.startsWith('.tmp-')));
});
for(const [name,pathDev,handleDev]of [['wide-independent',0x1234567800000001n,303n],['signed-independent',-123456789012345n,303n],
 ['wide-handle',101n,0x7654321089abcdefn],['signed-handle',101n,-123456789012345n]])
 test('anchor: independent domains require matching handles '+name,t=>{
  const f=setup(t,{pathDev,handleDev});assert.deepEqual(readLocalFileBytes(f.path,'outbox'),f.bytes);assert.equal(f.state.opens,2);
 });
for(const platform of ['linux','darwin'])test('anchor: other platforms retain exact device requirement '+platform,t=>{
 const f=setup(t,{platform});assert.throws(()=>readLocalFileBytes(f.path,'outbox'),e=>localFileReadDiagnostic(e).reason==='identity');
 assert.equal(f.state.opens,1);assert.equal(f.state.reads,0);assert.equal(f.state.closes.length,1);
});
for(const option of [{handleDev:0n},{pathDev:2n**64n},{handleDev:-(2n**63n)-1n}])
 test('anchor: zero handle or invalid incomparable device identity fails closed',t=>{
  const f=setup(t,option);assert.throws(()=>readLocalFileBytes(f.path,'outbox'));assert.ok(f.state.opens<=1);assert.equal(f.state.reads,0);
 });
for(const field of ['dev','ino','mtimeNs','ctimeNs','birthtimeNs','mode','nlink','uid','gid','size'])
 test('anchor: second opened handle must match every field '+field,t=>{
  const f=setup(t,{after:(name,s,_a,state)=>{if(name==='fstatSync'&&state.stats===2)s[field]+=1n;}});
  assert.throws(()=>readLocalFileBytes(f.path,'outbox'));assert.equal(f.state.reads,0);assert.equal(f.state.closes.length,2);
 });
for(const field of ['dev','ino','mtimeNs','ctimeNs','birthtimeNs','mode','nlink','uid','gid','size'])
 test('anchor: witness must stay unchanged after payload read '+field,t=>{
  const f=setup(t,{after:(name,s,_a,state)=>{if(name==='fstatSync'&&state.stats===4)s[field]+=1n;}});
  assert.throws(()=>readLocalFileBytes(f.path,'outbox'));assert.ok(f.state.reads>0);assert.equal(f.state.closes.length,2);
 });
for(const sample of [2,3])for(const field of ['dev','ino','ctimeNs'])
 test('anchor: path domain remains full-width at sample '+sample+' '+field,t=>{
  const f=setup(t,{after:(name,s,_a,state)=>{if(name==='lstatSync'&&state.paths===sample)s[field]+=0x100000000n;}});
  assert.throws(()=>readLocalFileBytes(f.path,'outbox'));assert.equal(f.state.closes.length,2);
 });
test('anchor: link introduced before path anchoring is rejected before reading',t=>{
 const f=setup(t,{after:(name,s,_a,state)=>{if(name==='lstatSync'&&state.paths===2)s.isSymbolicLink=()=>true;}});
 assert.throws(()=>readLocalFileBytes(f.path,'outbox'),e=>localFileReadDiagnostic(e).reason==='type');assert.equal(f.state.reads,0);
});
for(const [method,counter,index,phase]of [['openSync','opens',2,'anchor-open'],['fstatSync','stats',2,'anchor-before'],
 ['fstatSync','stats',4,'anchor-after'],['lstatSync','paths',2,'path-anchor']])
 test('anchor: native error has safe phase and is never retried '+phase,t=>{
  let failures=0;const f=setup(t,{before:(name,_a,state)=>{if(name===method&&state[counter]===index){failures++;throw Object.assign(Error('PRIVATE_PATH'),{code:'EPERM'});}}});
  assert.throws(()=>readLocalFileBytes(f.path,'outbox'),e=>{const d=localFileReadDiagnostic(e);assert.equal(d.phase,phase);assert.equal(d.system_code,'EPERM');
   assert.ok(!JSON.stringify(d).includes('PRIVATE'));return true;});
  assert.equal(failures,1);assert.equal(f.state.closes.length,phase==='anchor-open'?1:2);
 });
for(const closeAt of [1,2])test('anchor: close failure withholds complete bytes and closes the other handle once '+closeAt,t=>{
 const f=setup(t,{after:(name,_s,_a,state)=>{if(name==='closeSync'&&state.closes.length===closeAt)throw Object.assign(Error('PRIVATE_CLOSE'),{code:'EBADF'});}});
 assert.throws(()=>readLocalFileBytes(f.path,'outbox'),e=>localFileReadDiagnostic(e).phase===(closeAt===1?'anchor-close':'close'));
 assert.equal(f.state.closes.length,2);assert.equal(new Set(f.state.closes).size,2);
});
test('anchor: read failure remains primary when both closes fail; no double-close or leaked bytes',t=>{
 const f=setup(t,{before:name=>{if(name==='readSync')throw Object.assign(Error('PRIVATE_READ'),{code:'EIO'});},
  after:name=>{if(name==='closeSync')throw Object.assign(Error('PRIVATE_CLOSE'),{code:'EBADF'});}});
 assert.throws(()=>readLocalFileBytes(f.path,'outbox'),e=>{
  assert.deepEqual(localFileReadDiagnostic(e),{kind:'outbox',phase:'read',reason:'io',system_code:'EIO',close_failed:true});
  assert.equal(localFileReadDiagnostic({...e}),null);return true;
 });assert.equal(f.state.closes.length,2);assert.equal(new Set(f.state.closes).size,2);
});
test('anchor: both descriptors open read-only with no create/truncate permissions',t=>{
 const f=setup(t,{before:(name,a)=>{if(name==='openSync'){
  assert.equal(a[1]&(fs.constants.O_WRONLY|fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_TRUNC|fs.constants.O_APPEND),0);
 }}});assert.deepEqual(readLocalFileBytes(f.path,'outbox'),f.bytes);assert.equal(f.state.opens,2);
});
test('anchor: raw helper remains conservative and cannot authorize the fallback without IO',()=>{
 assert.equal(localDeviceCompatible(101n,303n,'win32'),false);
 assert.equal(localDeviceCompatible(303n,101n,'win32'),false);
});
