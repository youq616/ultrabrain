/** Owned-label lookup for explicit capture and document delivery.
 * Callers pin the authenticated identity before entry and again before sending
 * content. This helper never updates existing metadata or retries a write.
 */
import {requireThat} from './core.mjs';
import {personalId} from './personal-memory.mjs';

export async function ensureOwnedAgent(agentId,profile,{checkIdentity,invoke,assertAuthorized}) {
  personalId(agentId,'agent_id');
  const lookup=async()=>{
    let offset=0;
    for(let page=0;page<16;page++) {
      assertAuthorized();
      const result=await invoke('ultra_agent_list',{limit:100,offset});
      assertAuthorized();
      requireThat(result?.source_id===profile.source&&Array.isArray(result.agents)&&result.agents.length<=100&&
        result.agents.every(agent=>agent&&typeof agent.agent_id==='string'&&/^[A-Za-z0-9_-]{1,96}$/.test(agent.agent_id)),
        'mcp_contract_changed','Invalid owned Agent listing');
      if(result.agents.some(agent=>agent.agent_id===agentId))return true;
      if(result.next_offset===null)return false;
      requireThat(Number.isSafeInteger(result.next_offset)&&result.next_offset===offset+result.agents.length&&result.next_offset>offset,
        'mcp_contract_changed','Invalid Agent listing cursor');
      offset=result.next_offset;
    }
    requireThat(false,'agent_lookup_limit','Owned Agent lookup exceeded bounded window; no metadata was changed');
  };
  if(await lookup())return;
  await checkIdentity();assertAuthorized();
  try {
    // Revision zero is create-only for different metadata. Never copy a current
    // revision from the listing into a default-metadata registration request.
    await invoke('ultra_agent_register',{agent_id:agentId,agent_type:'custom',expected_revision:0});
  }catch(error){
    assertAuthorized();
    if(error?.code!=='revision_conflict')throw error;
    // Another client may have registered the owned label after our lookup.
    // Recheck identity and existence once; no second write and no blind success.
    await checkIdentity();assertAuthorized();
    if(!await lookup())throw error;
  }
  assertAuthorized();
}
