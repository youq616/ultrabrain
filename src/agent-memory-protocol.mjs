/** Agent Memory Protocol (AMP) contracts.
 * Transport adapters can map MCP/HTTP/CLI into these deterministic operations.
 */
import {requireThat,text} from './core.mjs';

const AGENT_ID=/^[A-Za-z0-9_-]{1,96}$/;

export function agentIdentity(input={}) {
  requireThat(typeof input.agent_id==='string'&&AGENT_ID.test(input.agent_id),
    'invalid_agent','Invalid agent id');
  requireThat(typeof input.agent_type==='string'&&input.agent_type.length<=128,
    'invalid_agent','Invalid agent type');
  return Object.freeze({
    agent_id:input.agent_id,
    agent_type:input.agent_type,
    capabilities:Array.isArray(input.capabilities)?Object.freeze(input.capabilities.map(x=>String(x))):Object.freeze([]),
    workspace:input.workspace?text(input.workspace,'workspace',1024):null
  });
}

export function memoryCommit(input={}) {
  requireThat(input && typeof input==='object','invalid_params','Commit object required');
  requireThat(input.agent_id&&AGENT_ID.test(input.agent_id),'invalid_agent','Commit requires agent');
  return Object.freeze({
    agent_id:input.agent_id,
    project_id:input.project_id??null,
    summary:text(input.summary??'','summary',8192),
    memories:Array.isArray(input.memories)?input.memories:[],
    timestamp:input.timestamp??null
  });
}

export function contextRequest(input={}) {
  requireThat(input.agent_id&&AGENT_ID.test(input.agent_id),'invalid_agent','Context requires agent');
  return Object.freeze({
    agent_id:input.agent_id,
    project_id:input.project_id??null,
    task:text(input.task??'','task',4096)
  });
}
