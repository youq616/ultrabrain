/** Selection of already-authorized structured entries; not a semantic model or truth scorer.
 * One canonical ranking shared by SQL and JavaScript: importance 3/2/1 plus one point per
 * distinct task term literally contained in the content; ties break on true time value
 * (millisecond precision) descending, then full UUID ascending. Task terms split on Unicode
 * whitespace, deduplicate and cap at 32 distinct terms; only ASCII A–Z is case-folded, so
 * non-ASCII text matches exactly as written. Compatibility: the previous implementation
 * lowercased whole strings, split only on /\s+/, counted duplicate terms and kept the first
 * 32 tokens including duplicates — see docs/PERSONAL-RANKING.md for the behavior change.
 */
import {requireThat} from './core.mjs';
import {contextQuery,validateMemoryType} from './personal-memory.mjs';
export {contextQuery,validateMemoryType};
const ASCII_UPPER=/[A-Z]/g;
/** Fold only ASCII A–Z; every other code point (including non-ASCII uppercase) stays as-is. */
export const foldAscii=value=>String(value).replace(ASCII_UPPER,c=>String.fromCharCode(c.charCodeAt(0)+32));
export function taskTerms(task='') {
  requireThat(typeof task==='string','invalid_params','Task must be text');
  const seen=new Set(),terms=[];
  for(const token of foldAscii(task).split(/\p{White_Space}+/u)) {
    if(!token||seen.has(token))continue;
    seen.add(token);terms.push(token);
    if(terms.length===32)break;
  }
  return Object.freeze(terms);
}
export function rankMemory(memory,query={}) {
  const folded=foldAscii(memory.content??'');
  const overlap=taskTerms(query.task??'').filter(term=>folded.includes(term)).length;
  return ({high:3,normal:2,low:1}[memory.importance]??0)+overlap;
}
/** Numeric millisecond time; never compare String(Date) forms, whose weekday names reorder months. */
const timeValue=value=>{
  const time=value instanceof Date?value.getTime():Date.parse(value);
  return Number.isFinite(time)?time:0;
};
export function buildPersonalContext(memories,query={}) {
  // Accept either caller input or the normalized query. Optional null IDs are harmless labels.
  const q=contextQuery(Object.fromEntries(Object.entries(query).filter(([k,v])=>v!==null)));
  requireThat(Array.isArray(memories),'invalid_params','Memory list required');
  const ranked=memories.filter(m=>m.status==='active'&&q.types.includes(m.type)&&m.derivation_current!==false&&
    (m.project_id===null||m.project_id===undefined||m.project_id===q.project_id))
    .sort((a,b)=>{
      const byRank=rankMemory(b,q)-rankMemory(a,q);
      if(byRank)return byRank;
      const byTime=timeValue(b.updated_at)-timeValue(a.updated_at);
      if(byTime)return byTime;
      const aId=String(a.id),bId=String(b.id);
      return aId<bId?-1:aId>bId?1:0;
    });
  const result={memories:[],trust:'untrusted-memory-data',selection:'bounded-literal-and-importance-v2',
    confidence_semantics:'caller estimate, not a verified probability; ranking order is not truth',exhaustive:false,dropped:0,budget_bytes:q.budget_bytes};
  for(const row of ranked) {
    if(result.memories.length>=q.limit){result.dropped++;continue;}
    result.memories.push(row);
    if(Buffer.byteLength(JSON.stringify(result))>q.budget_bytes){result.memories.pop();result.dropped++;}
  }
  // The counter itself can gain a digit; trim whole entries, never shorten a negation.
  while(Buffer.byteLength(JSON.stringify(result))>q.budget_bytes&&result.memories.length){result.memories.pop();result.dropped++;}
  return result;
}
