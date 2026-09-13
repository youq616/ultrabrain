import test from 'node:test';
import assert from 'node:assert/strict';
import {AgentMemory} from '../src/agent-memory.mjs';
import {sha256} from '../src/core.mjs';
import {automationSettings,automationSession} from '../src/automation-session.mjs';
import {bridgeOptions} from '../src/lifecycle-bridge.mjs';
const record={id:'00000000-0000-4000-8000-000000000001',type:'preference',content:'Do not use Docker Hub',content_hash:sha256('Do not use Docker Hub'),status:'active',owned_by_caller:true,visibility:'private',project_id:null};
const wrap=value=>({content:[{type:'text',text:JSON.stringify(value)}]});
function fixture(personal={source_id:'default',memories:[record],trust:'untrusted-memory-data'}){
 const calls=[];const client={async callTool(r){calls.push(r);return wrap(r.name==='ultra_personal_context'?personal:r.name==='ultra_recall'?{source_id:'default',memory_policy:'current',facts:[],candidates:0}:r.name==='ultra_agent_register'?{agent_id:r.arguments.agent_id}:r.name==='ultra_memory_commit'?{source_id:'default',event_id:r.arguments.event_id,entries:[{status:'candidate'}],storage:'stored'}:{items:[]});}};
 return {calls,client};
}
test('personal context is opt-in; legacy clients do not make additional calls',async()=>{
 const f=fixture();await new AgentMemory({client:f.client,rootUri:'ultra://default/',sessionId:'s'}).beforeTurn('continue');assert.deepEqual(f.calls.map(x=>x.name),['ultra_retrieve']);
});
test('active global preferences are included without requiring query substring overlap',async()=>{
 const f=fixture(),m=new AgentMemory({client:f.client,rootUri:'ultra://default/',sessionId:'s',personalContext:true});
 const r=await m.runTurn({input:'Write a unit test',generate:async({evidence})=>{assert.equal(evidence.personal_context.memories[0].content,record.content);return 'done';}});
 assert.equal(r.output,'done');assert.deepEqual(f.calls.map(x=>x.name),['ultra_retrieve','ultra_personal_context']);assert.equal(f.calls[1].arguments.query,undefined);
 assert.ok(r.evidence.combined_evidence_bytes<=m.budgetBytes);
});
test('combined page/fact/personal budget accounts for the serialized envelope',async()=>{
 const f=fixture();const r=await new AgentMemory({client:f.client,rootUri:'ultra://default/',sessionId:'s',personalContext:true,factRecall:{},budgetBytes:4096}).beforeTurn('continue');
 assert.equal(r.combined_evidence_bytes,Buffer.byteLength(JSON.stringify({items:r.items,facts:r.facts,personal_context:r.personal_context})));
 assert.ok(r.combined_evidence_bytes<=4096);
});
for(const change of [{source_id:'other'},{memories:[{...record,status:'candidate'}]},{memories:[{...record,content_hash:'0'.repeat(64)}]},{memories:[{...record,owned_by_caller:false}]},{memories:[{...record,project_id:'other'}]}])test('invalid personal evidence is rejected '+JSON.stringify(change),async()=>{
 const f=fixture({source_id:'default',memories:[record],...change});await assert.rejects(new AgentMemory({client:f.client,rootUri:'ultra://default/',sessionId:'s',personalContext:true}).beforeTurn('q'),{code:'mcp_contract_changed'});
});
test('selected-project context is forwarded, never all unrelated projects',async()=>{
 const f=fixture({source_id:'default',memories:[{...record,project_id:'code'}]});await new AgentMemory({client:f.client,rootUri:'ultra://default/',sessionId:'s',projectId:'code',personalContext:true}).beforeTurn('q');
 assert.equal(f.calls.at(-1).arguments.project_id,'code');
});
test('personal context cannot escape a directory root or use insufficient budget',()=>{
 const f=fixture();assert.throws(()=>new AgentMemory({client:f.client,rootUri:'ultra://default/restricted',sessionId:'s',personalContext:true}),{code:'scope_denied'});
 assert.throws(()=>new AgentMemory({client:f.client,rootUri:'ultra://default/',sessionId:'s',personalContext:true,budgetBytes:2048}),{code:'invalid_params'});
});
test('oversize personal evidence fails instead of overflowing the user budget',async()=>{
 const f=fixture({source_id:'default',memories:[],padding:'x'.repeat(10000)});await assert.rejects(new AgentMemory({client:f.client,rootUri:'ultra://default/',sessionId:'s',personalContext:true,budgetBytes:4096}).beforeTurn('q'),{code:'mcp_contract_changed'});
});
test('personal learning needs capture and per-call consent; it never activates memories',async()=>{
 const f=fixture(),m=new AgentMemory({client:f.client,rootUri:'ultra://default/',sessionId:'s',capture:true});
 await assert.rejects(m.learnPersonalMemories({agentId:'custom',eventId:'e',summary:'experience'}),{code:'capture_disabled'});assert.equal(f.calls.length,0);
 await m.registerPersonalAgent({agentId:'custom'});const r=await m.learnPersonalMemories({agentId:'custom',eventId:'e',summary:'experience',consent:true});
 assert.equal(r.entries[0].status,'candidate');assert.deepEqual(f.calls.map(x=>x.name),['ultra_agent_register','ultra_memory_commit']);
});
test('automation and bridge route personal selection without enabling capture',()=>{
 const opts=automationSettings({rootUri:'ultra://default/',includePersonal:true});assert.deepEqual(automationSettings(opts),opts);assert.equal(opts.allowCapture,false);
 assert.throws(()=>automationSettings({rootUri:'ultra://default/p',includePersonal:true}),{code:'scope_denied'});
 const args=['--url','https://memory.example/mcp','--token-file','/test','--root','ultra://default/','--personal-context'];
 const b=bridgeOptions(args);assert.equal(b.personalContext,true);assert.equal(b.capture,false);
});
test('automation before-turn makes the actual personal MCP call',async()=>{
 const f=fixture(),original=f.client.callTool;f.client.callTool=r=>r.name==='ultra_identity'?Promise.resolve(wrap({format:1,source_id:'default',instance_id:'00000000-0000-4000-8000-000000000001',actor_key:'a'.repeat(64)})):original(r);
 const s=await automationSession(f.client,{rootUri:'ultra://default/',includePersonal:true});assert.equal((await s.run('before_turn',{session_id:'s',query:'q'})).context.personal_context.memories[0].id,record.id);
});
