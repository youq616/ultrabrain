/** MCP lifecycle payload validation; authenticated principal is supplied separately by the server. */
import {requireThat,text,integer} from './core.mjs';
import {objectFields,personalId,AGENT_TYPES,normalizePersonalMemory,contextQuery} from './personal-memory.mjs';
export function agentIdentity(input={}) {
  objectFields(input,['agent_id','agent_type','capabilities','workspace','expected_revision']);
  const agent_id=personalId(input.agent_id,'agent_id'),agent_type=input.agent_type??'custom';
  requireThat(AGENT_TYPES.includes(agent_type),'invalid_params','Invalid agent_type');
  const capabilities=input.capabilities??[];
  requireThat(Array.isArray(capabilities)&&capabilities.length<=32,'invalid_params','Invalid capabilities');
  capabilities.forEach(x=>text(x,'capability',128));
  return Object.freeze({agent_id,agent_type,capabilities:[...new Set(capabilities)].sort(),
    workspace:input.workspace==null?null:text(input.workspace,'workspace',1024),
    expected_revision:integer(input.expected_revision,0,0,2147483646)});
}
export function memoryCommit(input={}) {
  objectFields(input,['agent_id','event_id','consent','summary','memories']);
  const agent_id=personalId(input.agent_id,'agent_id'),event_id=personalId(input.event_id,'event_id');
  requireThat(input.consent===true,'capture_disabled','Explicit consent:true required to persist personal memory');
  requireThat(!(input.summary!==undefined&&input.memories!==undefined),'invalid_params','Supply memories OR a summary, not two competing representations');
  const values=input.memories??(input.summary!==undefined?[{type:'experience',content:text(input.summary,'summary',8192)}]:null);
  requireThat(Array.isArray(values)&&values.length>0&&values.length<=16,'invalid_params','Commit requires 1..16 memory items');
  const memories=values.map(normalizePersonalMemory);
  requireThat(Buffer.byteLength(JSON.stringify(memories))<=262144,'invalid_params','Serialized commit exceeds 256 KiB');
  return Object.freeze({agent_id,event_id,memories,consent:true});
}
export const contextRequest=contextQuery;
