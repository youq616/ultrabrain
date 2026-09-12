/** Personal context selection layer.
 * Uses existing memory objects as the source; does not create a second store.
 */
import {requireThat,integer,text} from './core.mjs';

const TYPES = Object.freeze([
  'identity','preference','environment','project','decision','skill','error','goal','experience'
]);

export function validateMemoryType(type) {
  requireThat(TYPES.includes(type),'invalid_memory_type','Unknown personal memory type');
  return type;
}

export function contextQuery(input={}) {
  const allowed=['agent_id','project_id','task','limit','types'];
  requireThat(input && typeof input==='object' && Object.keys(input).every(k=>allowed.includes(k)),
    'invalid_params','Unknown context query field');
  const types=input.types??TYPES;
  requireThat(Array.isArray(types),'invalid_params','types must be an array');
  types.forEach(validateMemoryType);
  return Object.freeze({
    agent_id:input.agent_id??null,
    project_id:input.project_id??null,
    task:input.task?text(input.task,'task',4096):'',
    limit:integer(input.limit,20,1,200),
    types:Object.freeze([...types])
  });
}

export function rankMemory(memory,query={}) {
  const typeScore=query.types?.includes(memory.type)?1:0;
  const confidence=Number.isFinite(memory.confidence)?memory.confidence:0;
  const importance=memory.importance==='high'?1:memory.importance==='medium'?.5:0;
  return confidence*0.6+importance*0.3+typeScore*0.1;
}

export function buildPersonalContext(memories,query={}) {
  const q=contextQuery(query);
  requireThat(Array.isArray(memories),'invalid_memories','Memory list required');
  return {
    agent_id:q.agent_id,
    project_id:q.project_id,
    memories:memories
      .filter(m=>q.types.includes(m.type))
      .map(m=>({...m,_score:rankMemory(m,q)}))
      .sort((a,b)=>b._score-a._score)
      .slice(0,q.limit)
      .map(({_score,...m})=>m),
    trust:'untrusted-memory-data'
  };
}
