/** Production console+lineage scripts; synthetic DOM/HTTP, not actual Chromium. */
import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';
import {readFileSync} from 'node:fs';import {webcrypto} from 'node:crypto';
import * as contract from '../src/personal-lineage-contract.mjs';
import {row,uuid,hash,lineagePair} from './helpers/lineage-fixture.mjs';
const code=['app.js','lineage-ui.js'].map(f=>readFileSync(new URL('../web/personal/'+f,import.meta.url),'utf8')).join('\n');
async function reach(gate,work){
 let timer;
 try{await Promise.race([gate,work.then(()=>{throw Error('Operation finished before the test gate');}),
  new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Test gate not reached')),5000);})]);}
 finally{clearTimeout(timer);}
}
function fixture(route){
 const nodes=new Map(),calls=[],events=new Map(),{memory,source}=lineagePair();
 const make=()=>({value:'',checked:false,hidden:false,disabled:false,textContent:'',dataset:{},children:[],handlers:new Map(),
  addEventListener(k,f){this.handlers.set(k,f);},append(...x){this.children.push(...x);},replaceChildren(){this.children=[];},setAttribute(){},focus(){},reset(){}});
 const get=k=>{if(!nodes.has(k))nodes.set(k,make());return nodes.get(k);};
 const ctx=vm.createContext({document:{getElementById:get,createElement:make,querySelectorAll:()=>[],addEventListener(k,f){events.set(k,[...(events.get(k)??[]),f]);}},
  window:{addEventListener(){}},MutationObserver:class{observe(){}},TextEncoder,TextDecoder,AbortSignal,AbortController,crypto:webcrypto,contract,
  fetch:async(_url,options)=>{
   const body=JSON.parse(options.body);calls.push(body);
   const answer=route?await route(body,calls.length,{memory,source}):body.input.memory_id===memory.id?memory:source;
   if(answer?.error)return {ok:false,status:404,json:async()=>({ok:false,error:answer.error,delivery:'rejected'})};
   return {ok:true,status:200,json:async()=>JSON.parse(JSON.stringify({ok:true,result:{source_id:'selected',memory:answer,trust:'untrusted-memory-data',read_only:true,coverage:'current'}}))};
  }});
 const run=s=>vm.runInContext(s,ctx);run(code);run("loadLineageContract=async()=>contract;sourceId='selected';token='test-token';view='lookup';");
 get('workspace').hidden=false;get('lineage-panel').hidden=true;get('content').value='UNSAVED_PRIVATE_DRAFT';
 const click=(id,event='click',extra={})=>get(id).handlers.get(event)({preventDefault(){},...extra});
 const open=()=>{click('lineage-open');get('lineage-id').value=memory.id;};
 const inspect=()=>{get('lineage-consent').checked=true;return click('lineage-run');};
 return {get,run,click,calls,events,memory,source,open,inspect};
}
test('lineage UI: opening or typing does not query; consent and complete UUID are required',async()=>{
 const f=fixture();f.open();await f.click('lineage-run');assert.equal(f.calls.length,0);
 f.get('lineage-id').value='bad';await f.inspect();assert.equal(f.calls.length,0);assert.match(f.get('message').textContent,/full_memory_uuid_required/);
});
test('lineage UI: input from exact current lookup is prefilled, not followed',()=>{
 const f=fixture();f.run("current={source_id:'selected',memory:{id:'"+f.memory.id+"'}}");f.click('lineage-open');
 assert.equal(f.get('lineage-id').value,f.memory.id);assert.equal(f.calls.length,0);
});
test('lineage UI: matched reference requires three verified reads and explicit full-source disclosure',async()=>{
 const f=fixture();f.open();await f.inspect();assert.equal(f.get('lineage-status').dataset.state,'matched');
 assert.deepEqual(f.calls.map(c=>c.input.memory_id),[f.memory.id,f.source.id,f.memory.id]);
 assert.ok(f.calls.every(c=>c.operation==='memory_read'&&Object.keys(c.input).join()==='memory_id'));
 assert.equal(f.get('lineage-original-text').textContent,'');f.click('lineage-show-source');
 assert.equal(f.get('lineage-original-text').textContent,f.source.content);assert.equal(f.get('content').value,'UNSAVED_PRIVATE_DRAFT');
 f.click('lineage-clear-source');assert.equal(f.get('lineage-original-text').textContent,'');assert.equal(f.calls.length,3);
});
for(const [state,alter]of [
 ['changed',f=>{f.source.content='已改写';f.source.content_hash=hash(f.source.content);f.source.revision++;f.memory.derivation_current=false;}],
 ['archived',f=>{f.source.status='archived';f.source.revision++;f.memory.derivation_current=false;}],
 ['quote_mismatch',f=>{f.memory.derivation.start--;f.memory.derivation.end--;}],
 ['inconsistent',f=>f.memory.derivation_current=false]])
 test('lineage UI: distinct observed status '+state,async()=>{
  const f=fixture();alter(f);f.open();await f.inspect();assert.equal(f.get('lineage-status').dataset.state,state);
 });
for(const [owned,state]of [[true,'unlinked'],[false,'withheld']])test('lineage UI: no visible reference never triggers guessed source fetch '+state,async()=>{
 const f=fixture();f.memory.derivation=null;f.memory.owned_by_caller=owned;f.memory.status='active';f.memory.visibility='source';
 f.open();await f.inspect();assert.equal(f.get('lineage-status').dataset.state,state);assert.equal(f.calls.length,1);assert.equal(f.get('lineage-show-source').disabled,true);
});
test('lineage UI: missing/invisible source is explicit and still rechecks the selected entry',async()=>{
 const f=fixture(async(b,n,{memory,source})=>b.input.memory_id===source.id?{error:'not_found'}:memory);
 f.open();await f.inspect();assert.equal(f.get('lineage-status').dataset.state,'unavailable');assert.equal(f.calls.length,3);
 assert.equal(f.get('lineage-open-source').disabled,true);assert.equal(f.get('lineage-original-text').textContent,'');
});
test('lineage UI: source outage is not rewritten as a missing source or retried',async()=>{
 const f=fixture(async(b,n,{memory})=>{if(n===2)throw Error('PRIVATE_PATH');return memory;});f.open();await f.inspect();
 assert.equal(f.calls.length,2);assert.equal(f.run('lineageData'),null);assert.ok(!f.get('message').textContent.includes('PRIVATE_PATH'));
});
for(const [name,alter] of [['reference',m=>m.derivation.input_id='bad'],['body hash',m=>m.content='BROKEN'],
 ['own reference',m=>{m.owned_by_caller=false;m.status='active';m.visibility='source';}]])
 test('lineage UI: malformed primary '+name+' never starts source read',async()=>{
  const f=fixture();alter(f.memory);f.open();await f.inspect();assert.equal(f.calls.length,1);assert.equal(f.run('lineageData'),null);
 });
for(const [name,alter]of [['source-id',s=>s.id=uuid(6)],['foreign-source',s=>{s.owned_by_caller=false;s.status='active';s.visibility='source';}],['source-hash',s=>s.content_hash='0'.repeat(64)]])
 test('lineage UI: wrong source '+name+' never displays unbound content',async()=>{
  const f=fixture();alter(f.source);f.open();await f.inspect();assert.equal(f.run('lineageData'),null);assert.equal(f.get('lineage-original-text').textContent,'');
 });
for(const change of [{revision:2},{status:'archived'},{derivation_current:false},{content:'concurrent'},
 {provenance:'concurrent'},{project_id:'concurrent'},{visibility:'source'}])test('lineage UI: final reread rejects concurrent selected-entry change '+JSON.stringify(change),async()=>{
 const f=fixture(async(b,n,{memory,source})=>n===2?source:n===3?row(1,{...memory,...change,content_hash:hash(change.content??memory.content)}):memory);
 f.open();await f.inspect();assert.equal(f.calls.length,3);assert.equal(f.run('lineageData'),null);
 assert.match(f.get('message').textContent,/lineage_selected_changed/);
});
for(const phase of [1,2,3])for(const boundary of ['consent','cancel','id','session','source','navigation','pending'])
 test('lineage UI: revocation during read '+phase+' after '+boundary+' stops delivery/following',async()=>{
  let release,entered;const gate=new Promise(r=>entered=r);
  const f=fixture(async(b,n,{memory,source})=>{if(n===phase)await new Promise(r=>{release=r;entered();});return b.input.memory_id===memory.id?memory:source;});
  f.open();const work=f.inspect();await reach(gate,work);assert.ok(release);
  if(boundary==='consent'){f.get('lineage-consent').checked=false;f.click('lineage-consent','change');}
  else if(boundary==='cancel')f.click('lineage-close');else if(boundary==='id')f.get('lineage-id').value=uuid(9);
  else if(boundary==='session')f.run("token='other'");else if(boundary==='source')f.run("sourceId='other'");
  else if(boundary==='navigation')f.run('loadVersion++');else f.run('pending={input:{}}');
  release();await work;assert.equal(f.calls.length,phase);assert.equal(f.run('lineageData'),null);assert.equal(f.get('lineage-original-text').textContent,'');
 });
for(const boundary of ['consent','id','session','source','navigation','hidden','pending','busy'])test('lineage UI: stale display/jump blocked after '+boundary,async()=>{
 const f=fixture();f.open();await f.inspect();
 f.run('openMemoryLookup=async id=>{globalThis.lastJump=id}');
 if(boundary==='consent')f.get('lineage-consent').checked=false;else if(boundary==='id')f.get('lineage-id').value=uuid(9);
 else if(boundary==='session')f.run("token='other'");else if(boundary==='source')f.run("sourceId='other'");
 else if(boundary==='navigation')f.run('loadVersion++');else if(boundary==='hidden')f.get('workspace').hidden=true;
 else if(boundary==='busy')f.run('busy=true');else f.run('pending={input:{}}');
 f.click('lineage-show-source');await f.click('lineage-open-source');assert.equal(f.get('lineage-original-text').textContent,'');assert.equal(f.run('globalThis.lastJump'),undefined);
});
test('lineage UI: correction navigation uses a fresh exact read, no implicit editing or draft replacement',async()=>{
 const f=fixture();f.open();await f.inspect();f.run('openMemoryLookup=async id=>{globalThis.lastJump=id}');await f.click('lineage-open-source');
 assert.equal(f.run('globalThis.lastJump'),f.source.id);assert.equal(f.get('lineage-panel').hidden,true);assert.equal(f.get('content').value,'UNSAVED_PRIVATE_DRAFT');
});
test('lineage UI: primary and original are always rendered as literal text',async()=>{
 const f=fixture();f.memory.content='<img src=x onerror=bad()> 中文';f.memory.content_hash=hash(f.memory.content);
 f.open();await f.inspect();assert.equal(f.get('lineage-memory').textContent,f.memory.content);assert.equal(f.get('lineage-memory').children.length,0);
});
test('lineage UI: late failed attempt cannot clear newer success or replace its message',async()=>{
 let reject,entered;const gate=new Promise(r=>entered=r);
 const f=fixture(async(b,n,{memory,source})=>{if(n===1)await new Promise((_,r)=>{reject=r;entered();});return b.input.memory_id===memory.id?memory:source;});
 f.open();const old=f.inspect();await reach(gate,old);assert.ok(reject);
 f.click('lineage-close');f.open();await f.inspect();const text=f.get('message').textContent;reject(Error('late'));await old;
 assert.equal(f.get('lineage-status').dataset.state,'matched');assert.equal(f.get('message').textContent,text);
});
test('lineage UI: double click and pending state do not start duplicate requests',async()=>{
 const f=fixture();f.open();await Promise.all([f.inspect(),f.inspect()]);assert.equal(f.calls.length,3);
 f.run('pending={input:{}}');await f.inspect();assert.equal(f.calls.length,3);
});
test('lineage UI: navigation capture clears displayed source before other click handlers',async()=>{
 const f=fixture();f.open();await f.inspect();f.click('lineage-show-source');
 for(const handler of f.events.get('click'))handler({target:{closest:()=>true}});
 assert.equal(f.get('lineage-original-text').textContent,'');assert.equal(f.get('lineage-panel').hidden,true);assert.equal(f.get('lineage-id').value,'');
});
