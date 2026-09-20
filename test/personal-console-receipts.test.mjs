/** Shipped browser JS with explicit synthetic HTTP replies; real DB/browser tests are separate. */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
const app=readFileSync(new URL('../web/personal/app.js',import.meta.url),'utf8');
const id='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const tick=()=>new Promise(r=>setImmediate(r));
function receipt(body){
 const p=body.input;
 if(body.operation==='register')return {source_id:'default',agent_id:p.agent_id,actor_key:'a'.repeat(64),revision:1,replayed:true};
 if(body.operation==='commit')return {source_id:'default',event_id:p.event_id,entries:[{id,revision:1,status:'candidate'}],
   storage:'stored',state:'candidate',review_required:true,model_calls:0,replayed:false};
 if(body.operation==='capture')return {source_id:'default',event_id:p.event_id,input_id:id,input_revision:1,job_id:other,
   storage:'journaled',state:'queued',review_required:true,model_calls:0,replayed:false};
 if(body.operation==='update')return {id:p.memory_id,revision:p.expected_revision+1,status:'candidate',review_required:true,replayed:false};
 if(body.operation==='review')return {id:p.memory_id,revision:p.expected_revision+1,status:p.status,replayed:false};
 return {memories:[],next_offset:null};
}
function fixture(route=async b=>receipt(b)){
 const nodes=new Map(),calls=[];
 const element=()=>({value:'',checked:false,dataset:{},hidden:false,disabled:false,textContent:'',children:[],handlers:new Map(),
  addEventListener(k,f){this.handlers.set(k,f);},reset(){for(const x of ['content','project'])get(x).value='';},replaceChildren(){this.children=[];},
  append(...xs){this.children.push(...xs);},setAttribute(){},focus(){}});
 const get=k=>{if(!nodes.has(k))nodes.set(k,element());return nodes.get(k);};
 const ctx=vm.createContext({document:{getElementById:get,createElement:element,querySelectorAll:()=>[]},window:{addEventListener(){}},
  TextEncoder,TextDecoder,AbortController,AbortSignal,crypto:webcrypto,confirm:()=>true,
  fetch:async(_url,o)=>{const body=JSON.parse(o.body);calls.push(body);const reply=await route(body);
   return {ok:(reply?.__status??200)<400,status:reply?.__status??200,json:async()=>reply?.__envelope??({ok:true,result:reply})};}});
 const run=s=>vm.runInContext(s,ctx);run(app);run("sourceId='default';token='PRIVATE_SESSION_TOKEN';view='lookup';");
 Object.entries({content:'ORIGINAL_DRAFT',type:'preference',visibility:'private',importance:'normal',provenance:'Synthetic user',project:''})
   .forEach(([k,v])=>get(k).value=v);get('consent').checked=true;
 return {get,run,calls,
  start(operation='commit'){
   if(operation==='update')run(`editing={id:'${id}',revision:2,origin_kind:'agent',owned_by_caller:true};`);
   if(operation==='review')run(`mutate('review',{memory_id:'${id}',expected_revision:2,status:'archived'});`);
   else if(operation==='capture')get('queue-personal').handlers.get('click')();
   else get('memory-form').handlers.get('submit')({preventDefault(){}});
  },retry(){get('retry').handlers.get('click')();},
  async settle(){for(let i=0;i<200&&run('busy');i++)await tick();assert.equal(run('busy'),false);}};
}
for(const op of ['commit','capture','update','review'])test(op+' verifies a matching receipt then clears pending',async()=>{
 const f=fixture();f.start(op);await f.settle();assert.equal(f.run('pending'),null);assert.equal(f.calls.filter(b=>b.operation===op).length,1);
 assert.match(f.get('message').textContent,/操作已确认/);
});
const corruptions={
 commit:[['event',r=>r.event_id='other-event'],['source',r=>r.source_id='foreign'],['state',r=>r.state='active'],
  ['count',r=>r.entries=[]],['duplicate',r=>r.entries.push(r.entries[0])],['revision',r=>r.entries[0].revision=2],
  ['id',r=>r.entries[0].id='not-a-uuid'],['entry state',r=>r.entries[0].status='active'],['stored',r=>r.storage='not_stored'],
  ['model',r=>r.model_calls=1],['review',r=>r.review_required=false],['replay',r=>r.replayed='false']],
 capture:[['event',r=>r.event_id='wrong'],['source',r=>r.source_id='foreign'],['input',r=>r.input_id='invalid'],
  ['job',r=>r.job_id='not-a-uuid'],['revision',r=>r.input_revision=2],['state',r=>r.state='completed'],
  ['storage',r=>r.storage='stored'],['model',r=>r.model_calls=1]],
 update:[['id',r=>r.id=other],['revision',r=>r.revision=4],['state',r=>r.status='active'],['review',r=>r.review_required=false]],
 review:[['id',r=>r.id=other],['revision',r=>r.revision=2],['state',r=>r.status='active']],
};
for(const [op,cases]of Object.entries(corruptions))for(const [label,change]of cases)test(op+' retains the immutable pending request on wrong '+label,async()=>{
 const f=fixture(async b=>{const r=receipt(b);if(b.operation===op)change(r);return r;});f.start(op);await f.settle();
 assert.equal(f.run('pending?.delivery_unconfirmed'),true);assert.equal(f.get('content').value,'ORIGINAL_DRAFT');
 assert.equal(f.calls.filter(b=>b.operation===op).length,1);assert.match(f.get('message').textContent,/console_receipt_unconfirmed/);
});
for(const envelope of [{ok:'true',result:{}},{ok:true},{ok:true,result:null},{ok:true,result:[]},[]])test('malformed success envelope does not discard a sent event '+JSON.stringify(envelope),async()=>{
 const f=fixture(async b=>b.operation==='update'?{__envelope:envelope}:receipt(b));f.start('update');await f.settle();
 assert.equal(f.run('pending?.delivery_unconfirmed'),true);assert.equal(f.get('content').value,'ORIGINAL_DRAFT');
});
for(const key of ['source_id','agent_id','actor_key','revision','replayed'])test('invalid registration '+key+' blocks the following plaintext request',async()=>{
 const f=fixture(async b=>{const r=receipt(b);if(b.operation==='register')r[key]='WRONG';return r;});
 f.start();await f.settle();assert.equal(f.calls.some(b=>b.operation==='commit'),false);
 assert.equal(f.get('content').value,'ORIGINAL_DRAFT');assert.notEqual(f.run('pending'),null);
});
for(const op of ['commit','capture','update','review'])test(op+' can retry a bad receipt only with the same original request',async()=>{
 let attempts=0;const f=fixture(async b=>{const r=receipt(b);if(b.operation===op){if(++attempts===1)return {};r.replayed=true;}return r;});
 f.start(op);await f.settle();assert.equal(f.run('pending?.delivery_unconfirmed'),true);
 const first=f.calls.find(b=>b.operation===op);f.retry();await f.settle();assert.equal(f.run('pending'),null);
 assert.deepEqual(f.calls.filter(b=>b.operation===op),[first,first]);
});
for(const op of ['commit','capture','update'])for(const change of ['content','consent'])test(op+' confirmation preserves form changes made after transmission: '+change,async()=>{
 let release;const f=fixture(async b=>{if(b.operation===op)await new Promise(r=>release=r);return receipt(b);});
 f.start(op);while(!release)await tick();
 if(change==='content')f.get('content').value='NEWER_UNSAVED_DRAFT';else f.get('consent').checked=false;
 release();await f.settle();assert.equal(f.run('pending'),null);assert.equal(f.get('content').value,change==='content'?'NEWER_UNSAVED_DRAFT':'ORIGINAL_DRAFT');
 assert.equal(f.get('consent').checked,false);assert.match(f.get('message').textContent,/草稿.*保留/);
 if(op==='update')assert.equal(f.run('editing.revision'),2,'Do not silently rebase the new draft');
});
test('reviewing a record does not clear an unrelated unsaved draft',async()=>{
 const f=fixture();f.start('review');await f.settle();assert.equal(f.run('pending'),null);assert.equal(f.get('content').value,'ORIGINAL_DRAFT');
});
test('receipt from a different session cannot be confirmed under the new session',async()=>{
 let release;const f=fixture(async b=>{if(b.operation==='commit')await new Promise(r=>release=r);return receipt(b);});
 f.start();while(!release)await tick();f.run("token='NEW_SESSION';");release();await f.settle();
 assert.equal(f.run('pending?.delivery_unconfirmed'),true);assert.equal(f.get('content').value,'ORIGINAL_DRAFT');
});
test('the pending export contains neither session token nor callbacks as data',async()=>{
 const f=fixture(async b=>b.operation==='commit'?{}:receipt(b));f.start();await f.settle();
 assert.notEqual(f.run('pending'),null);assert.ok(!f.run('JSON.stringify(pending)').includes('PRIVATE_SESSION_TOKEN'));
});

// Implementation self-review: falsified rejection, stable replay and post-ack UI failures.
for(const reply of [
 {__envelope:{ok:false,delivery:'rejected'}},
 {__envelope:{ok:false,error:'untrusted_error'}},
 {__envelope:{ok:true,result:{}},__status:400},
])test('ambiguous error/success envelopes preserve a sent update '+JSON.stringify(reply),async()=>{
 const f=fixture(async b=>b.operation==='update'?reply:receipt(b));f.start('update');await f.settle();
 assert.equal(f.run('pending?.delivery_unconfirmed'),true);assert.equal(f.get('content').value,'ORIGINAL_DRAFT');
});
test('duplicate IDs are rejected even when a batch has the correct entry count',async()=>{
 const f=fixture(async b=>{const r=receipt(b);if(b.operation==='commit')r.entries.push({...r.entries[0]});return r;});
 f.run("mutate('commit',{agent_id:'personal-console',consent:true,memories:[{type:'preference',content:'one'},{type:'preference',content:'two'}]});");
 await f.settle();assert.equal(f.run('pending?.delivery_unconfirmed'),true);
});
test('nested pending input cannot be changed before an explicit replay',async()=>{
 let attempts=0;const f=fixture(async b=>{const r=receipt(b);if(b.operation==='commit'&&++attempts===1)return {};return r;});
 f.start();await f.settle();const original=f.calls.find(b=>b.operation==='commit').input;
 f.run("pending.input.memories[0].content='OTHER'; pending.input.event_id='OTHER';");
 f.retry();await f.settle();assert.deepEqual(f.calls.filter(b=>b.operation==='commit')[1].input,original);
});
test('bad registration on retry cannot erase an earlier ambiguous body submission',async()=>{
 let registrations=0;const f=fixture(async b=>{
   const r=receipt(b);if(b.operation==='register'&&++registrations>1)r.source_id='foreign';
   if(b.operation==='commit')return {};return r;
 });
 f.start();await f.settle();const event=f.run('pending.input.event_id');f.retry();await f.settle();
 assert.equal(f.run('pending.delivery_unconfirmed'),true);assert.equal(f.run('pending.input.event_id'),event);
 assert.equal(f.calls.filter(b=>b.operation==='commit').length,1);
});
test('a post-ack rendering failure never creates an unconfirmed retry',async()=>{
 const f=fixture();f.run("resetEditor=()=>{throw Error('Synthetic rendering failure');};");f.start();await f.settle();
 assert.equal(f.run('pending'),null);assert.match(f.get('message').textContent,/已取得确认/);
 f.retry();await f.settle();assert.equal(f.calls.filter(b=>b.operation==='commit').length,1);
});
test('normal document metadata operation does not erase an unrelated draft',async()=>{
 const f=fixture(async b=>b.operation==='document_archive'?{source_id:'default',event_id:b.input.event_id,document_id:id,
  status:'archived',revision:2,archived_at:'2026-09-20T00:00:00.000Z',archived_fragments:0,fenced_jobs:0,
  derived_entries_invalidated:0,original_retained:true,model_calls:0,replayed:false}:receipt(b));
 f.run(`mutate('document_archive',{document_id:'${id}'},undefined,{document_id:'${id}',revision:1,byte_size:1});`);await f.settle();
 assert.equal(f.run('pending'),null);assert.equal(f.get('content').value,'ORIGINAL_DRAFT');
});

// Independent Codex review 5258535272 / 4055400401: a complete negative
// envelope on HTTP success is contradictory, not proof a write was rejected.
for(const op of ['commit','capture','update','review'])test('independent review: HTTP success with complete rejection retains '+op,async()=>{
 const f=fixture(async b=>b.operation===op?{__status:200,__envelope:{ok:false,error:'invalid_params',delivery:'rejected'}}:receipt(b));
 f.start(op);await f.settle();assert.equal(f.run('pending?.delivery_unconfirmed'),true);
 assert.equal(f.get('content').value,'ORIGINAL_DRAFT');assert.equal(f.calls.filter(b=>b.operation===op).length,1);
 assert.match(f.get('message').textContent,/response_unconfirmed/);
});
test('independent review: contradictory registration retains preparation without target send',async()=>{
 const f=fixture(async b=>b.operation==='register'?{__status:200,__envelope:{ok:false,error:'invalid_params',delivery:'rejected'}}:receipt(b));
 f.start();await f.settle();assert.notEqual(f.run('pending'),null);
 assert.equal(f.run('pending.delivery_unconfirmed??false'),false);
 assert.equal(f.calls.some(b=>b.operation==='commit'),false);
});
test('independent review: explicit non-success rejection still terminates a previously unsent event',async()=>{
 const f=fixture(async b=>b.operation==='update'?{__status:400,__envelope:{ok:false,error:'revision_conflict',delivery:'rejected'}}:receipt(b));
 f.start('update');await f.settle();assert.equal(f.run('pending'),null);
 assert.equal(f.get('content').value,'ORIGINAL_DRAFT');assert.match(f.get('message').textContent,/revision_conflict/);
});
test('independent review: HTTP-success rejection replays the original event after an actual ambiguity',async()=>{
 let attempts=0;const f=fixture(async b=>{
  if(b.operation==='commit'&&++attempts===1)return {__status:200,__envelope:{ok:false,error:'invalid_params',delivery:'rejected'}};
  const r=receipt(b);if(b.operation==='commit')r.replayed=true;return r;
 });
 f.start();await f.settle();const original=f.calls.find(b=>b.operation==='commit');assert.notEqual(f.run('pending'),null);
 f.retry();await f.settle();assert.equal(f.run('pending'),null);
 assert.deepEqual(f.calls.filter(b=>b.operation==='commit'),[original,original]);
});

// The legacy browser scenario must cancel its independent stale editor before a
// new commit. Review/archival deliberately preserves that editor, not an implicit reset.
test('independent editor is explicitly cancelled before a fresh commit scenario',async()=>{
 const f=fixture(async b=>b.operation==='update'
  ?{__status:400,__envelope:{ok:false,error:'revision_conflict',delivery:'rejected'}}:receipt(b));
 f.start('update');await f.settle();assert.equal(f.run('pending'),null);
 f.start('review');await f.settle();assert.equal(f.run('editing.revision'),2);
 assert.equal(f.get('content').value,'ORIGINAL_DRAFT');
 f.get('cancel-edit').handlers.get('click')();assert.equal(f.run('editing'),null);
 assert.equal(f.get('content').value,'');f.get('content').value='EXPLICIT_NEW_COMMIT';f.get('consent').checked=true;
 f.start('commit');await f.settle();assert.equal(f.run('pending'),null);
 assert.deepEqual(f.calls.map(b=>b.operation),['update','review','register','commit']);
 assert.equal(f.calls.at(-1).input.memories[0].content,'EXPLICIT_NEW_COMMIT');
});
