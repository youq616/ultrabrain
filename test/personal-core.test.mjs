import test from 'node:test';
import assert from 'node:assert/strict';
import {agentIdentity,contextRequest,memoryCommit} from '../src/agent-memory-protocol.mjs';
import {buildPersonalContext,contextQuery} from '../src/personal-context-engine.mjs';

test('AMP validates agents and context lifecycle payloads',()=>{
  assert.equal(agentIdentity({agent_id:'claude-code',agent_type:'coding_agent'}).agent_id,'claude-code');
  assert.equal(contextRequest({agent_id:'codex',task:'continue project'}).task,'continue project');
  assert.equal(memoryCommit({agent_id:'codex',summary:'done'}).summary,'done');
  assert.throws(()=>agentIdentity({agent_id:'bad id',agent_type:'x'}));
});

test('personal context ranks trusted memory candidates',()=>{
 const result=buildPersonalContext([
  {type:'preference',content:'cli',confidence:.95,importance:'high'},
  {type:'error',content:'temporary',confidence:.2,importance:'low'}
 ],contextQuery({types:['preference','error']}));
 assert.equal(result.memories[0].content,'cli');
});
