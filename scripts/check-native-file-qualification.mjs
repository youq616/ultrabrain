#!/usr/bin/env node
/** Only a fresh synthetic scratch directory. No user path or queue selection. */
import fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {readLocalFileBytes, localDeviceCompatible, localFileReadDiagnostic} from '../src/local-file-read.mjs';
const fields=['dev','ino','mode','nlink','uid','gid','size','mtimeNs','ctimeNs','birthtimeNs'];
const errno=e=>['EACCES','EPERM','ENOENT','ENOENT','EIO','EBADF','ENOSPC','EEXIST'].includes(e?.code)?e.code:null;
let root, fd, phase='arguments', observation=null, checks=[], failed=false;
try {
 if(process.argv.length!==2)throw Error('arguments');
 phase='setup';root=fs.mkdtempSync(join(tmpdir(),'ub-qualification-'));
 const path=join(root,'synthetic');const bytes=Buffer.from('synthetic qualification sample');
 fs.writeFileSync(path,bytes,{mode:0o600});
 phase='observe';const a=fs.lstatSync(path,{bigint:true});fd=fs.openSync(path,'r');
 const b=fs.fstatSync(fd,{bigint:true});fs.closeSync(fd);fd=undefined;
 observation={path_device_zero:a.dev===0n,handle_device_zero:b.dev===0n,
  path_device_negative:a.dev<0n,handle_device_negative:b.dev<0n,
  inode_zero:a.ino===0n||b.ino===0n,numeric_compatible:localDeviceCompatible(a.dev,b.dev),
  changed_fields:fields.filter(k=>a[k]!==b[k]),bigint_fields:fields.every(k=>typeof a[k]==='bigint'&&typeof b[k]==='bigint')};
 for(const kind of ['profile','outbox']){
  phase=kind;try {const read=readLocalFileBytes(path,kind);const passed=read.equals(bytes);checks.push({kind,passed,diagnostic:null});if(!passed)failed=true;}
  catch(e){failed=true;checks.push({kind,passed:false,diagnostic:localFileReadDiagnostic(e),system_code:errno(e)});}
 }
} catch(e){failed=true;checks.push({phase,passed:false,system_code:errno(e)});}
finally {
 if(fd!==undefined)try{fs.closeSync(fd);}catch{failed=true;}
 if(root)try{fs.rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:50});}catch{failed=true;checks.push({phase:'cleanup',passed:false});}
}
console.log(JSON.stringify({format:'ultrabrain-native-qualification-v1',passed:!failed,node:process.version,uv:process.versions.uv,
 platform:process.platform,observation,checks,user_paths_selected:false,server_calls:0,model_calls:0}));
process.exitCode=failed?1:0;
