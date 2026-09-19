/** Independent review probes. Synthetic transports/DOM; no client host or PostgreSQL claims. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,unlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import vm from 'node:vm';
import {CaptureOutbox} from '../ultrabrain/src/capture-outbox.mjs';
import {deliverCapture} from '../ultrabrain/src/capture-delivery.mjs';
import {deliverDocumentImport} from '../ultrabrain/src/client-document.mjs';
import {sha256} from '../ultrabrain/src/core.mjs';
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const payload=(event_id='review')=>({agent_id:'reviewer',event_id,transcript:'Synthetic review text',consent:true});
function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'review-ub-consent-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const workspace=join(root,'workspace');mkdirSync(workspace,{mode:0o700});
  const input={format:1,source:'review',workspace,allow_capture:true,outbox_directory:join(root,'queue'),
    expected_instance:'11111111-1111-4111-8111-111111111111',expected_actor:'a'.repeat(64),
    server:{transport:'stdio',command:'node',args:[]}};
  const q=new CaptureOutbox(input);
  const identity={format:1,source_id:input.source,instance_id:input.expected_instance,actor_key:input.expected_actor};
  const connection=capture=>({identity,capture,close:async()=>{}});
  const receipt=p=>({source_id:input.source,event_id:p.event_id,storage:'journaled',job_id:'22222222-2222-4222-8222-222222222222'});
  return {q,input,connection,receipt,entries:()=>readdirSync(q.directory).filter(n=>n.endsWith('.entry'))};
}
test('flush waits for queue lock then rechecks false without consuming attempts',async t=>{
  const f=fixture(t);await f.q.enqueue(payload());
  const path=join(f.q.directory,f.entries()[0]),before=readFileSync(path),lock=join(f.q.directory,'.queue.lock');
  writeFileSync(lock,'{"pid":2147483647}',{mode:0o600});
  let permitted=true;
  const running=f.q.flush(()=>assert.fail('Connection must not open'),{authorize:()=>permitted});
  await turn();permitted=false;unlinkSync(lock);
  await assert.rejects(running,{code:'capture_disabled'});
  assert.deepEqual(readFileSync(path),before);
  assert.ok(!readdirSync(f.q.directory).some(n=>n.endsWith('.lock')));
});
test('enqueue rejects a thenable that appears only after waiting for queue lock',async t=>{
  const f=fixture(t);await f.q.status();const lock=join(f.q.directory,'.queue.lock');
  writeFileSync(lock,'{"pid":2147483647}',{mode:0o600});
  let asynchronous=false;
  const running=f.q.enqueue(payload(),{authorize:()=>asynchronous?Promise.resolve(true):undefined});
  await turn();asynchronous=true;unlinkSync(lock);
  await assert.rejects(running,{code:'invalid_params'});await turn();assert.deepEqual(f.entries(),[]);
});
test('thenable rejection is consumed without persistence or an unhandled rejection',async t=>{
  const f=fixture(t);let called=0;const unhandled=[];const listener=e=>unhandled.push(e);
  process.on('unhandledRejection',listener);t.after(()=>process.removeListener('unhandledRejection',listener));
  await assert.rejects(f.q.enqueue(payload(),{authorize:()=>({then(_resolve,reject){called++;reject(new Error('synthetic thenable denial'));}})}),{code:'invalid_params'});
  await turn();assert.equal(called,1);assert.deepEqual(unhandled,[]);assert.deepEqual(f.entries(),[]);
});
test('capture abort within the final authorization callback prevents plaintext dispatch',async()=>{
  const controller=new AbortController(),calls=[];let auth=0;
  await assert.rejects(deliverCapture(payload(),{allowCapture:true,projectId:null},{signal:controller.signal,
    authorize(){if(++auth===3)controller.abort();},checkIdentity:async()=>{},invoke:async name=>calls.push(name)}),{code:'aborted'});
  assert.deepEqual(calls,['ultra_agent_register']);
});
test('document abort within final authorization preserves prior registration boundary',async()=>{
  const controller=new AbortController(),calls=[];let checks=0;
  const data={...payload(),label:'review.txt',content_base64:Buffer.from('synthetic').toString('base64'),content_sha256:sha256('synthetic')};delete data.transcript;
  await assert.rejects(deliverDocumentImport(data,{allowDocuments:true,projectId:null,source:'review'},{signal:controller.signal,
    checkIdentity:async()=>{checks++;},authorize(){if(checks===3)controller.abort();},
    invoke:async name=>{calls.push(name);return name==='ultra_agent_list'?{source_id:'review',agents:[],next_offset:null}:{};}}),{code:'aborted'});
  assert.deepEqual(calls,['ultra_agent_list','ultra_agent_register']);
});
test('revocation after matched first acknowledgement leaves later immutable records untouched',async t=>{
  const f=fixture(t);await f.q.enqueue(payload('first'));await f.q.enqueue(payload('second'));
  const paths=f.entries().sort(),remaining=join(f.q.directory,paths[1]),original=readFileSync(remaining);let permitted=true,sent=0;
  await assert.rejects(f.q.flush(async()=>f.connection(async p=>{sent++;permitted=false;return f.receipt(p);}),
    {limit:2,authorize:()=>permitted}),{code:'capture_disabled'});
  assert.equal(sent,1);assert.equal(f.entries().length,1);assert.deepEqual(readFileSync(remaining),original);
});
test('mismatched acknowledgement after revocation never deletes the pending event',async t=>{
  const f=fixture(t);await f.q.enqueue(payload());let permitted=true;
  const report=await f.q.flush(async()=>f.connection(async p=>{permitted=false;return {...f.receipt(p),event_id:'foreign'};}),{authorize:()=>permitted});
  assert.equal(report.delivered,0);assert.equal(report.blocked,1);assert.equal(report.last_error,'mcp_contract_changed');
  const path=join(f.q.directory,f.entries()[0]),record=JSON.parse(readFileSync(path));assert.deepEqual(record.payload,payload());
  const before=readFileSync(path);await assert.rejects(f.q.flush(()=>assert.fail(),{authorize:()=>permitted}),{code:'capture_disabled'});
  assert.deepEqual(readFileSync(path),before);
});
const app=readFileSync(new URL('../ultrabrain/web/personal/app.js',import.meta.url),'utf8');
function browserFixture(){
  let release;const calls=[],elements=new Map();
  const element=()=>({value:'',checked:false,dataset:{},hidden:false,disabled:false,textContent:'',handlers:new Map(),
    addEventListener(name,fn){this.handlers.set(name,fn);},reset(){},replaceChildren(){},setAttribute(){},append(){},focus(){}});
  const get=id=>{if(!elements.has(id))elements.set(id,element());return elements.get(id);};
  const context=vm.createContext({document:{getElementById:get,querySelectorAll:()=>[],createElement:element},window:{addEventListener(){}},crypto:{randomUUID},AbortSignal,confirm:()=>true,
    fetch:async(_url,options)=>{const body=JSON.parse(options.body);calls.push(body);if(body.operation==='register')await new Promise(r=>release=r);
      return {ok:true,json:async()=>({ok:true,result:{memories:[],next_offset:null}})};}});
  vm.runInContext(app,context);vm.runInContext("token='session-a';sourceId='review';",context);
  get('content').value='Synthetic pending input';get('consent').checked=true;get('type').value='preference';get('visibility').value='private';
  return {get,calls,run:code=>vm.runInContext(code,context),release:()=>release(),submit:()=>get('memory-form').handlers.get('submit')({preventDefault(){}}),
    async settled(){for(let i=0;i<100&&vm.runInContext('busy',context);i++)await turn();assert.equal(vm.runInContext('busy',context),false);}};
}
for(const change of ["token='session-b'","sourceId='foreign'","editing={id:'another',revision:2}","document.getElementById('importance').value='critical'","document.getElementById('provenance').value='changed'","document.getElementById('type').value='identity'"])
test('browser pending registration binds '+change,async()=>{
  const f=browserFixture();f.submit();await turn();f.run(change);f.release();await f.settled();
  assert.deepEqual(f.calls.map(c=>c.operation),['register']);assert.equal(f.run('pending'),null);assert.match(f.get('message').textContent,/memory_consent_or_selection_changed/);
});
