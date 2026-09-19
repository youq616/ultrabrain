/** Shipped browser JS with synthetic DOM/fetch. Real Chromium is tested separately. */
import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';
import {readFileSync} from 'node:fs';import {createHash,webcrypto} from 'node:crypto';
const app=readFileSync(new URL('../web/personal/app.js',import.meta.url),'utf8');
const id='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const digest=s=>createHash('sha256').update(s).digest('hex');
const row=(change={})=>({id,type:'preference',origin_kind:'agent',content:'CURRENT VERSION',content_hash:digest('CURRENT VERSION'),status:'candidate',revision:3,
 confidence:null,importance:'normal',visibility:'private',owned_by_caller:true,provenance:'Synthetic user',project_id:null,derivation:null,derivation_current:true,...change});
const receipt=(change={})=>({source_id:'default',memory:row(),trust:'untrusted-memory-data',read_only:true,coverage:'single currently authorized record; not a historical or continuously refreshed snapshot',...change});
const tick=()=>new Promise(r=>setImmediate(r));
function fixture(route=async()=>receipt()){
 const nodes=new Map(),calls=[];
 function element(){return {value:'',checked:false,dataset:{},hidden:false,disabled:false,textContent:'',children:[],handlers:new Map(),addEventListener(n,f){this.handlers.set(n,f);},reset(){},replaceChildren(){this.children=[];},setAttribute(){},append(...c){this.children.push(...c);},focus(){}};}
 const get=id=>{if(!nodes.has(id))nodes.set(id,element());return nodes.get(id);};
 const ctx=vm.createContext({document:{getElementById:get,querySelectorAll:()=>[],createElement:element},window:{addEventListener(){}},TextEncoder,TextDecoder,AbortController,AbortSignal,crypto:webcrypto,confirm:()=>true,
 fetch:async(_url,o)=>{const body=JSON.parse(o.body);calls.push({body,signal:o.signal});return {ok:true,json:async()=>({ok:true,result:await route(body)})};}});
 vm.runInContext(app,ctx);const run=s=>vm.runInContext(s,ctx);run("token='test-session';sourceId='default';view='lookup';");get('lookup-id').value=id;
 return {get,calls,run,submit:()=>get('lookup-form').handlers.get('submit')({preventDefault(){}}),click:(name,event='click')=>get(name).handlers.get(event)({preventDefault(){}})};
}
test('shipped UI exposes exact ID lookup, not a substring masquerading as ID search',()=>{
 const html=readFileSync(new URL('../web/personal/index.html',import.meta.url),'utf8');for(const n of ['lookup-id','lookup-form','lookup-cancel'])assert.ok(html.includes('id="'+n+'"'));
});
test('opening lookup never reads or changes the existing editor',async()=>{
 const f=fixture();f.get('content').value='UNSAVED DRAFT';await f.run('load()');assert.equal(f.calls.length,0);assert.equal(f.get('content').value,'UNSAVED DRAFT');
});
for(const value of ['', '  ', 'bad-id',id+'%','../other'])test('invalid ID rejected locally '+JSON.stringify(value),async()=>{
 const f=fixture();f.get('lookup-id').value=value;await f.submit();assert.equal(f.calls.length,0);assert.equal(f.run('current'),null);
});
test('lookup selects exactly one latest row, not the old recall revision',async()=>{
 const f=fixture();await f.submit();assert.deepEqual(f.calls.map(x=>x.body),[{operation:'memory_read',input:{memory_id:id}}]);
 assert.equal(f.run('current.memory.revision'),3);assert.equal(f.get('export').disabled,false);assert.equal(f.get('lookup-cancel').disabled,false);
 const card=f.get('results').children[0],actions=card.children.find(x=>x.children?.some(b=>b.textContent==='编辑'));
 assert.ok(actions);actions.children.find(b=>b.textContent==='编辑').handlers.get('click')();
 assert.equal(f.run('editing.revision'),3);assert.equal(f.get('content').value,'CURRENT VERSION');assert.equal(f.get('consent').checked,false);assert.equal(f.calls.length,1);
});
for(const change of [{id:other},{owned_by_caller:false},{status:'gone'},{content_hash:'0'.repeat(64)},{revision:0},{visibility:'public'},{origin_kind:'other'}])
 test('unusable record cannot populate the editor '+JSON.stringify(change),async()=>{
 const f=fixture(async()=>receipt({memory:row(change)}));await f.submit();assert.equal(f.run('current'),null);assert.equal(f.get('export').disabled,true);
 });
for(const memory of [row({owned_by_caller:false,visibility:'source',status:'active'}),row({origin_kind:'document_fragment'})])test('shared or document-bound record is visible but has no edit authority '+memory.origin_kind+memory.owned_by_caller,async()=>{
 const f=fixture(async()=>receipt({memory}));await f.submit();assert.equal(f.run('current.memory.id'),id);
 assert.equal(f.get('results').children.flatMap(x=>x.children).flatMap(x=>x.children??[]).some(x=>x.dataset.write),false);
});
for(const kind of ['input','cancel','logout','navigation','source'])test('late lookup suppressed after '+kind,async()=>{
 let release;const f=fixture(async()=>{await new Promise(r=>release=r);return receipt();});const p=f.submit();await tick();assert.ok(release);
 if(kind==='input'){f.get('lookup-id').value=other;f.click('lookup-id','input');}
 else if(kind==='cancel')f.click('lookup-cancel');else if(kind==='logout')f.click('logout');
 else if(kind==='navigation'){f.run("view='recall'");await f.run('load()');}
 else f.run("sourceId='foreign'");
 release();await p;assert.equal(f.run('current'),null);assert.equal(f.get('export').disabled,true);
});
test('read failure never looks like a successfully empty record and never retries',async()=>{
 const f=fixture(async()=>{throw Error('synthetic outage');});await f.submit();assert.equal(f.calls.length,1);assert.equal(f.run('current'),null);
});
test('pending writes block lookup before any network request',async()=>{
 const f=fixture();f.run("pending={operation:'update'};");await f.submit();assert.equal(f.calls.length,0);
});
test('completed lookup can be cleared locally without deleting or rereading a record',async()=>{
 const f=fixture();await f.submit();f.click('lookup-cancel');assert.equal(f.run('current'),null);assert.equal(f.calls.length,1);assert.equal(f.get('export').disabled,true);
});

for(const change of ['id','token','hash'])test('lookup rejects authority change without relying on DOM input events: '+change,async()=>{
 const f=fixture();f.run("sha256Hex=async()=>{"+(change==='id'?"document.getElementById('lookup-id').value='changed';":change==='token'?"token='new-session';":"sourceId='other';")+"return '0'.repeat(64);}");
 await f.submit();assert.equal(f.run('current'),null);assert.equal(f.get('export').disabled,true);
});
test('an older lookup cannot replace a newer result or disable its clear control',async()=>{
 let release;const f=fixture(async body=>{if(body.input.memory_id===id)await new Promise(r=>release=r);return receipt({memory:row({id:body.input.memory_id})});});
 const first=f.submit();await tick();f.get('lookup-id').value=other;f.click('lookup-id','input');await f.submit();
 assert.equal(f.run('current.memory.id'),other);release();await first;assert.equal(f.run('current.memory.id'),other);assert.equal(f.get('lookup-cancel').disabled,false);
});
test('owned stale derivations are inspectable but not silently certified as current',async()=>{
 const f=fixture(async()=>receipt({memory:row({derivation_current:false})}));await f.submit();assert.equal(f.run('current.memory.derivation_current'),false);
});
