/** Actual CLI subprocesses; SDK imports are explicitly replaced, never called. */
import test from 'node:test';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';import {fileURLToPath} from 'node:url';
import {CaptureOutbox} from '../src/capture-outbox.mjs';
const cli=fileURLToPath(new URL('../packages/ultrabrain-client/src/cli.mjs',import.meta.url));
const preload=new URL('./fixtures/capture-delivery-control-cli-preload.mjs',import.meta.url).href;
function setup(t){
 const root=mkdtempSync(join(tmpdir(),'ub-control-cli-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const workspace=join(root,'work');mkdirSync(workspace,{mode:0o700});
 const input={format:1,source:'personal',workspace,outbox_directory:join(root,'queue'),allow_capture:true,expected_actor:'a'.repeat(64),
  expected_instance:'11111111-1111-4111-8111-111111111111',server:{transport:'stdio',command:'never-executed',args:[]}};
 const profile=join(root,'profile.json'),marker=join(root,'network-marker');writeFileSync(profile,JSON.stringify(input),{mode:0o600});
 const q=new CaptureOutbox(input);
 const run=(command,args=[],body='',extraEnv={})=>{
  const r=spawnSync(process.execPath,['--import',preload,cli,command,'--profile',profile,...args],{
   input:body,encoding:'utf8',timeout:7000,maxBuffer:16384,env:{...process.env,ULTRABRAIN_CONTROL_CONNECT_MARKER:marker,...extraEnv}});
  assert.equal(r.error,undefined);assert.equal(r.signal,null);assert.equal(r.stderr,'');assert.ok(!r.stdout.includes(root)&&!r.stdout.includes('PRIVATE'));
  assert.equal(existsSync(marker),false);return {status:r.status,body:JSON.parse(r.stdout)};
 };
 return {root,profile,input,q,run};
}
test('control CLI: pause/status/resume roundtrip never connects or changes capture settings',async t=>{
 const {run,profile}=setup(t),before=readFileSync(profile);const p=run('queue-pause');assert.equal(p.status,0);assert.equal(p.body.local_control,'confirmed');assert.equal(p.body.delivery,'not_submitted');
 const s=run('queue-status');assert.deepEqual(s.body.result.delivery,p.body.result);
 const r=run('queue-resume',['--expected-sha',p.body.result.control_sha256,'--confirm-resume']);assert.equal(r.status,0);assert.equal(r.body.result.state,'running');
 assert.deepEqual(readFileSync(profile),before);
});
for(const args of [[],['--confirm-resume'],['--expected-sha','0'.repeat(64)],['--expected-sha','0'.repeat(64),'--confirm-resume','--retry-blocked'],['--confirm-resume','--expected-sha','0'.repeat(64)]])
test('control CLI: malformed resume arguments fail closed '+args.length,async t=>{
 const {q,run}=setup(t);const p=await q.pauseDelivery();const r=run('queue-resume',args);assert.equal(r.status,1);assert.equal(r.body.error,'invalid_params');
 assert.equal((await q.status()).delivery.control_sha256,p.control_sha256);
});
test('control CLI: stale resume observation is rejected',async t=>{
 const {q,run}=setup(t);const old=await q.pauseDelivery(),now=await q.pauseDelivery();const r=run('queue-resume',['--expected-sha',old.control_sha256,'--confirm-resume']);
 assert.equal(r.status,1);assert.equal(r.body.error,'conflict');assert.equal(r.body.delivery,'not_submitted');assert.deepEqual((await q.status()).delivery,now);
});
test('control CLI: paused queue capture retains input locally without SDK connection',async t=>{
 const {q,run}=setup(t);await q.pauseDelivery();const r=run('queue-capture',[],JSON.stringify({agent_id:'fixture',event_id:'one',consent:true,transcript:'SYNTHETIC_PRIVATE'}));
 assert.equal(r.status,1);assert.equal(r.body.result.queued.storage,'client_journal');assert.equal(r.body.result.delivery.last_error,'outbox_paused');assert.equal((await q.status()).pending,1);
});
for(const command of ['queue-pause','queue-resume'])test('control CLI: '+command+' receives cancellation while waiting for the queue lock',async t=>{
 const {q,run}=setup(t);const p=await q.pauseDelivery(),path=join(q.directory,'delivery-control.json'),before=readFileSync(path);
 const lock=join(q.directory,'.queue.lock'),bytes=JSON.stringify({pid:process.pid});writeFileSync(lock,bytes,{mode:0o600});
 const r=run(command,command==='queue-pause'?[]:['--expected-sha',p.control_sha256,'--confirm-resume'],'',{ULTRABRAIN_CONTROL_CANCEL:'yes'});
 assert.equal(r.status,1);assert.equal(r.body.error,'aborted');assert.deepEqual(readFileSync(path),before);assert.equal(readFileSync(lock,'utf8'),bytes);
});
test('control CLI: disabled profile can pause but cannot resume',async t=>{
 const {run,profile,input}=setup(t);writeFileSync(profile,JSON.stringify({...input,allow_capture:false}));const p=run('queue-pause');assert.equal(p.status,0);
 const r=run('queue-resume',['--expected-sha',p.body.result.control_sha256,'--confirm-resume']);assert.equal(r.status,1);assert.equal(r.body.error,'capture_disabled');
});
