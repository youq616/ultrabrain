import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync,readFileSync,writeFileSync,chmodSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DurableOutbox} from '../src/durable-outbox.mjs';
import {AgentMemory} from '../src/agent-memory.mjs';
const payload={session_id:'s1',event_id:'e1',transcript:'consented conversation',visibility:'private'};
const receipt={state:'needs_model',uri:'ultra://default/sessions/actor/s1/e1',storage:'stored'};
const wrap=value=>({content:[{type:'text',text:JSON.stringify(value)}]});
function fixture(t, extra={}) {
  const directory=mkdtempSync(join(tmpdir(),'ub-outbox-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const config={directory,rootUri:'ultra://default/',principalId:'actor1',serverId:'server1',...extra};
  return {directory,config,box:new DurableOutbox(config)};
}
test('durable events survive a fresh client instance',async t=>{
  const {box,config}=fixture(t);box.enqueue(payload);
  const next=new DurableOutbox(config);let delivered;
  await next.flush(async p=>{delivered=p;return receipt;});
  assert.equal(delivered.transcript,payload.transcript);assert.equal(delivered.retry,true);
  assert.equal(next.inspect().pending,0);
});
test('no raw transcript is retained in acknowledged journal files',async t=>{
  const {box,directory}=fixture(t);box.enqueue(payload);await box.flush(async()=>receipt);
  for(const n of readdirSync(directory)) assert.ok(!readFileSync(join(directory,n),'utf8').includes(payload.transcript));
  assert.equal(box.enqueue(payload).acknowledged,true);
});
test('event reuse is rejected before and after ACK',async t=>{
  const {box}=fixture(t);box.enqueue(payload);
  assert.throws(()=>box.enqueue({...payload,transcript:'changed'}),{code:'conflict'});
  await box.flush(async()=>receipt);
  assert.throws(()=>box.enqueue({...payload,transcript:'changed'}),{code:'conflict'});
});
test('a journal cannot be silently reassigned to another principal or server',t=>{
  const {config}=fixture(t);
  assert.throws(()=>new DurableOutbox({...config,principalId:'another'}),{code:'outbox_binding_mismatch'});
  assert.throws(()=>new DurableOutbox({...config,serverId:'another'}),{code:'outbox_binding_mismatch'});
});
test('network failure preserves data and persists backoff',async t=>{
  const {box,config}=fixture(t);box.enqueue(payload);
  const first=await box.flush(async()=>{throw Object.assign(new Error('secret password'),{code:'mcp_timeout'});});
  assert.equal(first.results[0].state,'pending');
  const fresh=new DurableOutbox(config);
  const deferred=await fresh.flush(async()=>{throw new Error('must not send during backoff');});
  assert.equal(deferred.deferred,1);assert.equal(deferred.results.length,0);
  await fresh.flush(async()=>receipt,{force:true});assert.equal(fresh.inspect().pending,0);
});
test('lost response replays the same immutable event rather than rerunning generation',async t=>{
  const {box}=fixture(t);box.enqueue(payload);const seen=new Set();let calls=0;
  const send=async p=>{calls++;seen.add(p.event_id);if(calls===1)throw new Error('connection lost after save');return receipt;};
  await box.flush(send);await box.flush(send,{force:true});
  assert.equal(calls,2);assert.equal(seen.size,1);assert.equal(box.inspect().pending,0);
});
test('queue fullness never silently evicts unacknowledged data',t=>{
  const {box}=fixture(t,{maxEvents:1});box.enqueue(payload);
  assert.throws(()=>box.enqueue({...payload,event_id:'e2'}),{code:'outbox_full'});
  assert.equal(box.inspect().pending,1);
});
test('corrupt event fails closed before sending',async t=>{
  const {box,directory}=fixture(t);const {key}=box.enqueue(payload);
  const path=join(directory,`${key}.event.json`);const value=JSON.parse(readFileSync(path,'utf8'));
  value.payload.transcript='tampered';writeFileSync(path,JSON.stringify(value));
  const result=await box.flush(async()=>{assert.fail('should not send');});
  assert.equal(result.results[0].state,'quarantined');
  assert.equal(box.inspect().quarantined,1);
});
test('symlink and non-private journal paths are rejected',t=>{
  const {directory,config}=fixture(t);
  const link=join(directory,'alias');symlinkSync(directory,link);
  assert.throws(()=>new DurableOutbox({...config,directory:link}),{code:'insecure_outbox'});
  chmodSync(directory,0o755);assert.throws(()=>new DurableOutbox(config),{code:'insecure_outbox'});
});
test('foreign source receipt is not accepted as delivery confirmation',async t=>{
  const {box}=fixture(t);box.enqueue(payload);
  const result=await box.flush(async()=>({...receipt,uri:'ultra://other/sessions/a'}));
  assert.equal(result.results[0].error,'scope_denied');assert.equal(box.inspect().pending,1);
});
test('capture filtering happens before persistence and network submission',async t=>{
  const {box,directory}=fixture(t);let sent;
  const memory=new AgentMemory({client:{async callTool(p){sent=p.arguments;throw new Error('offline');}},
    rootUri:'ultra://default/',sessionId:'s1',capture:true,outbox:box,principalId:'actor1',serverId:'server1',
    captureFilter:s=>s.replaceAll('SECRET','[redacted]')});
  await assert.rejects(memory.afterTurn({eventId:'e1',transcript:'SECRET'}),{durablyQueued:true});
  assert.equal(sent.transcript,'[redacted]');
  for(const n of readdirSync(directory)) assert.ok(!readFileSync(join(directory,n),'utf8').includes('SECRET'));
});
test('excluded turns reach neither disk nor network',async t=>{
  const {box}=fixture(t);const memory=new AgentMemory({client:{callTool(){throw new Error('not permitted');}},
    rootUri:'ultra://default/',sessionId:'s1',capture:true,outbox:box,principalId:'actor1',serverId:'server1',captureFilter:()=>null});
  assert.equal((await memory.afterTurn({eventId:'e1',transcript:'private'})).storage,'not_stored');assert.equal(box.inspect().pending,0);
});
test('pending capture is not submitted while opt-in is disabled',async t=>{
  const {box}=fixture(t);box.enqueue(payload);
  const memory=new AgentMemory({client:{callTool(){throw new Error('not permitted');}},rootUri:'ultra://default/',sessionId:'s1',
    outbox:box,principalId:'actor1',serverId:'server1'});
  await assert.rejects(memory.flushOutbox(),{code:'capture_disabled'});
});

for (const ch of ['"','\\','\n','\u0001']) test(`64 KiB escaped payload round-trips after restart: ${JSON.stringify(ch)}`,async t=>{
  const {box,config}=fixture(t), transcript='x'+ch.repeat(65535);
  assert.equal(Buffer.byteLength(transcript),65536);
  box.enqueue({...payload,transcript});
  const next=new DurableOutbox(config); let sent=0;
  await next.flush(async p=>{assert.equal(p.transcript,transcript);sent++;return receipt;});
  assert.equal(sent,1);assert.equal(next.inspect().pending,0);
});
test('one corrupt event is isolated without blocking healthy records or force-replaying it',async t=>{
  const {box,directory}=fixture(t), bad=box.enqueue(payload);
  box.enqueue({...payload,event_id:'healthy'});
  writeFileSync(join(directory,`${bad.key}.event.json`),'not-json');
  const seen=[]; const send=async p=>{seen.push(p.event_id);return receipt;};
  const r=await box.flush(send);assert.equal(r.quarantined,1);assert.deepEqual(seen,['healthy']);
  assert.equal(readFileSync(join(directory,`${bad.key}.event.json`),'utf8'),'not-json');
  await box.flush(send,{force:true});assert.deepEqual(seen,['healthy']);
  assert.throws(()=>box.enqueue(payload),{code:'outbox_quarantined'});
});
test('oversized, symlinked and corrupt ACK records never cause unsafe delivery',async t=>{
  const {box,directory}=fixture(t);const a=box.enqueue(payload),b=box.enqueue({...payload,event_id:'second'});
  writeFileSync(join(directory,`${a.key}.ack.json`),'{');chmodSync(join(directory,`${a.key}.ack.json`),0o600);
  const r=await box.flush(async p=>{assert.equal(p.event_id,'second');return receipt;});
  assert.equal(r.quarantined,1);
  const c=box.enqueue({...payload,event_id:'third'});
  writeFileSync(join(directory,`${c.key}.event.json`),'a'.repeat(524289));
  const r2=await box.flush(async()=>assert.fail('oversized sent'));assert.equal(r2.results[0].state,'quarantined');
});

test('symlinked event is quarantined without following or altering its target',async t=>{
  const {box,directory}=fixture(t);const {key}=box.enqueue(payload);
  const target=join(directory,'external-secret');writeFileSync(target,'DO NOT READ');
  rmSync(join(directory,`${key}.event.json`));symlinkSync(target,join(directory,`${key}.event.json`));
  const result=await box.flush(async()=>assert.fail('symlink sent'));
  assert.equal(result.results[0].state,'quarantined');assert.equal(readFileSync(target,'utf8'),'DO NOT READ');
});
