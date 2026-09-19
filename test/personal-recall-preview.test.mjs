/** Shipped browser handlers + synthetic DOM/HTTP barriers; Chromium uses real APIs separately. */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {webcrypto,createHash} from 'node:crypto';
const app=readFileSync(new URL('../web/personal/app.js',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const memory=(changes={})=>({id:'11111111-1111-4111-8111-111111111111',type:'preference',status:'active',revision:2,
 project_id:null,owned_by_caller:true,visibility:'private',importance:'high',content:'Do not delete synthetic configuration.',
 content_hash:createHash('sha256').update('Do not delete synthetic configuration.').digest('hex'),provenance:'Synthetic user',...changes});
const envelope=(input,changes={})=>({source_id:'default',trust:'untrusted-memory-data',selection:'bounded-literal-and-importance-v2',
 exhaustive:false,dropped:0,budget_bytes:input.budget_bytes,memories:[memory()],...changes});
function fixture(route=async body=>envelope(body.input)) {
 const nodes=new Map(),calls=[];
 function element(){return {value:'',checked:false,dataset:{},hidden:false,disabled:false,textContent:'',children:[],handlers:new Map(),
  addEventListener(name,handler){this.handlers.set(name,handler);},reset(){},replaceChildren(){this.children=[];},
  setAttribute(){},append(...children){this.children.push(...children);},focus(){}};}
 const get=id=>{if(!nodes.has(id))nodes.set(id,element());return nodes.get(id);};
 const ctx=vm.createContext({document:{getElementById:get,querySelectorAll:()=>[],createElement:element},window:{addEventListener(){}},
  TextEncoder,TextDecoder,AbortController,AbortSignal,crypto:webcrypto,confirm:()=>true,
  fetch:async(_url,options)=>{const body=JSON.parse(options.body);calls.push({body,signal:options.signal});
   const result=await route(body,options);return {ok:true,json:async()=>({ok:true,result})};}});
 vm.runInContext(app,ctx);
 const run=text=>vm.runInContext(text,ctx);
 run("token='synthetic-token';sourceId='default';view='recall';");
 get('recall-task').value='configuration';get('recall-limit').value='20';get('recall-budget').value='6000';get('recall-consent').checked=true;
 return {get,calls,run,click:(id,event='click')=>get(id).handlers.get(event)({preventDefault(){}}),
  async submit(){await this.click('recall-form','submit');},
  async settle(){for(let i=0;i<200&&run('recallController!==null');i++)await tick();assert.equal(run('recallController'),null);}};
}
test('preview is an explicit form in the shipped UI',()=>{
 const html=readFileSync(new URL('../web/personal/index.html',import.meta.url),'utf8');
 for(const id of ['recall-form','recall-task','recall-project','recall-limit','recall-budget','recall-consent','recall-cancel'])assert.ok(html.includes('id="'+id+'"'),id);
});
test('opening or refreshing preview never transmits a task',async()=>{
 const f=fixture();await f.run('load()');assert.deepEqual(f.calls,[]);assert.equal(f.get('recall-consent').checked,false);
 assert.equal(f.run('current'),null);assert.equal(f.get('export').disabled,true);
});
for(const [label,change] of [['no-consent',f=>f.get('recall-consent').checked=false],['empty-task',f=>f.get('recall-task').value='  '],
 ['UTF8-over-budget',f=>f.get('recall-task').value='中'.repeat(1366)],['NUL',f=>f.get('recall-task').value='a\0b'],
 ['unpaired-surrogate',f=>f.get('recall-task').value='\ud800'],['invalid-project',f=>f.get('recall-project').value='../other'],
 ['invalid-limit',f=>f.get('recall-limit').value='1000'],['invalid-budget',f=>f.get('recall-budget').value='0']])
 test('preview refuses '+label+' without network',async()=>{const f=fixture();change(f);await f.submit();assert.equal(f.calls.length,0);assert.equal(f.run('current'),null);});
test('preview sends only canonical read criteria and preserves complete memories',async()=>{
 const f=fixture();f.get('recall-project').value='chosen';await f.submit();
 assert.deepEqual(f.calls.map(x=>x.body),[{operation:'context',input:{task:'configuration',project_id:'chosen',limit:20,budget_bytes:6000}}]);
 assert.equal(f.run('current.memories[0].content'),'Do not delete synthetic configuration.');assert.equal(f.get('export').disabled,false);
 assert.equal(f.get('prev').disabled,true);assert.equal(f.get('next').disabled,true);assert.match(f.get('coverage').textContent,/6000/);
 assert.equal(f.get('results').children.filter(x=>x.children.some(y=>y.dataset.write)).length,0);
});
for(const cause of ['task','project','limit','budget','consent','cancel','navigation','logout','refresh'])
 test('preview drops and cancels a late response after '+cause,async()=>{
  let release;const f=fixture(async body=>{if(body.operation!=='context')return {memories:[],next_offset:null};await new Promise(resolve=>release=resolve);return envelope(body.input);});
  const pending=f.submit();await tick();assert.equal(typeof release,'function');
  if(['task','project','limit','budget'].includes(cause)){
   f.get('recall-'+cause).value=cause==='limit'?'5':cause==='budget'?'2048':'changed';f.click('recall-'+cause,'input');
  }else if(cause==='consent'){f.get('recall-consent').checked=false;f.click('recall-consent','change');}
  else if(cause==='cancel')f.click('recall-cancel');
  else if(cause==='logout')f.click('logout');
  else if(cause==='navigation'){f.run("view='active'");void f.run('load()');}
  else void f.run('load()');
  assert.equal(f.calls[0].signal.aborted,true);release();await pending;
  assert.equal(f.run("current?.memories?.some(m=>m.content.includes('synthetic configuration'))??false"),false);
  if(cause==='logout'){assert.equal(f.get('recall-task').value,'');assert.equal(f.get('recall-project').value,'');}
 });
for(const field of ['source_id','trust','budget_bytes','exhaustive','memories','content_hash','project_id','status','derivation_current'])
 test('preview does not display an invalid '+field+' receipt',async()=>{
  const f=fixture(async body=>{
   const result=envelope(body.input);
   if(field==='memories')result.memories={};
   else if(field==='content_hash')result.memories[0].content_hash='0'.repeat(64);
   else if(field==='project_id')result.memories[0].project_id='foreign';
   else if(field==='status')result.memories[0].status='candidate';
   else if(field==='derivation_current')result.memories[0].derivation_current=false;
   else result[field]=field==='budget_bytes'?8192:field==='exhaustive'?true:'foreign';
   return result;
  });await f.submit();assert.equal(f.run('current'),null);assert.equal(f.get('export').disabled,true);
 });
test('preview rejects a serialized response larger than the selected budget',async()=>{
 const f=fixture(async body=>envelope(body.input,{padding:'x'.repeat(6000)}));await f.submit();assert.equal(f.run('current'),null);
});
test('a slow old preview cannot overwrite a newer successful preview',async()=>{
 let release;const f=fixture(async body=>{if(body.input.task==='configuration')await new Promise(resolve=>release=resolve);return envelope(body.input,{memories:[]});});
 const older=f.submit();await tick();f.get('recall-task').value='new query';f.click('recall-task','input');f.get('recall-consent').checked=true;
 await f.submit();const current=f.run('current');release();await older;assert.equal(f.run('current'),current);assert.equal(f.get('export').disabled,false);
});
test('network failures do not turn into empty successful previews or automatic retries',async()=>{
 const f=fixture(async()=>{throw Error('synthetic response loss');});await f.submit();assert.equal(f.calls.length,1);assert.equal(f.run('current'),null);assert.equal(f.get('export').disabled,true);
 assert.match(f.get('message').textContent,/未确认/);
});
test('revocation during content hashing suppresses the result',async()=>{
 const f=fixture();f.run("sha256Hex=async()=>{document.getElementById('recall-consent').checked=false;return '0'.repeat(64);}");
 await f.submit();assert.equal(f.calls.length,1);assert.equal(f.run('current'),null);assert.equal(f.get('export').disabled,true);
});
test('unconfirmed writes prevent any preview request',async()=>{
 const f=fixture();f.run("pending={operation:'commit'};");await f.submit();assert.equal(f.calls.length,0);
 assert.match(f.get('message').textContent,/尚未确认的写入/);
});
test('source changes while awaiting the response cannot certify a preview',async()=>{
 let release;const f=fixture(async body=>{await new Promise(r=>release=r);return envelope(body.input);});
 const pending=f.submit();await tick();f.run("sourceId='other'");release();await pending;
 assert.equal(f.run('current'),null);assert.equal(f.get('export').disabled,true);
});
test('empty valid context is distinct from a failed preview',async()=>{
 const f=fixture(async body=>envelope(body.input,{memories:[],dropped:2}));await f.submit();
 assert.equal(f.run('current.memories.length'),0);assert.equal(f.get('export').disabled,false);assert.match(f.get('coverage').textContent,/舍弃 2 条/);
});

for(const field of ['task','token'])test('unexpected reflected '+field+' cannot enter a preview export',async()=>{
 const f=fixture(async body=>envelope(body.input,{[field]:'PRIVATE_REFLECTION'}));await f.submit();
 assert.equal(f.run('current'),null);assert.equal(f.get('export').disabled,true);
});
