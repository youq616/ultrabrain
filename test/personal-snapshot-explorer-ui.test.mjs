/** Execute the production console, inspector and explorer scripts with a synthetic DOM. */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import * as contract from '../src/personal-snapshot-contract.mjs';
import {encoded,envelope,row} from './helpers/snapshot-audit-fixture.mjs';
const code=['app.js','snapshot-ui.js','snapshot-inspector-ui.js','snapshot-explorer-ui.js']
 .map(f=>readFileSync(new URL('../web/personal/'+f,import.meta.url),'utf8')).join('\n');
function fixture(){
 const nodes=new Map(),events=new Map(),reads=[];
 const element=()=>({value:'',checked:false,hidden:false,disabled:false,textContent:'',dataset:{},children:[],handlers:new Map(),
  addEventListener(k,f){this.handlers.set(k,f);},append(...x){this.children.push(...x);},replaceChildren(){this.children=[];},setAttribute(){},focus(){}});
 const get=k=>{if(!nodes.has(k))nodes.set(k,element());return nodes.get(k);};
 const ctx=vm.createContext({document:{getElementById:get,createElement:element,querySelectorAll:()=>[],
  addEventListener(k,f){events.set(k,[...(events.get(k)??[]),f]);}},window:{addEventListener(){}},MutationObserver:class{observe(){}},
  TextEncoder,TextDecoder,AbortSignal,AbortController,crypto:webcrypto,contract,
  fetch:()=>{throw Error('Explorer must not send data');}});
 const run=s=>vm.runInContext(s,ctx);run(code);
 run("loadSnapshotContract=async()=>contract;download=()=>{throw Error('Unexpected download');};token='private-token';sourceId='selected';view='lookup';");
 get('workspace').hidden=false;get('content').value='UNSAVED_DRAFT';
 const click=(id,event='click',data={})=>get(id).handlers.get(event)({preventDefault(){},...data});
 const file=(rows)=>{const bytes=encoded(envelope(rows));return {name:'synthetic.json',size:bytes.byteLength,arrayBuffer:async()=>{reads.push(true);return bytes.slice().buffer;}};};
 const inspect=async(left=[row()],right=null)=>{
  click('inspector-open');get('inspector-left').files=[file(left)];get('inspector-right').files=right?[file(right)]:[];
  click('inspector-left','change');get('inspector-consent').checked=true;await click('inspector-run');
  assert.notEqual(run('inspectorData'),null);click('explorer-open');
 };
 const browse=()=>{get('explorer-consent').checked=true;click('explorer-run');};
 const show=()=>get('explorer-results').children[0].children.at(-1).handlers.get('click')();
 return {get,run,click,inspect,browse,show,file,reads,events};
}
test('explorer UI: opening before verification or without browsing consent reveals no records',async()=>{
 const f=fixture();f.click('explorer-open');assert.equal(f.get('explorer-panel').hidden,true);
 await f.inspect();f.click('explorer-run');assert.equal(f.get('explorer-results').children.length,0);
 assert.equal(f.get('explorer-detail').hidden,true);assert.equal(f.get('explorer-run').disabled,true);
});
test('explorer UI: index is metadata-only, explicit detail displays literal untrusted text',async()=>{
 const f=fixture();await f.inspect([row(1,{content:'<img src=x onerror=bad()> PRIVATE_BODY',provenance:'PRIVATE_PROVENANCE'})]);
 f.browse();assert.equal(f.get('explorer-results').children.length,1);assert.equal(f.get('explorer-detail').hidden,true);
 assert.ok(!JSON.stringify(f.get('explorer-results')).includes('PRIVATE_BODY'));assert.ok(!JSON.stringify(f.get('explorer-results')).includes('PRIVATE_PROVENANCE'));
 f.show();assert.match(f.get('explorer-detail-text').textContent,/<img src=x/);assert.equal(f.get('explorer-detail-text').children.length,0);
 f.click('explorer-detail-clear');assert.equal(f.get('explorer-detail-text').textContent,'');assert.equal(f.get('explorer-detail').hidden,true);
 assert.equal(f.get('content').value,'UNSAVED_DRAFT');assert.equal(f.reads.length,1);assert.equal(f.run('pending'),null);
});
test('explorer UI: 23 results paginate 20+3 without another file read and clear details',async()=>{
 const f=fixture();await f.inspect(Array.from({length:23},(_,i)=>row(i)));f.browse();f.show();
 assert.equal(f.get('explorer-results').children.length,20);f.click('explorer-next');
 assert.equal(f.get('explorer-results').children.length,3);assert.equal(f.get('explorer-detail-text').textContent,'');
 assert.equal(f.get('explorer-next').disabled,true);f.click('explorer-next');assert.equal(f.get('explorer-results').children.length,3);
 f.click('explorer-prev');assert.equal(f.get('explorer-results').children.length,20);assert.equal(f.reads.length,1);
});
test('explorer UI: every filter change clears old index and details without auto-search',async()=>{
 const f=fixture();await f.inspect();
 for(const id of ['explorer-query','explorer-status','explorer-type','explorer-importance','explorer-origin',
 'explorer-project-scope','explorer-project','explorer-agent','explorer-sort']){
  f.browse();f.show();f.click(id,'input');assert.equal(f.run('explorerPage'),null,id);
  assert.equal(f.get('explorer-summary').textContent,'');assert.equal(f.get('explorer-detail-text').textContent,'');
 }
 assert.equal(f.reads.length,1);
});
test('explorer UI: AND filtering and changed sort require an explicit new read',async()=>{
 const f=fixture();await f.inspect([row(1,{importance:'low'}),row(2,{importance:'high',status:'active',content:'MATCH'}),row(3)]);
 f.get('explorer-status').value='active';f.get('explorer-query').value='MATCH';f.browse();
 assert.equal(f.get('explorer-results').children.length,1);assert.match(f.get('explorer-summary').textContent,/符合条件 1 条/);
 f.get('explorer-query').value='MISSING';f.click('explorer-query','input');assert.equal(f.get('explorer-results').children.length,0);
 f.browse();assert.match(f.get('explorer-summary').textContent,/符合条件 0 条/);assert.equal(f.get('explorer-prev').disabled,true);
});
test('explorer UI: project mode clears the disabled stale project instead of querying it',async()=>{
 const f=fixture();await f.inspect();f.get('explorer-project-scope').value='exact';f.click('explorer-project-scope','change');
 assert.equal(f.get('explorer-project').disabled,false);f.get('explorer-project').value='old';
 f.get('explorer-project-scope').value='global';f.click('explorer-project-scope','change');
 assert.equal(f.get('explorer-project').value,'');assert.equal(f.get('explorer-project').disabled,true);f.browse();
 assert.match(f.get('explorer-summary').textContent,/符合条件 1 条/);
});
test('explorer UI: switching side requires fresh consent, shows the selected file only',async()=>{
 const f=fixture();await f.inspect([row(1,{content:'LEFT_BODY'})],[row(2,{content:'RIGHT_BODY'})]);f.browse();
 f.get('explorer-side').value='right';f.click('explorer-side','change');assert.equal(f.get('explorer-consent').checked,false);
 f.click('explorer-run');assert.equal(f.run('explorerPage'),null);f.browse();f.show();
 assert.match(f.get('explorer-detail-text').textContent,/RIGHT_BODY/);assert.ok(!f.get('explorer-detail-text').textContent.includes('LEFT_BODY'));
});
test('explorer UI: right side cannot be manufactured when only one file was inspected',async()=>{
 const f=fixture();await f.inspect();assert.equal(f.get('explorer-side-right').disabled,true);
 f.get('explorer-side').value='right';f.browse();assert.equal(f.run('explorerPage'),null);
});
for(const boundary of ['read-consent','browse-consent','file','session','source','navigation','view','pending','busy','workspace','parent-panel','browser-panel','filter','side'])
 test('explorer UI: stale detail and pagination are denied after '+boundary,async()=>{
  const f=fixture();await f.inspect(Array.from({length:23},(_,i)=>row(i)));f.browse();
  const stale=f.get('explorer-results').children[0].children.at(-1).handlers.get('click');
  if(boundary==='read-consent')f.get('inspector-consent').checked=false;
  else if(boundary==='browse-consent')f.get('explorer-consent').checked=false;
  else if(boundary==='file')f.get('inspector-left').files=[f.file([row(8)])];
  else if(boundary==='session')f.run("token='other'");else if(boundary==='source')f.run("sourceId='other'");
  else if(boundary==='navigation')f.run('loadVersion++');else if(boundary==='view')f.run("view='active'");
  else if(boundary==='pending')f.run('pending={input:{}}');else if(boundary==='busy')f.run('busy=true');
  else if(boundary==='workspace')f.get('workspace').hidden=true;
  else if(boundary==='parent-panel')f.get('inspector-panel').hidden=true;
  else if(boundary==='browser-panel')f.get('explorer-panel').hidden=true;
  else if(boundary==='filter')f.get('explorer-query').value='changed silently';else f.get('explorer-side').value='right';
  stale();f.click('explorer-next');assert.equal(f.get('explorer-detail-text').textContent,'');assert.equal(f.run('explorerPage'),null);
  assert.equal(f.get('content').value,'UNSAVED_DRAFT');
 });
for(const action of ['inspector-left','inspector-right','inspector-consent','inspector-cancel','inspector-run','inspector-open'])
 test('explorer UI: inspector lifecycle synchronously clears displayed private detail: '+action,async()=>{
  const f=fixture();await f.inspect();f.browse();f.show();
  if(action==='inspector-consent')f.get(action).checked=false;
  const p=f.click(action,['inspector-left','inspector-right','inspector-consent'].includes(action)?'change':'click');
  assert.equal(f.get('explorer-detail-text').textContent,'');assert.equal(f.get('explorer-panel').hidden,true);
  assert.equal(f.get('explorer-consent').checked,false);if(p?.then)await p;
 });
test('explorer UI: browse and comparison consents remain independent',async()=>{
 const f=fixture();await f.inspect([row(1)],[row(2)]);f.get('inspector-compare-consent').checked=true;f.click('inspector-compare');
 assert.notEqual(f.run('inspectorReport'),null);f.browse();f.get('explorer-consent').checked=false;f.click('explorer-consent','change');
 assert.notEqual(f.run('inspectorReport'),null);f.browse();f.get('inspector-compare-consent').checked=false;f.click('inspector-compare-consent','change');
 assert.notEqual(f.run('explorerPage'),null);f.show();assert.equal(f.get('explorer-detail').hidden,false);
});
test('explorer UI: invalid query fails closed and does not echo user input or exception details',async()=>{
 const f=fixture();await f.inspect();f.browse();f.show();f.get('explorer-query').value='SECRET\0';f.browse();
 assert.equal(f.run('explorerPage'),null);assert.equal(f.get('explorer-detail-text').textContent,'');
 assert.ok(!f.get('message').textContent.includes('SECRET'));assert.match(f.get('message').textContent,/筛选条件无效/);
});
test('explorer UI: closing clears filters and bodies but retains the independently verified file',async()=>{
 const f=fixture();await f.inspect();f.browse();f.show();f.get('explorer-query').value='SECRET_QUERY';f.click('explorer-close');
 assert.equal(f.get('explorer-query').value,'');assert.equal(f.get('explorer-detail-text').textContent,'');
 assert.notEqual(f.run('inspectorData'),null);assert.equal(f.get('content').value,'UNSAVED_DRAFT');
});
test('explorer UI: a detached page button cannot display a record after pagination',async()=>{
 const f=fixture();await f.inspect(Array.from({length:23},(_,i)=>row(i)));f.browse();
 const stale=f.get('explorer-results').children[0].children.at(-1).handlers.get('click');f.click('explorer-next');stale();
 assert.equal(f.get('explorer-detail-text').textContent,'');
});
test('explorer UI: capture-phase navigation clears bodies before app handlers execute',async()=>{
 const f=fixture();await f.inspect();f.browse();f.show();
 for(const handler of f.events.get('click'))handler({target:{closest:()=>true}});
 assert.equal(f.get('explorer-panel').hidden,true);assert.equal(f.get('explorer-detail-text').textContent,'');assert.equal(f.run('explorerBinding'),null);
});
