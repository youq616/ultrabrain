/** Real DB + local console API + AgentMemory via dispatcher. Synthetic data only. */
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {connect,loadNative} from '../src/runtime.mjs';
import {startPersonalConsole} from '../src/personal-console.mjs';
import {AgentMemory} from '../src/agent-memory.mjs';
assert.equal(process.env.ULTRABRAIN_TEST_ALLOW_WRITE,'1');
const engine=await connect(),source='console-'+randomBytes(5).toString('hex'),token=randomBytes(32).toString('hex');let ui,checks=0;const pass=()=>checks++;
async function api(operation,input={}){const r=await fetch(ui.origin+'/api/call',{method:'POST',headers:{'Content-Type':'application/json',Origin:ui.origin,Authorization:'Bearer '+token},body:JSON.stringify({operation,input})});const data=await r.json();return {status:r.status,...data};}
async function ok(operation,input={}){const r=await api(operation,input);assert.equal(r.ok,true,r.error);return r.result;}
try{
 await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)',[source]);ui=await startPersonalConsole({engine,source,token,port:0});
 assert.equal((await ok('info')).source_id,source);pass();
 await ok('register',{agent_id:'personal-console',agent_type:'general_agent'});assert.equal((await ok('agents')).agents[0].agent_id,'personal-console');pass();
 const memory={type:'preference',content:'Synthetic: do not use Docker Hub',importance:'high',provenance:'Synthetic console input'};
 const args={agent_id:'personal-console',event_id:'create',consent:true,memories:[memory]};
 const created=await ok('commit',args),id=created.entries[0].id;assert.equal(created.entries[0].status,'candidate');pass();
 assert.equal((await ok('commit',args)).entries[0].id,id);pass();
 assert.equal((await ok('profile')).memories.length,0);assert.equal((await ok('search',{status:'candidate'})).memories[0].id,id);pass();
 const review={memory_id:id,expected_revision:1,event_id:'activate',status:'active'};await ok('review',review);assert.equal((await ok('profile')).memories[0].id,id);pass();
 // Same host owner as local stdio. Cross-tool retrieval must actually see the console edit.
 const {dispatchToolCall}=await loadNative('src/mcp/dispatch.ts');
 const client={callTool:r=>dispatchToolCall(engine,r.name,r.arguments,{sourceId:source,remote:false,transport:'stdio'})};
 const agent=new AgentMemory({client,rootUri:`ultra://${source}/`,sessionId:'console-test',capture:true,personalContext:true});
 const result=await agent.beforeTurn('Unrelated task');assert.equal(result.personal_context.memories[0].id,id);assert.ok(result.combined_evidence_bytes<=agent.budgetBytes);pass();
 // A distinct authenticated actor must not inherit this local owner's private record.
 const foreign=await dispatchToolCall(engine,'ultra_memory_profile',{}, {sourceId:source,remote:true,transport:'http',auth:{sourceId:source,principal:{kind:'oauth_client',id:'other'},scopes:['read']}});
 assert.equal(JSON.parse(foreign.content[0].text).memories.length,0);pass();
 const edited=await ok('update',{memory_id:id,expected_revision:2,event_id:'edit',memory:{...memory,content:'Synthetic: edited preference'}});assert.equal(edited.status,'candidate');assert.equal((await ok('profile')).memories.length,0);pass();
 const stale=await api('review',{memory_id:id,expected_revision:2,event_id:'stale',status:'active'});assert.equal(stale.error,'revision_conflict');pass();
 await ok('review',{memory_id:id,expected_revision:3,event_id:'reactivate',status:'active'});
 await ok('review',{memory_id:id,expected_revision:4,event_id:'archive',status:'archived'});assert.equal((await ok('search',{status:'archived'})).memories[0].id,id);assert.equal((await agent.beforeTurn('q')).personal_context.memories.length,0);pass();
 // SDK learning remains explicit, creates candidates and cannot auto-activate based on confidence.
 await agent.registerPersonalAgent({agentId:'custom'});const candidate=await agent.learnPersonalMemories({agentId:'custom',eventId:'sdk',consent:true,summary:'Synthetic candidate experience'});
 assert.equal(candidate.entries[0].status,'candidate');assert.equal((await ok('context')).memories.length,0);pass();
 const raw=await fetch(ui.origin+'/api/call',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://foreign.invalid',Authorization:'Bearer '+token},body:JSON.stringify(args)});assert.equal(raw.status,403);pass();
 console.log(`PASS ${checks} personal console DB/API/Agent checks: same-owner reuse, isolation, candidate lifecycle, CAS and explicit SDK learning`);
}finally{await ui?.close();await engine.disconnect();}
