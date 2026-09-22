/** Negative controls for the real Node preload, not a snapshot/API double.
 * Each child has disposable files; a writable descriptor may predate the guard.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
const guard=fileURLToPath(new URL('./fixtures/snapshot-offline-guard.cjs',import.meta.url));
const original='ORIGINAL_SNAPSHOT_BYTES';
function run(t,code,{before='',created=false,success=false}={}) {
  const dir=mkdtempSync(join(tmpdir(),'ub-offline-negative-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'selected.json');if(!created)writeFileSync(path,original,{mode:0o600});
  const script=`const fs=require('node:fs'),fsp=require('node:fs/promises');
    const [guard,path]=process.argv.slice(1);const C=fs.constants;
    (async()=>{${before};require(guard);${code}})().catch(e=>{
      process.stderr.write(e.message==='OFFLINE_FORBIDDEN_OPERATION'?'DENIED\\n':'UNEXPECTED\\n');process.exitCode=1;
    });`;
  const r=spawnSync(process.execPath,['-e',script,guard,path],{encoding:'utf8',timeout:10000});
  assert.ifError(r.error);assert.equal(r.signal,null);
  if(success)assert.equal(r.status,0,r.stderr);
  else assert.notEqual(r.status,0,'Forbidden operation was not observed by the guard');
  assert.ok(!r.stderr.includes('UNEXPECTED'),r.stderr);
  if(created)assert.equal(existsSync(path),false,'Writable open created a file');
  else assert.equal(readFileSync(path,'utf8'),original,'Guard permitted a file mutation');
  return r;
}
for(const api of ['sync','callback','promise'])for(const flags of ["'w'","'a'","'r+'",'C.O_WRONLY','C.O_RDWR','C.O_RDONLY|C.O_CREAT','C.O_RDONLY|C.O_TRUNC','C.O_RDONLY|C.O_APPEND']) {
  const operation=api==='sync'?`fs.closeSync(fs.openSync(path,${flags}));`:
    api==='callback'?`await new Promise((ok,no)=>fs.open(path,${flags},(e,fd)=>{if(e)no(e);else fs.close(fd,e=>e?no(e):ok());}));`:
    `const h=await fsp.open(path,${flags});await h.close();`;
  test(`offline guard: ${api} rejects writable flags ${flags}`,t=>run(t,operation));
}
for(const api of ['sync','callback','promise'])test(`offline guard: ${api} cannot create a file with O_RDONLY|O_CREAT`,t=>{
  const flags='C.O_RDONLY|C.O_CREAT';
  const code=api==='sync'?`fs.closeSync(fs.openSync(path,${flags}));`:
    api==='promise'?`await (await fsp.open(path,${flags})).close();`:
    `await new Promise((ok,no)=>fs.open(path,${flags},(e,fd)=>e?no(e):fs.close(fd,ok)));`;
  run(t,code,{created:true});
});
for(const [name,code]of [
  ['writeSync',"fs.writeSync(fd,'X',0);"],
  ['write',"await new Promise((ok,no)=>fs.write(fd,'X',0,e=>e?no(e):ok()));"],
  ['writevSync',"fs.writevSync(fd,[Buffer.from('X')],0);"],
  ['writev',"await new Promise((ok,no)=>fs.writev(fd,[Buffer.from('X')],0,e=>e?no(e):ok()));"],
  ['ftruncateSync','fs.ftruncateSync(fd,0);'],
  ['ftruncate','await new Promise((ok,no)=>fs.ftruncate(fd,0,e=>e?no(e):ok()));'],
])test('offline guard: existing descriptor '+name+' is blocked',t=>run(t,`try{${code}}finally{fs.closeSync(fd);}`,{before:"const fd=fs.openSync(path,'r+');"}));
for(const [method,args]of [['write',"'X'"],['writev',"[Buffer.from('X')]"],['writeFile',"'X'"],['appendFile',"'X'"],
  ['truncate','0'],['chmod','0o600'],['chown','0,0'],['utimes','0,0'],['createWriteStream','']]) {
  test('offline guard: FileHandle.'+method+' refuses mutation before reaching the OS',t=>{
    run(t,`const h=await fsp.open(path,'r');try{await h.${method}(${args});}finally{await h.close();}`);
  });
}
for(const [name,code]of [
  ['copyFileSync',"fs.copyFileSync(path,path+'.copy');"],['linkSync',"fs.linkSync(path,path+'.link');"],
  ['chmodSync','fs.chmodSync(path,0o600);'],['utimesSync','fs.utimesSync(path,0,0);'],
  ['promise chmod','await fsp.chmod(path,0o600);'],['callback writeFile',"fs.writeFile(path,'X',()=>{});"],
  ['fetch',"await fetch('http://127.0.0.1:9');"],['child process',"require('node:child_process').spawn('must-not-start');"],
  ['SDK loading',"require('@modelcontextprotocol/sdk/client/index.js');"],
])test('offline guard: '+name+' is observed',t=>run(t,code));
test('offline guard: a caught mutation cannot produce a successful process status',t=>{
  const r=run(t,"try{fs.openSync(path,'w');}catch{}process.exitCode=0;process.stdout.write('CAUGHT');");
  assert.equal(r.stdout,'CAUGHT');
});
test('offline guard: explicit exit(0) cannot hide a caught mutation',t=>{
  run(t,"try{fs.writeFileSync(path,'X');}catch{}process.exit(0);");
});
for(const api of ['sync','callback','promise'])test('offline guard: real '+api+' read-only descriptor and stdout remain functional',t=>{
  const code=api==='sync'?`const fd=fs.openSync(path,C.O_RDONLY|(C.O_NOFOLLOW??0)|(C.O_NONBLOCK??0));
    try{process.stdout.write(fs.readFileSync(fd,'utf8'));}finally{fs.closeSync(fd);}`:
    api==='callback'?`await new Promise((ok,no)=>fs.open(path,'r',(e,fd)=>{if(e)return no(e);
      process.stdout.write(fs.readFileSync(fd,'utf8'));fs.close(fd,e=>e?no(e):ok());}));`:
    `const h=await fsp.open(path,'r');try{process.stdout.write(await h.readFile('utf8'));await h.stat();}finally{await h.close();}`;
  const r=run(t,code,{success:true});assert.equal(r.stdout,original);assert.equal(r.stderr,'');
});
test('offline guard: low-level stdout/stderr are the only write-descriptor exceptions',t=>{
  const r=run(t,"fs.writeSync(1,'OUT');await new Promise((ok,no)=>fs.write(2,'ERR',e=>e?no(e):ok()));",{success:true});
  assert.equal(r.stdout,'OUT');assert.equal(r.stderr,'ERR');
});
test('offline guard: named ESM exports receive the descriptor fence',t=>{
  run(t,"const {writeSync}=await import('node:fs');try{writeSync(fd,'X',0);}finally{fs.closeSync(fd);}",{before:"const fd=fs.openSync(path,'r+');"});
});
