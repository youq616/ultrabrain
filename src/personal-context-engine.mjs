/** Selection of already-authorized structured entries; not a semantic model or truth scorer. */
import {requireThat} from './core.mjs';
import {contextQuery,validateMemoryType} from './personal-memory.mjs';
export {contextQuery,validateMemoryType};
export function rankMemory(memory,query={}) {
  const terms=(query.task??'').toLowerCase().split(/\s+/u).filter(Boolean).slice(0,32);
  const overlap=terms.filter(t=>memory.content.toLowerCase().includes(t)).length;
  return ({high:3,normal:2,low:1}[memory.importance]??0)+overlap;
}
export function buildPersonalContext(memories,query={}) {
  // Accept either caller input or the normalized query. Optional null IDs are harmless labels.
  const q=contextQuery(Object.fromEntries(Object.entries(query).filter(([k,v])=>v!==null)));
  requireThat(Array.isArray(memories),'invalid_params','Memory list required');
  const ranked=memories.filter(m=>m.status==='active'&&q.types.includes(m.type)&&
    (m.project_id===null||m.project_id===undefined||m.project_id===q.project_id))
    .sort((a,b)=>rankMemory(b,q)-rankMemory(a,q)||String(b.updated_at).localeCompare(String(a.updated_at))||String(a.id).localeCompare(String(b.id)));
  const result={memories:[],trust:'untrusted-memory-data',selection:'bounded-literal-and-importance-v1',
    confidence_semantics:'caller estimate, not a verified probability',exhaustive:false,dropped:0,budget_bytes:q.budget_bytes};
  for(const row of ranked) {
    if(result.memories.length>=q.limit){result.dropped++;continue;}
    result.memories.push(row);
    if(Buffer.byteLength(JSON.stringify(result))>q.budget_bytes){result.memories.pop();result.dropped++;}
  }
  // The counter itself can gain a digit; trim whole entries, never shorten a negation.
  while(Buffer.byteLength(JSON.stringify(result))>q.budget_bytes&&result.memories.length){result.memories.pop();result.dropped++;}
  return result;
}
