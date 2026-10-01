/** Shipped UI + synthetic DOM/HTTP; does not claim browser or database execution. */
import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';
import {readFileSync} from 'node:fs';import {createHash,webcrypto} from 'node:crypto';
import * as lineage from '../src/personal-lineage-contract.mjs';
const app=readFileSync(new URL('../web/personal/app.js',import.meta.url),'utf8');
const left='11111111-1111-4111-8111-111111111111',right='22222222-2222-4222-8222-222222222222',third='33333333-3333-4333-8333-333333333333';
const hash=s=>createHash('sha256').update(s).digest('hex');
const row=(id,patch={})=>({id,type:'preference',origin_kind:'agent',content:'Record '+id,content_hash:hash('Record '+id),status:'candidate',revision:3,
 confidence:null,importance:'normal',visibility:'private',owned_by_caller:true,provenance:'User supplied source',project_id:null,derivation:null,derivation_current:true,...patch});
const envelope=memory=>({source_id:'default',memory,trust:'untrusted-memory-data',read_only:true,coverage:'single observation'});
const tick=()=>new Promise(r=>setImmediate(r));
function fixture(route=async id=>envelope(row(id))){
 const nodes=new Map(),calls=[];
 function element(){return {value:'',checked:false,dataset:{},hidden:false,disabled:false,textContent:'',children:[],handlers:new Map(),addEventListener(n,f){this.handlers.set(n,f);},reset(){},replaceChildren(...c){this.children=c;},setAttribute(){},append(...c){this.children.push(...c);},focus(){}};}
 const get=id=>{if(!nodes.has(id))nodes.set(id,element());return nodes.get(id);};
 const ctx=vm.createContext({document:{getElementById:get,querySelectorAll:()=>[],createElement:element},window:{addEventListener(){}},TextEncoder,TextDecoder,AbortController,AbortSignal,crypto:webcrypto,confirm:()=>true,lineage,
 fetch:async(_url,o)=>{const body=JSON.parse(o.body);calls.push(body);return {ok:true,json:async()=>({ok:true,result:await route(body.input.memory_id,body)})};}});
 vm.runInContext(app,ctx);const run=s=>vm.runInContext(s,ctx);
 run("token='test-session';sourceId='default';view='pair';loadPairLineageContract=async()=>lineage;");get('pair-left').value=left;get('pair-right').value=right;
 const click=(id,event='click')=>get(id).handlers.get(event)({preventDefault(){}});
 return {get,calls,run,click,read:()=>click('pair-form','submit'),cards:()=>get('pair-results').children};
}
const text=node=>[node.textContent,...node.children.map(text)].join('\n');
test('explicit pair navigation never reads or changes a draft',async()=>{
 const f=fixture();f.get('content').value='UNSAVED';await f.run('load()');assert.equal(f.calls.length,0);assert.equal(f.get('content').value,'UNSAVED');assert.equal(f.get('pair-panel').hidden,false);
});
for(const ids of [[left,left],['',right],['BAD',right],[left,right.toUpperCase().replace('2222','XXXX')]])test('invalid pair rejected before network '+ids,async()=>{
 const f=fixture();f.get('pair-left').value=ids[0];f.get('pair-right').value=ids[1];await f.read();assert.equal(f.calls.length,0);assert.equal(f.cards().length,0);
});
test('two distinct exact reads show complete text, versions and sources without writes',async()=>{
 const f=fixture();f.get('content').value='UNSAVED';await f.read();assert.deepEqual(f.calls,[left,right].map(memory_id=>({operation:'memory_read',input:{memory_id}})));
 assert.equal(f.cards().length,2);assert.match(text(f.cards()[0]),/r3/);assert.match(text(f.cards()[0]),/User supplied source/);assert.equal(f.get('content').value,'UNSAVED');
 assert.equal(f.run('current'),null);assert.equal(f.get('pair-clear').disabled,false);
});
test('refresh obtains new versions rather than reusing paired data',async()=>{
 let revision=3;const f=fixture(async id=>envelope(row(id,{revision})));await f.read();revision=4;await f.read();assert.equal(f.calls.length,4);assert.match(text(f.cards()[0]),/r4/);
});
test('stored quote is validated and displayed as historical, no automatic source read',async()=>{
 const quote='<img src=x onerror=alert(1)>',ref={job_id:third,input_id:third,input_revision:2,input_hash:'a'.repeat(64),profile_hash:'b'.repeat(64),quote,start:0,end:quote.length,offset_unit:'UTF-16 code units'};
 const f=fixture(async id=>envelope(row(id,{derivation:ref})));await f.read();assert.equal(f.calls.length,2);assert.ok(text(f.cards()[0]).includes(quote));assert.match(text(f.cards()[0]),/未重新读取来源/);
});
for(const patch of [{id:third},{revision:0},{content_hash:'f'.repeat(64)},{owned_by_caller:false},{derivation:{quote:'PRIVATE_BAD'}},{content:'\0'}])test('invalid second record rejects entire pair '+JSON.stringify(patch),async()=>{
 const f=fixture(async id=>envelope(row(id,id===right?patch:{})));await f.read();assert.equal(f.cards().length,0);assert.equal(f.run('pairData'),null);
});
for(const scope of ['not_found','network','foreign-source'])test('second unavailable/error cannot expose first or a cached pair '+scope,async()=>{
 let fail=false;const f=fixture(async id=>{if(fail&&id===right){if(scope==='foreign-source')return {...envelope(row(id)),source_id:'foreign'};throw Error(scope==='not_found'?'not_found':'PRIVATE_NETWORK_DETAIL');}return envelope(row(id));});
 await f.read();fail=true;await f.read();assert.equal(f.cards().length,0);assert.doesNotMatch(f.get('pair-summary').textContent,/PRIVATE/);
});
for(const kind of ['input','cancel','logout','navigation','source','token','write','snapshot','inspector','lineage','overview'])test('late read rejected after '+kind,async()=>{
 let release;const f=fixture(async id=>{await new Promise(r=>release=r);return envelope(row(id));});const pending=f.read();await tick();assert.ok(release);
 if(kind==='input'){f.get('pair-right').value=third;f.click('pair-right','input');}
 else if(kind==='cancel')f.click('pair-clear');else if(kind==='logout')f.click('logout');
 else if(kind==='navigation'){f.run("view='lookup'");await f.run('load()');}
 else if(kind==='source')f.run("sourceId='other'");else if(kind==='token')f.run("token='other'");
 else if(kind==='write')f.run("busy=true;controls()");
 else f.click(kind+'-open');
 release();await pending;assert.equal(f.cards().length,0);assert.equal(f.calls.length,1);
});
test('hash wait is guarded against authority changes even without DOM events',async()=>{
 const f=fixture();f.run("sha256Hex=async()=>{sourceId='foreign';return 'f'.repeat(64)}");await f.read();assert.equal(f.cards().length,0);assert.equal(f.calls.length,1);
});
test('old result cannot replace new pair or disable its clear action',async()=>{
 let release,first=true;const f=fixture(async id=>{if(first){first=false;await new Promise(r=>release=r);}return envelope(row(id));});
 const old=f.read();await tick();f.get('pair-left').value=third;f.click('pair-left','input');await f.read();release();await old;
 assert.equal(f.cards().length,2);assert.match(text(f.cards()[0]),new RegExp(third));assert.equal(f.get('pair-clear').disabled,false);
});
test('pair button rereads current record before separately editing and preserves draft',async()=>{
 let revision=3;const f=fixture(async id=>envelope(row(id,{revision})));f.get('content').value='UNSAVED';await f.read();revision=7;
 await f.cards()[0].children.at(-1).handlers.get('click')();assert.equal(f.calls.length,3);assert.equal(f.run('view'),'lookup');assert.equal(f.run('current.memory.revision'),7);
 assert.equal(f.get('content').value,'UNSAVED');assert.equal(f.run('editing'),null);assert.equal(f.cards().length,0);
});
test('record lost before handoff is not replaced by paired cache',async()=>{
 let gone=false;const f=fixture(async id=>{if(gone)throw Error('not_found');return envelope(row(id));});await f.read();gone=true;
 await f.cards()[0].children.at(-1).handlers.get('click')();assert.equal(f.run('current'),null);assert.equal(f.get('results').children.length,0);assert.equal(f.run('editing'),null);
});
test('detached old pair button cannot navigate after a fresh selection',async()=>{
 const f=fixture();await f.read();const button=f.cards()[0].children.at(-1);await f.read();const calls=f.calls.length;await button.handlers.get('click')();assert.equal(f.calls.length,calls);assert.equal(f.cards().length,2);
});
for(const patch of [{status:'archived',derivation_current:false},{owned_by_caller:false,status:'active',visibility:'source'},{origin_kind:'document_fragment'}])test('owned archive/shared/document observations never create pair write controls '+JSON.stringify(patch),async()=>{
 const f=fixture(async id=>envelope(row(id,patch)));await f.read();assert.equal(f.cards().length,2);assert.equal(f.cards()[0].children.filter(x=>x.dataset.write).length,0);
 await f.cards()[0].children.at(-1).handlers.get('click')();const actions=f.get('results').children.flatMap(x=>x.children).flatMap(x=>x.children??[]).filter(x=>x.dataset.write);
 if(patch.owned_by_caller===false||patch.origin_kind==='document_fragment')assert.equal(actions.length,0);
});
for(const state of ['busy=true','pending={operation:"update"}'])test('pending writes block pair read '+state,async()=>{
 const f=fixture();f.run(state);await f.read();assert.equal(f.calls.length,0);
});
test('clear removes observations without another request or clearing draft',async()=>{
 const f=fixture();f.get('content').value='UNSAVED';await f.read();f.click('pair-clear');assert.equal(f.cards().length,0);assert.equal(f.calls.length,2);assert.equal(f.get('content').value,'UNSAVED');
});
