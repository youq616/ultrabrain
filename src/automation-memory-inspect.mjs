/** Explicit one-record read. No writes, source following, filesystem or model. */
import {requireThat,UltraError} from './core.mjs';
import {candidateData} from './personal-candidates-contract.mjs';
import {parseSnapshotJSON} from './personal-snapshot-contract.mjs';
import {verifyPersonalMemoryRead} from './personal-memory-read-contract.mjs';
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
export function automationMemoryInspectRequest(input,settings){
 requireThat(!settings.rootSlug,'scope_denied','Use a source-root credential');
 requireThat(uuid(settings.expectedInstance)&&typeof settings.expectedActor==='string'&&/^[a-f0-9]{64}$/.test(settings.expectedActor),
  'memory_inspect_disabled','Observed instance and actor pins required');
 let r;try{r=candidateData(input,['memory_id','scope','consent','include_text']);}catch{throw new UltraError('invalid_params','Exact inspection selection required');}
 requireThat(uuid(r.memory_id)&&['global-only','global-and-project'].includes(r.scope)&&typeof r.include_text==='boolean',
  'invalid_params','Select an ID, scope and disclosure mode');
 requireThat(r.consent===true,'memory_inspect_consent_required','Explicit per-record read consent required');
 const project=settings.inspectProject??'';
 requireThat(typeof project==='string'&&(project===''||/^[A-Za-z0-9_-]{1,96}$/.test(project)),'invalid_params','Invalid credential inspection project');
 requireThat(r.scope!=='global-and-project'||project!=='','memory_inspect_project_required','Configure the inspection project in the credential');
 return Object.freeze({...r,project_id:r.scope==='global-and-project'?project:null});
}
function decode(wire){
 let value,error=false;
 try{
  const r=candidateData(wire,['content'],['isError']);
  requireThat(r.isError===undefined||typeof r.isError==='boolean','invalid_params','Invalid error flag');
  requireThat(Array.isArray(r.content),'invalid_params','Content array required');
  const d=Object.getOwnPropertyDescriptors(r.content);
  requireThat(Reflect.ownKeys(d).length===2&&d.length?.value===1&&d[0]?.enumerable&&Object.hasOwn(d[0],'value'),'invalid_params','One text result required');
  const item=candidateData(d[0].value,['type','text']);
  requireThat(item.type==='text'&&typeof item.text==='string'&&Buffer.byteLength(item.text)<=1048576,'invalid_params','Bounded JSON text required');
  value=parseSnapshotJSON(item.text);error=r.isError===true;
 }catch{throw new UltraError('memory_inspect_unconfirmed','Exact read response was not confirmed');}
 if(error){
  const code=Object.getOwnPropertyDescriptor(value??{},'error')?.value;
  throw new UltraError(['not_found','permission_denied','insufficient_scope'].includes(code)?code:'memory_inspect_unconfirmed','Memory read was rejected');
 }
 return value;
}
export async function readAutomationMemory(client,selection,settings,{signal}={}){
 // Selection is validated before every asynchronous boundary, never a caller-provided authority token.
 const r=automationMemoryInspectRequest(selection,settings);
 requireThat(!signal?.aborted,'cancelled','Inspection cancelled');
 const wire=await client.callTool({name:'ultra_memory_read',arguments:{memory_id:r.memory_id}},undefined,{signal,timeout:settings.timeoutMs});
 requireThat(!signal?.aborted,'cancelled','Inspection delivery cancelled');
 let row;
 try{row=verifyPersonalMemoryRead(decode(wire),r.memory_id,{source:settings.source,projectId:r.project_id});}
 catch(e){
  const code=Object.getOwnPropertyDescriptor(e??{},'code')?.value;
  if(code==='lineage_project_mismatch')throw new UltraError('memory_inspect_project_mismatch','Record outside chosen project');
  if(['not_found','permission_denied','insufficient_scope'].includes(code))throw e;
  throw new UltraError('memory_inspect_unconfirmed','Exact read response was not confirmed');
 }
 requireThat(row.owned_by_caller,'memory_inspect_not_owned','This inspector is for owned records');
 requireThat(row.origin_kind==='agent','memory_inspect_document_bound','Use the document interface for fragments');
 const memory=Object.freeze(Object.fromEntries(['id','type','origin_kind','agent_id','project_id','status','visibility','importance','confidence',
  'revision','content_hash','created_at','updated_at','last_confirmed','owned_by_caller','derivation_current'].map(k=>[k,row[k]])));
 const result={format:'ultrabrain-automation-memory-inspect-v1',source_id:settings.source,scope:r.scope,project_id:r.project_id,memory,
  read_only:true,read_requests:1,text_included:r.include_text,memory_writes_requested:false,model_calls:0,
  truth_verified:false,atomic_snapshot:false,trust:'untrusted-memory-data',
  limitations:Object.freeze(['full-record-transmitted-before-local-scope-check','observation-not-current-state-guarantee',
   'no-source-following-or-write-authority','metadata-is-private'])};
 if(r.include_text)result.text=Object.freeze({content:row.content,provenance:row.provenance,derivation:row.derivation});
 return Object.freeze(result);
}
const safeCodes=new Set(['invalid_params','invalid_credentials','invalid_uri','scope_denied','identity_mismatch','identity_rejected',
 'mcp_contract_changed','cancelled','connection_failed','invalid_endpoint','insecure_endpoint','invalid_token','not_found','permission_denied',
 'insufficient_scope','memory_inspect_disabled','memory_inspect_consent_required','memory_inspect_project_required','memory_inspect_project_mismatch',
 'memory_inspect_not_owned','memory_inspect_document_bound','memory_inspect_unconfirmed','memory_inspect_cleanup_failed']);
export function automationMemoryInspectFailure(error){
 let code,delivery;try{code=Object.getOwnPropertyDescriptor(error,'code')?.value;delivery=Object.getOwnPropertyDescriptor(error,'read_delivery')?.value;}catch{}
 return {ok:false,error:safeCodes.has(code)?code:'adapter_failed',read_delivery:delivery==='unconfirmed'?'unconfirmed':'not_started',memory_writes_requested:false};
}
