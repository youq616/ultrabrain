/** Explicit single-memory state transition through existing owned-record CAS/events.
 * No bulk decisions, model, filesystem, reason journal or caller-defined reviewer identity. */
import {requireThat,UltraError} from './core.mjs';
import {candidateData} from './personal-candidates-contract.mjs';
import {parseSnapshotJSON} from './personal-snapshot-contract.mjs';
import {readAutomationMemory} from './automation-memory-inspect.mjs';
const outcomes=new WeakMap();
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const label=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,96}$/.test(v);
const fields=['mode','action','memory_id','scope','event_id','expected_revision','expected_content_hash',
 'expected_status','expected_visibility','expected_project_id','consent','acknowledge_effects','shared_consent'];
export function automationMemoryReviewRequest(input,settings){
 requireThat(!settings.rootSlug,'scope_denied','Use a source-root credential');
 requireThat(uuid(settings.expectedInstance)&&typeof settings.expectedActor==='string'&&/^[a-f0-9]{64}$/.test(settings.expectedActor),
  'memory_review_disabled','Observed instance and actor pins required');
 let r;try{r=candidateData(input,fields);}catch{throw new UltraError('invalid_params','Exact review selection required');}
 requireThat(['apply','replay'].includes(r.mode)&&['active','archived'].includes(r.action)&&uuid(r.memory_id)&&label(r.event_id)&&
  ['global-only','global-and-project'].includes(r.scope)&&Number.isSafeInteger(r.expected_revision)&&r.expected_revision>=1&&r.expected_revision<=2147483646&&
  typeof r.expected_content_hash==='string'&&/^[a-f0-9]{64}$/.test(r.expected_content_hash)&&
  ['candidate','active','archived'].includes(r.expected_status)&&['private','source'].includes(r.expected_visibility)&&
  (r.expected_project_id===null||label(r.expected_project_id))&&typeof r.shared_consent==='boolean',
  'invalid_params','Complete observed version and explicit lifecycle selection required');
 requireThat(r.consent===true&&r.acknowledge_effects===true,'memory_review_consent_required','Explicit version-bound action consent and effects acknowledgement required');
 requireThat((r.action==='active'?settings.allowMemoryActivation:settings.allowMemoryArchive)===true,
  'memory_review_disabled','Enable this action separately in the credential');
 const project=settings.reviewProject??'';
 requireThat(typeof project==='string'&&(project===''||label(project)),'invalid_params','Invalid credential review project');
 requireThat(r.scope!=='global-and-project'||project!=='','memory_review_project_required','Configure the review project');
 requireThat(r.expected_project_id===null||r.scope==='global-and-project'&&r.expected_project_id===project,
  'memory_review_project_mismatch','Expected project is outside the chosen credential scope');
 if(r.action==='active'&&r.expected_visibility==='source')requireThat(settings.allowSourceActivation===true&&r.shared_consent===true,
  'memory_review_shared_consent_required','Source-shared activation needs a separate credential grant and item consent');
 return Object.freeze(r);
}
const safeCodes=new Set(['invalid_params','invalid_credentials','invalid_uri','scope_denied','identity_mismatch','identity_rejected',
 'mcp_contract_changed','cancelled','connection_failed','invalid_endpoint','insecure_endpoint','invalid_token','not_found','permission_denied',
 'insufficient_scope','conflict','revision_conflict','stale_source','memory_review_disabled','memory_review_consent_required',
 'memory_review_project_required','memory_review_project_mismatch','memory_review_shared_consent_required','memory_review_selected_changed',
 'memory_review_no_change','memory_review_stale_source','memory_review_replay_unavailable','memory_review_receipt_unconfirmed',
 'memory_review_single_item_required','memory_review_cleanup_failed','memory_inspect_unconfirmed','memory_inspect_project_mismatch',
 'memory_inspect_not_owned','memory_inspect_document_bound']);
const empty=()=>({read_attempts:0,write_attempts:0,write_delivery:'not_started'});
/** Only locally recorded outcomes survive wrappers. Remote exceptions cannot invent a confirmed write. */
export function automationMemoryReviewError(error,prior){
 let code;try{code=Object.getOwnPropertyDescriptor(error,'code')?.value;}catch{}
 const state=outcomes.get(prior)??outcomes.get(error)??empty();
 const safe=Object.assign(new UltraError(safeCodes.has(code)?code:'memory_review_unconfirmed','Memory review was not confirmed'),{
  read_delivery:state.read_attempts?'unconfirmed':'not_started',write_delivery:state.write_delivery,
  write_attempts:state.write_attempts,memory_writes_requested:state.write_attempts>0});
 outcomes.set(safe,Object.freeze({...state}));return safe;
}
export function automationMemoryReviewFailure(error,prior){
 const e=automationMemoryReviewError(error,prior);
 return {ok:false,error:e.code,read_delivery:e.read_delivery,write_delivery:e.write_delivery,
  write_attempts:e.write_attempts,memory_writes_requested:e.memory_writes_requested};
}
function receipt(wire,r){
 let value,isError;
 try{
  const v=candidateData(wire,['content'],['isError']);
  requireThat(v.isError===undefined||typeof v.isError==='boolean','invalid_params','Boolean error flag required');
  requireThat(Array.isArray(v.content),'invalid_params','Content array required');
  const d=Object.getOwnPropertyDescriptors(v.content);
  requireThat(Reflect.ownKeys(d).length===2&&d.length?.value===1&&d[0]?.enumerable&&Object.hasOwn(d[0],'value'),'invalid_params','One text result required');
  const part=candidateData(d[0].value,['type','text']);
  requireThat(part.type==='text'&&typeof part.text==='string'&&Buffer.byteLength(part.text)<=8192,'invalid_params','Bounded receipt required');
  value=parseSnapshotJSON(part.text);isError=v.isError===true;
 }catch{throw new UltraError('memory_review_receipt_unconfirmed','Receipt was not confirmed');}
 if(isError){
  const code=Object.getOwnPropertyDescriptor(value??{},'error')?.value;
  throw new UltraError(['not_found','permission_denied','insufficient_scope','conflict','revision_conflict','stale_source'].includes(code)?code:'memory_review_receipt_unconfirmed','Review was rejected');
 }
 try{
  const v=candidateData(value,['id','revision','status','replayed','assurance']);
  requireThat(v.id===r.memory_id&&v.revision===r.expected_revision+1&&v.status===r.action&&typeof v.replayed==='boolean'&&
   (r.mode!=='replay'||v.replayed===true)&&typeof v.assurance==='string'&&Buffer.byteLength(v.assurance)<=2048,
   'invalid_params','Matching complete receipt required');
  return Object.freeze({id:v.id,revision:v.revision,status:v.status,replayed:v.replayed});
 }catch{throw new UltraError('memory_review_receipt_unconfirmed','Receipt was not confirmed');}
}
export async function runAutomationMemoryReview(client,input,settings,{signal,checkIdentity}={}){
 const state=empty();
 const allowed=()=>requireThat(!signal?.aborted,'cancelled','Review cancelled');
 const identify=async()=>{allowed();await checkIdentity();allowed();};
 try{
  allowed();const r=automationMemoryReviewRequest(input,settings);
  // Settings are trusted executor configuration; pin the selected project before awaiting identity.
  const readSettings=Object.freeze({...settings,inspectProject:settings.reviewProject??''});
  await identify();state.read_attempts=1;
  const observed=await readAutomationMemory(client,{memory_id:r.memory_id,scope:r.scope,consent:true,include_text:false},readSettings,{signal});
  allowed();const row=observed.memory;
  requireThat(row.project_id===r.expected_project_id,'memory_review_project_mismatch','Record project changed');
  if(r.mode==='apply'){
   requireThat(row.revision===r.expected_revision&&row.content_hash===r.expected_content_hash&&row.status===r.expected_status&&row.visibility===r.expected_visibility,
    'memory_review_selected_changed','Record changed; inspect and consent again');
   requireThat(row.status!==r.action,'memory_review_no_change','Already in selected state');
   requireThat(r.action!=='active'||row.derivation_current,'memory_review_stale_source','Reconcile stale source before activation');
  }else requireThat(row.revision>r.expected_revision,'memory_review_replay_unavailable','Replay requires an advanced revision');
  await identify();
  const args=Object.freeze({memory_id:r.memory_id,expected_revision:r.expected_revision,event_id:r.event_id,status:r.action});
  state.write_attempts=1;state.write_delivery='unconfirmed';
  const response=await client.callTool({name:'ultra_personal_review',arguments:args},undefined,{signal,timeout:settings.timeoutMs});
  allowed();const ack=receipt(response,r);state.write_delivery='confirmed';
  await identify();
  const result=Object.freeze({format:'ultrabrain-automation-memory-review-v1',mode:r.mode,source_id:settings.source,event_id:r.event_id,
   observed_revision:row.revision,receipt:ack,read_requests:1,write_requests:1,write_delivery:'confirmed',memory_writes_requested:true,
   text_included:false,current_state_verified:false,truth_verified:false,human_identity_verified:false,
   limitations:Object.freeze(['explicit-caller-consent-not-human-authentication','full-record-read-before-local-scope-check',
    'receipt-is-not-current-state','server-event-binds-four-fields-not-extra-observation-pins','no-automatic-retry-or-bulk-review','metadata-is-private'])});
  outcomes.set(result,Object.freeze({...state}));return result;
 }catch(error){
  const carrier={};outcomes.set(carrier,Object.freeze({...state}));throw automationMemoryReviewError(error,carrier);
 }
}
