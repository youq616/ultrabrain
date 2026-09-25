/** Execute the production n8n node wrapper with a labelled runtime/platform double. */
import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';import vm from 'node:vm';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
function nodeWith(execute=async()=>[]){
 const sandbox={module:{exports:{}},require:name=>{
  if(name==='../../runtime.cjs')return {execute};
  if(name==='n8n-workflow')return {NodeOperationError:class extends Error{constructor(node,message,options){super(message);this.options=options;}}};
  throw Error('Unexpected node dependency');
 }};vm.runInNewContext(read('packages/n8n-nodes-ultrabrain/nodes/Ultrabrain/Ultrabrain.node.js'),sandbox);
 return new sandbox.module.exports.Ultrabrain();
}
test('overview option is additive and cannot be selected by item expression',()=>{
 const node=nodeWith(),p=node.description.properties,op=p.find(x=>x.name==='operation');
 assert.equal(op.noDataExpression,true);assert.equal(op.default,'before_turn');
 assert.deepEqual(Array.from(op.options,x=>x.value),['identity','personal_overview','before_turn','after_turn','session_status','resume_project']);
 assert.equal(p.find(x=>x.name==='overviewConsent').default,false);assert.equal(p.find(x=>x.name==='overviewScope').default,'');
 assert.ok(p.find(x=>x.name==='sessionId').displayOptions.hide.operation.includes('personal_overview'));
 assert.equal(node.description.usableAsTool,false);
});
test('node returns n8n main-output array without changing paired items',async()=>{
 const output=[{json:{ok:true},pairedItem:{item:3}}];const n=nodeWith(async()=>output);
 assert.equal((await n.execute())[0],output);
});
test('read failure is projected as read delivery, not an uncertain capture',async()=>{
 const n=nodeWith(async()=>{throw Object.assign(Error('PRIVATE_SERVER_BODY'),{code:'personal_overview_unconfirmed',read_delivery:'unconfirmed',memory_writes_requested:false,itemIndex:2});});
 await assert.rejects(n.execute.call({getNode:()=>({})}),e=>e.message==='Ultrabrain: personal_overview_unconfirmed; read_delivery=unconfirmed; memory_writes_requested=false'&&e.options.itemIndex===2);
});
test('legacy write failure preserves its existing delivery semantics',async()=>{
 const n=nodeWith(async()=>{throw Object.assign(Error('PRIVATE_SERVER_BODY'),{code:'unconfirmed_capture',delivery:'unconfirmed'});});
 await assert.rejects(n.execute.call({getNode:()=>({})}),{message:'Ultrabrain: unconfirmed_capture; delivery=unconfirmed'});
});
test('example is manual, inactive, credential-free, unconsented and has no stored execution data',()=>{
 const w=JSON.parse(read('examples/n8n/personal-overview.private.json'));
 assert.equal(w.active,false);assert.equal(w.settings.saveDataSuccessExecution,'none');assert.equal(w.settings.saveDataErrorExecution,'none');assert.equal(w.settings.saveManualExecutions,false);
 assert.equal(w.nodes.length,2);assert.equal(w.nodes[0].type,'n8n-nodes-base.manualTrigger');assert.ok(w.nodes.every(n=>!n.credentials&&!n.retryOnFail));
 const params=w.nodes[1].parameters;assert.equal(params.operation,'personal_overview');assert.equal(params.overviewConsent,false);assert.equal(params.overviewScope,'owned-all-projects');
 assert.deepEqual(w.pinData,{});
});
test('overview shares canonical response validation without filesystem-bound client code',()=>{
 const source=read('src/automation-overview.mjs');assert.ok(source.includes("from './personal-overview-contract.mjs'"));
 for(const forbidden of ['node:fs','client-overview.mjs','executeRaw','PersonalMemoryStore','configuredPersonalModel'])assert.ok(!source.includes(forbidden));
 assert.deepEqual([...source.matchAll(/name:'(ultra_[a-z_]+)'/g)].map(m=>m[1]),['ultra_personal_overview']);
});
