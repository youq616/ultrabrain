import test from 'node:test';
import assert from 'node:assert/strict';
import {agentIdentity,contextRequest,memoryCommit} from '../src/agent-memory-protocol.mjs';
import {registerAgent,contextRequest as oldContext,commitRequest} from '../src/agent-protocol.mjs';
import {normalizePersonalMemory,classifyMemory} from '../src/personal-memory.mjs';
import {buildPersonalContext} from '../src/personal-context-engine.mjs';
import {registerPersonalPlugin,PERSONAL_TOOL_NAMES} from '../src/personal-plugin.mjs';

test('draft protocol paths share the exact canonical implementation',()=>{
  assert.strictEqual(registerAgent,agentIdentity);assert.strictEqual(contextRequest,oldContext);assert.strictEqual(commitRequest,memoryCommit);
});
test('client metadata never accepts a self-assigned trust flag or owner',()=>{
  const p={agent_id:'claude-code',agent_type:'coding_agent',capabilities:['code','code']};
  assert.deepEqual(agentIdentity(p).capabilities,['code']);
  for(const field of ['source_id','owner_key','actor_key','trust_level','verified'])assert.throws(()=>agentIdentity({...p,[field]:'fake'}));
});
test('identifiers and agent metadata have bounded strict shapes',()=>{
  for(const agent_id of ['bad id','x'.repeat(97),null,4])assert.throws(()=>agentIdentity({agent_id}));
  for(const capabilities of ['code',[null],[{}],Array(33).fill('a')])assert.throws(()=>agentIdentity({agent_id:'codex',capabilities}));
});
test('commit needs consent and stable event id; no invented clock or confidence',()=>{
  const p={agent_id:'codex',event_id:'turn1',consent:true,summary:'Explicitly submitted experience'};
  const result=memoryCommit(p);assert.equal(result.memories[0].confidence,null);assert.equal(result.memories[0].type,'experience');
  for(const consent of [false,undefined,'true'])assert.throws(()=>memoryCommit({...p,consent}),{code:'capture_disabled'});
  assert.throws(()=>memoryCommit({...p,event_id:undefined}));assert.throws(()=>memoryCommit({...p,memories:[]}));
});
test('summary and list are explicit alternatives; empty/oversized commits rejected',()=>{
  const p={agent_id:'codex',event_id:'turn1',consent:true};
  for(const memories of [[],null,Array(17).fill({type:'skill',content:'a'})])assert.throws(()=>memoryCommit({...p,memories}));
  assert.throws(()=>memoryCommit({...p,memories:Array(5).fill({type:'skill',content:'x'.repeat(65536)})}));
});
test('classification is only a hint and never returns a trust probability',()=>{
  assert.equal(classifyMemory('用户喜欢命令行'),'preference');assert.equal(classifyMemory('运行 Ubuntu'),'environment');
  assert.equal(typeof classifyMemory('Unclassified experience'),'string');
});
test('context excludes candidate/archived and wrong-project data, independent of confidence',()=>{
  const rows=[{id:'a',type:'preference',content:'Use CLI',confidence:null,importance:'high',status:'active',project_id:null},
    {id:'b',type:'error',content:'unreviewed',confidence:1,importance:'high',status:'candidate'},
    {id:'c',type:'skill',content:'wrong project',confidence:1,importance:'high',status:'active',project_id:'other'}];
  const context=buildPersonalContext(rows,{task:'CLI',project_id:'mine'});
  assert.deepEqual(context.memories.map(x=>x.id),['a']);assert.equal(context.trust,'untrusted-memory-data');
});
test('context never truncates individual instructions to satisfy its serialized budget',()=>{
  const rows=[{id:'a',type:'preference',content:'x'.repeat(5000)+' DO NOT SHARE',importance:'high',status:'active'},
    {id:'b',type:'preference',content:'Do not use Docker Hub',importance:'normal',status:'active'}];
  const out=buildPersonalContext(rows,{budget_bytes:700});
  assert.ok(Buffer.byteLength(JSON.stringify(out))<=700);assert.equal(out.memories[0].id,'b');assert.equal(out.dropped,1);
});
test('personal tools have real handlers and consistent read/write scopes',()=>{
  class E extends Error{constructor(code,msg){super(msg);this.code=code;}}
  const operations=[];assert.equal(registerPersonalPlugin(operations,{OperationError:E}).length,8);
  assert.deepEqual(operations.map(x=>x.name),PERSONAL_TOOL_NAMES);
  assert.ok(operations.every(x=>typeof x.handler==='function'&&x.mutating===(x.scope==='write')));
  assert.throws(()=>registerPersonalPlugin(operations,{OperationError:E}),{code:'upstream_contract_changed'});
});
