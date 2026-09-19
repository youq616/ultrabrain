import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const elements=new Map();
function el(id) {if(!elements.has(id))elements.set(id,{value:'',checked:false,dataset:{},textContent:'',hidden:false,addEventListener(){},reset(){},replaceChildren(){},setAttribute(){},append(){}});return elements.get(id);}
const calls=[];let release;
const context=vm.createContext({document:{getElementById:el,querySelectorAll:()=>[]},window:{addEventListener(){}},crypto:{randomUUID:()=> 'test-event'},AbortSignal,fetch:async(_url,opts)=>{const body=JSON.parse(opts.body);calls.push(body.operation);if(body.operation==='register')await new Promise(resolve=>release=resolve);return {ok:true,json:async()=>({ok:true,result:{}})};}});
vm.runInContext(readFileSync('web/personal/app.js','utf8'),context);
vm.runInContext("token='synthetic';$('consent').checked=true;mutate('capture',{agent_id:'personal-console',consent:true,transcript:'consented before wait'});",context);
await new Promise(resolve=>setImmediate(resolve));
el('consent').checked=false;release();
await new Promise(resolve=>setImmediate(resolve));
console.log(JSON.stringify({calls,captureSentAfterRevocation:calls.includes('capture')}));
if(!calls.includes('capture'))throw new Error('Expected baseline regression did not reproduce');
