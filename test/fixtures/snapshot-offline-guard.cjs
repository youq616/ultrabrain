// Test-only negative capability guard for real source/installed Node execution.
// It permits real reads, cleanup and stdout/stderr. It is not a sandbox against
// hostile JS, native addons, process.binding or references saved before preload.
'use strict';
const fs=require('node:fs'),fsp=require('node:fs/promises');
const Module=require('node:module'),{syncBuiltinESMExports}=Module;
let violated=false;
function deny() {
  // Snapshot code deliberately sanitizes/catches exceptions. A swallowed denial
  // must still fail acceptance; do not write a diagnostic file inside this guard.
  if(!violated){
    violated=true;
    process.once('exit',()=>{process.exitCode=79;});
  }
  process.exitCode=79;
  throw Error('OFFLINE_FORBIDDEN_OPERATION');
}
const C=fs.constants;
const readMask=['O_NOFOLLOW','O_NONBLOCK','O_DIRECTORY','O_NOCTTY','O_SYNC','O_DSYNC','O_RSYNC','O_CLOEXEC','O_NOATIME']
  .reduce((mask,key)=>mask|(C[key]??0),0)>>>0;
function readOnly(flags) {
  if(typeof flags==='string')return ['r','rs','sr'].includes(flags);
  // An explicit allowlist rejects O_CREAT/O_TRUNC/O_APPEND even with O_RDONLY,
  // and rejects unknown future bits rather than treating them as read authority.
  return Number.isInteger(flags)&&flags>=0&&flags<=0xffffffff&&(flags&~readMask)===0;
}
const openSync=fs.openSync,open=fs.open,promiseOpen=fsp.open;
fs.openSync=function(path,flags,...args){if(!readOnly(flags))deny();return openSync.call(this,path,flags,...args);};
fs.open=function(path,flags,...args){if(!readOnly(flags))deny();return open.call(this,path,flags,...args);};
fsp.open=async function(path,flags='r',...args){
  if(!readOnly(flags))deny();
  const handle=await promiseOpen.call(this,path,flags,...args);
  // A read-only descriptor can still change metadata; block all public mutation
  // methods, not only writes that happen to fail with EBADF on this OS.
  for(const key of ['write','writev','writeFile','appendFile','truncate','chmod','chown','utimes','createWriteStream'])
    if(typeof handle[key]==='function')Object.defineProperty(handle,key,{value:deny,configurable:true});
  return handle;
};
for(const name of ['write','writeSync','writev','writevSync']) {
  const original=fs[name];
  fs[name]=function(fd,...args){if(fd!==1&&fd!==2)deny();return original.call(this,fd,...args);};
}
for(const name of ['writeFile','appendFile','rename','unlink','rm','rmdir','mkdir','mkdtemp','copyFile','cp','truncate',
  'symlink','link','chmod','chown','lchmod','lchown','utimes','lutimes','ftruncate','fchmod','fchown','futimes']) {
  for(const key of [name,name+'Sync'])if(typeof fs[key]==='function')fs[key]=deny;
  if(typeof fsp[name]==='function')fsp[name]=deny;
}
fs.createWriteStream=deny;
for(const [name,keys]of Object.entries({
  'node:child_process':['exec','execFile','spawn','fork','execSync','execFileSync','spawnSync'],
  'node:http':['request','get','createServer'],'node:https':['request','get','createServer'],
  'node:net':['connect','createConnection','createServer'],'node:tls':['connect','createServer'],
  'node:dgram':['createSocket'],'node:dns':['lookup','resolve'],
}))for(const key of keys)require(name)[key]=deny;
const net=require('node:net');net.Socket.prototype.connect=deny;net.Server.prototype.listen=deny;
globalThis.fetch=deny;
const load=Module._load;
Module._load=function(name,...args){
  if(typeof name==='string'&&(name==='@modelcontextprotocol/sdk'||name.startsWith('@modelcontextprotocol/sdk/')))deny();
  return load.call(this,name,...args);
};
syncBuiltinESMExports();
