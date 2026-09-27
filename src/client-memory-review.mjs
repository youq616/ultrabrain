/** Explicit single-record inspection, activation/archive and replay. No model or bulk actions. */
import {requireThat,UltraError} from './core.mjs';
import {memoryId,personalId,normalizePersonalMemory} from './personal-memory.mjs';
import {clientLineageRecord} from './client-lineage.mjs';
import {matchingWorkspace} from './client-profile-file.mjs';
import {assertClientAuthorized} from './client-authorization.mjs';
const evidence=new WeakMap();
const common=['operation','memory_id','workspace','consent'];
const pins=['event_id','expected_revision','expected_content_hash','expected_status','expected_visibility','expected_project_id','status'];
export const MEMORY_REVIEW_INPUT_MAX_BYTES=131072;
const editableFields=Object.freeze(['type','content','provenance','importance','confidence','visibility','project_id']);
const correction=r=>['correct','replay-correction'].includes(r.operation);
const replay=r=>['replay','replay-correction'].includes(r.operation);
const metaKeys=['id','type','origin_kind','status','revision','content_hash','visibility','project_id','owned_by_caller','derivation_current','importance','confidence'];
const freeze=v=>{if(v&&typeof v==='object'&&!Object.isFrozen(v)){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
function exactData(value,required,optional=[]){
 try{
  requireThat(value&&typeof value==='object'&&!Array.isArray(value),'invalid_params','Object required');
  const d=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(d);
  requireThat(required.every(k=>keys.includes(k))&&keys.every(k=>[...required,...optional].includes(k)&&d[k].enumerable&&Object.hasOwn(d[k],'value')),
   'invalid_params','Exact data fields required');
  return Object.fromEntries(keys.map(k=>[k,d[k].value]));
 }catch{throw new UltraError('invalid_params','Exact data fields required');}
}
function workspaceAllowed(profile,path){
 try{matchingWorkspace(profile,path);}catch{throw new UltraError('workspace_mismatch','Bound workspace unavailable or changed');}
}
export function memoryReviewRequest(input,profile){
 requireThat(profile?.expectedInstance&&profile.expectedActor&&profile.workspace,'memory_review_disabled','Observed identity pins and workspace required');
 const r=exactData(input,common,['include_text',...pins,'memory','acknowledge_reset']);
 requireThat(['inspect','apply','replay','correct','replay-correction'].includes(r.operation),'invalid_params','Choose an explicit supported operation');
 requireThat(r.consent===true,'memory_review_consent_required','Explicit per-record consent required');
 memoryId(r.memory_id);workspaceAllowed(profile,r.workspace);
 if(r.operation==='inspect'){
  exactData(input,common,['include_text']);
  requireThat(r.include_text===undefined||typeof r.include_text==='boolean','invalid_params','Explicit text disclosure required');
  return Object.freeze({...r,include_text:r.include_text===true});
 }
 exactData(input,[...common,...(correction(r)?pins.filter(k=>k!=='status'):pins),...(correction(r)?['memory','acknowledge_reset']:[])]);
 requireThat(profile.allowCapture===true,'memory_review_disabled','Existing personal write opt-in required');
 personalId(r.event_id,'event_id');
 requireThat(Number.isSafeInteger(r.expected_revision)&&r.expected_revision>=1&&r.expected_revision<=2147483646&&
  typeof r.expected_content_hash==='string'&&/^[a-f0-9]{64}$/.test(r.expected_content_hash)&&
  ['candidate','active','archived'].includes(r.expected_status)&&['private','source'].includes(r.expected_visibility)&&
  (correction(r)||['active','archived'].includes(r.status)),'invalid_params','Complete observed version and lifecycle selection required');
 if(r.expected_project_id!==null)personalId(r.expected_project_id,'expected_project_id');
 requireThat(r.expected_project_id===null||r.expected_project_id===profile.projectId,'memory_review_project_mismatch','Selection outside the client project');
 if(correction(r)){
  requireThat(r.acknowledge_reset===true,'memory_correction_reset_required','Correction returns to candidate and clears derivation and confirmation');
  const selected=exactData(r.memory,editableFields);
  // Never default missing/undefined edit fields: omission could accidentally
  // clear confidence/project or change visibility during a full replacement.
  requireThat(selected.confidence===null||typeof selected.confidence==='number'&&Number.isFinite(selected.confidence),
   'invalid_params','Explicit confidence value required');
  requireThat(['low','normal','high'].includes(selected.importance)&&['private','source'].includes(selected.visibility)&&
   typeof selected.provenance==='string'&&(selected.project_id===null||typeof selected.project_id==='string'),
   'invalid_params','Explicit editable fields required');
  const normalized=normalizePersonalMemory(selected);
  requireThat(normalized.project_id===null||normalized.project_id===profile.projectId,
   'memory_review_project_mismatch','Replacement outside the bound client project');
  r.memory=Object.freeze(Object.fromEntries(editableFields.map(k=>[k,normalized[k]])));
  requireThat(Buffer.byteLength(JSON.stringify(r))<=MEMORY_REVIEW_INPUT_MAX_BYTES,'input_too_large','Correction request exceeds bound');
 }
 return Object.freeze(r);
}
/** Snapshot data descriptors before the shared validator. Official JSON has no
 * accessors, but a programmatic transport seam must not run them while checking. */
function responseData(value){
 let nodes=0,bytes=0;const seen=new Set();
 const copy=(v,depth)=>{
  requireThat(++nodes<=20000&&depth<=32,'lineage_record_unconfirmed','Response data exceeds bounds');
  if(v===null||typeof v==='boolean')return v;
  if(typeof v==='string'){bytes+=Buffer.byteLength(v);requireThat(bytes<=1048576,'lineage_record_unconfirmed','Response data exceeds bounds');return v;}
  if(typeof v==='number'){requireThat(Number.isFinite(v),'lineage_record_unconfirmed','Finite JSON data required');return v;}
  requireThat(v&&typeof v==='object'&&!seen.has(v),'lineage_record_unconfirmed','JSON data required');seen.add(v);
  const d=Object.getOwnPropertyDescriptors(v),array=Array.isArray(v),keys=Reflect.ownKeys(d);
  requireThat(keys.length<=20001,'lineage_record_unconfirmed','Response data exceeds bounds');
  let result;
  if(array){
   const length=d.length?.value;requireThat(Number.isSafeInteger(length)&&length>=0&&length<=20000&&keys.length===length+1,'lineage_record_unconfirmed','Dense JSON array required');
   result=Array.from({length},(_,i)=>{const p=d[i];requireThat(p?.enumerable&&Object.hasOwn(p,'value'),'lineage_record_unconfirmed','Data fields required');return copy(p.value,depth+1);});
  }else result=Object.fromEntries(keys.map(k=>{
   requireThat(typeof k==='string'&&d[k].enumerable&&Object.hasOwn(d[k],'value'),'lineage_record_unconfirmed','Data fields required');
   bytes+=Buffer.byteLength(k);return [k,copy(d[k].value,depth+1)];
  }));
  seen.delete(v);return result;
 };
 try{return copy(value,0);}catch{throw new UltraError('lineage_record_unconfirmed','Exact read data was not confirmed');}
}
function receipt(value,r){
 try{
  const edit=correction(r),v=exactData(value,['id','revision','status','replayed',edit?'review_required':'assurance']);
  requireThat(v.id===r.memory_id&&v.revision===r.expected_revision+1&&v.status===(edit?'candidate':r.status)&&
   typeof v.replayed==='boolean'&&(!replay(r)||v.replayed===true)&&
   (edit?v.review_required===true:typeof v.assurance==='string'&&Buffer.byteLength(v.assurance)<=2048),
   'memory_review_receipt_unconfirmed','Invalid acknowledgement');
  return Object.freeze({id:v.id,revision:v.revision,status:v.status,replayed:v.replayed,...(edit?{review_required:true}:{})});
 }catch{throw new UltraError('memory_review_receipt_unconfirmed','Review acknowledgement was not confirmed');}
}
const safeCodes=new Set(['memory_correction_reset_required','memory_correction_no_change','invalid_params','invalid_profile','insecure_profile','missing_credentials','identity_mismatch','workspace_mismatch',
 'client_authorization_revoked','aborted','input_too_large','memory_review_disabled','memory_review_consent_required','memory_review_project_mismatch',
 'memory_review_selected_changed','memory_review_not_owned','memory_review_document_bound','memory_review_stale_source','memory_review_no_change',
 'memory_review_replay_unavailable','memory_review_receipt_unconfirmed','memory_review_cleanup_failed','lineage_record_unconfirmed',
 'insufficient_scope','lineage_project_mismatch','lineage_reference_invalid','lineage_source_invalid','not_found','permission_denied','conflict','revision_conflict']);
function failure(error,state){
 let code;try{code=Object.getOwnPropertyDescriptor(error,'code')?.value;}catch{}
 const e=Object.assign(new UltraError(safeCodes.has(code)?code:'memory_review_unconfirmed','Memory review was not confirmed'),{
  read_attempts:state.read_attempts,write_attempts:state.write_attempts,write_delivery:state.write_delivery,
  read_delivery:state.read_attempts?'unconfirmed':'not_started',memory_writes_requested:state.write_attempts>0});
 evidence.set(e,Object.freeze({...state}));return e;
}
/** Preserve only local outcomes across wrappers/cleanup, never remote-supplied counters. */
export function memoryReviewFailure(error,prior){
 return failure(error,evidence.get(prior)??evidence.get(error)??{read_attempts:0,write_attempts:0,write_delivery:'not_started'});
}
export async function deliverMemoryReview(input,profile,{checkIdentity,invoke,signal,authorize=()=>{}}){
 const state={read_attempts:0,write_attempts:0,write_delivery:'not_started'};
 try{
  assertClientAuthorized(authorize,signal);const r=memoryReviewRequest(input,profile);
  const allowed=()=>{assertClientAuthorized(authorize,signal);workspaceAllowed(profile,r.workspace);};
  allowed();await checkIdentity(signal);allowed();
  state.read_attempts++;const value=await invoke('ultra_memory_read',{memory_id:r.memory_id},signal);allowed();
  // Official transport provides decoded JSON; reuse the canonical exact-read validator.
  const row=clientLineageRecord(responseData(value),r.memory_id,profile);allowed();
  let result;
  if(r.operation==='inspect'){
   result={format:'ultrabrain-client-memory-review-v1',operation:r.operation,source_id:profile.source,
    memory:Object.fromEntries(metaKeys.map(k=>[k,row[k]])),text_included:r.include_text,read_requests:1,write_requests:0,
    memory_writes_requested:false,current_state_verified:false,truth_verified:false};
   if(r.include_text)result.text={content:row.content,provenance:row.provenance,derivation:row.derivation};
  }else{
   requireThat(row.owned_by_caller===true,'memory_review_not_owned','Shared visibility is not write ownership');
   requireThat(row.origin_kind==='agent','memory_review_document_bound','Use the document lifecycle interface');
   requireThat(row.project_id===(r.operation==='replay-correction'?r.memory.project_id:r.expected_project_id),
    'memory_review_project_mismatch','Project differs from the selected version or replay destination');
   if(!replay(r)){
    requireThat(row.revision===r.expected_revision&&row.content_hash===r.expected_content_hash&&row.status===r.expected_status&&
     row.visibility===r.expected_visibility,'memory_review_selected_changed','Record changed; inspect and obtain new consent');
    if(correction(r))requireThat(editableFields.some(k=>row[k]!==r.memory[k]),'memory_correction_no_change','No editable field changed');
    else{
     requireThat(row.status!==r.status,'memory_review_no_change','Already in selected state');
     requireThat(r.status!=='active'||row.derivation_current,'memory_review_stale_source','Reconcile stale source before activation');
    }
   }else{
    // A strictly greater current revision means the server CAS cannot execute a
    // new mutation. Only an already journaled exact event can return a receipt.
    requireThat(row.revision>r.expected_revision,'memory_review_replay_unavailable','No advanced revision; use original apply only after inspection');
   }
   allowed();await checkIdentity(signal);allowed();
   const wire={memory_id:r.memory_id,expected_revision:r.expected_revision,event_id:r.event_id,
    ...(correction(r)?{memory:r.memory}:{status:r.status})};
   state.write_attempts=1;state.write_delivery='unconfirmed';
   const response=correction(r)?await invoke('ultra_personal_update',wire,signal):await invoke('ultra_personal_review',wire,signal);allowed();
   const ack=receipt(response,r);state.write_delivery='confirmed';
   result={format:'ultrabrain-client-memory-review-v1',operation:r.operation,source_id:profile.source,event_id:r.event_id,
    observed_revision:row.revision,receipt:ack,read_requests:1,write_requests:1,write_delivery:'confirmed',
    memory_writes_requested:true,current_state_verified:false,truth_verified:false,text_included:false};
  }
  await checkIdentity(signal);allowed();
  if(correction(r))result.review_required=true;
  result.limitations=[...(correction(r)?['correction-clears-derivation-and-confirmation','replay-does-not-certify-historical-extra-pins']:[]),'explicit-caller-review-not-truth','receipt-is-not-current-state','no-automatic-retry-or-bulk-actions','metadata-is-private'];
  freeze(result);evidence.set(result,Object.freeze({...state}));return result;
 }catch(error){throw failure(error,state);}
}
