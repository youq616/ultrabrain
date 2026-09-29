/** Separate implementation-assistant audit; not independent reviewer-agent approval. */
import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';
import {readFileSync,existsSync} from 'node:fs';
import {fixture,wire,credentials,request,replacement,uuid} from './helpers/n8n-memory-correction-fixture.mjs';
import {automationMemoryCorrectionError,automationMemoryCorrectionFailure,parseCorrectionMemory,automationMemoryCorrectionRequest} from '../src/automation-memory-correction.mjs';
import {automationSettings} from '../src/automation-session.mjs';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
for(const location of ['outer','array','text'])test('correction audit: poisoned receipt accessor never executes '+location,async()=>{
 let n=0;const f=fixture({reply:(q,v)=>{const r=wire(v);if(q.name==='ultra_personal_update'){
  const target=location==='outer'?r:location==='array'?r.content:r.content[0];const key=location==='outer'?'content':location==='array'?'0':'text';
  Object.defineProperty(target,key,{enumerable:true,get(){n++;throw Error('PRIVATE');}});}return r;}});
 await assert.rejects(f.run(),{code:'memory_correction_receipt_unconfirmed',write_delivery:'unconfirmed'});assert.equal(n,0);
});
for(const wire of [{content:[],_meta:{}},{content:[{type:'text',text:'{}'}],structuredContent:{}},{content:[{type:'image',data:'PRIVATE'}]},
 {content:[{type:'text',text:'x'.repeat(8193)}]},{content:[{type:'text',text:'{}'},{type:'text',text:'{}'}]},
 {content:[{type:'text',text:'{"review_required":false,"review_required":true}'}]}])test('correction audit: no extra or ambiguous receipt channels',async()=>{
 const f=fixture({reply:(q,v)=>q.name==='ultra_personal_update'?wire:{content:[{type:'text',text:JSON.stringify(v)}]}});
 await assert.rejects(f.run(),{code:'memory_correction_receipt_unconfirmed',write_delivery:'unconfirmed'});
});
for(const continueOnFail of [true,false])test('correction audit: cleanup failure withholds receipt but retains confirmed fact '+continueOnFail,async()=>{
 const f=fixture({keepGoing:continueOnFail,phase:name=>{if(name==='close')throw Error('PRIVATE_CLOSE');}});
 if(continueOnFail){const r=(await f.run())[0].json;assert.equal(r.error,'memory_correction_cleanup_failed');assert.equal(r.write_delivery,'confirmed');assert.equal(r.result,undefined);}
 else await assert.rejects(f.run(),{code:'memory_correction_cleanup_failed',write_delivery:'confirmed'});
});
for(const kind of ['fake-confirmed','accessor','proxy'])test('correction audit: remote error cannot fabricate acknowledgement '+kind,async()=>{
 let calls=0,error;
 if(kind==='fake-confirmed')error={code:'conflict',write_delivery:'confirmed',write_attempts:99};
 else if(kind==='accessor')error={get code(){calls++;throw Error('PRIVATE');}};
 else{const p=Proxy.revocable({},{});error=p.proxy;p.revoke();}
 const f=fixture({keepGoing:true,phase:name=>{if(name==='ultra_personal_update')throw error;}}),r=(await f.run())[0].json;
 assert.equal(r.write_delivery,'unconfirmed');assert.equal(r.write_attempts,1);assert.equal(calls,0);assert.ok(!JSON.stringify(r).includes('PRIVATE'));
 const untrusted=automationMemoryCorrectionFailure(error);assert.equal(untrusted.write_delivery,'not_started');assert.equal(untrusted.write_attempts,0);
});
test('correction audit: returned outcome must be authentic to survive wrapper failure',async()=>{
 const f=fixture(),result=(await f.run())[0].json.result,e=Object.assign(Error('PRIVATE'),{code:'cancelled'});
 assert.equal(automationMemoryCorrectionError(e,result).write_delivery,'confirmed');
 assert.equal(automationMemoryCorrectionError(e,{...result}).write_delivery,'not_started');
});
test('correction audit: Unicode and raw byte boundaries reject rather than truncate',()=>{
 const content='测'.repeat(21845)+'a',memory=replacement({content});assert.equal(Buffer.byteLength(content),65536);
 assert.equal(parseCorrectionMemory(JSON.stringify(memory)).content,content);
 assert.throws(()=>parseCorrectionMemory(JSON.stringify(replacement({content:content+'b'}))));
 assert.throws(()=>parseCorrectionMemory(JSON.stringify(replacement({content:'\ud800'}))));
 assert.throws(()=>parseCorrectionMemory(JSON.stringify(replacement({content:'\u0001'.repeat(65536)}))));
});
test('correction audit: double escaped JSON key cannot silently change visibility',()=>{
 const s=JSON.stringify(replacement()).replace('"visibility":"private"','"visibility":"private","visib\\u0069lity":"source"');
 assert.throws(()=>parseCorrectionMemory(s),{code:'invalid_params'});
});
test('correction audit: direct API rejects undefined, hidden, Symbol and nonfinite replacement fields',()=>{
 for(const modify of [m=>m.importance=undefined,m=>m.confidence=NaN,m=>m.confidence=Infinity,
  m=>Object.defineProperty(m,'hidden',{value:'PRIVATE'}),m=>m[Symbol('extra')]='PRIVATE']){
  const r=request();modify(r.memory);assert.throws(()=>automationMemoryCorrectionRequest(r,automationSettings(credentials)));
 }
});
test('correction audit: replay outside the original destination remains refused after a later move',async()=>{
 const f=fixture({items:[{correctMode:'replay',correctScope:'global-and-project'}],record:{revision:4,project_id:'mine'},ack:{replayed:true}});
 await assert.rejects(f.run(),{code:'memory_correction_project_mismatch'});assert.ok(!f.calls.some(c=>c.name==='ultra_personal_update'));
});
test('correction audit: no-op correction cannot be used solely to clear provenance',async()=>{
 const derivation={job_id:uuid(20),input_id:uuid(2),input_revision:1,input_hash:'b'.repeat(64),profile_hash:'c'.repeat(64),quote:'PRIVATE',start:0,end:7,offset_unit:'UTF-16 code units'};
 const f=fixture({record:{derivation,derivation_current:false},items:[{correctReplacement:JSON.stringify(replacement({content:'PRIVATE_BODY',provenance:'PRIVATE_PROVENANCE'}))}]});
 await assert.rejects(f.run(),{code:'memory_correction_no_change'});
});
test('correction audit: credential change during handshake cannot grant a disabled action',async()=>{
 const creds={...credentials,allowMemoryCorrection:false},f=fixture({creds,phase:()=>{creds.allowMemoryCorrection=true;}});
 await assert.rejects(f.run(),{code:'memory_correction_disabled'});assert.equal(f.connections,0);
});
function node(){const sandbox={module:{exports:{}},require:name=>name==='../../runtime.cjs'?{execute:async()=>[]}:name==='n8n-workflow'?{NodeOperationError:Error}:(()=>{throw Error(name);})()};
 vm.runInNewContext(read('packages/n8n-nodes-ultrabrain/nodes/Ultrabrain/Ultrabrain.node.js'),sandbox);return new sandbox.module.exports.Ultrabrain();}
test('correction audit: UI has deliberate blank defaults and non-expression consent',()=>{
 const n=node(),p=n.description.properties;assert.equal(n.description.usableAsTool,false);assert.equal(p.find(x=>x.name==='operation').noDataExpression,true);
 for(const name of ['correctMode','correctMemoryId','correctScope','correctEventId','correctExpectedHash','correctExpectedStatus','correctExpectedVisibility','correctReplacement'])assert.equal(p.find(x=>x.name===name).default,'');
 for(const name of ['correctConsent','correctAcknowledgeReset','correctScopeChangeConsent']){assert.equal(p.find(x=>x.name===name).default,false);assert.equal(p.find(x=>x.name===name).noDataExpression,true);}
 assert.ok(p.find(x=>x.name==='correctAcknowledgeReset').description.includes('full old record'));
 assert.equal(new Set(p.map(x=>x.name)).size,p.length);assert.ok(!p.some(x=>x.name==='correctionProject'));
});
test('correction audit: manual sample has no credentials, approval, payload or automatic trigger',()=>{
 const w=JSON.parse(read('examples/n8n/personal-correction.private.json'));assert.equal(w.active,false);assert.equal(w.nodes[0].type,'n8n-nodes-base.manualTrigger');
 assert.equal(w.nodes[1].type,'CUSTOM.ultrabrain');assert.equal(w.nodes[1].parameters.correctConsent,false);assert.equal(w.nodes[1].parameters.correctReplacement,'');
 assert.ok(w.nodes.every(n=>!n.credentials&&!n.retryOnFail));assert.equal(w.settings.saveManualExecutions,false);assert.deepEqual(w.pinData,{});
});
test('correction audit: exact update tool, shared normalizer and no filesystem or model capability',()=>{
 const s=read('src/automation-memory-correction.mjs');assert.ok(s.includes('normalizePersonalMemory(')&&s.includes('readAutomationMemory('));
 assert.deepEqual([...s.matchAll(/name:'(ultra_[a-z_]+)'/g)].map(x=>x[1]),['ultra_personal_update']);
 for(const bad of ['executeRaw','node:fs','PersonalMemoryStore','setInterval(','ultra_personal_review','configuredPersonalModel'])assert.ok(!s.includes(bad));
});
test('correction audit: actual engine CI and portability run exact existing test filenames',()=>{
 const flow=read('.github/workflows/n8n-memory-correction.yml');assert.ok(flow.includes('n8n@2.38.7')&&flow.includes('node-version: \'24\''));
 assert.ok(flow.indexOf('run: bun test/n8n-memory-correction-integration.mjs --engine')>flow.indexOf('npm install --prefix'));
 for(const file of flow.match(/test\/[a-z0-9-]+\.test\.mjs/g))assert.ok(existsSync(new URL('../'+file,import.meta.url)),file);
 const portable=read('.github/workflows/client-portability.yml');assert.ok(portable.includes('windows-2025')&&portable.includes('ubuntu-24.04'));
 assert.ok(portable.includes('node --test test/n8n-memory-correction.test.mjs test/n8n-memory-correction-audit.test.mjs'));
});
