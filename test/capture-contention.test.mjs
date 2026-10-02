import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {captureProcessDiagnostic} from './helpers/capture-process-diagnostic.mjs';
import {captureContentionRound} from '../scripts/check-capture-contention.mjs';
import {contentionRoundEvidence} from './helpers/capture-contention-diagnostics.mjs';
test('contention: real 8-process start barrier preserves unique events and shared replay',async t=>{
 const r=await captureContentionRound();t.diagnostic(JSON.stringify(r));assert.equal(r.passed,true,JSON.stringify(r));assert.equal(r.records,17);assert.equal(r.identical_replays,7);
 assert.deepEqual(contentionRoundEvidence(r),{complete:true,passed:true,reported_workers:8,shutdown_unavailable_workers:0,reason:null});
});
for(const args of [['--help'],['--rounds','0'],['--rounds','26'],['--rounds','3.5'],['--profile','PRIVATE_PATH']])test('contention: CLI parameter boundary '+args[0]+' '+args[1],()=>{
 const r=spawnSync(process.execPath,[fileURLToPath(new URL('../scripts/check-capture-contention.mjs',import.meta.url)),...args],{encoding:'utf8',timeout:5000});
 assert.ifError(r.error);assert.equal(r.status,args[0]==='--help'?0:1);assert.ok(!r.stdout.includes('PRIVATE_PATH'));assert.equal(r.stderr,'');
});
for(const code of ['EPERM','EACCES','EBUSY','UNKNOWN_PRIVATE'])test('contention: native failure diagnostic excludes real paths '+code,()=>{
 const r=captureProcessDiagnostic({code,syscall:'open',path:'PRIVATE_PATH/.queue.lock',message:'PRIVATE_TOKEN'});
 assert.equal(r.target,'queue-lock');assert.equal(r.native_code,code==='UNKNOWN_PRIVATE'?null:code);assert.ok(!JSON.stringify(r).includes('PRIVATE'));
});
test('contention: diagnostic never invokes error properties',()=>{
 let n=0;const error={get code(){n++;throw Error('PRIVATE');},get path(){n++;throw Error('PRIVATE');},get syscall(){n++;throw Error('PRIVATE');}};
 assert.deepEqual(captureProcessDiagnostic(error),{code:'writer_failed',lock:null,journal:null,native_code:null,syscall:null,target:null});assert.equal(n,0);
});
