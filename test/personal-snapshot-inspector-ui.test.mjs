/** Actual app, export and inspection UI with synthetic DOM and selected local files. */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import * as contract from '../src/personal-snapshot-contract.mjs';
import {encoded,envelope,row} from './helpers/snapshot-audit-fixture.mjs';
const code=['app.js','snapshot-ui.js','snapshot-inspector-ui.js'].map(f=>readFileSync(new URL('../web/personal/'+f,import.meta.url),'utf8')).join('\n');
const tick=()=>new Promise(r=>setImmediate(r));
function fixture(){
 const nodes=new Map(),downloads=[],reads=[],events=new Map();
 const element=()=>({value:'',checked:false,hidden:false,disabled:false,textContent:'',dataset:{},children:[],handlers:new Map(),
  addEventListener(k,f){this.handlers.set(k,f);},append(...x){this.children.push(...x);},replaceChildren(){this.children=[];},setAttribute(){},focus(){}});
 const get=k=>{if(!nodes.has(k))nodes.set(k,element());return nodes.get(k);};
 const ctx=vm.createContext({document:{getElementById:get,createElement:element,querySelectorAll:()=>[],addEventListener(k,f){events.set(k,[...(events.get(k)??[]),f]);}},
  window:{addEventListener(){}},MutationObserver:class{observe(){}},TextEncoder,TextDecoder,AbortSignal,AbortController,crypto:webcrypto,contract,
  save:(value,name)=>downloads.push({value:JSON.parse(JSON.stringify(value)),name}),
  fetch:()=>{throw Error('Local inspection must not request HTTP data');}});
 const run=s=>vm.runInContext(s,ctx);run(code);run("loadSnapshotContract=async()=>contract;download=save;token='PRIVATE_TOKEN';sourceId='selected';view='lookup';");
 get('content').value='UNSAVED_DRAFT';get('workspace').hidden=false;get('inspector-panel').hidden=true;
 const click=(id,event='click')=>get(id).handlers.get(event)({preventDefault(){}});
 const file=(data=encoded(),label='snapshot.json')=>({name:label,size:data.byteLength,arrayBuffer:async()=>{reads.push(label);return data.slice().buffer;}});
 const select=(left=file(),right)=>{get('inspector-left').files=[left];get('inspector-right').files=right?[right]:[];click('inspector-left','change');};
 const open=()=>click('inspector-open');
 const inspect=()=>{get('inspector-consent').checked=true;return click('inspector-run');};
 const compare=()=>{get('inspector-compare-consent').checked=true;click('inspector-compare');};
 return {get,run,click,file,open,select,inspect,compare,downloads,reads,events};
}
test('open/select alone do not read files; separate local consent is required',async()=>{
 const f=fixture();f.open();f.select();await f.click('inspector-run');assert.equal(f.reads.length,0);assert.equal(f.downloads.length,0);
});
test('one selected file only shows integrity summary, no body, writes or downloads',async()=>{
 const f=fixture();f.open();f.select();await f.inspect();assert.equal(f.reads.length,1);assert.match(f.get('inspector-summary').textContent,/1 条/);
 assert.equal(f.get('inspector-details').hidden,true);assert.equal(f.get('inspector-compare').disabled,true);
 assert.equal(f.get('content').value,'UNSAVED_DRAFT');assert.equal(f.run('pending'),null);assert.equal(f.downloads.length,0);
});
test('two verified files require separate compare consent and explicit detail click',async()=>{
 const f=fixture();f.open();f.select(f.file(),f.file(encoded(envelope([row(1,{content:'<img src=x onerror=bad()> NEW'}),row(2)]))));
 await f.inspect();f.click('inspector-compare');assert.equal(f.run('inspectorReport'),null);
 f.compare();assert.equal(f.get('inspector-differences').children.length,2);assert.equal(f.get('inspector-details').hidden,true);
 const card=f.get('inspector-differences').children[0];card.children.at(-1).handlers.get('click')();
 assert.match(f.get('inspector-detail-right').textContent,/<img src=x/);assert.equal(f.get('inspector-detail-right').children.length,0);
 f.click('inspector-detail-clear');assert.equal(f.get('inspector-details').hidden,true);assert.equal(f.get('inspector-detail-right').textContent,'');
 f.click('inspector-export');assert.equal(f.downloads.length,1);const text=JSON.stringify(f.downloads);
 for(const s of ['<img','UNSAVED_DRAFT','PRIVATE_TOKEN','Synthetic audit fixture'])assert.ok(!text.includes(s));
});
for(const boundary of ['consent','cancel','navigation','session','source','pending','hidden','file'])test('late file read discarded after '+boundary,async()=>{
 const f=fixture();f.open();let release;const file=f.file();file.arrayBuffer=()=>new Promise(r=>release=()=>r(encoded().buffer));f.select(file);
 const work=f.inspect();for(let i=0;i<30&&!release;i++)await tick();assert.ok(release);
 if(boundary==='consent')f.get('inspector-consent').checked=false;
 else if(boundary==='cancel')f.click('inspector-cancel');
 else if(boundary==='navigation')f.run('loadVersion++');
 else if(boundary==='session')f.run("token='OTHER'");else if(boundary==='source')f.run("sourceId='other'");
 else if(boundary==='pending')f.run('pending={input:{}};');
 else if(boundary==='hidden')f.get('workspace').hidden=true;
 else f.get('inspector-left').files=[f.file()];
 release();await work;assert.equal(f.run('inspectorData'),null);assert.equal(f.get('inspector-summary').textContent,'');assert.equal(f.downloads.length,0);
});
test('revocation after module load prevents file reading',async()=>{
 const f=fixture();f.open();f.select();f.run("loadSnapshotContract=async()=>{document.getElementById('inspector-consent').checked=false;return contract;};");
 await f.inspect();assert.equal(f.reads.length,0);
});
test('double click while reading consumes one selection once',async()=>{
 const f=fixture();f.open();f.select();const a=f.inspect(),b=f.inspect();await Promise.all([a,b]);assert.equal(f.reads.length,1);
});
test('invalid second file withholds both summaries and old comparison',async()=>{
 const f=fixture();f.open();f.select(f.file(),f.file(new TextEncoder().encode('{}')));await f.inspect();
 assert.equal(f.run('inspectorData'),null);assert.equal(f.get('inspector-summary').textContent,'');assert.equal(f.get('inspector-details').hidden,true);
});
test('oversized file is rejected before arrayBuffer',async()=>{
 const f=fixture();f.open();const file=f.file();file.size=contract.SNAPSHOT_FILE_MAX_BYTES+1;f.select(file);await f.inspect();assert.equal(f.reads.length,0);
});
test('local native error text is not echoed to the page',async()=>{
 const f=fixture();f.open();const file=f.file();file.arrayBuffer=async()=>{throw Error('SECRET_PATH');};f.select(file);await f.inspect();
 assert.ok(!f.get('message').textContent.includes('SECRET_PATH'));assert.match(f.get('message').textContent,/snapshot_file_read_failed/);
});
test('a failed earlier read cannot erase a later valid inspection',async()=>{
 const f=fixture();f.open();let reject;const file=f.file();file.arrayBuffer=()=>new Promise((_,r)=>reject=r);f.select(file);
 const old=f.inspect();for(let i=0;i<30&&!reject;i++)await tick();assert.ok(reject);
 f.click('inspector-cancel');f.open();f.select();await f.inspect();const summary=f.get('inspector-summary').textContent;
 reject(Error('late error'));await old;assert.equal(f.get('inspector-summary').textContent,summary);assert.notEqual(f.run('inspectorData'),null);
});
for(const boundary of ['consent','file','session','comparison'])test('stale difference card cannot display or export after '+boundary,async()=>{
 const f=fixture();f.open();f.select(f.file(),f.file(encoded(envelope([row(2)]))));await f.inspect();f.compare();
 const card=f.get('inspector-differences').children[0];
 if(boundary==='consent')f.get('inspector-consent').checked=false;
 else if(boundary==='file')f.get('inspector-right').files=[f.file()];else if(boundary==='session')f.run("token='other'");
 else f.get('inspector-compare-consent').checked=false;
 card.children.at(-1).handlers.get('click')();f.click('inspector-export');assert.equal(f.get('inspector-details').hidden,true);assert.equal(f.downloads.length,0);
});
test('diff pagination includes the whole union while rendering twenty at a time',async()=>{
 const f=fixture();f.open();f.select(f.file(encoded(envelope([]))),f.file(encoded(envelope(Array.from({length:23},(_,i)=>row(i))))));
 await f.inspect();f.compare();assert.equal(f.get('inspector-differences').children.length,20);f.click('inspector-next');
 assert.equal(f.get('inspector-differences').children.length,3);assert.equal(f.get('inspector-next').disabled,true);
 f.click('inspector-export');assert.equal(f.downloads[0].value.differences.length,23);
 f.click('inspector-prev');assert.equal(f.get('inspector-differences').children.length,20);
});
test('cross-source comparison fails instead of producing a misleading diff',async()=>{
 const f=fixture();f.open();f.select(f.file(),f.file(encoded(envelope([row()],{source_id:'other'}))));await f.inspect();f.compare();
 assert.equal(f.run('inspectorReport'),null);assert.match(f.get('message').textContent,/来源不同/);
});
test('capture-phase navigation clears verified data and consent without waiting for observers',async()=>{
 const f=fixture();f.open();f.select();await f.inspect();
 for(const handler of f.events.get('click'))handler({target:{closest:()=>true}});
 assert.equal(f.run('inspectorData'),null);assert.equal(f.get('inspector-panel').hidden,true);assert.equal(f.get('inspector-consent').checked,false);
});
