/** Explicit direct-source verification. Three bounded reads at most, never writes.
 * The shared inspector validates complete records before local scope checks. */
import {requireThat,UltraError} from './core.mjs';
import {candidateData} from './personal-candidates-contract.mjs';
import {automationMemoryInspectRequest,readAutomationMemory} from './automation-memory-inspect.mjs';
import {lineageReference,compareLineage,sameLineageRecord} from './personal-lineage-contract.mjs';
const outcomes=new WeakMap();
export function automationMemoryLineageRequest(input,settings){
 let r;
 try{r=candidateData(input,['memory_id','scope','consent','follow_consent','include_text']);}
 catch{throw new UltraError('invalid_params','Exact lineage selection required');}
 requireThat(r.follow_consent===true,'memory_lineage_consent_required','Explicit permission to read the direct source required');
 const {follow_consent,...inspect}=r;
 automationMemoryInspectRequest(inspect,{...settings,inspectProject:settings.lineageProject??''});
 return Object.freeze(r);
}
const meta=row=>row?Object.freeze(Object.fromEntries(['id','type','origin_kind','status','revision','project_id','agent_id',
 'visibility','owned_by_caller','content_hash','derivation_current','updated_at'].map(k=>[k,row[k]]))):null;
const safeCodes=new Set(['invalid_params','invalid_credentials','invalid_uri','scope_denied','identity_mismatch','identity_rejected',
 'mcp_contract_changed','cancelled','connection_failed','invalid_endpoint','insecure_endpoint','invalid_token','not_found','permission_denied',
 'insufficient_scope','memory_inspect_disabled','memory_inspect_consent_required','memory_inspect_project_required','memory_inspect_project_mismatch',
 'memory_inspect_not_owned','memory_inspect_document_bound','memory_inspect_unconfirmed','memory_lineage_consent_required',
 'memory_lineage_selected_changed','memory_lineage_cleanup_failed']);
/** Do not trust a remote exception's counters or accessors as delivery evidence. */
export function automationMemoryLineageError(error,prior){
 let code;try{code=Object.getOwnPropertyDescriptor(error,'code')?.value;}catch{}
 const attempts=outcomes.get(prior)??outcomes.get(error)??0;
 const e=Object.assign(new UltraError(safeCodes.has(code)?code:'memory_lineage_unconfirmed','Memory source verification was not confirmed'),
  {read_delivery:attempts?'unconfirmed':'not_started',read_attempts:attempts,memory_writes_requested:false});
 outcomes.set(e,attempts);return e;
}
export function automationMemoryLineageFailure(error,prior){
 const e=automationMemoryLineageError(error,prior);
 return {ok:false,error:e.code,read_delivery:e.read_delivery,read_attempts:e.read_attempts,memory_writes_requested:false};
}
export async function runAutomationMemoryLineage(client,input,settings,{signal,checkIdentity}={}){
 let attempts=0;
 const allowed=()=>requireThat(!signal?.aborted,'cancelled','Source verification cancelled');
 const identify=async()=>{allowed();await checkIdentity();allowed();};
 try{
  allowed();settings=Object.freeze({...settings});
  const r=automationMemoryLineageRequest(input,settings);
  const readSettings=Object.freeze({...settings,inspectProject:settings.lineageProject??''});
  const read=async id=>{
   await identify();attempts++;
   const view=await readAutomationMemory(client,{memory_id:id,scope:r.scope,consent:true,include_text:true},readSettings,{signal});
   allowed();
   // Reconstitute only the complete, already verified record projection, not raw transport data.
   return Object.freeze({...view.memory,...view.text,trust:view.trust});
  };
  const memory=await read(r.memory_id),reference=lineageReference(memory);let original=null,verdict;
  if(reference){
   try{original=await read(reference.input_id);}
   catch(error){
    allowed();const code=Object.getOwnPropertyDescriptor(error,'code')?.value;
    if(code!=='not_found')throw error; // A denial, timeout or corrupt response is not missing evidence.
   }
   const last=await read(r.memory_id);
   requireThat(sameLineageRecord(memory,last),'memory_lineage_selected_changed','Selected memory changed during verification');
   verdict=original?compareLineage(memory,original):Object.freeze({state:'unavailable',truth_verified:false});
  }else verdict=Object.freeze({state:'unlinked',truth_verified:false});
  await identify();
  const result={format:'ultrabrain-automation-memory-lineage-v1',source_id:settings.source,scope:r.scope,
   project_id:r.scope==='global-and-project'?settings.lineageProject:null,memory:meta(memory),original:meta(original),
   reference:reference?Object.freeze(Object.fromEntries(Object.entries(reference).filter(([k])=>k!=='quote'))):null,
   verdict,read_requests:attempts,text_included:r.include_text,read_only:true,memory_writes_requested:false,model_calls:0,
   truth_verified:false,atomic_snapshot:false,trust:'untrusted-memory-data',
   limitations:Object.freeze(['full-records-transmitted-before-local-scope-check','direct-source-only-no-recursion',
    'separately-timed-observations','not-found-is-not-proof-of-deletion','matching-is-not-truth-or-write-authority','metadata-is-private'])};
  if(r.include_text)result.text=Object.freeze({memory:memory.content,quote:reference?.quote??null,source:original?.content??null});
  Object.freeze(result);outcomes.set(result,attempts);return result;
 }catch(error){const carrier={};outcomes.set(carrier,attempts);throw automationMemoryLineageError(error,carrier);}
}
