/** Implementation assistant's separate review probes, not another agent's approval. */
import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFileSync} from 'node:fs';
import {fixture,envelope,uuid} from './helpers/n8n-memory-inspect-fixture.mjs';
import {clientLineageRecord} from '../src/client-lineage.mjs';
import {verifyPersonalMemoryRead} from '../src/personal-memory-read-contract.mjs';
import {executeN8n} from '../src/n8n-executor.mjs';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
for(const location of ['outer','array','item'])test('inspect review: poisoned wire accessor never executed '+location,async()=>{
 let n=0;const f=fixture({reply:(req,v)=>{
  const wire={content:[{type:'text',text:JSON.stringify(v)}]};if(req.name==='ultra_memory_read'){
   const target=location==='outer'?wire:location==='array'?wire.content:wire.content[0];
   Object.defineProperty(target,location==='outer'?'content':location==='array'?'0':'text',{enumerable:true,get(){n++;throw Error('PRIVATE');}});
  }return wire;
 }});await assert.rejects(f.run(),{code:'memory_inspect_unconfirmed'});assert.equal(n,0);
});
for(const keepGoing of [false,true])test('inspect review: cleanup failure withholds even explicitly requested full text '+keepGoing,async()=>{
 const f=fixture({items:[{inspectIncludeText:true}],keepGoing,phase:name=>{if(name==='close')throw Error('PRIVATE_CLOSE');}});
 if(keepGoing){const r=(await f.run())[0].json;assert.equal(r.error,'memory_inspect_cleanup_failed');assert.equal(r.read_delivery,'unconfirmed');assert.equal(r.result,undefined);}
 else await assert.rejects(f.run(),{code:'memory_inspect_cleanup_failed',read_delivery:'unconfirmed'});
});
test('inspect review: later cancellation removes earlier undelivered text results',async()=>{
 let n=0;const f=fixture({items:[{inspectIncludeText:true},{}],keepGoing:true,phase:(name,c)=>{if(name==='ultra_memory_read'&&++n===2)c.abort();}});
 const r=await f.run();assert.equal(r.length,2);assert.ok(r.every(v=>v.json.ok===false&&!v.json.result));assert.ok(!JSON.stringify(r).includes('PRIVATE_BODY'));
});
test('inspect review: derived record does not trigger a source read, reference only explicitly output',async()=>{
 const derivation={job_id:uuid(20),input_id:uuid(2),input_revision:1,input_hash:'b'.repeat(64),profile_hash:'c'.repeat(64),quote:'PRIVATE',start:0,end:7,offset_unit:'UTF-16 code units'};
 for(const text of [false,true]){
  const f=fixture({items:[{inspectIncludeText:text}],reply:(q,v)=>({content:[{type:'text',text:JSON.stringify(q.name==='ultra_memory_read'?envelope({derivation,derivation_current:false}):v)}]})});
  const result=(await f.run())[0].json.result;assert.equal(f.calls.filter(c=>c.name==='ultra_memory_read').length,1);
  assert.equal(result.memory.derivation_current,false);if(text)assert.deepEqual(result.text.derivation,derivation);else assert.ok(!JSON.stringify(result).includes('PRIVATE'));
 }
});
test('inspect review: confirmed old writes are not erased by inspection cleanup failure',async()=>{
 const f=fixture({keepGoing:true,creds:{rootUri:'ultra://selected/',allowCapture:true,expectedInstance:uuid(99),expectedActor:'a'.repeat(64)},
 items:[{operation:'after_turn',sessionId:'fixed',eventId:'fixed',transcript:'explicit',captureConsent:true,visibility:'private'},{}]});
 const out=await executeN8n(f.context,async()=>({session:async()=>({run:async(op)=>op==='after_turn'?{confirmed:true}:{text:{content:'PRIVATE'}}}),close:async()=>{throw Error('PRIVATE');}}));
 assert.equal(out[0].json.ok,true);assert.equal(out[0].json.result.confirmed,true);assert.equal(out[1].json.error,'memory_inspect_cleanup_failed');
});
for(const type of ['getter','proxy'])test('inspect review: hostile connection errors sanitized '+type,async()=>{
 let n=0,e;if(type==='getter')e={get code(){n++;throw Error('PRIVATE');}};else{const p=Proxy.revocable({},{});e=p.proxy;p.revoke();}
 const f=fixture({keepGoing:true,connectError:e}),r=(await f.run())[0].json;assert.equal(n,0);assert.equal(r.error,'adapter_failed');assert.equal(r.result,undefined);
});
test('inspect review: canonical function is identical across clients and n8n',()=>{
 assert.equal(clientLineageRecord,verifyPersonalMemoryRead);
 const s=read('src/personal-memory-read-contract.mjs');assert.ok(!s.includes('node:fs')&&!s.includes('matchingWorkspace'));
 assert.ok(read('src/automation-memory-inspect.mjs').includes('verifyPersonalMemoryRead('));
 assert.deepEqual([...read('src/automation-memory-inspect.mjs').matchAll(/name:'(ultra_[a-z_]+)'/g)].map(m=>m[1]),['ultra_memory_read']);
});
function node(){const sandbox={module:{exports:{}},require:name=>name==='../../runtime.cjs'?{execute:async()=>[]}:name==='n8n-workflow'?{NodeOperationError:Error}:(()=>{throw Error(name);})()};
 vm.runInNewContext(read('packages/n8n-nodes-ultrabrain/nodes/Ultrabrain/Ultrabrain.node.js'),sandbox);return new sandbox.module.exports.Ultrabrain();}
test('inspect review: full record transfer is explicit, source-following and tool exposure disabled',()=>{
 const n=node(),props=n.description.properties;assert.equal(n.description.usableAsTool,false);
 for(const [name,value]of [['inspectMemoryId',''],['inspectScope',''],['inspectConsent',false],['inspectIncludeText',false]])assert.equal(props.find(p=>p.name===name).default,value);
 assert.ok(props.find(p=>p.name==='inspectConsent').description.includes('full selected record'));
 assert.ok(!props.some(p=>p.name==='inspectProject'));assert.ok(props.find(p=>p.name==='sessionId').displayOptions.hide.operation.includes('personal_inspect'));
});
test('inspect review: manual example contains no credential, approval, data or automatic trigger',()=>{
 const w=JSON.parse(read('examples/n8n/personal-inspect.private.json'));assert.equal(w.active,false);assert.equal(w.nodes[0].type,'n8n-nodes-base.manualTrigger');
 assert.equal(w.nodes[1].type,'CUSTOM.ultrabrain');assert.equal(w.nodes[1].parameters.inspectConsent,false);assert.equal(w.nodes[1].parameters.inspectIncludeText,false);
 assert.ok(w.nodes.every(n=>!n.credentials&&!n.retryOnFail));assert.deepEqual(w.pinData,{});assert.equal(w.settings.saveManualExecutions,false);
});
test('inspect review: CI installs exact local package before actual engine inspection',()=>{
 const workflow=read('.github/workflows/n8n-memory-inspect.yml');assert.ok(workflow.includes('n8n@2.38.7')&&workflow.includes('n8n-workflow@2.38.1'));
 assert.ok(workflow.indexOf('--engine --inspect')>workflow.indexOf('npm install --prefix'));assert.ok(workflow.includes('contents: read'));
 const portable=read('.github/workflows/client-portability.yml');assert.ok(portable.includes('test/n8n-memory-inspect.test.mjs test/n8n-memory-inspect-review.test.mjs'));
});
