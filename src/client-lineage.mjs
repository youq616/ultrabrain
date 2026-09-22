/** Explicit client direct-source inspection; no capture, model, document or generic dispatch.
 * Reuses the same nine-field lineage semantics as the personal console. Exact reads
 * are bounded/verified before following a reference. This is NOT a snapshot transaction.
 */
import {sha256,requireThat,UltraError} from './core.mjs';
import {objectFields,PERSONAL_MEMORY_TYPES} from './personal-memory.mjs';
import {matchingWorkspace} from './client-profile-file.mjs';
import {assertClientAuthorized} from './client-authorization.mjs';
import {lineageReference,compareLineage,sameLineageRecord} from './personal-lineage-contract.mjs';
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
export function lineageRequest(input,profile){
 requireThat(profile?.expectedInstance&&profile.expectedActor&&profile.workspace,'lineage_disabled','Observed identity pins and workspace required');
 objectFields(input,['memory_id','workspace','consent','include_text']);
 requireThat(input.consent===true,'lineage_consent_required','Explicit source inspection consent required');
 requireThat(uuid(input.memory_id)&&(input.include_text===undefined||typeof input.include_text==='boolean'),'invalid_params','Invalid source inspection selection');
 matchingWorkspace(profile,input.workspace);
 return Object.freeze({memory_id:input.memory_id,workspace:input.workspace,consent:true,include_text:input.include_text===true});
}
/** Verify the complete existing memory_read projection, own a copy, then enforce
 * this client's project boundary. Exact reads may inspect owned inactive entries.
 * Unknown properties are not propagated into stdout or an Agent context.
 */
export function clientLineageRecord(value,id,profile){
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
const metadata=row=>row?Object.fromEntries(['id','type','origin_kind','status','revision','project_id','agent_id',
 'visibility','owned_by_caller','content_hash','derivation_current','updated_at'].map(k=>[k,row[k]])):null;
const safeErrors=new Set(['invalid_profile','missing_credentials','invalid_params','lineage_disabled','lineage_consent_required','workspace_mismatch',
 'lineage_record_unconfirmed','lineage_reference_invalid','lineage_source_invalid','lineage_project_mismatch',
 'lineage_selected_changed','client_authorization_revoked','identity_mismatch','aborted','not_found','permission_denied']);
/** Stable failure projection for CLI/library delivery, never raw transport messages. */
export function clientLineageFailure(error,attempts=0){
 const code=safeErrors.has(error?.code)?error.code:'lineage_read_unconfirmed';
 const started=Math.max(attempts,Number.isSafeInteger(error?.read_attempts)&&error.read_attempts>=0&&error.read_attempts<=3?error.read_attempts:0);
 return Object.assign(new UltraError(code,'Source inspection was not confirmed'),
  {read_delivery:started?'unconfirmed':'not_started',read_attempts:started});
}
/** At most three ID-only reads plus one identity recheck before each read. Callers
 * supply synchronous live authority; per-operation cancellation reaches identity
 * and wire IO. Revocation fences delivery but cannot retract already-sent reads.
 */
export async function deliverClientLineage(input,profile,{checkIdentity,invoke,signal,authorize=()=>{}}){
 let started=0;
 try{
  assertClientAuthorized(authorize,signal);
  const request=lineageRequest(input,profile);
  const allowed=()=>{assertClientAuthorized(authorize,signal);matchingWorkspace(profile,request.workspace);};
  const read=async id=>{
   allowed();await checkIdentity(signal);allowed();
   // Conservative attempt count: a transport may reject before sending bytes.
   started++;const value=await invoke('ultra_memory_read',{memory_id:id},signal);allowed();
   const row=clientLineageRecord(value,id,profile);allowed();return row;
  };
  const memory=await read(request.memory_id),reference=lineageReference(memory);let original=null,verdict;
  if(reference){
   try{original=await read(reference.input_id);}
   catch(error){allowed();if(error.code!=='not_found')throw error;}
   const last=await read(request.memory_id);allowed();
   requireThat(sameLineageRecord(memory,last),'lineage_selected_changed','Selected memory changed while reading its source');
   verdict=original?compareLineage(memory,original):{state:'unavailable',truth_verified:false};
  }else verdict={state:memory.owned_by_caller?'unlinked':'withheld',truth_verified:false};
  const referenceMetadata=reference?Object.fromEntries(Object.entries(reference).filter(([key])=>key!=='quote')):null;
  const result={format:'ultrabrain-client-lineage-v1',source_id:profile.source,read_only:true,
   truth_verified:false,atomic_snapshot:false,memory_writes_requested:false,trust:'untrusted-memory-data',
   read_requests:started,text_included:request.include_text,memory:metadata(memory),reference:referenceMetadata,
   original:metadata(original),verdict,
   limitations:['direct-source-only','separately-timed-observations','absence-is-not-deletion',
    'matching-is-not-truth','metadata-is-private','no-automatic-correction']};
  if(request.include_text)result.text={memory:memory.content,quote:reference?.quote??null,source:original?.content??null};
  allowed();return frozen(result);
 }catch(error){
  // Never echo a remote message, query, source body, token or local filesystem path.
  throw clientLineageFailure(error,started);
 }
}
