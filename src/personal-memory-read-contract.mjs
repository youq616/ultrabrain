/** Canonical exact-read verifier shared by personal clients and automation. No IO. */
import {sha256,requireThat} from './core.mjs';
import {PERSONAL_MEMORY_TYPES} from './personal-memory.mjs';
import {lineageReference} from './personal-lineage-contract.mjs';
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const text=(v,max)=>typeof v==='string'&&v.isWellFormed()&&Buffer.byteLength(v)<=max;
const label=v=>text(v,96)&&/^[A-Za-z0-9_-]+$/.test(v);
const date=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)&&
 Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const recordFields=['id','type','origin_kind','content','content_hash','confidence','importance','provenance','agent_id','project_id',
 'status','visibility','revision','created_at','updated_at','last_confirmed','owned_by_caller','derivation','derivation_current','trust'];
const exact=(v,fields)=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===fields.length&&fields.every(k=>Object.hasOwn(v,k));
function frozen(value){
 if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const child of Object.values(value))frozen(child);Object.freeze(value);}return value;
}
/** Verify the complete existing memory_read projection, own a copy, then enforce
 * this client's project boundary. Exact reads may inspect owned inactive entries.
 * Unknown properties are not propagated into stdout or an Agent context.
 */
export function verifyPersonalMemoryRead(value,id,profile){
 const valid=c=>requireThat(c,'lineage_record_unconfirmed','Exact memory read contract invalid');
 valid(exact(value,['source_id','memory','trust','read_only','coverage'])&&value.source_id===profile.source&&
  value.read_only===true&&value.trust==='untrusted-memory-data'&&text(value.coverage,2048));
 let size;try{size=Buffer.byteLength(JSON.stringify(value));}catch{valid(false);}
 valid(size<=1048576);
 const row=value.memory;
 valid(exact(row,recordFields)&&uuid(id)&&row.id===id&&PERSONAL_MEMORY_TYPES.includes(row.type)&&
  ['agent','document_fragment'].includes(row.origin_kind)&&['candidate','active','archived'].includes(row.status)&&
  ['low','normal','high'].includes(row.importance)&&['private','source'].includes(row.visibility)&&
  Number.isSafeInteger(row.revision)&&row.revision>=1&&row.revision<=2147483647&&
  typeof row.owned_by_caller==='boolean'&&typeof row.derivation_current==='boolean'&&row.trust==='untrusted-memory-data'&&
  (row.owned_by_caller||row.visibility==='source'&&row.status==='active'&&row.derivation_current&&row.derivation===null)&&
  text(row.content,65536)&&row.content.trim()&&!row.content.includes('\0')&&digest(row.content_hash)&&
  text(row.provenance,2048)&&label(row.agent_id)&&(row.project_id===null||label(row.project_id))&&
  (row.confidence===null||typeof row.confidence==='number'&&Number.isFinite(row.confidence)&&row.confidence>=0&&row.confidence<=1)&&
  date(row.created_at)&&date(row.updated_at)&&(row.last_confirmed===null||date(row.last_confirmed)));
 valid(sha256(row.content)===row.content_hash);
 requireThat(row.project_id===null||row.project_id===profile.projectId,'lineage_project_mismatch','Record is outside the client project');
 // Validate every structured field before copying/following; bounds also exclude
 // cyclic/deep/non-finite derivations, while shared rows must withhold derivation.
 lineageReference(row);
 return frozen(structuredClone(row));
}
