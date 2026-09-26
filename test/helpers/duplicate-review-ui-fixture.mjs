/** Execute production scripts with a synthetic DOM, never a browser/network claim. */
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import * as contract from '../../src/personal-snapshot-contract.mjs';
import {encoded,envelope,row} from './snapshot-audit-fixture.mjs';
export function fixture(override){
 const nodes=new Map(),events=new Map(),reads=[];
 const make=()=>({value:'',checked:false,hidden:false,disabled:false,textContent:'',dataset:{},children:[],handlers:new Map(),
  addEventListener(k,f){this.handlers.set(k,f);},append(...a){this.children.push(...a);},replaceChildren(){this.children=[];},setAttribute(){},focus(){}});
 const get=id=>{if(!nodes.has(id))nodes.set(id,make());return nodes.get(id);};
 const c=override?{...contract,...override}:contract;
 const ctx=vm.createContext({document:{getElementById:get,createElement:make,querySelectorAll:()=>[],
  addEventListener(k,f){events.set(k,[...(events.get(k)??[]),f]);}},window:{addEventListener(){}},
  MutationObserver:class{observe(){}},TextEncoder,TextDecoder,AbortController,AbortSignal,crypto:webcrypto,contract:c,
  fetch:()=>{throw Error('Duplicate review must not send data');}});
 const run=s=>vm.runInContext(s,ctx);
 for(const name of ['app.js','snapshot-ui.js','snapshot-inspector-ui.js','snapshot-explorer-ui.js','snapshot-duplicates-ui.js'])
  run(readFileSync(new URL('../../web/personal/'+name,import.meta.url),'utf8'));
 run("loadSnapshotContract=async()=>contract;download=()=>{throw Error('Unexpected download')};token='synthetic';sourceId='selected';view='lookup';");
 get('workspace').hidden=false;get('content').value='UNSAVED_PRIVATE_DRAFT';
 const click=(id,event='click')=>get(id).handlers.get(event)({preventDefault(){}});
 const file=rows=>{const bytes=encoded(envelope(rows));return {name:'selected.json',size:bytes.length,arrayBuffer:async()=>{reads.push(true);return bytes.slice().buffer;}};};
 const inspect=async(left=[row(1,{content:'PRIVATE_DUPLICATE'}),row(2,{content:'PRIVATE_DUPLICATE'})],right=null)=>{
  click('inspector-open');get('inspector-left').files=[file(left)];get('inspector-right').files=right?[file(right)]:[];
  click('inspector-left','change');get('inspector-consent').checked=true;await click('inspector-run');
 };
 const scan=async()=>{click('duplicates-open');get('duplicates-consent').checked=true;await click('duplicates-run');};
 const group=(i=0)=>get('duplicates-groups').children[i].children.at(-1).handlers.get('click')();
 const show=(i=0)=>get('duplicates-members').children[i].children.at(-1).handlers.get('click')();
 const textConsent=()=>{get('duplicates-text-consent').checked=true;click('duplicates-text-consent','change');};
 const capture=id=>{for(const f of events.get('click')??[])f({target:{closest:selector=>selector.split(',').includes('#'+id)?{}:null}});};
 return {get,run,click,file,inspect,scan,group,show,textConsent,capture,reads,events};
}
export const tick=()=>new Promise(r=>setImmediate(r));
export async function until(predicate){for(let i=0;i<100&&!predicate();i++)await tick();if(!predicate())throw Error('Fixture did not reach checkpoint');}
