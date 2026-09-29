#!/usr/bin/env node
/** Synthetic scratch-only platform probe. Never selects a user file/profile/queue.
 * Device identifiers and file content are not emitted. No server/model actions. */
import fs from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import assert from 'node:assert/strict';
import {readLocalFileBytes,localDeviceCompatible,localFileReadDiagnostic} from '../src/local-file-read.mjs';
const main=()=>{
 if(process.argv.length!==2)throw Error('No arguments accepted');
 const root=fs.mkdtempSync(join(tmpdir(),'ub-native-read-'));let fd;
 try{
  const path=join(root,'synthetic');const bytes=Buffer.from('synthetic bounded local file');fs.writeFileSync(path,bytes,{mode:0o600});
  const before=fs.lstatSync(path,{bigint:true});fd=fs.openSync(path,'r');const handle=fs.fstatSync(fd,{bigint:true});fs.closeSync(fd);fd=undefined;
  const relation=before.dev===handle.dev?'exact':localDeviceCompatible(before.dev,handle.dev)?'windows-wide-path-narrow-handle':'unrecognized';
  assert.notEqual(relation,'unrecognized');assert.equal(before.ino,handle.ino);
  for(let i=0;i<100;i++){assert.deepEqual(readLocalFileBytes(path,'profile'),bytes);assert.deepEqual(readLocalFileBytes(path,'outbox'),bytes);}
  fs.linkSync(path,join(root,'alias'));assert.throws(()=>readLocalFileBytes(path,'outbox'));assert.deepEqual(readLocalFileBytes(path,'profile'),bytes);
  return {passed:true,format:'ultrabrain-native-local-read-v1',platform:process.platform,node:process.version,uv:process.versions.uv,
   device_relation:relation,reads:201,aliases_rejected:true,bigint_identity:true,user_paths_selected:false,server_calls:0,model_calls:0};
 }finally{if(fd!==undefined)fs.closeSync(fd);fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
};
try{process.stdout.write(JSON.stringify(main())+'\n');}catch(error){process.stdout.write(JSON.stringify({passed:false,error:'local_read_probe_failed',diagnostic:localFileReadDiagnostic(error)})+'\n');process.exitCode=1;}
