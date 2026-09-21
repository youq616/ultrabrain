/** Browser/Node shared logical export contract. No IO, permissions or model authority. */
export const SNAPSHOT_FORMAT='ultrabrain-owned-memories-v1';
export const SNAPSHOT_SCOPE='owned-memories-all-states';
export const SNAPSHOT_MAX_RECORDS=1000;
export const SNAPSHOT_MAX_BYTES=8388608;
export const SNAPSHOT_EXCLUDES=Object.freeze(['other-owners','document-original-bytes','jobs-and-event-history','host-configuration-and-credentials']);
const encoder=new TextEncoder();
const bytes=value=>encoder.encode(value).length;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const date=value=>{
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))return false;
  const time=Date.parse(value);return Number.isFinite(time)&&new Date(time).toISOString()===value;
};
const string=(value,max)=>typeof value==='string'&&value.isWellFormed()&&bytes(value)<=max;
const fields=['id','type','origin_kind','content','content_hash','confidence','importance','provenance','agent_id','project_id',
  'status','visibility','revision','created_at','updated_at','last_confirmed','owned_by_caller','derivation','derivation_current','trust'];
const exactKeys=(value,names)=>object(value)&&Object.keys(value).length===names.length&&names.every(k=>Object.hasOwn(value,k));
/** The injected digest accepts a UTF-8 string and returns a hex string or a promise.
 * Checkpoints run around asynchronous work so a browser can revoke local delivery.
 * A matching digest proves consistency, not authenticity or completeness of a hostile server.
 */
export async function verifyMemorySnapshot(result,request,source,hash,checkpoint=()=>{}) {
  const valid=condition=>{if(!condition)throw Object.assign(new Error('memory_snapshot_unconfirmed'),{code:'memory_snapshot_unconfirmed'});};
  checkpoint();
  valid(exactKeys(result,['format','scope','source_id','request_id','snapshot_at','read_only','complete','record_count','excluded','memories','memories_sha256']));
  valid(result.format===SNAPSHOT_FORMAT&&result.scope===SNAPSHOT_SCOPE&&result.source_id===source&&
    uuid(request.request_id)&&result.request_id===request.request_id&&date(result.snapshot_at)&&
    result.read_only===true&&result.complete===true&&Array.isArray(result.memories)&&
    Number.isSafeInteger(result.record_count)&&result.record_count===result.memories.length&&result.record_count<=SNAPSHOT_MAX_RECORDS&&
    JSON.stringify(result.excluded)===JSON.stringify(SNAPSHOT_EXCLUDES)&&digest(result.memories_sha256)&&
    bytes(JSON.stringify(result))<=SNAPSHOT_MAX_BYTES);
  let previous='';
  for(const row of result.memories){
    valid(exactKeys(row,fields)&&uuid(row.id)&&row.id>previous&&row.owned_by_caller===true&&row.trust==='untrusted-memory-data');
    previous=row.id;
    valid(string(row.type,32)&&/^[a-z_]+$/.test(row.type)&&['agent','document_fragment'].includes(row.origin_kind)&&
      string(row.content,65536)&&digest(row.content_hash)&&string(row.provenance,2048)&&
      ['candidate','active','archived'].includes(row.status)&&['private','source'].includes(row.visibility)&&
      ['low','normal','high'].includes(row.importance)&&Number.isSafeInteger(row.revision)&&row.revision>=1&&row.revision<=2147483647&&
      (row.confidence===null||typeof row.confidence==='number'&&Number.isFinite(row.confidence)&&row.confidence>=0&&row.confidence<=1)&&
      string(row.agent_id,96)&&/^[A-Za-z0-9_-]+$/.test(row.agent_id)&&
      (row.project_id===null||string(row.project_id,96)&&/^[A-Za-z0-9_-]+$/.test(row.project_id))&&
      date(row.created_at)&&date(row.updated_at)&&(row.last_confirmed===null||date(row.last_confirmed))&&
      typeof row.derivation_current==='boolean'&&(row.derivation===null||object(row.derivation)&&bytes(JSON.stringify(row.derivation))<=16384));
    checkpoint();const actual=await hash(row.content);checkpoint();valid(actual===row.content_hash);
  }
  const actual=await hash(JSON.stringify(result.memories));checkpoint();valid(actual===result.memories_sha256);
  return result;
}
