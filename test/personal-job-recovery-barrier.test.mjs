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

const noWork=()=>processResult({processed:0,results:[],model_requests_attempted:0});
const needsModel=()=>({source_id:'default',state:'needs_model',results:[],model_calls:0});
const lostLease=()=>processResult({results:[{job_id:id,state:'lease_lost',result:null}]});
const inconclusive={no_work:noWork,needs_model:needsModel,lease_lost:lostLease};
async function unknownThen(outcome,observed='processing'){
 let attempts=0;
 const f=fixture(async b=>b.operation==='consolidate'?(++attempts===1?{}:outcome()):
  {source_id:'default',jobs:[status(observed)],next_offset:null});
 f.start();await f.settle();assert.equal(f.run('pending?.delivery_unconfirmed'),true);
 const saved=f.run('pending');const json=JSON.stringify(f.calls[0]);
 await f.click('pending-job-inspect');await f.click('retry');await f.settle();
 return {f,saved,json};
}
for(const [name,outcome]of Object.entries(inconclusive))for(const observed of ['processing','queued'])
 test('independent P1: '+name+' after unknown delivery retains original '+observed+' job',async()=>{
  const {f,saved,json}=await unknownThen(outcome,observed);
  assert.equal(f.run('pending'),saved,'A no-effect retry cannot release the original uncertain request');
  assert.equal(f.run('pending.delivery_unconfirmed'),true);
  assert.equal(f.run('pending.last_processing_outcome'),name);
  assert.equal(f.run('jobRecovery'),null,'Old observation cannot authorize another retry');
  assert.equal(f.get('retry').disabled,true);
  assert.equal(f.get('pending-job-finish').disabled,true);
  assert.equal(f.get('content').value,'UNSAVED_DRAFT');
  assert.deepEqual(f.calls.filter(b=>b.operation==='consolidate').map(JSON.stringify),[json,json]);
  assert.match(f.get('message').textContent,/此前请求仍未确认/);
  assert.match(f.get('pending-guidance').textContent,/不能确认此前/);
  assert.ok(!f.run('JSON.stringify(pending)').includes('PRIVATE_TOKEN'));
 });
for(const [name,outcome]of Object.entries(inconclusive))test('first submission '+name+' remains a legitimate acknowledgement',async()=>{
 const f=fixture(async()=>outcome());f.start();await f.settle();assert.equal(f.run('pending'),null);
 assert.equal(f.calls.length,1);assert.equal(f.get('content').value,'UNSAVED_DRAFT');
});
for(const observed of ['completed','failed','stale'])test('retained no-work can be reconciled only by explicit fresh '+observed+' read',async()=>{
 let writes=0,reads=0;
 const f=fixture(async b=>b.operation==='consolidate'?(++writes===1?{}:noWork()):
  {source_id:'default',jobs:[status(++reads<=2?'processing':observed)],next_offset:null});
 f.start();await f.settle();const original=f.run('pending');await f.click('pending-job-inspect');await f.click('retry');await f.settle();
 assert.equal(f.run('pending'),original);await f.click('pending-job-inspect');assert.equal(f.run('pending'),original);
 await f.click('pending-job-finish');assert.equal(reads,3,'Unchecked finish sends no query');
 f.get('pending-job-consent').checked=true;await f.click('pending-job-finish');
 assert.equal(reads,4);assert.equal(writes,2);assert.equal(f.run('pending'),null);
 assert.match(f.get('message').textContent,/原处理回执仍未恢复/);
});
test('repeated inconclusive responses retain the same frozen request and require observation each time',async()=>{
 const outcomes=[{},noWork(),needsModel(),lostLease()];let writes=0;
 const f=fixture(async b=>b.operation==='consolidate'?outcomes[writes++]:{source_id:'default',jobs:[status('queued')],next_offset:null});
 f.start();await f.settle();const original=f.run('pending'),json=JSON.stringify(original.input);
 for(const name of ['no_work','needs_model','lease_lost']){
  const before=f.calls.length;await f.click('retry');assert.equal(f.calls.length,before);
  await f.click('pending-job-inspect');await f.click('retry');await f.settle();
  assert.equal(f.run('pending'),original);assert.equal(f.run('pending.last_processing_outcome'),name);
  assert.equal(JSON.stringify(original.input),json);assert.ok(Object.isFrozen(original.input));
 }
 assert.equal(writes,4);assert.equal(f.get('content').value,'UNSAVED_DRAFT');
});
for(const change of ['clear','navigation','consent','session','source'])test('retained request survives '+change+' during terminal reconciliation',async()=>{
 let writes=0,reads=0,release;
 const f=fixture(async b=>{
  if(b.operation==='consolidate')return ++writes===1?{}:noWork();
  reads++;if(reads===4)await new Promise(r=>release=r);
  return {source_id:'default',jobs:[status(reads<=2?'processing':'completed')],next_offset:null};
 });
 f.start();await f.settle();const original=f.run('pending');await f.click('pending-job-inspect');await f.click('retry');await f.settle();
 assert.equal(f.run('pending'),original);await f.click('pending-job-inspect');f.get('pending-job-consent').checked=true;
 const finish=f.click('pending-job-finish');await tick();assert.ok(release);
 if(change==='clear')f.run('invalidateJobRecovery()');
 else if(change==='navigation')f.run('loadVersion++');
 else if(change==='consent')f.get('pending-job-consent').checked=false;
 else f.run(change==='session'?"token='OTHER'":"sourceId='OTHER'");
 release();await finish;assert.equal(f.run('pending'),original);assert.equal(writes,2);
});
test('a actual same-job completion on the next authorized attempt can acknowledge the request',async()=>{
 let writes=0;const f=fixture(async b=>b.operation==='consolidate'?[{},noWork(),processResult()][writes++]:
  {source_id:'default',jobs:[status('queued')],next_offset:null});
 f.start();await f.settle();await f.click('pending-job-inspect');await f.click('retry');await f.settle();
 assert.notEqual(f.run('pending'),null);await f.click('pending-job-inspect');await f.click('retry');await f.settle();
 assert.equal(writes,3);assert.equal(f.run('pending'),null);
 assert.deepEqual(f.calls.filter(b=>b.operation==='consolidate').map(b=>b.input),Array(3).fill(f.calls[0].input));
});
for(const damage of ['foreign','malformed','wrong_job'])test('inconclusive retry still validates contract before classification: '+damage,async()=>{
 const {f,saved}=await unknownThen(()=>{
  if(damage==='foreign')return {...noWork(),source_id:'other'};
  if(damage==='malformed')return {...needsModel(),model_calls:1};
  const r=lostLease();r.results[0].job_id=other;return r;
 });
 assert.equal(f.run('pending'),saved);assert.equal(f.run('pending.last_processing_outcome'),undefined);
 assert.match(f.get('message').textContent,/console_receipt_unconfirmed/);
});

// CI 35669293556/job106561925990 rejected wait_for_function's internal eval
// under the unchanged strict CSP. Exercise the actual replacement callback with
// string code generation disabled; this VM check is not real-browser evidence.
const barrierScript=readFileSync(new URL('./personal-job-recovery-barrier-browser.py',import.meta.url),'utf8');
function wireWaitFixture(window){
 const expression=/primary_wire_result = page\.evaluate\("""([\s\S]*?)"""\)/.exec(barrierScript)?.[1];
 assert.ok(expression,'A bounded direct Promise wait must replace the CSP-dependent poller');
 let timeout,cleared=0,timers=0;
 const ctx=vm.createContext({window,
  setTimeout(fn,ms){assert.equal(ms,30000);timeout=fn;timers++;return 7;},
  clearTimeout(id){assert.equal(id,7);cleared++;}}, {codeGeneration:{strings:false,wasm:false}});
 return {run:()=>vm.runInContext('('+expression+')()',ctx),expire:()=>timeout(),
  get cleared(){return cleared;},get timers(){return timers;}};
}
test('CSP wire wait: retain strict security, completion and uncertainty assertions',()=>{
 assert.ok(!barrierScript.includes('wait_for_function('));
 assert.ok(!barrierScript.includes('bypass_csp'));
 assert.ok(barrierScript.includes("assert primary_wire_result['ok'] is True"));
 assert.ok(barrierScript.includes("assert primary_wire_result['result']['results'][0]['state'] == 'completed'"));
 assert.ok(barrierScript.includes("expect(page.locator('#pending-panel')).to_be_visible()"));
 const consoleCode=readFileSync(new URL('../src/personal-console.mjs',import.meta.url),'utf8');
 assert.match(consoleCode,/script-src 'self'/);assert.ok(!consoleCode.includes('unsafe-eval'));
});
test('CSP wire wait: actual completed response resolves and clears the bounded timer',async()=>{
 const response={ok:true,result:{results:[{state:'completed'}]}},window={primaryWire:Promise.resolve(),primaryWireResult:response};
 const f=wireWaitFixture(window);assert.equal(await f.run(),response);assert.equal(f.cleared,1);assert.equal(f.timers,1);
});
test('CSP wire wait: stale result cannot bypass the actual in-flight completion',async()=>{
 let release;const window={primaryWire:new Promise(r=>release=r),primaryWireResult:{ok:true}};
 const f=wireWaitFixture(window);let finished=false;const work=f.run().then(value=>{finished=true;return value;});
 await Promise.resolve();await Promise.resolve();assert.equal(finished,false);
 const actual={ok:true,result:{results:[{state:'completed'}]}};window.primaryWireResult=actual;release();
 assert.equal(await work,actual);assert.equal(f.cleared,1);
});
test('CSP wire wait: failed wire data is not converted into a successful acknowledgement',async()=>{
 const failure={wireFailed:true},f=wireWaitFixture({primaryWire:Promise.resolve(),primaryWireResult:failure});
 assert.equal(await f.run(),failure);assert.equal(f.cleared,1);
});
test('CSP wire wait: missing original Promise fails instead of accepting cached state',async()=>{
 const f=wireWaitFixture({primaryWireResult:{ok:true}});
 await assert.rejects(f.run(),/Primary wire missing/);assert.equal(f.timers,0);assert.equal(f.cleared,0);
});
test('CSP wire wait: stalled wire rejects at the existing 30-second deadline',async()=>{
 const f=wireWaitFixture({primaryWire:new Promise(()=>{})});const work=f.run();f.expire();
 await assert.rejects(work,/Primary wire deadline exceeded/);assert.equal(f.timers,1);assert.equal(f.cleared,1);
});
