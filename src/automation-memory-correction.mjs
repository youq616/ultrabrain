/** Explicit complete replacement via existing owned-record CAS/event semantics.
 * No automatic activation, bulk edits, human authentication or new server journal. */
import {requireThat,UltraError} from './core.mjs';
import {normalizePersonalMemory} from './personal-memory.mjs';
import {candidateData} from './personal-candidates-contract.mjs';
import {parseSnapshotJSON} from './personal-snapshot-contract.mjs';
import {readAutomationMemory} from './automation-memory-inspect.mjs';
const outcomes=new WeakMap();
export const CORRECTION_FIELDS=Object.freeze(['type','content','provenance','importance','confidence','visibility','project_id']);
export const AUTOMATION_CORRECTION_MAX_BYTES=131072;
const fields=['mode','memory_id','scope','event_id','expected_revision','expected_content_hash','expected_status',
 'expected_visibility','expected_project_id','memory','consent','acknowledge_reset','scope_change_consent'];
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const label=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,96}$/.test(v);
/** Require all seven fields: never use normalizer defaults for a replacement. */
export function correctionMemory(value){
 let r;try{r=candidateData(value,CORRECTION_FIELDS);}catch{throw new UltraError('invalid_params','Complete data-only replacement required');}
 requireThat(['low','normal','high'].includes(r.importance)&&['private','source'].includes(r.visibility)&&typeof r.provenance==='string'&&
  (r.confidence===null||typeof r.confidence==='number'&&Number.isFinite(r.confidence))&&(r.project_id===null||label(r.project_id)),
  'invalid_params','Explicit replacement fields required');
 const normalized=normalizePersonalMemory(r);
 return Object.freeze(Object.fromEntries(CORRECTION_FIELDS.map(k=>[k,normalized[k]])));
}
/** The n8n parameter is explicit JSON text, not a blind copy of an input item. */
export function parseCorrectionMemory(value){
 requireThat(typeof value==='string'&&value.isWellFormed()&&Buffer.byteLength(value)<=AUTOMATION_CORRECTION_MAX_BYTES,
  'invalid_params','Bounded replacement JSON text required');
 let parsed;try{parsed=parseSnapshotJSON(value);}catch{throw new UltraError('invalid_params','Unambiguous replacement JSON required');}
 return correctionMemory(parsed);
}
export function automationMemoryCorrectionRequest(input,settings){
 requireThat(!settings.rootSlug,'scope_denied','Use a source-root credential');
 requireThat(uuid(settings.expectedInstance)&&typeof settings.expectedActor==='string'&&/^[a-f0-9]{64}$/.test(settings.expectedActor),
  'memory_correction_disabled','Observed instance and actor pins required');
 requireThat(settings.allowMemoryCorrection===true,'memory_correction_disabled','Enable correction separately in the credential');
 let r;try{r=candidateData(input,fields);}catch{throw new UltraError('invalid_params','Exact correction selection required');}
 requireThat(['apply','replay'].includes(r.mode)&&uuid(r.memory_id)&&label(r.event_id)&&['global-only','global-and-project'].includes(r.scope)&&
  Number.isSafeInteger(r.expected_revision)&&r.expected_revision>=1&&r.expected_revision<=2147483646&&
  typeof r.expected_content_hash==='string'&&/^[a-f0-9]{64}$/.test(r.expected_content_hash)&&
  ['candidate','active','archived'].includes(r.expected_status)&&['private','source'].includes(r.expected_visibility)&&
  (r.expected_project_id===null||label(r.expected_project_id))&&typeof r.scope_change_consent==='boolean',
  'invalid_params','Complete observed version and correction selection required');
 requireThat(r.consent===true&&r.acknowledge_reset===true,'memory_correction_consent_required',
  'Consent to replacement and resetting candidate status, derivation and confirmation required');
 const project=settings.correctionProject??'';
 requireThat(project===''||label(project),'invalid_params','Invalid correction project credential');
 requireThat(r.scope!=='global-and-project'||project!=='','memory_correction_project_required','Configure the correction project');
 r.memory=correctionMemory(r.memory);
 const inScope=p=>p===null||r.scope==='global-and-project'&&p===project;
 requireThat(inScope(r.expected_project_id)&&inScope(r.memory.project_id),'memory_correction_project_mismatch','Both projects must be in the chosen scope');
 if(r.expected_project_id!==r.memory.project_id||r.expected_visibility!==r.memory.visibility)
  requireThat(settings.allowCorrectionScopeChange===true&&r.scope_change_consent===true,'memory_correction_scope_consent_required',
   'Changing project or visibility needs a separate credential grant and explicit consent');
 requireThat(Buffer.byteLength(JSON.stringify(r))<=AUTOMATION_CORRECTION_MAX_BYTES,'invalid_params','Correction request exceeds bound');
 return Object.freeze(r);
}
const safeCodes=new Set(['invalid_params','invalid_credentials','invalid_uri','scope_denied','identity_mismatch','identity_rejected',
 'mcp_contract_changed','cancelled','connection_failed','invalid_endpoint','insecure_endpoint','invalid_token','not_found','permission_denied',
 'insufficient_scope','conflict','revision_conflict','memory_correction_disabled','memory_correction_consent_required',
 'memory_correction_project_required','memory_correction_project_mismatch','memory_correction_scope_consent_required',
 'memory_correction_selected_changed','memory_correction_no_change','memory_correction_replay_unavailable','memory_correction_receipt_unconfirmed',
 'memory_correction_single_item_required','memory_correction_cleanup_failed','memory_inspect_unconfirmed','memory_inspect_project_mismatch',
 'memory_inspect_not_owned','memory_inspect_document_bound']);
const empty=()=>({read_attempts:0,write_attempts:0,write_delivery:'not_started'});
/** Only local outcomes survive wrappers; remote exceptions cannot forge write facts. */
export function automationMemoryCorrectionError(error,prior){
 let code;try{code=Object.getOwnPropertyDescriptor(error,'code')?.value;}catch{}
 const state=outcomes.get(prior)??outcomes.get(error)??empty();
 const safe=Object.assign(new UltraError(safeCodes.has(code)?code:'memory_correction_unconfirmed','Memory correction was not confirmed'),{
  read_delivery:state.read_attempts?'unconfirmed':'not_started',write_delivery:state.write_delivery,
  write_attempts:state.write_attempts,memory_writes_requested:state.write_attempts>0});
 outcomes.set(safe,Object.freeze({...state}));return safe;
}
export function automationMemoryCorrectionFailure(error,prior){
 const e=automationMemoryCorrectionError(error,prior);
 return {ok:false,error:e.code,read_delivery:e.read_delivery,write_delivery:e.write_delivery,
  write_attempts:e.write_attempts,memory_writes_requested:e.memory_writes_requested};
}
function receipt(wire,r){
 let value,isError;
 try{
  const v=candidateData(wire,['content'],['isError']);
  requireThat(v.isError===undefined||typeof v.isError==='boolean','invalid_params','Boolean error flag required');
  requireThat(Array.isArray(v.content),'invalid_params','Content array required');const d=Object.getOwnPropertyDescriptors(v.content);
  requireThat(Reflect.ownKeys(d).length===2&&d.length?.value===1&&d[0]?.enumerable&&Object.hasOwn(d[0],'value'),'invalid_params','One text result required');
  const part=candidateData(d[0].value,['type','text']);
  requireThat(part.type==='text'&&typeof part.text==='string'&&Buffer.byteLength(part.text)<=8192,'invalid_params','Bounded receipt required');
  value=parseSnapshotJSON(part.text);isError=v.isError===true;
 }catch{throw new UltraError('memory_correction_receipt_unconfirmed','Correction receipt was not confirmed');}
 if(isError){
  const code=Object.getOwnPropertyDescriptor(value??{},'error')?.value;
  throw new UltraError(['not_found','permission_denied','insufficient_scope','conflict','revision_conflict'].includes(code)?code:'memory_correction_receipt_unconfirmed','Correction rejected');
 }
 try{
  const v=candidateData(value,['id','revision','status','replayed','review_required']);
  requireThat(v.id===r.memory_id&&v.revision===r.expected_revision+1&&v.status==='candidate'&&v.review_required===true&&
   typeof v.replayed==='boolean'&&(r.mode!=='replay'||v.replayed===true),'invalid_params','Matching correction receipt required');
  return Object.freeze({id:v.id,revision:v.revision,status:v.status,replayed:v.replayed,review_required:true});
 }catch{throw new UltraError('memory_correction_receipt_unconfirmed','Correction receipt was not confirmed');}
}
export async function runAutomationMemoryCorrection(client,input,settings,{signal,checkIdentity}={}){
 const state=empty();const allowed=()=>requireThat(!signal?.aborted,'cancelled','Correction cancelled');
 const identify=async()=>{allowed();await checkIdentity();allowed();};
 try{
  allowed();const r=automationMemoryCorrectionRequest(input,settings);
  const readSettings=Object.freeze({...settings,inspectProject:settings.correctionProject??''});
  await identify();state.read_attempts=1;
  // Text is needed for exact no-op detection; it is never placed in the result.
  const observed=await readAutomationMemory(client,{memory_id:r.memory_id,scope:r.scope,consent:true,include_text:true},readSettings,{signal});
  allowed();const row=observed.memory;
  requireThat(row.project_id===(r.mode==='replay'?r.memory.project_id:r.expected_project_id),
   'memory_correction_project_mismatch','Observed project differs from the selected source or replay destination');
  if(r.mode==='apply'){
   requireThat(row.revision===r.expected_revision&&row.content_hash===r.expected_content_hash&&row.status===r.expected_status&&row.visibility===r.expected_visibility,
    'memory_correction_selected_changed','Record changed; inspect and consent again');
   const current={...row,content:observed.text.content,provenance:observed.text.provenance};
   requireThat(CORRECTION_FIELDS.some(k=>current[k]!==r.memory[k]),'memory_correction_no_change','No replacement field changed');
  }else requireThat(row.revision>r.expected_revision,'memory_correction_replay_unavailable','Replay requires an advanced revision');
  await identify();
  const args=Object.freeze({memory_id:r.memory_id,expected_revision:r.expected_revision,event_id:r.event_id,memory:r.memory});
  state.write_attempts=1;state.write_delivery='unconfirmed';
  const response=await client.callTool({name:'ultra_personal_update',arguments:args},undefined,{signal,timeout:settings.timeoutMs});
  allowed();const ack=receipt(response,r);state.write_delivery='confirmed';await identify();
  const result=Object.freeze({format:'ultrabrain-automation-memory-correction-v1',mode:r.mode,source_id:settings.source,event_id:r.event_id,
   observed_revision:row.revision,receipt:ack,read_requests:1,write_requests:1,write_delivery:'confirmed',memory_writes_requested:true,
   text_included:false,current_state_verified:false,truth_verified:false,human_identity_verified:false,review_required:true,
   limitations:Object.freeze(['full-record-read-before-local-scope-check','correction-resets-candidate-derivation-confirmation',
    'explicit-caller-consent-not-human-authentication','receipt-is-not-current-state','server-event-does-not-bind-extra-observation-pins',
    'no-automatic-activation-retry-or-bulk-correction','metadata-is-private'])});
  outcomes.set(result,Object.freeze({...state}));return result;
 }catch(error){const carrier={};outcomes.set(carrier,Object.freeze({...state}));throw automationMemoryCorrectionError(error,carrier);}
}
