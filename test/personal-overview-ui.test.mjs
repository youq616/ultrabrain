/** Production app+overview JS, synthetic DOM and HTTP. Not a real browser/server claim. */
import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';
import {readFileSync} from 'node:fs';import {webcrypto} from 'node:crypto';
import * as contract from '../src/personal-overview-contract.mjs';
import {overviewReceipt} from './helpers/overview-fixture.mjs';
const code=['app.js','overview-ui.js'].map(n=>readFileSync(new URL('../web/personal/'+n,import.meta.url),'utf8')).join('\n');
const tick=()=>new Promise(r=>setImmediate(r));
function fixture(route=b=>overviewReceipt(b.input.request_id)){
 const nodes=new Map(),calls=[],events=new Map(),navigations=[];
 const make=()=>({value:'',checked:false,hidden:false,disabled:false,textContent:'',dataset:{},children:[],handlers:new Map(),
  addEventListener(k,f){this.handlers.set(k,f);},replaceChildren(){this.children=[];},append(...x){this.children.push(...x);},setAttribute(){},focus(){}});
 const get=k=>{if(!nodes.has(k))nodes.set(k,make());return nodes.get(k);};
 const ctx=vm.createContext({document:{getElementById:get,createElement:make,querySelectorAll:()=>[],querySelector:q=>({click(){navigations.push(q);}}),
  addEventListener(k,f){events.set(k,[...(events.get(k)??[]),f]);}},window:{addEventListener(){}},MutationObserver:class{observe(){}},
  TextEncoder,TextDecoder,AbortController,AbortSignal,crypto:webcrypto,contract,
  fetch:async(_url,options)=>{const b=JSON.parse(options.body);calls.push(b);return {ok:true,status:200,json:async()=>({ok:true,result:await route(b)})};}});
 const run=s=>vm.runInContext(s,ctx);run(code);run("loadOverviewContract=async()=>contract;sourceId='selected';token='SYNTHETIC_TOKEN';view='lookup';");
 get('workspace').hidden=false;get('content').value='UNSAVED_DRAFT';
 const click=id=>get(id).handlers.get('click')({preventDefault(){}});
 const capture=id=>{for(const f of events.get('click')??[])f({target:{closest:q=>q.split(',').includes('#'+id)?{id}:null}});};
 const open=()=>click('overview-open'),read=()=>click('overview-run');
 return {get,run,calls,navigations,click,capture,open,read};
}
test('overview UI: opening is not a query or automatic polling',async()=>{
 const f=fixture();f.open();await tick();assert.equal(f.calls.length,0);assert.equal(f.get('overview-cards').children.length,0);
 assert.equal(f.get('overview-jobs').disabled,true);assert.match(f.get('overview-notice').textContent,/尚未读取/);
});
test('overview UI: explicit metadata read only, preserved draft and no pending ownership',async()=>{
 const f=fixture();f.open();await f.read();assert.equal(f.calls.length,1);assert.equal(f.calls[0].operation,'overview');
 assert.deepEqual(Object.keys(f.calls[0].input),['request_id']);assert.equal(f.get('overview-cards').children.length,4);
 assert.match(f.get('overview-notice').textContent,/待确认 5 条/);assert.equal(f.get('content').value,'UNSAVED_DRAFT');assert.equal(f.run('pending'),null);
 assert.equal(f.get('overview-jobs').disabled,false);
});
test('overview UI: each refresh is a new bound read, never reuses a request UUID',async()=>{
 const f=fixture();f.open();await f.read();await f.read();assert.equal(f.calls.length,2);assert.notEqual(f.calls[0].input.request_id,f.calls[1].input.request_id);
});
for(const [name,change]of [['count',r=>r.memories.total++],['source',r=>r.source_id='other'],['request',r=>r.request_id='00000000-0000-4000-8000-000000000000'],
 ['secret field',r=>r.content='PRIVATE'],['date',r=>r.observed_at='invalid'],['NaN',r=>r.agents.total=NaN]])test('overview UI: bad entire response withheld: '+name,async()=>{
 const f=fixture(b=>{const r=overviewReceipt(b.input.request_id);change(r);return r;});f.open();await f.read();
 assert.equal(f.run('overviewData'),null);assert.equal(f.get('overview-cards').children.length,0);assert.equal(f.get('overview-jobs').disabled,true);
 assert.match(f.get('overview-notice').textContent,/未确认/);assert.ok(!f.get('message').textContent.includes('PRIVATE'));
});
test('overview UI: transport exception cannot be reported as zero counts or echo raw error',async()=>{
 const f=fixture(()=>{throw Error('PRIVATE_PATH');});f.open();await f.read();assert.equal(f.run('overviewData'),null);assert.equal(f.calls.length,1);
 assert.match(f.get('overview-notice').textContent,/失败/);assert.ok(!f.get('message').textContent.includes('PRIVATE_PATH'));
});
for(const boundary of ['close','session','source','view','navigation','pending','busy','hidden'])test('overview UI: late response is fenced after '+boundary,async()=>{
 let release;const f=fixture(async b=>{await new Promise(r=>release=r);return overviewReceipt(b.input.request_id);});f.open();const work=f.read();
 for(let i=0;i<30&&!release;i++)await tick();assert.ok(release);
 if(boundary==='close')f.click('overview-close');else if(boundary==='session')f.run("token='other'");
 else if(boundary==='source')f.run("sourceId='other'");else if(boundary==='view')f.run("view='jobs'");
 else if(boundary==='navigation')f.run('loadVersion++');else if(boundary==='pending')f.run('pending={input:{}}');
 else if(boundary==='busy')f.run('busy=true');else f.get('workspace').hidden=true;
 release();await work;assert.equal(f.run('overviewData'),null);assert.equal(f.get('overview-cards').children.length,0);
 assert.equal(f.get('content').value,'UNSAVED_DRAFT');
});
test('overview UI: revocation during contract loading prevents network transmission',async()=>{
 const f=fixture();f.open();f.run("loadOverviewContract=async()=>{token='other';return contract}");await f.read();assert.equal(f.calls.length,0);
});
test('overview UI: double click produces a single metadata request',async()=>{
 const f=fixture();f.open();await Promise.all([f.read(),f.read()]);assert.equal(f.calls.length,1);
});
test('overview UI: earlier failure does not erase a later successful view',async()=>{
 let reject,n=0;const f=fixture(async b=>{if(!n++)await new Promise((_,r)=>reject=r);return overviewReceipt(b.input.request_id);});
 f.open();const old=f.read();for(let i=0;i<30&&!reject;i++)await tick();assert.ok(reject);
 f.click('overview-close');f.open();await f.read();const text=f.get('overview-notice').textContent;
 reject(Error('old'));await old;assert.equal(f.get('overview-notice').textContent,text);assert.notEqual(f.run('overviewData'),null);
});
for(const [id,target]of [['overview-candidates','candidate'],['overview-active','active'],['overview-jobs','jobs'],['overview-documents','documents'],['overview-agents','agents']])
 test('overview UI: '+id+' only dispatches existing navigation after a checked read',async()=>{
 const f=fixture();f.open();f.click(id);assert.equal(f.navigations.length,0);await f.read();f.click(id);
 assert.deepEqual(f.navigations,['[data-view="'+target+'"]']);assert.equal(f.calls.length,1);
 assert.equal(f.get('overview-panel').hidden,true);assert.equal(f.get('content').value,'UNSAVED_DRAFT');
});
for(const boundary of ['source','session','pending','view'])test('overview UI: stale action cannot navigate after '+boundary,async()=>{
 const f=fixture();f.open();await f.read();
 if(boundary==='source')f.run("sourceId='other'");else if(boundary==='session')f.run("token='other'");
 else if(boundary==='pending')f.run('pending={input:{}}');else f.run("view='jobs'");
 f.click('overview-jobs');assert.equal(f.navigations.length,0);assert.equal(f.run('overviewData'),null);
});
for(const id of ['refresh','logout','save','retry','snapshot-open','inspector-open','explorer-open','lineage-open'])test('overview UI: actual delegated selector clears counts before '+id,async()=>{
 const f=fixture();f.open();await f.read();f.capture(id);assert.equal(f.run('overviewData'),null);assert.equal(f.get('overview-panel').hidden,true);
});
test('overview UI: opening also clears other explicit sensitive previews without touching draft',()=>{
 const f=fixture();f.run('let revoked=[];function invalidateLineage(x){revoked.push(["lineage",x])}function invalidateInspector(x){revoked.push(["inspector",x])}function invalidateSnapshot(){revoked.push(["snapshot"])}');
 f.open();assert.equal(f.run('revoked.length'),3);assert.equal(f.get('content').value,'UNSAVED_DRAFT');
});
