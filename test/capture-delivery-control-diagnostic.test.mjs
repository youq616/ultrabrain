/** Real child processes, deliberate native IO faults; not a Windows reproduction. */
import test from 'node:test';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {controlWorkerReport} from './helpers/capture-control-report.mjs';
const checker=fileURLToPath(new URL('../scripts/check-capture-delivery-control.mjs',import.meta.url));
const preload=new URL('./fixtures/capture-delivery-control-failure-preload.mjs',import.meta.url).href;
function run(mode){
 const r=spawnSync(process.execPath,[checker,'--rounds','2'],{encoding:'utf8',timeout:22000,maxBuffer:32768,
  env:{...process.env,NODE_OPTIONS:'--import '+preload,ULTRABRAIN_CONTROL_CHECK_TEST:mode}});
 assert.ifError(r.error);assert.equal(r.status,1);assert.equal(r.signal,null);assert.equal(r.stderr,'');assert.ok(!r.stdout.includes('PRIVATE'));
 const report=JSON.parse(r.stdout);assert.equal(report.passed,false);assert.equal(report.rounds_requested,2);assert.equal(report.rounds.length,1);
 assert.equal(report.rounds[0].passed,false);assert.equal(report.rounds[0].outcomes.length,8);return report.rounds[0];
}
test('control diagnostic: native EPERM before staged preserves worker and authentic lock phase',()=>{
 const r=run('enqueue-eperm');assert.equal(r.stage,'enqueue');const failed=r.outcomes.find(x=>x.worker===4);
 assert.equal(failed.valid,false);assert.equal(failed.exit,1);assert.equal(failed.result.code,'outbox_lock_io');
 assert.deepEqual(failed.result.lock,{kind:'queue',phase:'create',system_code:'EPERM'});
});
test('control diagnostic: failures after resume barrier retain authentic control publication diagnostic',()=>{
 const r=run('resume-enospc');assert.equal(r.stage,'resume',JSON.stringify(r));const failed=r.outcomes.find(x=>x.result.code==='outbox_journal_io');
 assert.ok(failed);assert.equal(failed.result.journal.target,'control');assert.equal(failed.result.journal.phase,'publish');assert.equal(failed.result.journal.system_code,'ENOSPC');
});
for(const mode of ['early-exit','overflow'])test('control diagnostic: '+mode+' is bounded and does not erase the failed round',()=>{
 const r=run(mode);assert.equal(r.stage,'ready');assert.ok(r.outcomes.some(x=>x.result.code==='invalid_worker_report'));
});
test('control diagnostic: timed-out workers remain a distinct failed round',()=>{
 const r=run('timeout');assert.equal(r.stage,'ready');assert.equal(r.timed_out,true);assert.ok(r.outcomes.every(x=>!x.valid));
});
test('control diagnostic: invalid and oversized child reports do not echo arbitrary bytes',()=>{
 for(const text of ['PRIVATE','null','[]','{}','"PRIVATE"',' '.repeat(4097),JSON.stringify({ok:true,outcome:'PRIVATE'})])
  assert.deepEqual(controlWorkerReport(text),{ok:false,code:'invalid_worker_report'});
 assert.deepEqual(controlWorkerReport('{"ok":true,"outcome":"resumed"}',{overflow:true}),{ok:false,code:'invalid_worker_report'});
});
test('control diagnostic: only fixed success and native failure fields cross the process boundary',()=>{
 assert.deepEqual(controlWorkerReport(JSON.stringify({ok:true,outcome:'resumed',secret:'PRIVATE'})),{ok:true,outcome:'resumed'});
 const r=controlWorkerReport(JSON.stringify({ok:false,code:'outbox_lock_io',message:'PRIVATE',path:'PRIVATE',native_code:'PRIVATE',syscall:'PRIVATE',target:'PRIVATE',
  lock:{kind:'queue',phase:'create',system_code:'EPERM',message:'PRIVATE'},journal:null}));
 assert.equal(r.code,'outbox_lock_io');assert.equal(r.native_code,null);assert.equal(r.syscall,null);assert.equal(r.target,null);
 assert.deepEqual(r.lock,{kind:'queue',phase:'create',system_code:'EPERM'});assert.ok(!JSON.stringify(r).includes('PRIVATE'));
});
test('control diagnostic: nested journal and cleanup details are allowlisted and bounded',()=>{
 const r=controlWorkerReport(JSON.stringify({ok:false,code:'outbox_journal_io',journal:{target:'control',operation:'replace',phase:'publish',system_code:'ENOSPC',
  publication:'unconfirmed',directory_sync:'not_attempted',message:'PRIVATE',secondary:Array.from({length:9},()=>({phase:'close',system_code:'PRIVATE',path:'PRIVATE'})),
  lock_release:Array.from({length:9},()=>({kind:'queue',phase:'unlink',system_code:'EPERM',path:'PRIVATE'}))}}));
 assert.equal(r.journal.secondary.length,2);assert.equal(r.journal.lock_release.length,2);assert.equal(r.journal.secondary[0].system_code,null);
 assert.ok(!JSON.stringify(r).includes('PRIVATE'));
});
