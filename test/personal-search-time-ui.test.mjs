/** Shipped browser JS in synthetic DOM/HTTP; canonical backend parity, not database proof. */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import {searchQuery} from '../src/personal-memory.mjs';
const app=readFileSync(new URL('../web/personal/app.js',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const from='2024-03-10T07:00:00.000001Z',before='2024-03-10T07:00:00.000002Z';
const id='11111111-1111-4111-8111-111111111111';
const row=(content='SYNTHETIC')=>({id,content,type:'preference',origin_kind:'agent',revision:3,status:'candidate',owned_by_caller:true,
  visibility:'private',confidence:0.4,provenance:'Synthetic fixture',project_id:null,updated_at:from});
const result=(body,content='SYNTHETIC',next=null)=>({source_id:'selected',status:body.input.status,memories:[{...row(content),project_id:body.input.project_id??null,agent_id:body.input.agent_id??'search-time-fixture'}],next_offset:next});
function fixture(route=async body=>result(body)){
 const nodes=new Map(),calls=[],exports=[],signals=[];
 function element(){return {value:'',checked:false,dataset:{},hidden:false,disabled:false,textContent:'',children:[],handlers:new Map(),
  addEventListener(name,handler){this.handlers.set(name,handler);},reset(){},replaceChildren(...children){this.children=children;},
  setAttribute(){},append(...children){this.children.push(...children);},focus(){}};}
 const get=id=>{if(!nodes.has(id))nodes.set(id,element());return nodes.get(id);};
 const ctx=vm.createContext({document:{getElementById:get,querySelectorAll:()=>[],createElement:element},window:{addEventListener(){}},
  AbortController,AbortSignal,TextEncoder,TextDecoder,crypto:webcrypto,exports,confirm:()=>true,
  fetch:async(_url,options)=>{const body=JSON.parse(options.body);calls.push(body);signals.push(options.signal);
    const reply=await route(body,options);return {ok:true,status:200,json:async()=>({ok:true,result:reply})};}});
 const run=s=>vm.runInContext(s,ctx);run(app);run("token='SYNTHETIC_SESSION';sourceId='selected';download=value=>exports.push(value);");
 Object.entries({type:'preference',content:'UNSAVED',importance:'high',visibility:'private',provenance:'Unsaved source',project:'unsaved-project'}).forEach(([k,v])=>get(k).value=v);
 get('consent').checked=true;
 const event=(id,name='click')=>get(id).handlers.get(name)({preventDefault(){}});
 return {get,run,calls,exports,signals,event,load:()=>run('load()'),search:()=>event('search-form','submit'),
  set(id,value,notify=true){get(id).value=value;if(notify)event(id,'input');},
  criteria(query,lo,hi,project='',agent=''){ctx.args=[query,lo,hi,project,agent];return run('searchCriteria(...args)');},
  async settled(){for(let i=0;i<100&&run('busy');i++)await tick();assert.equal(run('busy'),false);}};
}
function plain(value){return JSON.parse(JSON.stringify(value));}
const valid=['','0001-01-01T00:00:00Z','9999-12-31T23:59:59.999999Z','2000-02-29T00:00:00Z','2024-02-29T23:59:59.1Z',
 '2024-03-10T07:00:00Z',...Array.from({length:6},(_,i)=>'2024-03-10T07:00:00.'+'1'.repeat(i+1)+'Z')];
for(const value of valid)for(const field of ['updated_from','updated_before'])test('exact backend parity '+field+' '+JSON.stringify(value),()=>{
 const f=fixture();f.run("Date=class{constructor(){throw Error('No Date conversion')}static parse(){throw Error('No Date parse')}}");
 const actual=f.criteria('literal',field==='updated_from'?value:'',field==='updated_before'?value:'');
 assert.equal(actual[field],searchQuery({query:'literal',[field]:value})[field]);assert.equal(actual.query,'literal');
 assert.ok(Object.isFrozen(actual));
});
const invalid=[' ','\t','\n','2024-01-01T00:00:00Z\n',' 2024-01-01T00:00:00Z','2024-01-01T00:00:00Z ',
 '2024-01-01t00:00:00z','2024-01-01','2024-01-01T00:00Z','2024-01-01 00:00:00Z','2024-01-01T00:00:00+00:00',
 '2024-01-01T00:00:00.1234567Z','2024-01-01T00:00:00.Z','0000-01-01T00:00:00Z','10000-01-01T00:00:00Z',
 '1900-02-29T00:00:00Z','2100-02-29T00:00:00Z','2023-02-29T00:00:00Z','2024-04-31T00:00:00Z',
 '2024-00-01T00:00:00Z','2024-13-01T00:00:00Z','2024-01-00T00:00:00Z','2024-01-32T00:00:00Z',
 '2024-01-01T24:00:00Z','2024-01-01T00:60:00Z','2024-01-01T00:00:60Z'];
for(const value of invalid)for(const field of ['updated_from','updated_before'])test('reject same invalid UTC domain '+field+' '+JSON.stringify(value),()=>{
 const f=fixture();assert.throws(()=>f.criteria('',field==='updated_from'?value:'',field==='updated_before'?value:''));
 assert.throws(()=>searchQuery({[field]:value}),{code:'invalid_params'});
});
for(const value of [undefined,null,0,false,[],{},new String('')])test('UI string domain rejects '+String(value)+' without changing backend absence policy',()=>{
 const f=fixture();assert.throws(()=>f.criteria('',value,''));assert.throws(()=>f.criteria('','',value));
 if(value===null||value===undefined)assert.equal(searchQuery({updated_from:value}).updated_from,null);
});
for(const [lo,hi] of [[from,from],[before,from],['2024-01-01T00:00:00.1Z','2024-01-01T00:00:00.100000Z']])test('equal/reversed exact endpoints rejected '+lo+' '+hi,()=>{
 const f=fixture();assert.throws(()=>f.criteria('',lo,hi));assert.throws(()=>searchQuery({updated_from:lo,updated_before:hi}),{code:'invalid_params'});
});
test('microsecond adjacent ordering retained, raw input unchanged',async()=>{
 const f=fixture();f.set('updated-from',from);f.set('updated-before',before);await f.search();
 assert.equal(f.calls[0].input.updated_from,from);assert.equal(f.calls[0].input.updated_before,before);
 assert.equal(f.get('updated-from').value,from);assert.match(f.get('search-applied').textContent,/已应用/);
});
test('untouched initial login load remains unbounded',async()=>{
 const f=fixture();await f.load();assert.deepEqual(f.calls,[{operation:'search',input:{status:'candidate',query:'',limit:20,offset:0,budget_bytes:131072}}]);
 assert.equal(f.run('current.memories.length'),1);
});
test('canonical summary and transmission never rewrite raw inputs',async()=>{
 const f=fixture();const raw='2000-02-29T00:00:00.1Z';f.set('updated-from',raw);await f.search();
 assert.equal(f.get('updated-from').value,raw);assert.equal(f.calls[0].input.updated_from,'2000-02-29T00:00:00.100000Z');
 assert.match(f.get('search-applied').textContent,/2000-02-29T00:00:00\.100000Z/);f.event('export');
 assert.equal(f.exports[0].search.updated_from,f.calls[0].input.updated_from);assert.equal(f.exports[0].complete,false);
 assert.ok(!JSON.stringify(f.exports).includes('SYNTHETIC_SESSION'));
});
for(const field of ['query','updated-from','updated-before','search-project','search-agent'])test('editing '+field+' clears results/paging/export without request and requires explicit search',async()=>{
 const f=fixture(async b=>result(b,'OLD',20));await f.load();f.set(field,field==='query'?'new':field==='search-project'?'Project_A':field==='search-agent'?'Agent_A':'2024-01-01T00:00:00Z');
 assert.equal(f.calls.length,1);assert.equal(f.run('current'),null);assert.equal(f.get('results').children.length,0);
 for(const control of ['prev','next','export'])assert.equal(f.get(control).disabled,true);
 await f.event('refresh');f.run("view='active';offset=0");await f.load();assert.equal(f.calls.length,1);
 await f.search();assert.equal(f.calls.length,2);assert.equal(f.calls[1].input.offset,0);assert.equal(f.calls[1].input.status,'active');
});
test('dirty input reverted to same string still requires explicit apply',async()=>{
 const f=fixture();await f.load();f.set('query','different');f.set('query','');await f.load();assert.equal(f.calls.length,1);await f.search();assert.equal(f.calls.length,2);
});
test('invalid input clears prior export and never transmits',async()=>{
 const f=fixture();await f.load();f.set('updated-from',' 2024-01-01T00:00:00Z');await f.search();
 assert.equal(f.calls.length,1);assert.equal(f.run('current'),null);assert.match(f.get('search-applied').textContent,/条件无效/);
 f.event('export');assert.equal(f.exports.length,0);
});
test('paging uses immutable applied criteria, search resets page zero, status navigation retains bounds',async()=>{
 const f=fixture(async b=>result(b,'PAGE',b.input.offset===0?20:null));f.set('search-project','Project_A');f.set('query','literal');f.set('updated-from',from);f.set('updated-before',before);await f.search();
 const first=plain(f.calls[0].input);await f.event('next');assert.deepEqual(f.calls[1].input,{...first,offset:20});
 f.event('export');assert.equal(f.exports[0].search.offset,20);await f.event('prev');assert.deepEqual(f.calls[2].input,first);
 await f.event('next');await f.search();assert.equal(f.calls.at(-1).input.offset,0);
 f.run("view='archived';offset=0");await f.load();assert.deepEqual(f.calls.at(-1).input,{...first,status:'archived'});
});
for(const action of ['next','prev','export'])for(const field of ['query','search-project','search-agent'])test('unsignalled '+field+' draft edit cannot reuse old '+action,async()=>{
 const f=fixture(async b=>result(b,'PAGE',20));await f.load();f.set(field,'UNAPPLIED',false);await f.event(action);
 assert.equal(f.calls.length,1);assert.equal(f.exports.length,0);assert.equal(f.run('current'),null);assert.equal(f.get('export').disabled,true);
});
test('hidden search edit preserves unrelated current data, export and pagination',async()=>{
 const f=fixture();f.run("view='agents';current={agents:[{agent_id:'synthetic'}]};nextOffset=20");f.get('export').disabled=false;f.get('next').disabled=false;
 f.set('updated-from',from);assert.equal(f.run('current.agents[0].agent_id'),'synthetic');assert.equal(f.get('export').disabled,false);assert.equal(f.get('next').disabled,false);
 f.event('export');assert.equal(f.exports.length,1);assert.equal(Object.hasOwn(f.exports[0],'search'),false);
 f.run("view='candidate'");await f.load();assert.equal(f.calls.length,0);
});
for(const outcome of ['success','error'])for(const change of ['query','time','project','project-reverted','project-unsignalled','agent','agent-reverted','agent-unsignalled','reverted','unsignalled','navigation','status','refresh','replacement','logout','token','source','offset','write','pending'])
 test('late '+outcome+' ignored after '+change,async()=>{
  let release,first=true;const f=fixture(async body=>{if(body.operation==='search'&&first){first=false;await new Promise(resolve=>release=resolve);if(outcome==='error')throw Error('OLD_FAILURE');return result(body,'OLD');}return result(body,'NEW');});
  const waiting=f.load();await tick();assert.ok(release);
  if(change==='query')f.set('query','new');
  if(change==='time')f.set('updated-from',from);
  if(change==='project')f.set('search-project','Project_A');
  if(change==='project-reverted'){f.set('search-project','Project_A');f.set('search-project','');}
  if(change==='project-unsignalled')f.set('search-project','Project_A',false);
  if(change==='agent')f.set('search-agent','Agent_A');
  if(change==='agent-reverted'){f.set('search-agent','Agent_A');f.set('search-agent','');}
  if(change==='agent-unsignalled')f.set('search-agent','Agent_A',false);
  if(change==='reverted'){f.set('query','new');f.set('query','');}
  if(change==='unsignalled')f.set('query','new',false);
  if(change==='navigation'){f.run("view='lookup'");await f.load();}
  if(change==='status'){f.run("view='active';offset=0");await f.load();}
  if(change==='refresh')await f.load();
  if(change==='replacement')await f.search();
  if(change==='logout')f.event('logout');
  if(change==='token')f.run("token='REPLACEMENT_SESSION'");
  if(change==='source')f.run("sourceId='other'");
  if(change==='offset')f.run('offset=20');
  if(change==='write'){f.run("mutate('review',{memory_id:'"+id+"',expected_revision:3,status:'archived'})");await f.settled();}
  if(change==='pending')f.run("pending={operation:'update',input:{event_id:'existing'}}");
  f.get('message').textContent='NEW MESSAGE';release();await waiting;await tick();
  assert.doesNotMatch(JSON.stringify(f.run('current')),/OLD/);assert.equal(f.get('message').textContent,'NEW MESSAGE');
  if(['query','time','project','project-reverted','agent','agent-reverted','reverted','navigation','status','refresh','replacement','logout','write'].includes(change))assert.equal(f.signals[0].aborted,true);
 });
test('ordinary criteria edits preserve draft, confidence, expected revision and consent',async()=>{
 const f=fixture();f.run("editing={id:'"+id+"',revision:9};draftConfidence=.41");const draft=f.run('editorReceiptSelection()');
 await f.load();f.set('query','new');f.set('search-project','Project_A');f.set('search-agent','Agent_A');f.set('updated-from',from);await f.search();assert.equal(f.run('editorReceiptSelection()'),draft);
 assert.equal(f.run('memoryDraft().project_id'),'unsaved-project');assert.equal(f.calls.at(-1).input.project_id,'Project_A');
});
test('pending immutable write blocks search and survives criteria edits',async()=>{
 const f=fixture();f.run("pending=Object.freeze({operation:'update',input:Object.freeze({event_id:'ORIGINAL',expected_revision:9}),delivery_unconfirmed:true})");
 const original=f.run('pending');f.set('updated-from',from);f.set('search-project','Project_A');f.set('search-agent','Agent_A');await f.search();await f.load();
 assert.equal(f.calls.length,0);assert.equal(f.run('pending'),original);assert.equal(f.run('pending.input.event_id'),'ORIGINAL');assert.equal(f.get('content').value,'UNSAVED');
});
test('post-ack busy=true with pending=null reload remains allowed',async()=>{
 const f=fixture();f.run('busy=true;pending=null');await f.load();assert.equal(f.calls.length,1);assert.equal(f.run('current.memories.length'),1);assert.equal(f.get('export').disabled,false);
});
test('post-ack reload cannot silently apply dirty criteria',async()=>{
 const f=fixture();f.set('updated-from',from);f.run('busy=true;pending=null');await f.load();assert.equal(f.calls.length,0);assert.equal(f.run('current'),null);
});
test('explicit retry aborts outstanding ordinary search but keeps the original event',async()=>{
 let release;const f=fixture(async body=>{if(body.operation==='search')await new Promise(resolve=>release=resolve);else throw Error('synthetic unconfirmed');return result(body);});
 f.set('search-agent','Agent_A');const waiting=f.search();await tick();f.run("pending={operation:'review',input:{event_id:'ORIGINAL',memory_id:'"+id+"',expected_revision:9,status:'archived'},source_id:'selected',sessionCurrent:()=>true,editorUnchanged:()=>false}");
 await f.run('submitPending()');assert.equal(f.signals[0].aborted,true);assert.equal(f.run('pending.input.event_id'),'ORIGINAL');release();await waiting;
 assert.equal(f.run('current'),null);assert.equal(f.run('pending.delivery_unconfirmed'),true);assert.equal(f.run('searchApplied.agent_id'),'Agent_A');
});

for(const value of ['', 'A', 'Project_A', 'project_a', '0-x_Y', 'a'.repeat(96), 'null', 'undefined'])test('search project preserves canonical identifier '+JSON.stringify(value),async()=>{
 const f=fixture();const actual=f.criteria('literal',from,before,value);
 assert.ok(Object.isFrozen(actual));assert.equal(actual.project_id,value||null);
 assert.equal(actual.project_id,searchQuery({...value?{project_id:value}:{},query:'literal'}).project_id);
 f.set('search-project',value);await f.search();assert.equal(f.get('search-project').value,value);
 if(value){assert.equal(f.calls[0].input.project_id,value);assert.match(f.get('search-applied').textContent,/仅该项目，不含全局/);}
 else{assert.equal(Object.hasOwn(f.calls[0].input,'project_id'),false);assert.match(f.get('search-applied').textContent,/全部可见（含全局）/);}
 f.event('export');assert.deepEqual(plain(f.exports[0].search),f.calls[0].input);assert.equal(f.exports[0].complete,false);
});
for(const value of [' ', '\t', '\n', 'Project_A\n', 'Project_A\r', 'Project_A\r\n', ' Project_A', 'Project_A ', 'a.b', 'a/b', '项目', 'é', 'a'.repeat(97), 0, false, [], {}, new String('Project_A')])test('invalid project never sends or retains old export '+JSON.stringify(value),async()=>{
 const f=fixture();await f.load();f.set('search-project',value);await f.search();
 assert.equal(f.calls.length,1);assert.equal(f.run('current'),null);assert.match(f.get('search-applied').textContent,/条件无效/);
 assert.throws(()=>searchQuery({project_id:value}),{code:'invalid_params'});f.event('export');assert.equal(f.exports.length,0);
});
for(const value of [undefined,null])test('project UI rejects nonstring absence '+String(value)+' while backend absence stays unchanged',async()=>{
 const f=fixture();await f.load();f.set('search-project',value);await f.search();assert.equal(f.calls.length,1);
 assert.match(f.get('search-applied').textContent,/条件无效/);assert.equal(searchQuery({project_id:value}).project_id,null);
});
for(const event of ['input','change'])test('project '+event+' invalidates immediately and revert still needs explicit search',async()=>{
 const f=fixture(async b=>result(b,'PAGE',20));await f.load();f.get('search-project').value='Project_A';f.event('search-project',event);
 assert.equal(f.run('current'),null);for(const id of ['prev','next','export'])assert.equal(f.get(id).disabled,true);
 f.get('search-project').value='';f.event('search-project',event);await f.load();assert.equal(f.calls.length,1);
 await f.search();assert.equal(f.calls.length,2);assert.equal(Object.hasOwn(f.calls.at(-1).input,'project_id'),false);
});
test('project status/refresh/export and clearing never borrow independent editor project',async()=>{
 const f=fixture();f.set('search-project','Project_A');await f.search();const input=plain(f.calls[0].input);
 for(const status of ['active','archived','candidate']){f.run("view='"+status+"';offset=0");await f.load();assert.deepEqual(f.calls.at(-1).input,{...input,status});}
 f.get('project').value='editor-only';f.event('memory-form','input');assert.equal(f.run('current.memories.length'),1);assert.equal(f.get('export').disabled,false);
 await f.event('refresh');assert.equal(f.calls.at(-1).input.project_id,'Project_A');assert.equal(f.run('memoryDraft().project_id'),'editor-only');
 f.set('search-project','');await f.search();assert.equal(Object.hasOwn(f.calls.at(-1).input,'project_id'),false);assert.equal(f.get('project').value,'editor-only');
});
test('hidden project draft preserves unrelated current page authority and post-ack cannot apply it',async()=>{
 const f=fixture();f.run("view='agents';current={agents:[{agent_id:'synthetic'}]};nextOffset=20");f.get('export').disabled=false;f.get('next').disabled=false;
 f.set('search-project','Project_A');assert.equal(f.run('current.agents[0].agent_id'),'synthetic');assert.equal(f.get('export').disabled,false);assert.equal(f.get('next').disabled,false);
 f.event('export');assert.equal(Object.hasOwn(f.exports[0],'search'),false);f.run("view='candidate';busy=true;pending=null");await f.load();assert.equal(f.calls.length,0);
});

for(const value of ['', 'A', 'Agent_A', 'agent_a', '0-x_Y', 'a'.repeat(96), 'null', 'undefined', 'constructor', '__proto__'])test('search Agent label preserves exact identifier '+JSON.stringify(value),async()=>{
 const f=fixture();const actual=f.criteria('literal',from,before,'Project_A',value);
 assert.ok(Object.isFrozen(actual));assert.equal(actual.agent_id,value||null);
 assert.equal(actual.agent_id,searchQuery({...value?{agent_id:value}:{},query:'literal'}).agent_id);
 f.set('search-agent',value);await f.search();assert.equal(f.get('search-agent').value,value);
 if(value){assert.equal(f.calls[0].input.agent_id,value);assert.ok(f.get('search-applied').textContent.includes(value+'（精确匹配）'));}
 else{assert.equal(Object.hasOwn(f.calls[0].input,'agent_id'),false);assert.match(f.get('search-applied').textContent,/全部可见标签/);}
 f.event('export');assert.deepEqual(plain(f.exports[0].search),f.calls[0].input);assert.equal(f.exports[0].complete,false);
 assert.equal(f.exports[0].result.memories[0].agent_id,value||'search-time-fixture');
});
for(const value of [' ', '\t', '\n', 'Agent_A\n', 'Agent_A\r', 'Agent_A\r\n', 'Agent_A\u2028', 'Agent_A\u2029', ' Agent_A', 'Agent_A ',
 'a.b', 'a/b', 'a\\b', 'a\0b', 'Agent 标签', 'é', 'a'.repeat(97), 0, false, [], {}, new String('Agent_A'), null])test('invalid Agent label never sends or retains old export '+JSON.stringify(value),async()=>{
 const f=fixture();await f.load();f.set('search-agent',value);await f.search();
 assert.equal(f.calls.length,1);assert.equal(f.run('current'),null);assert.match(f.get('search-applied').textContent,/条件无效/);
 assert.throws(()=>searchQuery({agent_id:value}),{code:'invalid_params'});f.event('export');assert.equal(f.exports.length,0);
});
test('Agent UI rejects undefined while backend omitted label remains unconstrained',async()=>{
 const f=fixture();await f.load();f.set('search-agent',undefined);await f.search();assert.equal(f.calls.length,1);
 assert.match(f.get('search-applied').textContent,/条件无效/);assert.equal(searchQuery({agent_id:undefined}).agent_id,null);
 assert.throws(()=>searchQuery({agent_id:''}),{code:'invalid_params'});
});
for(const event of ['input','change'])test('Agent '+event+' invalidates immediately and revert still needs explicit search',async()=>{
 const f=fixture(async b=>result(b,'PAGE',20));await f.load();f.get('search-agent').value='Agent_A';f.event('search-agent',event);
 assert.equal(f.run('current'),null);for(const id of ['prev','next','export'])assert.equal(f.get(id).disabled,true);
 f.get('search-agent').value='';f.event('search-agent',event);await f.load();assert.equal(f.calls.length,1);
 await f.search();assert.equal(f.calls.length,2);assert.equal(Object.hasOwn(f.calls.at(-1).input,'agent_id'),false);
});
test('frozen Agent/project/time criteria and page input bind paging/export/status/refresh',async()=>{
 const f=fixture(async b=>result(b,'PAGE',b.input.offset===0?20:null));
 f.set('search-agent','Agent_A');f.set('search-project','Project_A');f.set('query','literal');f.set('updated-from',from);f.set('updated-before',before);await f.search();
 const first=plain(f.calls[0].input);assert.ok(f.run('Object.isFrozen(searchApplied)&&Object.isFrozen(searchPage.input)'));
 assert.equal(f.run("Reflect.set(searchApplied,'agent_id','changed')"),false);assert.equal(f.run("Reflect.set(searchPage.input,'agent_id','changed')"),false);
 assert.equal(f.run('searchApplied.agent_id'),'Agent_A');await f.event('next');assert.deepEqual(f.calls[1].input,{...first,offset:20});
 f.event('export');assert.deepEqual(plain(f.exports[0].search),{...first,offset:20});assert.equal(f.exports[0].complete,false);
 await f.event('prev');assert.deepEqual(f.calls[2].input,first);await f.event('next');await f.search();assert.deepEqual(f.calls.at(-1).input,first);
 for(const status of ['active','archived','candidate']){f.run("view='"+status+"';offset=0");await f.load();assert.deepEqual(f.calls.at(-1).input,{...first,status});}
 await f.event('refresh');assert.deepEqual(f.calls.at(-1).input,first);
 f.get('project').value='editor-only';f.get('type').value='environment';f.event('memory-form','input');
 assert.equal(f.run('current.memories.length'),1);assert.equal(f.get('export').disabled,false);await f.event('refresh');assert.deepEqual(f.calls.at(-1).input,first);
 f.set('search-agent','');await f.search();assert.equal(Object.hasOwn(f.calls.at(-1).input,'agent_id'),false);
 assert.equal(f.get('project').value,'editor-only');assert.equal(f.get('type').value,'environment');assert.equal(f.calls.at(-1).input.project_id,'Project_A');
});
test('hidden Agent draft preserves unrelated page and post-ack cannot apply it',async()=>{
 const f=fixture();f.run("view='agents';current={agents:[{agent_id:'synthetic'}]};nextOffset=20");f.get('export').disabled=false;f.get('next').disabled=false;
 f.set('search-agent','Agent_A');assert.equal(f.run('current.agents[0].agent_id'),'synthetic');assert.equal(f.get('export').disabled,false);assert.equal(f.get('next').disabled,false);
 f.event('export');assert.equal(Object.hasOwn(f.exports[0],'search'),false);f.run("view='candidate';busy=true;pending=null");await f.load();assert.equal(f.calls.length,0);
});
test('Agent criteria preserve complete editor and immutable pending request while blocked',async()=>{
 const f=fixture(async body=>{if(body.operation==='search')return result(body);throw Error('synthetic unconfirmed');});
 f.run("editing={id:'"+id+"',revision:9};draftConfidence=.41");const draft=f.run('editorReceiptSelection()');
 f.set('search-agent','Agent_A');await f.search();assert.equal(f.run('editorReceiptSelection()'),draft);
 f.run("pending=Object.freeze({operation:'review',input:Object.freeze({event_id:'ORIGINAL',memory_id:'"+id+"',expected_revision:9,status:'archived'}),source_id:'selected',sessionCurrent:()=>true,editorUnchanged:()=>false,delivery_unconfirmed:true})");
 const original=f.run('pending');f.set('search-agent','agent_a');await f.search();await f.load();assert.equal(f.calls.length,1);assert.equal(f.run('pending'),original);
 assert.equal(f.run('editorReceiptSelection()'),draft);assert.equal(f.run('pending.input.event_id'),'ORIGINAL');assert.equal(f.run('pending.input.expected_revision'),9);
});
test('Agent visible label is separate text-only markup with explicit textbox association',()=>{
 const html=readFileSync(new URL('../web/personal/index.html',import.meta.url),'utf8');
 assert.match(html,/<label for="search-agent" id="search-agent-label">搜索 Agent 标签（精确标识，可留空）<\/label><input id="search-agent"[^>]*type="text"[^>]*aria-labelledby="search-agent-label"[^>]*aria-describedby="search-agent-help"/);
 assert.match(html,/id="search-agent"[^>]*maxlength="96"/);assert.match(html,/标签由客户端自述，不是认证身份或软件来源证明/);
 // Native browser role/name checks supply actual accessibility semantics; this is markup-only regression evidence.
});
test('post-ack reload reuses applied Agent but cannot apply a dirty label',async()=>{
 const f=fixture();f.set('search-agent','Agent_A');await f.search();f.run('busy=true;pending=null');await f.load();
 assert.equal(f.calls.length,2);assert.equal(f.calls[1].input.agent_id,'Agent_A');assert.equal(f.get('export').disabled,false);
 f.set('search-agent','agent_a');await f.load();assert.equal(f.calls.length,2);assert.equal(f.run('current'),null);
});
