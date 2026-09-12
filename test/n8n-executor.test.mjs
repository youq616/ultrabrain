import test from 'node:test';
import assert from 'node:assert/strict';
import {executeN8n} from '../src/n8n-executor.mjs';
import {UltraError} from '../src/core.mjs';
const params={operation:'before_turn',sessionId:'s',query:'q',projectId:'',memoryPolicy:'current',summary:'prefer',budgetBytes:16000,includeFacts:false,factEntity:'',timeoutMs:30000};
function context(list=[{}],overrides={}) {
 const inputs=list.map(x=>({json:{...x,secret:'sensitive input'}}));
 return {inputs,getInputData:()=>inputs,getCredentials:async()=>({endpoint:'https://memory.example/mcp',token:'secret',rootUri:'ultra://default/',allowCapture:false}),
  getNodeParameter:(name,index,fallback)=>Object.hasOwn(list[index],name)?list[index][name]:Object.hasOwn(params,name)?params[name]:fallback,
  continueOnFail:()=>false,...overrides};
}
function connector(){let closed=0,opened=0;const seen=[];return {seen,get closed(){return closed;},get opened(){return opened;},async connect(){opened++;return {async session(settings){return {async run(op,p){seen.push({op,p,settings});return {safe:'output'};}};},async close(){closed++;}};}};}
test('all items run once, preserve pairedItem and never mutate or echo original input',async()=>{
 const c=context([{query:'first'},{query:'second'}]),before=JSON.stringify(c.inputs),f=connector();
 const r=await executeN8n(c,f.connect);assert.equal(r.length,2);assert.equal(f.opened,1);assert.equal(f.closed,1);
 assert.deepEqual(r.map(x=>x.pairedItem),[{item:0},{item:1}]);assert.equal(JSON.stringify(c.inputs),before);
 assert.ok(!JSON.stringify(r).includes('sensitive input'));assert.equal(f.seen[1].p.query,'second');
});
test('disabled capture makes no network connection',async()=>{
 const c=context([{operation:'after_turn',eventId:'e',transcript:'PRIVATE',captureConsent:true,visibility:'private'}]),f=connector();
 await assert.rejects(executeN8n(c,f.connect),{code:'capture_disabled',itemIndex:0});assert.equal(f.opened,0);
});
test('per-item consent false cannot be overridden by credential permission',async()=>{
 const c=context([{operation:'after_turn',eventId:'e',transcript:'PRIVATE',captureConsent:false,visibility:'private'}],
  {getCredentials:async()=>({rootUri:'ultra://default/',allowCapture:true})}),f=connector();
 await assert.rejects(executeN8n(c,f.connect),{code:'capture_disabled'});assert.equal(f.opened,0);
});
test('continue-on-fail retains item alignment and safe error only',async()=>{
 const c=context([{operation:'after_turn',eventId:'e',transcript:'PRIVATE',captureConsent:false,visibility:'private'},{query:'second'}],{continueOnFail:()=>true}),f=connector();
 const r=await executeN8n(c,f.connect);assert.equal(r[0].json.error,'capture_disabled');assert.equal(r[1].json.ok,true);
 assert.ok(!JSON.stringify(r).includes('PRIVATE'));assert.ok(!JSON.stringify(r).includes('sensitive input'));
 assert.equal(f.seen.length,1);assert.equal(f.closed,1);
});
test('write response loss reports unconfirmed without retrying internally',async()=>{
 const c=context([{operation:'after_turn',eventId:'e',transcript:'PRIVATE',captureConsent:true,visibility:'private'}],
  {getCredentials:async()=>({rootUri:'ultra://default/',allowCapture:true}),continueOnFail:()=>true});
 let calls=0,closed=0;const r=await executeN8n(c,async()=>({session:async()=>({run:async()=>{calls++;const e=new UltraError('mcp_timeout','token PRIVATE');e.delivery='unconfirmed';throw e;}}),close:async()=>closed++}));
 assert.equal(calls,1);assert.equal(closed,1);assert.equal(r[0].json.delivery,'unconfirmed');assert.ok(!JSON.stringify(r).includes('PRIVATE'));
});
test('cleanup errors do not erase a confirmed result',async()=>{
 const c=context();const r=await executeN8n(c,async()=>({session:async()=>({run:async()=>({confirmed:true})}),close:async()=>{throw new Error('SECRET');}}));
 assert.equal(r[0].json.result.confirmed,true);
});
test('bad credentials are sanitized, and no empty input connection is opened',async()=>{
 const c=context([]),f=connector();assert.deepEqual(await executeN8n(c,f.connect),[]);assert.equal(f.opened,0);
 await assert.rejects(executeN8n(context([{}],{getCredentials:async()=>{throw new Error('token');}}),f.connect),{code:'invalid_credentials'});
});
test('excessively large batches fail before credentials and network',async()=>{
 const c=context(Array.from({length:1001},()=>({}))),f=connector();
 await assert.rejects(executeN8n(c,f.connect),{code:'invalid_params'});assert.equal(f.opened,0);
});
