/** Production scripts + canonical verifier with an explicitly synthetic DOM.
 * No browser/network assertion: the separate Chromium fixture covers those.
 */
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import * as contract from '../../src/personal-snapshot-contract.mjs';
import {encoded,envelope,row} from './snapshot-audit-fixture.mjs';
export const pair=(n=1,content='PRIVATE_BODY',extra={})=>[row(n,{content}),row(n+1,{content,...extra})];
export function fixture(override={}){
 const nodes=new Map(),events=new Map(),reads=[],observers=[];
 const make=()=>({value:'',checked:false,hidden:false,disabled:false,textContent:'',dataset:{},children:[],handlers:new Map(),
  addEventListener(k,f){this.handlers.set(k,f);},append(...items){this.children.push(...items);},replaceChildren(){this.children=[];},setAttribute(){},focus(){}});
 const get=id=>{if(!nodes.has(id))nodes.set(id,make());return nodes.get(id);};
 const ctx=vm.createContext({document:{getElementById:get,createElement:make,querySelectorAll:()=>[],
  addEventListener(k,f){events.set(k,[...(events.get(k)??[]),f]);}},window:{addEventListener(){}},
  MutationObserver:class{constructor(fn){observers.push(fn);}observe(){}},
  TextEncoder,TextDecoder,AbortController,AbortSignal,crypto:webcrypto,contract:{...contract,...override},
  fetch:()=>{throw Error('Unexpected data request');}});
 const run=s=>vm.runInContext(s,ctx);
 for(const name of ['app.js','snapshot-ui.js','snapshot-inspector-ui.js','snapshot-explorer-ui.js',
  'snapshot-duplicates-ui.js','snapshot-duplicate-compare-ui.js'])
  run(readFileSync(new URL('../../web/personal/'+name,import.meta.url),'utf8'));
 run("loadSnapshotContract=async()=>contract;download=()=>{throw Error('Unexpected download')};token='synthetic';sourceId='selected';view='lookup';");
 get('workspace').hidden=false;get('content').value='UNSAVED_PRIVATE_DRAFT';
 const capture=id=>{for(const f of events.get('click')??[])f({target:{closest:selector=>selector.split(',').includes('#'+id)?{}:null}});};
 const click=(id,event='click')=>{if(event==='click')capture(id);return get(id).handlers.get(event)({preventDefault(){}});};
 const file=(rows,patch={})=>{const bytes=encoded(envelope(rows,patch));return {name:'selected.json',size:bytes.length,
  arrayBuffer:async()=>{reads.push(true);return bytes.slice().buffer;}};};
 const inspect=async(left=pair(),right=pair(),lmeta={},rmeta={})=>{
  click('inspector-open');get('inspector-left').files=[file(left,lmeta)];get('inspector-right').files=right===null?[]:[file(right,rmeta)];
  click('inspector-left','change');get('inspector-consent').checked=true;await click('inspector-run');
 };
 const scan=async()=>{click('dupcmp-open');get('dupcmp-consent').checked=true;await click('dupcmp-run');};
 const group=(i=0)=>get('dupcmp-groups').children[i].children.at(-1).handlers.get('click')();
 const filter=kind=>{get('dupcmp-kind').value=kind;click('dupcmp-kind','change');};
 const text=node=>node.textContent+' '+node.children.map(text).join(' ');
 const mutate=id=>{for(const fn of observers)fn([{target:get(id)}]);};
 return {get,run,click,capture,file,inspect,scan,group,filter,reads,text,mutate};
}
export const tick=()=>new Promise(r=>setImmediate(r));
export async function until(fn){for(let i=0;i<100&&!fn();i++)await tick();if(!fn())throw Error('Missing test checkpoint');}
