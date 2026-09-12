import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,chmodSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AgentMemory} from '../src/agent-memory.mjs';
import {DurableOutbox} from '../src/durable-outbox.mjs';
import {deferredSlug,enqueueSession,processSessions} from '../src/deferred-sessions.mjs';
import {workerOptions,readWorkerToken,consolidateOnce,boundTokenFetch} from '../src/consolidation-client.mjs';
import {sha256} from '../src/core.mjs';
const wrap=x=>({content:[{type:'text',text:JSON.stringify(x)}]});
const receipt={uri:'ultra://default/sessions/deferred/a/b',state:'queued',storage:'journaled',deferred:true};
const raw={session_id:'s',event_id:'e',transcript:'retained',visibility:'private',defer_extraction:true};
function fixture(t) {
 const directory=mkdtempSync(join(tmpdir(),'ub-deferred-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const config={directory,rootUri:'ultra://default/',principalId:'actor',serverId:'server'};
 return {directory,config,outbox:new DurableOutbox(config)};
}
test('deferred mode is opt-in and carries immutable delivery policy through restart',async t=>{
 const f=fixture(t);f.outbox.enqueue(raw);let submitted;
 const fresh=new DurableOutbox(f.config);
 await fresh.flush(async p=>{submitted=p;return receipt;});
 assert.equal(submitted.defer_extraction,true);assert.equal(fresh.inspect().pending,0);
 assert.equal(fresh.enqueue(raw).receipt.storage,'journaled');
 assert.throws(()=>fresh.enqueue({...raw,defer_extraction:false}),{code:'conflict'});
});
test('old inline outbox cannot accept a deferred ACK masquerading as canonical storage',async t=>{
 const {outbox}=fixture(t);const value={...raw};delete value.defer_extraction;const job=outbox.enqueue(value);
 assert.throws(()=>outbox.acknowledge(job.key,sha256(JSON.stringify(value)),receipt),{code:'unconfirmed_capture'});
 assert.equal(outbox.inspect().pending,1);
});
test('capture records queued as journaled rather than extracted, without calling consolidation',async t=>{
 const {outbox}=fixture(t);const called=[];
 const memory=new AgentMemory({client:{async callTool(p){called.push(p);return wrap(receipt);}},
   rootUri:'ultra://default/',sessionId:'s',capture:true,deferExtraction:true,outbox,principalId:'actor',serverId:'server'});
 assert.equal((await memory.afterTurn({eventId:'e',transcript:'retained'})).state,'queued');
 assert.deepEqual(called.map(c=>c.name),['ultra_commit_session']);assert.equal(called[0].arguments.defer_extraction,true);
});
test('consolidation is explicit and uses configured source not a server-supplied override',async()=>{
 let call;
 const client={async callTool(p){call=p;return wrap({source_id:'default',results:[]});}};
 const memory=new AgentMemory({client,rootUri:'ultra://default/',sessionId:'s',capture:true,deferExtraction:true});
 await memory.processPending();assert.equal(call.arguments.expected_source,'default');
 const disabled=new AgentMemory({client,rootUri:'ultra://default/',sessionId:'s'});
 await assert.rejects(disabled.processPending(),{code:'capture_disabled'});
});
test('failed authority is checked before any deferred SQL or model work',async()=>{
 const store={source:'default',actor:'a',async assertSessionAccess(){throw Object.assign(new Error('denied'),{code:'scope_denied'});},
 sql(){assert.fail('SQL before auth');},transaction(){assert.fail('transaction before auth');}};
 await assert.rejects(enqueueSession(store,raw),{code:'scope_denied'});
 await assert.rejects(processSessions(store,{expected_source:'default'}),{code:'scope_denied'});
});
test('dry capture never writes or calls a model',async()=>{
 const store={source:'default',actor:'a',dryRun:true,async assertSessionAccess(){},transaction(){assert.fail('no writes');}};
 assert.equal((await enqueueSession(store,raw)).storage,'not_stored');
});
test('deferred identifiers remain case-sensitive through lowercase native URI storage',()=>{
 const a=sha256('actor');assert.notEqual(deferredSlug(a,'S','E'),deferredSlug(a,'s','e'));
});
test('worker rejects remote plaintext, embedded credentials, query and automated failed retries',()=>{
 const args=['--source','default','--token-file','/test/token'];
 for(const url of ['http://example.com/mcp','https://user:secret@example.com/mcp','https://example.com/mcp?a=b'])
  assert.throws(()=>workerOptions([...args,'--url',url]),{code:'insecure_endpoint'});
 assert.throws(()=>workerOptions([...args,'--url','http://127.0.0.1:3131/mcp','--loop','--retry']),{code:'invalid_params'});
 assert.equal(workerOptions([...args,'--url','https://example.com/mcp']).once,true);
});
test('worker reads owner-only token files without following symlinks',t=>{
 const {directory}=fixture(t),path=join(directory,'token');writeFileSync(path,'gbrain_this-is-a-test-token',{mode:0o600});
 assert.equal(readWorkerToken(path),'gbrain_this-is-a-test-token');
 chmodSync(path,0o644);assert.throws(()=>readWorkerToken(path),{code:'insecure_token_file'});
 chmodSync(path,0o600);symlinkSync(path,join(directory,'alias'));assert.throws(()=>readWorkerToken(join(directory,'alias')));
});
test('worker logs aggregate states only, never payloads or server error messages',async()=>{
 const client={async callTool(){return wrap({source_id:'default',results:[{state:'needs_model',transcript:'SECRET'}]});}};
 const result=await consolidateOnce(client,{source:'default',limit:1});assert.deepEqual(result,{processed:1,states:{needs_model:1}});
 assert.ok(!JSON.stringify(result).includes('SECRET'));
 client.callTool=async()=>({...wrap({error:'SECRET'}),isError:true});
 await assert.rejects(consolidateOnce(client,{source:'default',limit:1}),{code:'consolidation_rejected'});
});
test('worker token cannot follow SDK metadata to a different origin or HTTP downgrade',async t=>{
 const {directory}=fixture(t),file=join(directory,'token');writeFileSync(file,'gbrain_testing_no_real_key',{mode:0o600});
 let requests=0;const bound=boundTokenFetch('https://memory.example/mcp',file,async(url,init)=>{requests++;assert.equal(init.redirect,'error');return new Response('ok');});
 await bound('https://memory.example/mcp');assert.equal(requests,1);
 for(const url of ['https://other.example/oauth','http://memory.example/mcp'])assert.throws(()=>bound(url),{code:'insecure_endpoint'});
 assert.equal(requests,1);
});
