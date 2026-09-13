/** Optional personal-memory extension over the unchanged shared lifecycle implementation. */
import {AgentMemory as BaseAgentMemory} from './agent-memory-base.mjs';
import {PERSONAL_MEMORY_TYPES,personalId as identifier} from './personal-memory.mjs';
import {integer,requireThat,sha256} from './core.mjs';
export class AgentMemory extends BaseAgentMemory {
  constructor(options={}) {
    super(options);
    const personalContext=options.personalContext??false;
    requireThat(typeof personalContext==='boolean','invalid_params','personalContext must be boolean');
    requireThat(!personalContext||!this.root.slug,'scope_denied','Personal context requires a source root; it has no directory-fence semantics');
    requireThat(!personalContext||this.budgetBytes>=4096,'invalid_params','Combined personal context requires at least 4096 bytes');
    this.personalContext=personalContext;
  }
  async beforeTurn(query,options={}) {
    if(!this.personalContext)return super.beforeTurn(query,options);
    const personalBudget=Math.floor(this.budgetBytes/3);
    // A per-call view avoids mutating this.budgetBytes during concurrent turns.
    // Base retrieval still accounts for its page/fact envelope and uses the same client.
    const scoped=Object.create(this);scoped.budgetBytes=this.budgetBytes-personalBudget-64;
    const result=await BaseAgentMemory.prototype.beforeTurn.call(scoped,query,options);
    result.personal_context=await this.personalBeforeTurn({budgetBytes:personalBudget,signal:options.signal});
    const combined={items:result.items,...(result.facts?{facts:result.facts}:{}),personal_context:result.personal_context};
    result.combined_evidence_bytes=Buffer.byteLength(JSON.stringify(combined));
    requireThat(result.combined_evidence_bytes<=this.budgetBytes,'mcp_contract_changed','Combined personal/page/fact evidence exceeded budget');
    result.combined_evidence_budget_bytes=this.budgetBytes;
    result.personal_selection='Explicitly active global and selected-project entries; bounded, not semantic ranking';
    return result;
  }
  async personalBeforeTurn({budgetBytes=this.budgetBytes,signal}={}) {
    requireThat(this.personalContext&&!this.root.slug,'scope_denied','Enable personalContext explicitly on a source root');
    integer(budgetBytes,this.budgetBytes,512,131072);
    const result=await this.invoke('ultra_personal_context',{...(this.projectId?{project_id:this.projectId}:{}),limit:20,budget_bytes:budgetBytes},signal);
    requireThat(result.source_id===this.root.source&&Array.isArray(result.memories),'mcp_contract_changed','Invalid personal context response');
    requireThat(Buffer.byteLength(JSON.stringify(result))<=budgetBytes,'mcp_contract_changed','Personal context exceeded budget');
    for(const row of result.memories) {
      requireThat(row&&PERSONAL_MEMORY_TYPES.includes(row.type)&&typeof row.content==='string'&&row.content_hash===sha256(row.content)&&
        row.status==='active'&&row.derivation_current!==false&&(row.project_id==null||row.project_id===this.projectId)&&
        (row.owned_by_caller===true||row.visibility==='source'),'mcp_contract_changed','Personal context includes ineligible, stale or out-of-project data');
    }
    return {...result,trust:'untrusted-memory-data'};
  }
  async registerPersonalAgent({agentId,agentType='custom',capabilities=[],expectedRevision=0,signal}={}) {
    requireThat(this.capture&&!this.root.slug,'capture_disabled','Personal registration requires capture opt-in and a source root');
    identifier(agentId,'agentId');
    return this.invoke('ultra_agent_register',{agent_id:agentId,agent_type:agentType,capabilities,expected_revision:expectedRevision},signal);
  }
  async queuePersonalTranscript({agentId,eventId,transcript,consent=false,signal}={}) {
    requireThat(this.capture&&consent===true&&!this.root.slug,'capture_disabled','Personal capture requires explicit consent and a source root');
    identifier(agentId,'agentId');identifier(eventId,'eventId');
    const result=await this.invoke('ultra_personal_capture',{agent_id:agentId,event_id:eventId,transcript,consent:true,
      ...(this.projectId?{project_id:this.projectId}:{})},signal);
    requireThat(result.source_id===this.root.source&&result.event_id===eventId&&result.storage==='journaled'&&typeof result.job_id==='string',
      'mcp_contract_changed','Personal capture receipt does not match the request');
    return result;
  }
  async learnPersonalMemories({agentId,eventId,memories,summary,consent=false,signal}={}) {
    requireThat(this.capture&&consent===true&&!this.root.slug,'capture_disabled','Personal learning requires explicit per-call consent and capture opt-in on a source root');
    identifier(agentId,'agentId');identifier(eventId,'eventId');
    requireThat((memories===undefined)!==(summary===undefined),'invalid_params','Provide memories or summary, not both');
    const result=await this.invoke('ultra_memory_commit',{agent_id:agentId,event_id:eventId,consent:true,
      ...(summary===undefined?{memories}:{summary})},signal);
    requireThat(result.source_id===this.root.source&&result.event_id===eventId&&result.storage==='stored'&&Array.isArray(result.entries)&&
      result.entries.every(x=>x.status==='candidate'),'mcp_contract_changed','Personal candidate receipt does not match this request');
    return result;
  }
}
