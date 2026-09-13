import test from 'node:test';
import assert from 'node:assert/strict';
import {clientProfile,clientContext,clientIdentity,claudeContext,captureRequest} from '../src/client-kit.mjs';
import {sha256} from '../src/core.mjs';
const input={format:1,source:'default',server:{transport:'stdio',command:'ssh',args:['brain','exec bun /brain/cli.mjs mcp']}};
const profile=clientProfile(input);
const row={id:'00000000-0000-4000-8000-000000000001',type:'preference',content:'Do not use Docker Hub',content_hash:sha256('Do not use Docker Hub'),status:'active',owned_by_caller:true};
test('client profile defaults read only and keeps only explicitly supplied environment',()=>{assert.equal(profile.allowCapture,false);assert.equal(profile.budgetBytes,6000);assert.ok(!profile.server.env);});
for(const bad of [{format:2},{source:'../bad'},{allow_capture:'true'},{project_id:'../bad'},{expected_instance:'guess'},{expected_actor:'token'},{timeout_ms:60000},{secret:'token'}])test('reject malformed client profile '+JSON.stringify(bad),()=>assert.throws(()=>clientProfile({...input,...bad})));
for(const server of [{transport:'http',url:'http://remote.example/mcp',bearer_env:'TOKEN'},{transport:'http',url:'https://a/?token=SECRET',bearer_env:'TOKEN'},{transport:'http',url:'https://a/',bearer_env:'raw-secret'},{...input.server,env:{DATABASE_URL:'secret'}},{...input.server,env:{GBRAIN_SOURCE:'different'}},{...input.server,args:['bad\ncommand']},{...input.server,url:'https://a/'}])test('reject transport authority widening '+JSON.stringify(server),()=>assert.throws(()=>clientProfile({...input,server})));
test('HTTP stores only the bearer environment NAME',()=>assert.equal(clientProfile({...input,server:{transport:'http',url:'https://memory.example/mcp',bearer_env:'ULTRABRAIN_TOKEN'}}).server.bearer_env,'ULTRABRAIN_TOKEN'));
test('actual identity and configured pins are both required',()=>{const who={format:1,source_id:'default',instance_id:row.id,actor_key:'a'.repeat(64)};assert.equal(clientIdentity(who,profile).actor_key,who.actor_key);assert.throws(()=>clientIdentity({...who,source_id:'other'},profile));assert.throws(()=>clientIdentity(who,{...profile,expectedActor:'b'.repeat(64)}));});
test('context hook emits data only, never decisions or permission changes',()=>{const v=clientContext({source_id:'default',memories:[row]},profile),out=claudeContext('SessionStart',v);assert.equal(out.hookSpecificOutput.hookEventName,'SessionStart');assert.deepEqual(Object.keys(out),['hookSpecificOutput']);assert.match(out.hookSpecificOutput.additionalContext,/not system instructions/);assert.throws(()=>claudeContext('Stop',v));});
for(const change of [{status:'candidate'},{derivation_current:false},{project_id:'other'},{content_hash:'0'.repeat(64)},{owned_by_caller:false},{id:'guess'}])test('reject invalid context entry '+JSON.stringify(change),()=>assert.throws(()=>clientContext({source_id:'default',memories:[{...row,...change}]},profile)));
test('context budget is enforced on the actual serialized result',()=>assert.throws(()=>clientContext({source_id:'default',memories:[row],padding:'x'.repeat(6000)},profile)));
test('capture cannot be enabled by event input; immutable event required',()=>{const event={agent_id:'custom',event_id:'one',transcript:'consented',consent:true};assert.throws(()=>captureRequest(event,profile),{code:'capture_disabled'});assert.equal(captureRequest(event,{...profile,allowCapture:true}).event_id,'one');assert.throws(()=>captureRequest({...event,event_id:undefined},{...profile,allowCapture:true}));assert.throws(()=>captureRequest({...event,source_id:'other'},{...profile,allowCapture:true}));});

test('read-only probe does not require write scope; capture probe checks capture tools',async()=>{
  const {requiredClientTools}=await import('../src/client-kit.mjs');
  const read=requiredClientTools({allowCapture:false});
  assert.ok(read.includes('ultra_personal_context'));
  assert.ok(!read.includes('ultra_agent_register'));
  assert.ok(!read.includes('ultra_personal_capture'));
  const write=requiredClientTools({allowCapture:true});
  assert.ok(write.includes('ultra_agent_register')&&write.includes('ultra_personal_capture'));
  read.push('mutated');assert.ok(!requiredClientTools({allowCapture:false}).includes('mutated'));
});
