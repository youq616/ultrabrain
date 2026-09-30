/** Implementation-author's separate adversarial audit, NOT a second-agent review. */
import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {CaptureOutbox} from '../src/capture-outbox.mjs';
import {captureJournalDiagnostic} from '../src/capture-journal.mjs';
const CONTROL='delivery-control.json';
function setup(t){
 const root=fs.mkdtempSync(join(tmpdir(),'ub-control-audit-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const workspace=join(root,'work');fs.mkdirSync(workspace,{mode:0o700});
 const input={format:1,source:'personal',allow_capture:true,workspace,outbox_directory:join(root,'queue'),expected_actor:'a'.repeat(64),
  expected_instance:'11111111-1111-4111-8111-111111111111',server:{transport:'stdio',command:'never-executed',args:[]}};
 const q=new CaptureOutbox(input);return {root,q,input,path:join(q.directory,CONTROL)};
}
const item=(id='one')=>({agent_id:'fixture',event_id:id,consent:true,transcript:'SYNTHETIC_PRIVATE_TEXT'});
function patch(method,handler){const original=fs[method];fs[method]=(...args)=>handler(original,...args);syncBuiltinESMExports();return()=>{fs[method]=original;syncBuiltinESMExports();};}
for(const [label,mutate] of [
 ['invalid-json',()=>'{'],['duplicate-key',b=>b.replace('"state":"paused"','"state":"running","state":"paused"')],
 ['escaped-key',b=>b.replace('"state"','"sta\\u0074e"')],['extra-field',b=>JSON.stringify({...JSON.parse(b),secret:'PRIVATE'})+'\n'],
 ['invalid-utf8',()=>Buffer.from([0xff])],['bom',b=>'\ufeff'+b],['array',()=> '[]\n'],['null',()=> 'null\n'],
 ['wrong-state',b=>b.replace('"paused"','"open"')],['zero-revision',b=>b.replace('"revision":1','"revision":0')],
 ['fractional-revision',b=>b.replace('"revision":1','"revision":1.5')],['overflow',b=>b.replace('"revision":1','"revision":9007199254740992')],
 ['invalid-date',b=>b.replace(/"changed_at":"[^"]+"/,'"changed_at":"2026-02-30T00:00:00.000Z"')],
 ['invalid-change-id',b=>b.replace(/"change_id":"[^"]+"/,'"change_id":"not-valid"')],['oversize',()=> ' '.repeat(4097)],
])test('control audit: '+label+' fails closed without rewriting the control',async t=>{
 const {q,path}=setup(t);await q.enqueue(item());const p=await q.pauseDelivery();fs.writeFileSync(path,mutate(fs.readFileSync(path,'utf8')));
 const before=fs.readFileSync(path);await assert.rejects(q.flush(()=>assert.fail('No network')),{code:'outbox_corrupt'});
 await assert.rejects(q.pauseDelivery(),{code:'outbox_corrupt'});await assert.rejects(q.resumeDelivery(p.control_sha256,{confirm:true}),{code:'outbox_corrupt'});
 assert.deepEqual(fs.readFileSync(path),before);
});
test('control audit: foreign control binding fails before connection',async t=>{
 const {q,path}=setup(t);await q.pauseDelivery();const r=JSON.parse(fs.readFileSync(path));r.binding_sha256='b'.repeat(64);fs.writeFileSync(path,JSON.stringify(r)+'\n');
 await assert.rejects(q.flush(()=>assert.fail('No network')),{code:'identity_mismatch'});
});
test('control audit: hard-linked control is rejected without modifying either alias',async t=>{
 const {q,path,root}=setup(t);await q.pauseDelivery();const alias=join(root,'alias');fs.linkSync(path,alias);const before=fs.readFileSync(alias);
 await assert.rejects(q.pauseDelivery(),{code:'outbox_corrupt'});await assert.rejects(q.flush(()=>assert.fail('No network')),{code:'outbox_corrupt'});
 assert.deepEqual(fs.readFileSync(alias),before);
});
test('control audit: revision exhaustion never wraps or resets the gate',async t=>{
 const {q,path}=setup(t);await q.pauseDelivery();const r=JSON.parse(fs.readFileSync(path));r.revision=Number.MAX_SAFE_INTEGER;fs.writeFileSync(path,JSON.stringify(r)+'\n');
 const paused=(await q.status()).delivery;await assert.rejects(q.pauseDelivery(),{code:'outbox_control_exhausted'});
 await assert.rejects(q.resumeDelivery(paused.control_sha256,{confirm:true}),{code:'outbox_control_exhausted'});
 assert.equal((await q.status()).delivery.state,'paused');
});
test('control audit: failed resume rename keeps old pause and all event bytes',async t=>{
 const {q,path}=setup(t);await q.enqueue(item());const p=await q.pauseDelivery(),before=fs.readFileSync(path),failure=Object.assign(Error('PRIVATE'),{code:'EIO'});
 let calls=0;const restore=patch('renameSync',(native,a,b,...rest)=>{if(b===path){calls++;throw failure;}return native(a,b,...rest);});
 try{await assert.rejects(q.resumeDelivery(p.control_sha256,{confirm:true}),e=>{const d=captureJournalDiagnostic(e);assert.equal(e.code,'outbox_journal_io');assert.equal(d.target,'control');assert.equal(d.phase,'publish');assert.equal(d.system_code,'EIO');return true;});}finally{restore();}
 assert.equal(calls,1);assert.deepEqual(fs.readFileSync(path),before);assert.equal(fs.readdirSync(q.directory).filter(n=>n.startsWith('.tmp-')).length,1,'Prepared publication evidence must remain');
 assert.equal((await q.status()).delivery.state,'paused');
});
test('control audit: primary control-write failure is not replaced by lock-release failure',async t=>{
 const {q,path}=setup(t);const p=await q.pauseDelivery(),before=fs.readFileSync(path),failure=Object.assign(Error('PRIVATE_PRIMARY'),{code:'ENOSPC'});
 const restoreRename=patch('renameSync',(native,a,b,...rest)=>{if(b===path)throw failure;return native(a,b,...rest);});
 const restoreUnlink=patch('unlinkSync',(native,p,...rest)=>{if(p===join(q.directory,'.queue.lock')||/\.retired-queue-[a-f0-9-]{36}\.lock$/.test(p))throw Object.assign(Error('PRIVATE_CLEANUP'),{code:'EPERM'});return native(p,...rest);});
 try{await assert.rejects(q.resumeDelivery(p.control_sha256,{confirm:true}),e=>{const d=captureJournalDiagnostic(e);assert.equal(e.code,'outbox_journal_io');assert.equal(d.target,'control');assert.equal(d.system_code,'ENOSPC');assert.deepEqual(d.lock_release,[process.platform==='win32'?{kind:'queue',phase:'retire-unlink',system_code:'EPERM',retirement:{namespace_state:'released',close_failed:false}}:{kind:'queue',phase:'unlink',system_code:'EPERM'}]);assert.ok(!JSON.stringify(d).includes('PRIVATE'));return true;});}finally{restoreUnlink();restoreRename();}
 assert.deepEqual(fs.readFileSync(path),before);assert.equal(fs.existsSync(join(q.directory,'.queue.lock')),process.platform!=='win32');
 if(process.platform==='win32')assert.equal(fs.readdirSync(q.directory).filter(n=>/^\.retired-queue-/.test(n)).length,1);
});
test('control audit: pause between entries returns already confirmed delivery, not a misleading total failure',async t=>{
 const {q,input}=setup(t);await q.enqueue(item('one'));await q.enqueue(item('two'));let sent=0;
 const r=await q.flush(async()=>({identity:{format:1,source_id:input.source,instance_id:input.expected_instance,actor_key:input.expected_actor},
  capture:async p=>{sent++;await new CaptureOutbox(input).pauseDelivery();return {source_id:input.source,event_id:p.event_id,storage:'journaled',job_id:'22222222-2222-4222-8222-222222222222'};},close:async()=>{}}));
 assert.equal(sent,1);assert.equal(r.delivered,1);assert.equal(r.remaining_pending,1);assert.equal(r.last_error,'outbox_paused');
 const remaining=fs.readdirSync(q.directory).filter(n=>n.endsWith('.entry'));assert.equal(JSON.parse(fs.readFileSync(join(q.directory,remaining[0]))).attempts,0);
});
test('control audit: failed control fsync preserves prepared evidence and the old gate',async t=>{
 const {q,path}=setup(t);const p=await q.pauseDelivery(),before=fs.readFileSync(path);let target;
 const open=patch('openSync',(native,path,...rest)=>{const fd=native(path,...rest);if(typeof path==='string'&&path.includes('.tmp-'))target=fd;return fd;});
 const sync=patch('fsyncSync',(native,fd)=>{if(fd===target)throw Object.assign(Error('PRIVATE'),{code:'ENOSPC'});return native(fd);});
 try{await assert.rejects(q.resumeDelivery(p.control_sha256,{confirm:true}),e=>{const d=captureJournalDiagnostic(e);assert.equal(d.target,'control');assert.equal(d.phase,'file-sync');assert.equal(d.publication,'not_attempted');return true;});}finally{sync();open();}
 assert.deepEqual(fs.readFileSync(path),before);assert.equal(fs.readdirSync(q.directory).filter(n=>n.startsWith('.tmp-')).length,1);
});
test('control audit: rename completed before error is unconfirmed, not rolled back or automatically retried',async t=>{
 const {q,path}=setup(t);const p=await q.pauseDelivery();let count=0;
 const restore=patch('renameSync',(native,a,b,...rest)=>{const r=native(a,b,...rest);if(b===path){count++;throw Object.assign(Error('PRIVATE'),{code:'EIO'});}return r;});
 try{await assert.rejects(q.resumeDelivery(p.control_sha256,{confirm:true}),e=>{const d=captureJournalDiagnostic(e);assert.equal(d.target,'control');assert.equal(d.phase,'publish');assert.equal(d.publication,'unconfirmed');return true;});}finally{restore();}
 assert.equal(count,1);assert.equal((await q.status()).delivery.state,'running');await assert.rejects(q.resumeDelivery(p.control_sha256,{confirm:true}),{code:'conflict'});
});
test('control audit: unexpected filenames prevent control mutation without deleting evidence',async t=>{
 const {q,path}=setup(t);const p=await q.pauseDelivery(),before=fs.readFileSync(path);fs.writeFileSync(join(q.directory,'unexpected'),'',{mode:0o600});
 await assert.rejects(q.pauseDelivery(),{code:'outbox_corrupt'});await assert.rejects(q.resumeDelivery(p.control_sha256,{confirm:true}),{code:'outbox_corrupt'});assert.deepEqual(fs.readFileSync(path),before);
});
test('control audit: symlink control is refused without following or replacing it',async t=>{
 const {q,path,root}=setup(t);const p=await q.pauseDelivery(),original=fs.readFileSync(path),target=join(root,'target');fs.renameSync(path,target);
 fs.symlinkSync(target,path);await assert.rejects(q.resumeDelivery(p.control_sha256,{confirm:true}),{code:'insecure_outbox'});
 assert.deepEqual(fs.readFileSync(target),original);assert.equal(fs.lstatSync(path).isSymbolicLink(),true);
});
