import {requireThat, text, sha256} from './core.mjs';

export const AGENT_TYPES = Object.freeze([
  'coding_agent','general_agent','automation_agent','custom'
]);

export function registerAgent(input={}) {
  requireThat(AGENT_TYPES.includes(input.type ?? 'custom'),'invalid_params','Unknown agent type');
  text(input.agent_id,'agent_id',128);
  return Object.freeze({
    agent_id: input.agent_id,
    type: input.type ?? 'custom',
    workspace: input.workspace ?? null,
    capabilities: Array.isArray(input.capabilities) ? input.capabilities.slice(0,64) : [],
    identity_hash: sha256(JSON.stringify([input.agent_id,input.type,input.workspace ?? null]))
  });
}

export function contextRequest(input={}) {
  text(input.agent_id,'agent_id',128);
  text(input.task,'task',4096);
  return {
    agent_id: input.agent_id,
    task: input.task,
    project_id: input.project_id ?? null,
    memory_policy: input.memory_policy ?? 'current'
  };
}

export function commitRequest(input={}) {
  text(input.agent_id,'agent_id',128);
  text(input.summary,'summary',65536);
  return {
    agent_id: input.agent_id,
    summary: input.summary,
    memories: Array.isArray(input.memories) ? input.memories : []
  };
}
