/** Independent test cases written in a separate implementer pass, NOT a reviewer-agent verdict. */
import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFileSync} from 'node:fs';
import {fixture,wire,credentials,request} from './helpers/n8n-memory-review-fixture.mjs';
import {automationMemoryReviewRequest,automationMemoryReviewFailure} from '../src/automation-memory-review.mjs';
import {automationSettings} from '../src/automation-session.mjs';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
for(const location of ['outer','array','item'])test('audit: poisoned write-response descriptor is never executed '+location,async()=>{
 let n=0;const f=fixture({reply:(q,v)=>{const w=wire(v);if(q.name==='ultra_personal_review'){
  const target=location==='outer'?w:location==='array'?w.content:w.content[0];
  Object.defineProperty(target,location==='outer'?'content':location==='array'?'0':'text',{enumerable:true,get(){n++;throw Error('PRIVATE');}});
 }return w;}});await assert.rejects(f.run(),{code:'memory_review_receipt_unconfirmed',write_delivery:'unconfirmed'});assert.equal(n,0);
});
for(const kind of ['extra-channel','duplicate-key','oversized','isError','missing'])test('audit: invalid write envelope '+kind,async()=>{
 const f=fixture({reply:(q,v)=>{let w=wire(v);if(q.name==='ultra_personal_review'){
  if(kind==='extra-channel')w._meta={private:'PRIVATE'};
  if(kind==='duplicate-key')w.content[0].text=w.content[0].text.replace('"revision":2','"revision":7,"revi\\u0073ion":2');
  if(kind==='oversized')w.content[0].text='x'.repeat(8193);
  if(kind==='isError')w.isError='false';if(kind==='missing')w.content=[];
 }return w;}});await assert.rejects(f.run(),{code:'memory_review_receipt_unconfirmed',write_delivery:'unconfirmed'});
});
for(const keepGoing of [false,true])test('audit: cleanup failure cannot undo acknowledgement or expose withheld receipt '+keepGoing,async()=>{
 const f=fixture({keepGoing,phase:op=>{if(op==='close')throw Error('PRIVATE_CLOSE');}});
 if(keepGoing){const r=(await f.run())[0].json;assert.equal(r.write_delivery,'confirmed');assert.equal(r.error,'memory_review_cleanup_failed');assert.equal(r.result,undefined);}
 else await assert.rejects(f.run(),{code:'memory_review_cleanup_failed',write_delivery:'confirmed'});
});
test('audit: pre-write identity cancellation does not send the write',async()=>{
 let n=0;const f=fixture({phase:(op,c)=>{if(op==='ultra_identity'&&++n===3)c.abort();}});
 await assert.rejects(f.run(),{code:'cancelled',write_delivery:'not_started'});assert.equal(f.calls.filter(c=>c.name==='ultra_personal_review').length,0);
});
test('audit: dropping acknowledgement stays unconfirmed and no automatic retry occurs',async()=>{
 const f=fixture({phase:op=>{if(op==='ultra_personal_review')throw Error('PRIVATE_LOST');},keepGoing:true});
 const r=(await f.run())[0].json;assert.equal(r.write_delivery,'unconfirmed');assert.equal(r.write_attempts,1);assert.equal(r.result,undefined);
 assert.equal(f.calls.filter(c=>c.name==='ultra_personal_review').length,1);
});
for(const key of ['consent','expected_revision','action'])test('audit: request accessors do not execute '+key,()=>{
 let n=0;const r=request();Object.defineProperty(r,key,{enumerable:true,get(){n++;return true;}});
 assert.throws(()=>automationMemoryReviewRequest(r,automationSettings(credentials)));assert.equal(n,0);
});
for(const kind of ['getter','proxy'])test('audit: connection errors cannot forge outcomes '+kind,async()=>{
 let n=0,e;if(kind==='getter')e={get code(){n++;throw Error('PRIVATE');},write_delivery:'confirmed'};
 else{const p=Proxy.revocable({},{});e=p.proxy;p.revoke();}
 const f=fixture({connectError:e,keepGoing:true}),r=(await f.run())[0].json;assert.equal(n,0);assert.equal(r.write_delivery,'not_started');assert.equal(r.error,'memory_review_unconfirmed');
});
function node(execute=async()=>[]){const box={module:{exports:{}},require:k=>k==='../../runtime.cjs'?{execute}:k==='n8n-workflow'?{
 NodeOperationError:class extends Error{constructor(_,m,o){super(m);this.options=o;}}}:(()=>{throw Error(k)})()};
 vm.runInNewContext(read('packages/n8n-nodes-ultrabrain/nodes/Ultrabrain/Ultrabrain.node.js'),box);return new box.module.exports.Ultrabrain();}
test('audit: node defaults cannot execute an unselected or unconsented action',()=>{
 const n=node(),p=n.description.properties;assert.equal(n.description.usableAsTool,false);
 for(const k of ['reviewMode','reviewAction','reviewMemoryId','reviewScope','reviewEventId','reviewExpectedHash','reviewExpectedStatus','reviewExpectedVisibility'])assert.equal(p.find(x=>x.name===k).default,'');
 for(const k of ['reviewConsent','reviewAcknowledgeEffects','reviewSharedConsent']){assert.equal(p.find(x=>x.name===k).default,false);assert.equal(p.find(x=>x.name===k).noDataExpression,true);}
 assert.equal(p.find(x=>x.name==='reviewExpectedRevision').default,0);assert.ok(!p.some(x=>x.name==='reviewProject'));
});
test('audit: NodeOperationError reports confirmed write fact on withheld result',async()=>{
 const n=node(async()=>{throw Object.assign(Error('PRIVATE'),{code:'memory_review_cleanup_failed',write_delivery:'confirmed',memory_writes_requested:true,itemIndex:0});});
 await assert.rejects(n.execute.call({getNode:()=>({})}),{message:'Ultrabrain: memory_review_cleanup_failed; write_delivery=confirmed; memory_writes_requested=true'});
});
test('audit: example is manual, disabled and has no data, credentials or automatic retry',()=>{
 const w=JSON.parse(read('examples/n8n/personal-review.private.json'));assert.equal(w.active,false);assert.equal(w.nodes[0].type,'n8n-nodes-base.manualTrigger');
 assert.equal(w.nodes[1].type,'CUSTOM.ultrabrain');assert.equal(w.nodes[1].parameters.reviewConsent,false);assert.equal(w.nodes[1].parameters.reviewAction,'');
 assert.ok(w.nodes.every(n=>!n.credentials&&!n.retryOnFail));assert.deepEqual(w.pinData,{});assert.equal(w.settings.saveManualExecutions,false);
});
test('audit: trusted action grants are separate and default off',()=>{
 const box={module:{exports:{}}};vm.runInNewContext(read('packages/n8n-nodes-ultrabrain/credentials/UltrabrainApi.credentials.js'),box);
 const props=new box.module.exports.UltrabrainApi().properties;
 for(const k of ['allowMemoryActivation','allowMemoryArchive','allowSourceActivation'])assert.equal(props.find(p=>p.name===k).default,false);
 assert.equal(props.find(p=>p.name==='reviewProject').default,'');
});

test('audit: real engine CI installs local package and retains original cross-platform suites',()=>{
 const workflow=read('.github/workflows/n8n-memory-review.yml');assert.ok(workflow.includes('n8n@2.38.7')&&workflow.includes('n8n-workflow@2.38.1'));
 assert.ok(workflow.indexOf('run: bun test/n8n-memory-review-integration.mjs --engine')>workflow.indexOf('npm install --prefix'));
 assert.ok(workflow.includes('contents: read')&&!workflow.includes('pull_request_target'));
 const p=read('.github/workflows/client-portability.yml');assert.ok(p.includes('test/capture-profile-binding.test.mjs'));
 assert.ok(p.includes('windows-2025')&&p.includes('ubuntu-24.04')&&p.includes('test/n8n-memory-review-audit.test.mjs'));
});

test('audit: dedicated workflow runs both existing review test files',()=>{
 const command=read('.github/workflows/n8n-memory-review.yml').split('\n').find(line=>line.includes('run: node --test'));
 assert.ok(command,'An actual unit-test command is required');
 const selected=command.trim().slice('run: node --test '.length).split(/\s+/);
 assert.deepEqual(selected,['test/n8n-memory-review.test.mjs','test/n8n-memory-review-audit.test.mjs']);
 for(const path of selected)assert.ok(read(path).includes("import test from 'node:test'"));
});
