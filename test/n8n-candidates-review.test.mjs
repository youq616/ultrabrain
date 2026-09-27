/** Separate implementer review probes; not a separate reviewer agent. */
import test from 'node:test';import assert from 'node:assert/strict';
import vm from 'node:vm';import {readFileSync} from 'node:fs';
import {fixture,page,creds} from './helpers/n8n-candidates-fixture.mjs';
import {executeN8n} from '../src/n8n-executor.mjs';
for(const location of ['outer','array','item'])test('review: protocol accessors fail without evaluation '+location,async()=>{
 let n=0;const f=fixture({response:(req,v)=>{
  const wire={content:[{type:'text',text:JSON.stringify(v)}]};if(req.name==='ultra_personal_candidates'){
   const target=location==='outer'?wire:location==='array'?wire.content:wire.content[0];
   Object.defineProperty(target,location==='outer'?'content':location==='array'?'0':'text',{enumerable:true,get(){n++;throw Error('PRIVATE');}});
  }return wire;
 }});await assert.rejects(f.run(),{code:'personal_candidates_unconfirmed'});assert.equal(n,0);
});
for(const keepGoing of [true,false])test('review: cleanup failure withholds candidate result '+keepGoing,async()=>{
 const f=fixture({keepGoing,phase:op=>{if(op==='close')throw Error('PRIVATE_CLOSE');}});
 if(keepGoing){const r=(await f.run())[0].json;assert.equal(r.error,'candidates_cleanup_failed');assert.equal(r.result,undefined);assert.equal(r.read_delivery,'unconfirmed');}
 else await assert.rejects(f.run(),{code:'candidates_cleanup_failed',read_delivery:'unconfirmed'});
});
test('review: second item cancellation suppresses previously undelivered candidates',async()=>{
 let n=0;const f=fixture({rows:[{},{}],keepGoing:true,phase:(op,c)=>{if(op==='ultra_personal_candidates'&&++n===2)c.abort();}});
 const r=await f.run();assert.equal(r.length,2);assert.ok(r.every(v=>v.json.ok===false&&!v.json.result));
});
test('review: confirmed legacy writes survive candidate cleanup failure',async()=>{
 const f=fixture({rows:[{operation:'after_turn',sessionId:'synthetic',eventId:'stable',transcript:'explicit synthetic text',captureConsent:true,visibility:'private'},{}],credentials:{...creds,allowCapture:true},keepGoing:true});
 const r=await executeN8n(f.context,async()=>({session:async()=>({run:async(op)=>op==='after_turn'?{confirmed:true,delivery:{storage:'journaled'}}:{page:{}}}),close:async()=>{throw Error('private');}}));
 assert.equal(r[0].json.ok,true);assert.equal(r[1].json.error,'candidates_cleanup_failed');
});
for(const kind of ['getter','proxy'])test('review: untrusted connection exceptions sanitized '+kind,async()=>{
 let n=0,error;if(kind==='getter')error={get code(){n++;throw Error('PRIVATE');}};
 else{const p=Proxy.revocable({},{});error=p.proxy;p.revoke();}
 const f=fixture({keepGoing:true,connectError:error}),r=await f.run();assert.equal(n,0);assert.equal(r[0].json.error,'adapter_failed');
 assert.equal(r[0].json.read_delivery,'not_started');
});
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
function node(){const s={module:{exports:{}},require:name=>name==='../../runtime.cjs'?{execute:async()=>[]}:name==='n8n-workflow'?{NodeOperationError:Error}:(()=>{throw Error(name);})()};
 vm.runInNewContext(read('packages/n8n-nodes-ultrabrain/nodes/Ultrabrain/Ultrabrain.node.js'),s);return new s.module.exports.Ultrabrain();}
test('review: node defaults require deliberate scope and consent, and no tool-agent exposure',()=>{
 const n=node(),props=n.description.properties,operation=props.find(p=>p.name==='operation');
 assert.equal(operation.default,'before_turn');assert.equal(operation.noDataExpression,true);assert.equal(n.description.usableAsTool,false);
 assert.equal(operation.options.filter(o=>o.value==='personal_candidates').length,1);
 for(const [name,value]of [['candidateScope',''],['candidateConsent',false],['candidateLimit',20],['candidateAfter','']])assert.equal(props.find(p=>p.name===name).default,value);
 assert.ok(props.find(p=>p.name==='sessionId').displayOptions.hide.operation.includes('personal_candidates'));
});
test('review: candidate project is credential-bound, not a node parameter',()=>{
 assert.ok(!node().description.properties.some(p=>p.name==='candidateProject'));
 assert.ok(read('packages/n8n-nodes-ultrabrain/credentials/UltrabrainApi.credentials.js').includes("name:'candidateProject'"));
});
test('review: new module has exactly one tool and uses canonical page verifier',()=>{
 const s=read('src/automation-candidates.mjs');assert.deepEqual([...s.matchAll(/name:'(ultra_[a-z_]+)'/g)].map(m=>m[1]),['ultra_personal_candidates']);
 assert.ok(s.includes('verifyCandidatePage('));for(const bad of ['executeRaw','PersonalMemoryStore','node:fs','setInterval('])assert.ok(!s.includes(bad));
});

test('review: sample workflow is manual, inactive, credential-free and starts without consent',()=>{
 const w=JSON.parse(read('examples/n8n/personal-candidates.private.json'));
 assert.equal(w.active,false);assert.equal(w.nodes[0].type,'n8n-nodes-base.manualTrigger');
 assert.equal(w.nodes[1].type,'CUSTOM.ultrabrain','Example must match the private loader registration');
 assert.equal(w.nodes[1].parameters.operation,'personal_candidates');assert.equal(w.nodes[1].parameters.candidateConsent,false);
 assert.ok(w.nodes.every(n=>!n.credentials&&!n.retryOnFail));assert.deepEqual(w.pinData,{});
 assert.equal(w.settings.saveDataSuccessExecution,'none');assert.equal(w.settings.saveDataErrorExecution,'none');assert.equal(w.settings.saveManualExecutions,false);
});
test('review: real engine CI follows package install and retains Windows/Linux contracts',()=>{
 const c=read('.github/workflows/n8n-candidates.yml'),p=read('.github/workflows/client-portability.yml');
 assert.ok(c.indexOf('run: bun test/n8n-candidates-integration.mjs --engine')>c.indexOf('npm install --prefix'));
 assert.ok(c.includes('n8n@2.38.7')&&c.includes('n8n-workflow@2.38.1'));
 assert.ok(c.includes('contents: read')&&!c.includes('pull_request_target'));
 assert.ok(p.includes('windows-2025')&&p.includes('ubuntu-24.04'));
 assert.ok(p.includes('test/n8n-candidates.test.mjs test/n8n-candidates-review.test.mjs'));
});
