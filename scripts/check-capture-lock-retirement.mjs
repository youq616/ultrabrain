#!/usr/bin/env node
/** Synthetic held-reader/name-reuse probe, no user path, server or model input. */
import assert from 'node:assert/strict';
import fs from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {retireCaptureLock} from '../src/capture-lock-retirement.mjs';
import {sha256} from '../src/core.mjs';
import {captureProcessDiagnostic} from '../test/helpers/capture-process-diagnostic.mjs';
let root,phase='arguments',report,fd;
try{
 assert.equal(process.argv.length,2);phase='setup';root=fs.mkdtempSync(join(tmpdir(),'ub-lock-retirement-probe-'));
 const bytes=Buffer.from('synthetic lock ownership'),hash=sha256(bytes),old=join(root,'legacy');
 fs.writeFileSync(old,bytes,{mode:0o600});fd=fs.openSync(old,'r');let legacy;
 phase='legacy-unlink';fs.unlinkSync(old);
 try{const next=fs.openSync(old,'wx',0o600);fs.closeSync(next);legacy='reused';}
 catch(e){legacy=['EPERM','EACCES','EEXIST'].includes(e.code)?e.code:'other_error';}
 fs.closeSync(fd);fd=undefined;if(fs.existsSync(old))fs.unlinkSync(old);
 phase='retirement';let rounds=0;
 for(;rounds<25;rounds++){
  const path=join(root,'.queue.lock');fs.writeFileSync(path,bytes,{flag:'wx',mode:0o600});fd=fs.openSync(path,'r');
  retireCaptureLock(root,'queue',hash,()=>{});
  const next=fs.openSync(path,'wx',0o600);fs.writeSync(next,'new owner');fs.closeSync(next);
  assert.throws(()=>fs.openSync(path,'wx',0o600),{code:'EEXIST'});
  const observed=Buffer.alloc(bytes.length);assert.equal(fs.readSync(fd,observed,0,observed.length,0),bytes.length);assert.deepEqual(observed,bytes);
  assert.equal(fs.readFileSync(path,'utf8'),'new owner');fs.closeSync(fd);fd=undefined;fs.unlinkSync(path);
  assert.deepEqual(fs.readdirSync(root),[]);
 }
 report={format:'ultrabrain-lock-retirement-probe-v1',passed:true,platform:process.platform,node:process.version,uv:process.versions.uv,
  legacy_name_reuse:legacy,retirement_rounds:rounds,held_reader_preserved:true,exclusive_next_owner:true,network_calls:0,model_calls:0,user_queue_access:false};
}catch(e){report={format:'ultrabrain-lock-retirement-probe-v1',passed:false,phase,error:captureProcessDiagnostic(e)};}
finally{
 if(fd!==undefined)try{fs.closeSync(fd);}catch{report={...report,passed:false,close_failed:true};}
 if(root)try{fs.rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:30});}catch{report={...report,passed:false,cleanup_failed:true};}
}
console.log(JSON.stringify(report));if(!report.passed)process.exitCode=1;
