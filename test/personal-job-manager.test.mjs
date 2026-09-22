/** Shipped console JS with synthetic DOM/HTTP. No actual database/browser claim. */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
const app=readFileSync(new URL('../web/personal/app.js',import.meta.url),'utf8');
const id='11111111-1111-4111-8111-111111111111',inputId='22222222-2222-4222-8222-222222222222',outputId='33333333-3333-4333-8333-333333333333';
const time='2026-09-20T00:00:00.000Z';
const row=(change={})=>({job_id:id,input_id:inputId,input_revision:1,state:'queued',attempts:0,retryable:false,error:null,
 lease_until:null,result:null,created_at:time,updated_at:time,assurance:'Synthetic fixture',...change});
const completed=()=>row({state:'completed',attempts:1,result:{entries:[{id:outputId,revision:1,status:'candidate',exact_duplicate_hints:[]}],
 gateway_invocations:1,usage:{input_tokens:null,output_tokens:3},profile_hash:'a'.repeat(64),input_hash:'b'.repeat(64),review_required:true,source_retained:true,truth_verified:false}});
const receipt=(change={})=>({source_id:'default',jobs:[row()],next_offset:null,...change});
const tick=()=>new Promise(r=>setImmediate(r));
function fixture(route=async()=>receipt()){
 const nodes=new Map(),calls=[];const element=()=>({value:'',checked:false,dataset:{},hidden:false,disabled:false,textContent:'',children:[],handlers:new Map(),
 addEventListener(k,f){this.handlers.set(k,f);},replaceChildren(){this.children=[];},append(...n){this.children.push(...n);},setAttribute(){},focus(){},reset(){}});
 const get=id=>{if(!nodes.has(id))nodes.set(id,element());return nodes.get(id);};
 let confirmation=()=>true;const ctx=vm.createContext({document:{getElementById:get,createElement:element,querySelectorAll:()=>[]},window:{addEventListener(){}},
 TextEncoder,TextDecoder,AbortController,AbortSignal,crypto:webcrypto,confirm:()=>confirmation(),
 fetch:async(_url,o)=>{const body=JSON.parse(o.body);calls.push(body);return {ok:true,status:200,json:async()=>({ok:true,result:await route(body)})};}});
 const run=s=>vm.runInContext(s,ctx);run(app);run("sourceId='default';token='TEST_SESSION';view='jobs';");get('job-state').value='any';get('document-status').value='any';get('content').value='UNSAVED';
 return {get,run,calls,confirm:f=>confirmation=f,load:()=>run('load()'),click:(id,event='click')=>get(id).handlers.get(event)({preventDefault(){}}),
 async settle(){for(let i=0;i<100&&run('busy');i++)await tick();assert.equal(run('busy'),false);},
 buttons(){const visit=n=>[n,...n.children.flatMap(visit)];return visit(get('results')).filter(n=>n.handlers.has('click'));}};
}
test('UI provides state filter, exact ID and explicit clear controls',()=>{
 const html=readFileSync(new URL('../web/personal/index.html',import.meta.url),'utf8');
 for(const name of ['job-panel','job-form','job-state','job-id','job-clear'])assert.ok(html.includes('id="'+name+'"'));
});
test('default job list reads only metadata, keeps the independent draft and permits links',async()=>{
 const f=fixture();await f.load();assert.deepEqual(f.calls,[{operation:'jobs',input:{state:'any',limit:20,offset:0}}]);
 assert.equal(f.get('content').value,'UNSAVED');assert.equal(f.get('export').disabled,false);
 assert.ok(f.buttons().some(b=>b.textContent==='核对原文记录'));assert.match(f.get('coverage').textContent,/原文/);
});
for(const state of ['queued','processing','completed','failed','stale'])test('selector sends requested state '+state,async()=>{
 const f=fixture(async()=>receipt({jobs:[]}));f.get('job-state').value=state;await f.load();assert.equal(f.calls[0].input.state,state);
});
test('exact ID lookup ignores list filter and never paginates',async()=>{
 const f=fixture();f.get('job-state').value='failed';f.get('job-id').value=id;await f.load();
 assert.deepEqual(f.calls,[{operation:'jobs',input:{job_id:id}}]);assert.equal(f.get('next').disabled,true);assert.equal(f.get('prev').disabled,true);
});
for(const bad of ['bad',' '+id,id+'\n',id.toUpperCase().replace('1','A')])test('bad job ID never reaches HTTP '+JSON.stringify(bad),async()=>{
 const f=fixture();f.get('job-id').value=bad;await f.load();assert.equal(f.calls.length,0);assert.equal(f.run('current'),null);
});
const damaged=[['source',r=>r.source_id='other'],['duplicate',r=>r.jobs.push(r.jobs[0])],['state',r=>r.jobs[0].state='deleted'],
 ['input ID',r=>r.jobs[0].input_id='bad'],['revision',r=>r.jobs[0].input_revision=0],['attempts',r=>r.jobs[0].attempts=4],
 ['retry authority',r=>r.jobs[0].retryable=true],['invalid date',r=>r.jobs[0].created_at='2026-02-30T00:00:00.000Z'],
 ['reversed date',r=>r.jobs[0].updated_at='2025-01-01T00:00:00.000Z'],['next offset',r=>r.next_offset=20],
 ['unexpected transcript',r=>r.jobs[0].transcript='PRIVATE'],['completed missing receipt',r=>r.jobs[0].state='completed'],
 ['noncanonical lease',r=>r.jobs[0].lease_until='yesterday'],['unknown top-level',r=>r.transcript='PRIVATE']];
for(const [name,change]of damaged)test('invalid whole job page is withheld: '+name,async()=>{
 const f=fixture(async()=>{const r=receipt();change(r);return r;});await f.load();assert.equal(f.run('current'),null);
 assert.equal(f.get('export').disabled,true);assert.equal(f.get('results').children.length,0);assert.match(f.get('coverage').textContent,/未确认/);
});
for(const [name,change]of [['missing review',r=>r.review_required=false],['false truth',r=>r.truth_verified=true],
 ['duplicate output',r=>r.entries.push(r.entries[0])],['wrong status',r=>r.entries[0].status='active'],
 ['bad hint',r=>r.entries[0].exact_duplicate_hints=['bad']],['invalid usage',r=>r.usage.input_tokens=-1]])test('invalid completed receipt cannot expose candidate actions: '+name,async()=>{
 const f=fixture(async()=>{const r=completed();change(r.result);return receipt({jobs:[r]});});await f.load();assert.equal(f.run('current'),null);
});
test('completed receipt offers explicit candidate and source reads, no implicit activation',async()=>{
 const f=fixture(async()=>receipt({jobs:[completed()]}));await f.load();
 assert.deepEqual(f.buttons().map(b=>b.textContent),['核对原文记录','核对候选 #1']);
 const read=[];f.run('openMemoryLookup=async id=>{globalThis.selectedMemory=id;}');
 await f.buttons()[1].handlers.get('click')();assert.equal(f.run('globalThis.selectedMemory'),outputId);assert.equal(f.calls.length,1);
});
test('state mismatch is not shown under selected filter',async()=>{
 const f=fixture();f.get('job-state').value='failed';await f.load();assert.equal(f.run('current'),null);
});
for(const change of ['state','id','session','source','navigation','clear'])test('late job response is discarded after '+change,async()=>{
 let release;const f=fixture(async()=>{await new Promise(r=>release=r);return receipt();});const read=f.load();await tick();assert.ok(release);
 if(change==='state')f.get('job-state').value='failed';else if(change==='id')f.get('job-id').value=inputId;
 else if(change==='session')f.run("token='other'");else if(change==='source')f.run("sourceId='other'");
 else if(change==='navigation'){f.run("view='recall'");await f.load();}else f.click('job-clear');
 release();await read;assert.equal(f.run('current'),null);assert.equal(f.get('export').disabled,true);
});
for(const change of ['state','id','session'])test('a retained old card cannot cancel after silent '+change+' change',async()=>{
 const f=fixture();await f.load();const button=f.buttons().find(b=>b.textContent==='取消整理，保留原文');assert.ok(button);
 if(change==='state')f.get('job-state').value='failed';else if(change==='id')f.get('job-id').value=inputId;else f.run("token='other'");
 button.handlers.get('click')();await f.settle();assert.equal(f.calls.length,1);
});
for(const invalid of [{},{id:inputId,state:'stale'},{id,state:'completed'},{id,state:'stale',dry_run:true}])test('cancel acknowledgement must match selected job '+JSON.stringify(invalid),async()=>{
 const f=fixture(async b=>b.operation==='cancel_job'?invalid:receipt());await f.load();
 f.buttons().find(b=>b.textContent==='取消整理，保留原文').handlers.get('click')();await f.settle();
 assert.equal(f.run('pending.delivery_unconfirmed'),true);assert.equal(f.run('pending.input.job_id'),id);assert.equal(f.get('content').value,'UNSAVED');
});
test('valid cancel acknowledgement retains draft and does not claim historical event replay',async()=>{
 const f=fixture(async b=>b.operation==='cancel_job'?{id,state:'stale'}:receipt());await f.load();
 f.buttons().find(b=>b.textContent==='取消整理，保留原文').handlers.get('click')();await f.settle();assert.equal(f.run('pending'),null);
 assert.equal(f.get('content').value,'UNSAVED');assert.deepEqual(f.calls.filter(b=>b.operation==='cancel_job'),[{operation:'cancel_job',input:{job_id:id}}]);
});
test('completed empty extraction is valid and cannot be mistaken for a truth certificate',async()=>{
 const r=completed();r.result.entries=[];const f=fixture(async()=>receipt({jobs:[r]}));await f.load();assert.notEqual(f.run('current'),null);
 assert.equal(f.buttons().length,1);
});
test('clearing metadata is local and leaves filters and independent drafts intact',async()=>{
 const f=fixture();await f.load();f.click('job-clear');assert.equal(f.calls.length,1);assert.equal(f.run('current'),null);
 assert.equal(f.get('export').disabled,true);assert.equal(f.get('content').value,'UNSAVED');
});

// Implementation self-review: edge receipts, pagination and final user decisions.
test('full page retains next offset but exact-ID mode rejects any cursor',async()=>{
 const make=i=>row({job_id:String(i).padStart(8,'0')+'-1111-4111-8111-111111111111'});
 const f=fixture(async()=>receipt({jobs:Array.from({length:20},(_,i)=>make(i)),next_offset:20}));
 await f.load();assert.equal(f.get('next').disabled,false);assert.equal(f.run('nextOffset'),20);
 const exact=fixture(async()=>receipt({next_offset:1}));exact.get('job-id').value=id;await exact.load();assert.equal(exact.run('current'),null);
});
test('expired processing lease remains visible without granting a client-side retry lease',async()=>{
 const f=fixture(async()=>receipt({jobs:[row({state:'processing',attempts:1,retryable:true,lease_until:time})]}));
 await f.load();assert.notEqual(f.run('current'),null);
 assert.ok(f.buttons().some(b=>b.textContent.includes('恢复')));assert.equal(f.calls.length,1);
});
test('exhausted attempts cannot offer a model retry but still allow cancellation',async()=>{
 const f=fixture(async()=>receipt({jobs:[row({state:'failed',attempts:3,error:'personal_processing_failed'})]}));
 await f.load();assert.ok(!f.buttons().some(b=>b.textContent.includes('重试')));
 assert.ok(f.buttons().some(b=>b.textContent==='取消整理，保留原文'));
});
test('cancelling the final confirmation sends nothing',async()=>{
 const f=fixture();await f.load();f.confirm(()=>false);
 f.buttons().find(b=>b.textContent==='取消整理，保留原文').handlers.get('click')();await f.settle();assert.equal(f.calls.length,1);
});
test('selection is checked again after cancellation confirmation',async()=>{
 const f=fixture();await f.load();f.confirm(()=>{f.get('job-id').value=inputId;return true;});
 f.buttons().find(b=>b.textContent==='取消整理，保留原文').handlers.get('click')();await f.settle();assert.equal(f.calls.length,1);
});
test('an unconfirmed model retry requires a new explicit billing decision',async()=>{
 const f=fixture(async b=>{if(b.operation==='consolidate')throw Error('synthetic lost response');return receipt();});await f.load();
 f.buttons().find(b=>b.textContent==='整理此条（调用模型）').handlers.get('click')();await f.settle();
 assert.equal(f.run('pending.operation'),'consolidate');const sent=f.calls.length;f.confirm(()=>false);f.click('retry');await f.settle();
 assert.equal(f.calls.length,sent);assert.equal(f.run('pending.delivery_unconfirmed'),true);
});
test('completed page rejects oversized candidate batches instead of dropping entries',async()=>{
 const r=completed();r.result.entries=Array.from({length:17},(_,i)=>({...r.result.entries[0],id:String(i).padStart(8,'0')+'-1111-4111-8111-111111111111'}));
 const f=fixture(async()=>receipt({jobs:[r]}));await f.load();assert.equal(f.run('current'),null);
});
test('failed metadata fetch is not reported as an empty successful job list',async()=>{
 const f=fixture(async()=>{throw Error('synthetic network failure');});await f.load();assert.equal(f.run('current'),null);
 assert.match(f.get('coverage').textContent,/未确认/);assert.equal(f.calls.length,1);
});
