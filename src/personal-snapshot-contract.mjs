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

// Local-file inspection reuses the export verifier; it never asserts provenance.
// Pretty-printed exports may exceed the compact envelope's 8 MiB budget.
export const SNAPSHOT_FILE_MAX_BYTES=16777216;
const inspectedFiles=new WeakSet();
function inspectionError(code){return Object.assign(new Error(code),{code});}
/** Reject duplicate keys (including escaped aliases) and excessive nesting BEFORE
 * JSON.parse/stringification. JSON syntax is still checked by the native parser.
 * Strings are skipped as a unit, so braces/colons inside content are not structure.
 */
function boundedSnapshotJSON(text){
  const stack=[];
  for(let i=0;i<text.length;i++){
    const ch=text[i];
    if(ch==='"'){
      const start=i++;
      for(;i<text.length;i++){
        if(text[i]==='\\'){i++;continue;}
        if(text[i]==='"')break;
      }
      if(i>=text.length)throw inspectionError('snapshot_file_invalid_json');
      let next=i+1;while(/[\x20\t\r\n]/.test(text[next]??'!'))next++;
      if(text[next]===':'&&stack.at(-1) instanceof Set){
        let key;try{key=JSON.parse(text.slice(start,i+1));}catch{throw inspectionError('snapshot_file_invalid_json');}
        const keys=stack.at(-1);if(keys.has(key))throw inspectionError('snapshot_file_duplicate_key');keys.add(key);
      }
    }else if(ch==='{'||ch==='['){
      stack.push(ch==='{'?new Set():null);
      if(stack.length>32)throw inspectionError('snapshot_file_too_deep');
    }else if(ch==='}'||ch===']')stack.pop();
  }
  try{return JSON.parse(text);}catch{throw inspectionError('snapshot_file_invalid_json');}
}
function freezeSnapshot(value){
  const todo=[value];
  while(todo.length){const v=todo.pop();if(v&&typeof v==='object'&&!Object.isFrozen(v)){todo.push(...Object.values(v));Object.freeze(v);}}
  return value;
}
/** Inspect only caller-supplied bytes. No filesystem, HTTP, model or mutation API.
 * IDs/source/request fields in a local file are self-declarations, not credentials.
 */
export async function inspectMemorySnapshotFile(data,hash,checkpoint=()=>{}){
  checkpoint();
  if(!ArrayBuffer.isView(data)||data.BYTES_PER_ELEMENT!==1||!Number.isSafeInteger(data.byteLength)||
    data.byteLength<1||data.byteLength>SNAPSHOT_FILE_MAX_BYTES)throw inspectionError('snapshot_file_size');
  // Own a copy across hash awaits; changing the caller's buffer cannot alter verified data.
  const copy=new Uint8Array(data.buffer,data.byteOffset,data.byteLength).slice();
  let text;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(copy);}
  catch{throw inspectionError('snapshot_file_invalid_utf8');}
  const snapshot=boundedSnapshotJSON(text.startsWith('\ufeff')?text.slice(1):text);
  if(!object(snapshot)||!string(snapshot.source_id,256)||!snapshot.source_id.length)
    throw inspectionError('memory_snapshot_unconfirmed');
  await verifyMemorySnapshot(snapshot,{request_id:snapshot.request_id},snapshot.source_id,hash,checkpoint);checkpoint();
  const fileHash=await hash(text);checkpoint();
  if(!digest(fileHash))throw inspectionError('memory_snapshot_unconfirmed');
  const result=freezeSnapshot({snapshot,file_sha256:fileHash,file_bytes:copy.byteLength});
  inspectedFiles.add(result);return result;
}
// Semantic JSON equality ignores object insertion order, not array order or text bytes.
// Input depth was bounded during inspection; own-property iteration is prototype-safe.
function orderedJSON(value){
  if(value===null||typeof value!=='object')return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(orderedJSON).join(',')+']';
  return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+orderedJSON(value[k])).join(',')+'}';
}
/** Compare two inspected immutable files, never the live database. All states and
 * projects remain included. No chronology, deletion, ownership or restore inference.
 */
export function compareMemorySnapshots(left,right){
  if(!inspectedFiles.has(left)||!inspectedFiles.has(right))throw inspectionError('snapshot_not_inspected');
  const a=left.snapshot,b=right.snapshot;
  if(a.source_id!==b.source_id)throw inspectionError('snapshot_source_mismatch');
  const l=new Map(a.memories.map(r=>[r.id,r])),r=new Map(b.memories.map(r=>[r.id,r]));
  const counts={left_only:0,right_only:0,changed:0,unchanged:0},differences=[];
  for(const id of [...new Set([...l.keys(),...r.keys()])].sort()){
    const old=l.get(id),now=r.get(id);let kind,changed=[];
    if(!old)kind='right_only';else if(!now)kind='left_only';
    else {changed=fields.filter(k=>orderedJSON(old[k])!==orderedJSON(now[k])).sort();kind=changed.length?'changed':'unchanged';}
    counts[kind]++;if(kind!=='unchanged')differences.push({id,kind,fields:changed});
  }
  const summary=f=>({request_id:f.snapshot.request_id,snapshot_at:f.snapshot.snapshot_at,
    record_count:f.snapshot.record_count,file_sha256:f.file_sha256,memories_sha256:f.snapshot.memories_sha256});
  return freezeSnapshot({format:'ultrabrain-snapshot-comparison-v1',read_only:true,identity_verified:false,
    source_id:a.source_id,left:summary(left),right:summary(right),counts,differences,
    limitations:['local-file-comparison-only','unsigned-self-declared-owner','absence-is-not-deletion',
      'no-live-database-check','not-a-restore-plan','ids-and-hashes-are-private-metadata']});
}
