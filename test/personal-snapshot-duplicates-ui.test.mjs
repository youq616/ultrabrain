/** Production console/inspector/explorer/duplicate panel in a synthetic DOM.
 * File checks use the real shared contract. No HTTP, database or real-browser claim.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import * as contract from '../src/personal-snapshot-contract.mjs';
import {encoded,envelope,row,uuid} from './helpers/snapshot-audit-fixture.mjs';
const code=['app.js','snapshot-ui.js','snapshot-inspector-ui.js','snapshot-explorer-ui.js','snapshot-duplicates-ui.js']
 .map(name=>readFileSync(new URL('../web/personal/'+name,import.meta.url),'utf8')).join('\n');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){
 const nodes=new Map(),events=new Map(),reads=[];
 const make=()=>({value:'',checked:false,hidden:false,disabled:false,textContent:'',dataset:{},children:[],handlers:new Map(),
  addEventListener(k,f){this.handlers.set(k,f);},append(...items){this.children.push(...items);},replaceChildren(...items){this.children=items;},setAttribute(){},focus(){}});
 const get=id=>{if(!nodes.has(id))nodes.set(id,make());return nodes.get(id);};
 const ctx=vm.createContext({document:{getElementById:get,createElement:make,querySelectorAll:()=>[],
  addEventListener(k,f){events.set(k,[...(events.get(k)??[]),f]);}},window:{addEventListener(){}},MutationObserver:class{observe(){}},
  TextEncoder,TextDecoder,AbortSignal,AbortController,crypto:webcrypto,contract,
  fetch:()=>assert.fail('Local review must not use the API')});
 const run=text=>vm.runInContext(text,ctx);run(code);
 run("loadSnapshotContract=async()=>contract;download=()=>{throw Error('Unexpected download')};token='TEST_TOKEN';sourceId='selected';view='lookup';");
 get('workspace').hidden=false;get('content').value='UNSAVED_DRAFT';
 const click=(id,event='click')=>get(id).handlers.get(event)({preventDefault(){}});
 const file=rows=>{const bytes=encoded(envelope(rows));return {name:'synthetic.json',size:bytes.byteLength,
  arrayBuffer:async()=>{reads.push(true);return bytes.slice().buffer;}};};
 const inspect=async(left=pair(),right=null)=>{
  click('inspector-open');get('inspector-left').files=[file(left)];get('inspector-right').files=right?[file(right)]:[];
  click('inspector-left','change');get('inspector-consent').checked=true;await click('inspector-run');
  assert.notEqual(run('inspectorData'),null);click('duplicates-open');
 };
 const scan=async()=>{get('duplicates-consent').checked=true;await click('duplicates-run');};
 const group=(i=0)=>get('duplicates-groups').children[i].children.at(-1).handlers.get('click')();
 const pick=(index,slot)=>get('duplicates-members').children[index].children.at(slot==='a'?-2:-1).handlers.get('click')();
 const compare=()=>{get('duplicates-detail-consent').checked=true;return click('duplicates-compare');};
 return {get,run,click,file,inspect,scan,group,pick,compare,reads,events};
}
const pair=()=>[row(1,{content:'PRIVATE_EXACT_BODY',provenance:'PRIVATE_ORIGIN'}),
 row(2,{content:'PRIVATE_EXACT_BODY',provenance:'OTHER_PRIVATE_ORIGIN',project_id:'elsewhere',status:'archived'})];
const groups=n=>Array.from({length:n*2},(_,i)=>row(i+1,{content:'PRIVATE_GROUP_'+Math.floor(i/2)}));
test('duplicates panel: no unverified access, no scan on open and no default consent',async()=>{
 const f=fixture();f.click('duplicates-open');assert.equal(f.get('duplicates-panel').hidden,true);
 await f.inspect();assert.equal(f.run('duplicateReport'),null);assert.equal(f.get('duplicates-run').disabled,true);
 assert.equal(f.get('duplicates-consent').checked,false);await f.click('duplicates-run');assert.equal(f.get('duplicates-groups').children.length,0);
});
test('duplicates panel: shared exact auditor, metadata default, preserved draft and no reread',async()=>{
 const f=fixture();await f.inspect();await f.scan();assert.equal(f.run('duplicateReport.counts.groups'),1);
 assert.equal(f.get('duplicates-groups').children.length,1);assert.equal(f.reads.length,1);
 assert.equal(f.get('content').value,'UNSAVED_DRAFT');assert.equal(f.run('pending'),null);
 assert.ok(!JSON.stringify(f.get('duplicates-groups').children).includes('PRIVATE_EXACT_BODY'));
 assert.equal(f.get('duplicates-detail').hidden,true);assert.match(f.get('duplicates-summary').textContent,/不是可删除/);
});
test('duplicates panel: group and member pages are bounded and exhaustive',async()=>{
 const f=fixture();await f.inspect(groups(23));await f.scan();
 assert.equal(f.get('duplicates-groups').children.length,10);assert.equal(f.get('duplicates-group-prev').disabled,true);
 f.click('duplicates-group-next');assert.equal(f.get('duplicates-groups').children.length,10);
 f.click('duplicates-group-next');assert.equal(f.get('duplicates-groups').children.length,3);assert.equal(f.get('duplicates-group-next').disabled,true);
 f.click('duplicates-group-prev');f.group();assert.match(f.get('duplicates-members').children[0].textContent+JSON.stringify(f.get('duplicates-members').children[0]),new RegExp(uuid(21)));
 await f.inspect(Array.from({length:1000},(_,i)=>row(i+1,{content:'same'})));await f.scan();f.group();
 assert.equal(f.get('duplicates-members').children.length,20);let seen=20;
 while(!f.get('duplicates-member-next').disabled){f.click('duplicates-member-next');seen+=f.get('duplicates-members').children.length;}
 assert.equal(seen,1000);f.click('duplicates-member-prev');assert.equal(f.get('duplicates-members').children.length,20);
});
test('duplicates panel: A/B selection across pages and explicit literal full-record comparison',async()=>{
 const rows=Array.from({length:22},(_,i)=>row(i+1,{content:'<img src=x onerror="alert(1)">PRIVATE_BODY',project_id:i===21?'other':null}));
 const f=fixture();await f.inspect(rows);await f.scan();f.group();f.pick(0,'a');
 f.click('duplicates-member-next');f.pick(1,'b');f.click('duplicates-compare');assert.equal(f.get('duplicates-detail').hidden,true);
 f.compare();assert.equal(f.get('duplicates-detail').hidden,false);
 assert.deepEqual(JSON.parse(f.get('duplicates-detail-a').textContent),rows[0]);assert.deepEqual(JSON.parse(f.get('duplicates-detail-b').textContent),rows[21]);
 assert.equal(f.reads.length,1);assert.equal(f.get('content').value,'UNSAVED_DRAFT');
});
test('duplicates panel: the same record cannot be compared against itself',async()=>{
 const f=fixture();await f.inspect();await f.scan();f.group();f.pick(0,'a');f.pick(0,'b');f.compare();
 assert.equal(f.get('duplicates-detail').hidden,true);assert.equal(f.get('duplicates-detail-a').textContent,'');
});
for(const boundary of ['consent','detail-consent','side','group-page','member-page','inspector-consent','file','inspector-close','close'])
 test('duplicates panel: private comparison cleared on '+boundary,async()=>{
  const f=fixture();await f.inspect(groups(12),pair());await f.scan();f.group();f.pick(0,'a');f.pick(1,'b');f.compare();
  assert.notEqual(f.get('duplicates-detail-a').textContent,'');
  if(boundary==='consent'){f.get('duplicates-consent').checked=false;f.click('duplicates-consent','change');}
  else if(boundary==='detail-consent'){f.get('duplicates-detail-consent').checked=false;f.click('duplicates-detail-consent','change');}
  else if(boundary==='side'){f.get('duplicates-side').value='right';f.click('duplicates-side','change');}
  else if(boundary==='group-page')f.click('duplicates-group-next');
  else if(boundary==='member-page') {f.click('duplicates-member-next');f.click('duplicates-detail-clear');}
  else if(boundary==='inspector-consent'){f.get('inspector-consent').checked=false;f.click('inspector-consent','change');}
  else if(boundary==='file')f.click('inspector-left','change');
  else if(boundary==='inspector-close')f.click('inspector-cancel');
  else f.click('duplicates-close');
  assert.equal(f.get('duplicates-detail-a').textContent,'');assert.equal(f.get('duplicates-detail-b').textContent,'');
 });
for(const boundary of ['token','source','navigation','view','busy','pending','hidden','side'])
 test('duplicates panel: per-action guard refuses silent '+boundary+' change',async()=>{
  const f=fixture();await f.inspect(pair(),pair());await f.scan();f.group();f.pick(0,'a');f.pick(1,'b');
  if(boundary==='token')f.run("token='other'");else if(boundary==='source')f.run("sourceId='other'");
  else if(boundary==='navigation')f.run('loadVersion++');else if(boundary==='view')f.run("view='active'");
  else if(boundary==='busy')f.run('busy=true');else if(boundary==='pending')f.run('pending={}');
  else if(boundary==='hidden')f.get('workspace').hidden=true;else f.get('duplicates-side').value='right';
  f.compare();assert.equal(f.get('duplicates-detail-a').textContent,'');assert.equal(f.run('duplicateReport'),null);
 });
for(const boundary of ['close','consent','file','side','navigation'])test('duplicates panel: pending scan fenced on '+boundary,async()=>{
 const f=fixture();await f.inspect(pair(),pair());
 f.run('let releaseScan;const originalAudit=inspectorData.contract.inspectMemorySnapshotDuplicates;inspectorData.contract={...inspectorData.contract,inspectMemorySnapshotDuplicates:async(...args)=>{await new Promise(r=>releaseScan=r);return originalAudit(...args)}}');
 const work=f.scan();await tick();assert.equal(f.run('duplicateWorking'),true);
 if(boundary==='close')f.click('duplicates-close');else if(boundary==='consent'){f.get('duplicates-consent').checked=false;f.click('duplicates-consent','change');}
 else if(boundary==='file')f.click('inspector-left','change');else if(boundary==='side'){f.get('duplicates-side').value='right';f.click('duplicates-side','change');}
 else f.run('loadVersion++');
 f.run('releaseScan()');await work;assert.equal(f.run('duplicateReport'),null);assert.equal(f.get('duplicates-groups').children.length,0);
});
test('duplicates panel: double scan has one operation and a stale failure cannot erase a new result',async()=>{
 const f=fixture();await f.inspect();f.run('let rejectOld,scanCalls=0;const originalAudit=inspectorData.contract.inspectMemorySnapshotDuplicates;inspectorData.contract={...inspectorData.contract,inspectMemorySnapshotDuplicates:async(...args)=>{scanCalls++;if(scanCalls===1)await new Promise((_,r)=>rejectOld=r);return originalAudit(...args)}}');
 const old=f.scan();await tick();await f.scan();assert.equal(f.run('scanCalls'),1);
 f.click('duplicates-close');f.click('duplicates-open');await f.scan();assert.equal(f.run('duplicateReport.counts.groups'),1);
 f.run("rejectOld(Error('PRIVATE_FAILURE'))");await old;assert.equal(f.run('duplicateReport.counts.groups'),1);
 assert.ok(!f.get('message').textContent.includes('PRIVATE_FAILURE'));
});
test('duplicates panel: old group and member closures cannot act after pagination/re-scan',async()=>{
 const f=fixture();await f.inspect(groups(12));await f.scan();
 const staleGroup=f.get('duplicates-groups').children[0].children.at(-1).handlers.get('click');
 f.click('duplicates-group-next');staleGroup();assert.equal(f.get('duplicates-members').children.length,0);
 await f.scan();f.group();const stale=f.get('duplicates-members').children[0].children.at(-2).handlers.get('click');
 await f.scan();stale();assert.equal(f.get('duplicates-a-id').textContent,'');
});
test('duplicates panel: legitimate all-zero report differs from failure',async()=>{
 const f=fixture();await f.inspect([]);await f.scan();assert.equal(f.run('duplicateReport.scanned_records'),0);
 assert.match(f.get('duplicates-summary').textContent,/0/);assert.equal(f.get('duplicates-group-next').disabled,true);
 f.run("inspectorData.contract={...inspectorData.contract,inspectMemorySnapshotDuplicates:async()=>{throw Error('PRIVATE_FAIL')}}");
 await f.scan();assert.equal(f.run('duplicateReport'),null);assert.match(f.get('duplicates-summary').textContent,/未完成/);
 assert.ok(!f.get('message').textContent.includes('PRIVATE_FAIL'));
});
test('duplicates panel: alternate right file is isolated and requires fresh consent',async()=>{
 const f=fixture();await f.inspect(pair(),groups(3));await f.scan();assert.equal(f.run('duplicateReport.counts.groups'),1);
 f.get('duplicates-side').value='right';f.click('duplicates-side','change');assert.equal(f.get('duplicates-consent').checked,false);
 await f.scan();assert.equal(f.run('duplicateReport.counts.groups'),3);
});
test('duplicates panel: inspector and existing explorer still clear each other synchronously',async()=>{
 const f=fixture();await f.inspect();f.click('explorer-open');f.get('explorer-consent').checked=true;f.click('explorer-run');
 f.get('explorer-results').children[0].children.at(-1).handlers.get('click')();assert.notEqual(f.get('explorer-detail-text').textContent,'');
 f.click('duplicates-open');assert.equal(f.get('explorer-detail-text').textContent,'');await f.scan();
 for(const fn of f.events.get('click'))fn({target:{closest:selector=>selector.includes('#explorer-open')?{}:null}});
 assert.equal(f.run('duplicateReport'),null);assert.equal(f.get('duplicates-panel').hidden,true);
});

test('duplicates panel: selecting a second group on the same page does not invalidate valid group controls',async()=>{
 const f=fixture();await f.inspect(groups(3));await f.scan();f.group(0);f.pick(0,'a');f.group(1);
 assert.notEqual(f.run('duplicateReport'),null);assert.equal(f.run('duplicateGroup.members[0].id'),uuid(3));
 assert.equal(f.get('duplicates-a-id').textContent,'');assert.equal(f.get('duplicates-members').children.length,2);
 f.group(2);assert.equal(f.run('duplicateGroup.members[0].id'),uuid(5));
});
test('duplicates panel: actual member paging revokes visible body and disclosure consent, retains choices',async()=>{
 const f=fixture();await f.inspect(Array.from({length:45},(_,i)=>row(i+1,{content:'same'})));await f.scan();f.group();
 f.pick(0,'a');f.pick(1,'b');f.compare();f.click('duplicates-member-next');
 assert.equal(f.get('duplicates-detail-a').textContent,'');assert.equal(f.get('duplicates-detail-consent').checked,false);
 assert.equal(f.run('duplicateA'),uuid(1));assert.equal(f.run('duplicateB'),uuid(2));
});
