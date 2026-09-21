/** Shipped browser handlers and the real shared verifier, with explicitly synthetic HTTP/DOM. */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {webcrypto,createHash} from 'node:crypto';
import * as contract from '../src/personal-snapshot-contract.mjs';
const app=readFileSync(new URL('../web/personal/app.js',import.meta.url),'utf8')+'\n'+readFileSync(new URL('../web/personal/snapshot-ui.js',import.meta.url),'utf8');
const hash=s=>createHash('sha256').update(s).digest('hex');
function fixture(route=async b=>({format:contract.SNAPSHOT_FORMAT,scope:contract.SNAPSHOT_SCOPE,source_id:'selected',request_id:b.input.request_id,
 snapshot_at:'2026-09-21T00:00:00.000Z',read_only:true,complete:true,record_count:0,excluded:[...contract.SNAPSHOT_EXCLUDES],memories:[],memories_sha256:hash('[]')})){
 const nodes=new Map(),calls=[],downloads=[];
 const element=()=>({value:'',checked:false,hidden:false,disabled:false,textContent:'',dataset:{},children:[],handlers:new Map(),
 addEventListener(k,f){this.handlers.set(k,f);},append(...x){this.children.push(...x);},replaceChildren(){this.children=[];},setAttribute(){},focus(){}});
 const get=id=>{if(!nodes.has(id))nodes.set(id,element());return nodes.get(id);};
 const ctx=vm.createContext({document:{getElementById:get,createElement:element,querySelectorAll:()=>[],addEventListener(){}},window:{addEventListener(){}},
 MutationObserver:class{observe(){}},TextEncoder,TextDecoder,AbortSignal,AbortController,crypto:webcrypto,contract,
 save:(x,n)=>downloads.push({value:JSON.parse(JSON.stringify(x)),name:n}),
 fetch:async(_url,o)=>{const b=JSON.parse(o.body);calls.push(b);return {ok:true,status:200,json:async()=>({ok:true,result:await route(b)})};}});
 const run=s=>vm.runInContext(s,ctx);run(app);
 // Only the module loader is substituted; the actual verifier is imported above.
 run("loadSnapshotContract=async()=>contract;download=save;token='PRIVATE_TOKEN';sourceId='selected';view='lookup';");
 get('content').value='INDEPENDENT_DRAFT';get('snapshot-panel').hidden=true;
 const click=(id,event='click')=>get(id).handlers.get(event)({preventDefault(){}});
 return {get,calls,downloads,run,click,start:()=>click('snapshot-export'),open(){click('snapshot-open');get('snapshot-consent').checked=true;}};
}
test('HTML separates all-owned snapshot consent from current-page export',()=>{
 const html=readFileSync(new URL('../web/personal/index.html',import.meta.url),'utf8');
 for(const id of ['snapshot-panel','snapshot-open','snapshot-consent','snapshot-export','snapshot-cancel'])assert.ok(html.includes('id="'+id+'"'));
 assert.ok(html.includes('不是当前搜索页'));assert.ok(html.includes('不是完整备份'));
});
test('opening export dialog makes no data request',()=>{
 const f=fixture();f.click('snapshot-open');assert.equal(f.calls.length,0);assert.equal(f.get('snapshot-consent').checked,false);
});
test('without consent no snapshot is requested or downloaded',async()=>{
 const f=fixture();f.click('snapshot-open');await f.start();assert.equal(f.calls.length,0);assert.equal(f.downloads.length,0);
});
test('explicit empty snapshot validates then downloads once without pending/write calls',async()=>{
 const f=fixture();f.open();await f.start();assert.equal(f.calls.length,1);assert.equal(f.calls[0].operation,'memory_snapshot');
 assert.deepEqual(Object.keys(f.calls[0].input).sort(),['consent','request_id']);assert.equal(f.downloads.length,1);
 assert.equal(f.get('content').value,'INDEPENDENT_DRAFT');assert.equal(f.run('pending'),null);assert.equal(f.get('snapshot-consent').checked,false);
 assert.ok(!JSON.stringify(f.downloads).includes('PRIVATE_TOKEN'));assert.equal(f.run('snapshotController'),null);
});
for(const boundary of ['consent','cancel','navigation','lock','session','source','pending'])test('late response is not downloaded after '+boundary,async()=>{
 let release;const f=fixture(async b=>{await new Promise(r=>release=r);return {format:contract.SNAPSHOT_FORMAT,scope:contract.SNAPSHOT_SCOPE,
 source_id:'selected',request_id:b.input.request_id,snapshot_at:'2026-09-21T00:00:00.000Z',read_only:true,complete:true,
 record_count:0,excluded:[...contract.SNAPSHOT_EXCLUDES],memories:[],memories_sha256:hash('[]')};});
 f.open();const work=f.start();for(let i=0;i<10&&!release;i++)await new Promise(r=>setImmediate(r));assert.ok(release);
 if(boundary==='consent'){f.get('snapshot-consent').checked=false;f.click('snapshot-consent','change');}
 else if(boundary==='cancel')f.click('snapshot-cancel');else if(boundary==='navigation')await f.run('load()');
 else if(boundary==='lock')f.click('logout');else if(boundary==='session')f.run("token='REPLACEMENT'");
 else if(boundary==='source')f.run("sourceId='other'");else f.run('pending={input:{}};');
 release();await work;assert.equal(f.downloads.length,0);assert.equal(f.calls.length,1);
});
test('new exports cannot be started during unresolved writes',async()=>{
 const f=fixture();f.run('pending={input:{}};');f.open();await f.start();assert.equal(f.calls.length,0);
});
test('double clicks while waiting issue one request and one download',async()=>{
 const f=fixture();f.open();const work=f.start();await f.start();await work;assert.equal(f.calls.length,1);assert.equal(f.downloads.length,1);
});
for(const result of [{},{complete:false},[],null])test('malformed export is never downloaded '+JSON.stringify(result),async()=>{
 const f=fixture(async()=>result);f.open();await f.start();assert.equal(f.downloads.length,0);assert.equal(f.run('pending'),null);
 assert.match(f.get('message').textContent,/未下载/);
});
test('failed export has no automatic retry and does not clear the independent draft',async()=>{
 const f=fixture(async()=>{throw Error('synthetic storage error');});f.open();await f.start();
 assert.equal(f.downloads.length,0);assert.equal(f.calls.length,1);assert.equal(f.get('content').value,'INDEPENDENT_DRAFT');
 assert.equal(f.get('snapshot-consent').checked,false);
});
test('authorization is rechecked after the contract module loads but before sending content query',async()=>{
 const f=fixture();f.open();f.run("loadSnapshotContract=async()=>{document.getElementById('snapshot-consent').checked=false;return contract;};");
 await f.start();assert.equal(f.calls.length,0);assert.equal(f.downloads.length,0);
});

test('a cancelled earlier export cannot overwrite a later verified download',async()=>{
 let release,attempts=0;const f=fixture(async b=>{
  if(++attempts===1)await new Promise(r=>release=r);
  return {format:contract.SNAPSHOT_FORMAT,scope:contract.SNAPSHOT_SCOPE,source_id:'selected',request_id:b.input.request_id,
   snapshot_at:'2026-09-21T00:00:00.000Z',read_only:true,complete:true,record_count:0,excluded:[...contract.SNAPSHOT_EXCLUDES],memories:[],memories_sha256:hash('[]')};
 });
 f.open();const first=f.start();for(let i=0;i<10&&!release;i++)await new Promise(r=>setImmediate(r));assert.ok(release);
 f.click('snapshot-cancel');f.open();await f.start();const text=f.get('message').textContent;release();await first;
 assert.equal(f.calls.length,2);assert.equal(f.downloads.length,1);assert.equal(f.get('message').textContent,text);
 assert.equal(f.downloads[0].value.request_id,f.calls[1].input.request_id);
});
test('silently hiding the explicit export panel does not grant download authority',async()=>{
 const f=fixture();f.open();f.get('snapshot-panel').hidden=true;await f.start();assert.equal(f.calls.length,0);assert.equal(f.downloads.length,0);
});
