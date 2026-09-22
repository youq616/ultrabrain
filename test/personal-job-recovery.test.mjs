/** Execute shipped console JS; synthetic responses, not browser/database evidence. */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
const app=readFileSync(new URL('../web/personal/app.js',import.meta.url),'utf8');
const id='11111111-1111-4111-8111-111111111111',inputId='22222222-2222-4222-8222-222222222222',other='33333333-3333-4333-8333-333333333333';
const time='2026-09-21T00:00:00.000Z';
const completed=()=>({entries:[{id:other,revision:1,status:'candidate',exact_duplicate_hints:[]}],gateway_invocations:1,
 usage:{input_tokens:null,output_tokens:3},profile_hash:'a'.repeat(64),input_hash:'b'.repeat(64),review_required:true,source_retained:true,truth_verified:false});
const status=(state='completed')=>({job_id:id,input_id:inputId,input_revision:1,state,attempts:state==='queued'?0:1,
 retryable:['failed','processing'].includes(state),error:state==='failed'?'personal_processing_failed':state==='stale'?'cancelled':null,
 lease_until:state==='processing'?time:null,result:state==='completed'?completed():null,created_at:time,updated_at:time,assurance:'Synthetic'});
const processResult=(change={})=>({source_id:'default',processed:1,model_requests_attempted:1,retry_policy:'Explicit retries may repeat costs',
 results:[{job_id:id,state:'completed',attempts:1,error:null,result:completed()}],...change});
const tick=()=>new Promise(r=>setImmediate(r));
function fixture(route=async b=>b.operation==='consolidate'?processResult():{source_id:'default',jobs:[status()],next_offset:null}){
 const nodes=new Map(),calls=[];const element=()=>({value:'',checked:false,dataset:{},hidden:false,disabled:false,textContent:'',children:[],handlers:new Map(),
 addEventListener(k,f){this.handlers.set(k,f);},replaceChildren(){this.children=[];},append(...xs){this.children.push(...xs);},setAttribute(){},focus(){},reset(){throw Error('Never reset unrelated draft');}});
 const get=k=>{if(!nodes.has(k))nodes.set(k,element());return nodes.get(k);};let confirmation=()=>true;
 const ctx=vm.createContext({document:{getElementById:get,createElement:element,querySelectorAll:()=>[]},window:{addEventListener(){}},
 TextEncoder,TextDecoder,AbortController,AbortSignal,crypto:webcrypto,confirm:()=>confirmation(),
 fetch:async(_url,o)=>{const body=JSON.parse(o.body);calls.push(body);const r=await route(body);return {ok:true,status:200,json:async()=>({ok:true,result:r})};}});
 const run=s=>vm.runInContext(s,ctx);run(app);run("sourceId='default';token='PRIVATE_TOKEN';view='lookup';");
 get('content').value='UNSAVED_DRAFT';get('job-state').value='any';
 return {get,run,calls,confirm:f=>confirmation=f,
 start(){run(`mutate('consolidate',{expected_source:'default',job_id:'${id}',limit:1,allow_model_call:true,retry:false},undefined,{job_id:'${id}',input_id:'${inputId}',input_revision:1,attempts:0});`);},
 click(k){return get(k).handlers.get('click')();},
 async settle(){for(let i=0;i<200&&run('busy');i++)await tick();assert.equal(run('busy'),false);}};
}
for(const [name,damage]of [
 ['empty',()=>({})],['source',r=>({...r,source_id:'foreign'})],['wrong job',r=>{r.results[0].job_id=other;return r;}],
 ['missing count',r=>{delete r.processed;return r;}],['inconsistent count',r=>({...r,processed:0})],['unbounded invocations',r=>({...r,model_requests_attempted:2})],
 ['dry run',r=>({...r,dry_run:true})],['unexpected job',r=>({...r,results:[...r.results,...r.results],processed:2})],
 ['partial completion',r=>{r.results[0].result={};return r;}],['truth claim',r=>{r.results[0].result.truth_verified=true;return r;}],
 ['activated candidate',r=>{r.results[0].result.entries[0].status='active';return r;}],['wrong state',r=>{r.results[0].state='queued';return r;}],
 ['missing attempts',r=>{delete r.results[0].attempts;return r;}],['fractional attempts',r=>{r.results[0].attempts=1.5;return r;}],
 ['completion without call',r=>({...r,model_requests_attempted:0})],['missing no-model source',()=>({state:'needs_model',results:[],model_calls:0})],
 ['no-model with results',r=>({source_id:'default',state:'needs_model',results:r.results,model_calls:0})],
 ['no-model with charge',()=>({source_id:'default',state:'needs_model',results:[],model_calls:1})],
 ['source echo conflict',r=>{r.results[0].source_id='foreign';return r;}],
 ['raw transcript',r=>({...r,transcript:'UNEXPECTED_PRIVATE_DATA'})],
])test('P1 regression: retain original model request on '+name,async()=>{
 const f=fixture(async()=>damage(processResult()));f.start();await f.settle();
 assert.equal(f.run('pending?.delivery_unconfirmed'),true);assert.equal(f.run('pending.input.job_id'),id);
 assert.equal(f.get('content').value,'UNSAVED_DRAFT');assert.equal(f.calls.length,1);
 assert.match(f.get('message').textContent,/console_receipt_unconfirmed/);
});
for(const [name,reply]of [
 ['completed',processResult()],['no work',processResult({processed:0,results:[],model_requests_attempted:0})],
 ['needs model',{source_id:'default',state:'needs_model',results:[],model_calls:0}],
 ['lease lost',processResult({results:[{job_id:id,state:'lease_lost',result:null}]})],
 ['failed after call',processResult({results:[{job_id:id,state:'failed',attempts:1,error:'personal_processing_failed',result:null}]})],
 ['stale before dispatch',processResult({model_requests_attempted:0,results:[{...status('stale'),attempts:0,error:'stale_source'}]})],
 ['profile mismatch',processResult({model_requests_attempted:0,results:[status('failed')]})],
 ['empty candidates',(()=>{const r=processResult();r.results[0].result.entries=[];return r;})()],
])test('canonical processing response acknowledges '+name,async()=>{
 const f=fixture(async()=>reply);f.start();await f.settle();assert.equal(f.run('pending'),null);assert.equal(f.get('content').value,'UNSAVED_DRAFT');
});

// Complete recovery workflow: observation is not an original processing receipt.
const ambiguous=async f=>{f.start();await f.settle();assert.equal(f.run('pending?.delivery_unconfirmed'),true);};
const recoverFixture=(job=()=>status(),process=()=>({}))=>fixture(async b=>b.operation==='consolidate'?process():{source_id:'default',jobs:[job()],next_offset:null});
test('uncertain processing never retries just because the retry button is clicked',async()=>{
 const f=recoverFixture();await ambiguous(f);await f.click('retry');await f.settle();assert.equal(f.calls.length,1);
 assert.match(f.get('message').textContent,/先只读核对/);assert.equal(f.run('pending.input.job_id'),id);
});
test('read-only recovery queries precisely the original job, no transcript or model call',async()=>{
 const f=recoverFixture();await ambiguous(f);await f.click('pending-job-inspect');
 assert.deepEqual(f.calls,[f.calls[0],{operation:'jobs',input:{job_id:id}}]);
 assert.notEqual(f.run('pending'),null);assert.match(f.get('pending-job-status').textContent,/completed/);
 assert.ok(!f.run('JSON.stringify(pending)').includes('PRIVATE_TOKEN'));assert.equal(f.get('content').value,'UNSAVED_DRAFT');
});
for(const state of ['completed','stale','failed'])test('explicit finish rechecks current '+state+' state, never resends processing',async()=>{
 const f=recoverFixture(()=>status(state));await ambiguous(f);await f.click('pending-job-inspect');
 f.get('pending-job-consent').checked=true;await f.click('pending-job-finish');
 assert.equal(f.run('pending'),null);assert.deepEqual(f.calls.map(b=>b.operation),['consolidate','jobs','jobs']);
 assert.match(f.get('message').textContent,/原处理回执仍未恢复/);assert.equal(f.get('content').value,'UNSAVED_DRAFT');
});
for(const state of ['queued','processing'])test('nonterminal '+state+' status cannot finish tracking',async()=>{
 const f=recoverFixture(()=>status(state));await ambiguous(f);await f.click('pending-job-inspect');
 f.get('pending-job-consent').checked=true;await f.click('pending-job-finish');assert.notEqual(f.run('pending'),null);assert.equal(f.calls.length,2);
});
test('finish requires a separate checked consent and confirmation',async()=>{
 const f=recoverFixture();await ambiguous(f);await f.click('pending-job-inspect');await f.click('pending-job-finish');assert.equal(f.calls.length,2);
 f.get('pending-job-consent').checked=true;f.confirm(()=>false);await f.click('pending-job-finish');assert.equal(f.calls.length,2);assert.notEqual(f.run('pending'),null);
});
test('a task restarted after the first observation cannot be finished from stale evidence',async()=>{
 let reads=0;const f=recoverFixture(()=>status(++reads===1?'failed':'processing'));await ambiguous(f);await f.click('pending-job-inspect');
 f.get('pending-job-consent').checked=true;await f.click('pending-job-finish');assert.notEqual(f.run('pending'),null);
 assert.match(f.get('message').textContent,/job_recovery_state_changed/);assert.equal(f.calls.filter(b=>b.operation==='consolidate').length,1);
});
for(const [name,damage]of [['wrong job',r=>r.job_id=other],['wrong input',r=>r.input_id=other],['wrong revision',r=>r.input_revision=2],
 ['missing receipt',r=>r.result=null],['bad time',r=>r.updated_at='2026-02-30T00:00:00.000Z']])test('invalid reconciliation preserves the original request: '+name,async()=>{
 const f=recoverFixture(()=>{const r=status();damage(r);return r;});await ambiguous(f);await f.click('pending-job-inspect');
 assert.equal(f.run('jobRecovery'),null);assert.notEqual(f.run('pending'),null);assert.equal(f.get('pending-job-finish').disabled,true);
});
for(const change of ['clear','navigation','session','source'])test('late recovery is fenced after '+change,async()=>{
 let release;const f=fixture(async b=>{if(b.operation==='consolidate')return {};await new Promise(r=>release=r);return {source_id:'default',jobs:[status()],next_offset:null};});
 await ambiguous(f);const read=f.click('pending-job-inspect');await tick();assert.ok(release);
 if(change==='clear')f.click('pending-job-clear');else if(change==='navigation'){f.run("view='recall'");await f.run('load()');}
 else f.run(change==='session'?"token='OTHER'":"sourceId='other'");
 release();await read;assert.equal(f.run('jobRecovery'),null);assert.equal(f.get('pending-job-status').textContent,'');assert.notEqual(f.run('pending'),null);
});
test('failed status read cannot erase or confirm an unknown model request',async()=>{
 const f=fixture(async b=>{if(b.operation==='consolidate')return {};throw Error('Synthetic unavailable');});await ambiguous(f);
 await f.click('pending-job-inspect');assert.equal(f.run('pending.delivery_unconfirmed'),true);assert.equal(f.run('jobRecovery'),null);
});
test('same-input retry needs observation, a fresh read, and a new fee confirmation',async()=>{
 let attempts=0;const f=recoverFixture(()=>status('queued'),()=>++attempts===1?{}:processResult());await ambiguous(f);
 await f.click('pending-job-inspect');f.confirm(()=>false);await f.click('retry');assert.equal(attempts,1);
 f.confirm(()=>true);await f.click('retry');await f.settle();assert.equal(attempts,2);assert.equal(f.run('pending'),null);
 const writes=f.calls.filter(b=>b.operation==='consolidate');assert.deepEqual(writes[0],writes[1]);
 assert.equal(f.calls.filter(b=>b.operation==='jobs').length,3);
});
test('completion between observation and retry blocks another invocation',async()=>{
 let reads=0;const f=recoverFixture(()=>status(++reads===1?'queued':'completed'));await ambiguous(f);await f.click('pending-job-inspect');
 await f.click('retry');assert.equal(f.calls.filter(b=>b.operation==='consolidate').length,1);assert.notEqual(f.run('pending'),null);
});
test('a new-session confirmation cannot authorize retry of the old model request',async()=>{
 const f=recoverFixture(()=>status('queued'));await ambiguous(f);await f.click('pending-job-inspect');
 f.confirm(()=>{f.run("token='OTHER'");return true;});await f.click('retry');assert.equal(f.calls.filter(b=>b.operation==='consolidate').length,1);
});
test('finish cannot use evidence invalidated during the confirmation prompt',async()=>{
 const f=recoverFixture();await ambiguous(f);await f.click('pending-job-inspect');f.get('pending-job-consent').checked=true;
 f.confirm(()=>{f.run("loadVersion++");return true;});await f.click('pending-job-finish');assert.equal(f.calls.length,2);assert.notEqual(f.run('pending'),null);
});
test('read cancellation is not server cancellation and cannot expose secrets',async()=>{
 const f=recoverFixture();await ambiguous(f);await f.click('pending-job-inspect');f.click('pending-job-clear');
 assert.equal(f.calls.length,2);assert.equal(f.run('pending.operation'),'consolidate');assert.equal(f.run('jobRecovery'),null);
 assert.equal(f.get('pending-job-consent').checked,false);assert.equal(f.get('content').value,'UNSAVED_DRAFT');
});
test('model pending panel does not describe processing as immutable event replay',async()=>{
 const f=recoverFixture();await ambiguous(f);assert.match(f.get('pending-guidance').textContent,/不是幂等事件重放/);
 const html=readFileSync(new URL('../web/personal/index.html',import.meta.url),'utf8');
 for(const k of ['pending-job-recovery','pending-job-inspect','pending-job-clear','pending-job-status','pending-job-consent','pending-job-finish'])assert.ok(html.includes('id="'+k+'"'));
});
