/** Explicit scoped candidate metadata for automation. No body reads, writes or filesystem. */
import {randomUUID} from 'node:crypto';
import {requireThat,UltraError} from './core.mjs';
import {candidateData,candidatePageRequest,verifyCandidatePage,CANDIDATES_MAX_BYTES} from './personal-candidates-contract.mjs';
import {parseSnapshotJSON} from './personal-snapshot-contract.mjs';
/** The project is trusted credential configuration, never an item JSON override. */
export function automationCandidatesRequest(input,settings){
  requireThat(!settings.rootSlug,'scope_denied','Candidate pages require a source-root credential');
  requireThat(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(settings.expectedInstance??'')&&
    /^[a-f0-9]{64}$/.test(settings.expectedActor??''),'candidates_disabled','Observed instance and actor pins required');
  let r;
  try{r=candidateData(input,['scope','consent'],['after_id','limit']);}
  catch{throw new UltraError('invalid_params','Exact candidate selection required');}
  requireThat(['global-only','global-and-project'].includes(r.scope),'invalid_params','Select a candidate scope');
  requireThat(r.consent===true,'candidates_consent_required','Explicit metadata consent required');
  const project=settings.candidateProject??'';
  requireThat(typeof project==='string'&&(project===''||/^[A-Za-z0-9_-]{1,96}$/.test(project)),
    'invalid_params','Invalid credential candidate project');
  requireThat(r.scope!=='global-and-project'||project!=='','candidates_project_required','Configure the project in the credential');
  try{candidatePageRequest({request_id:'00000000-0000-4000-8000-000000000000',
    ...(r.scope==='global-and-project'?{project_id:project}:{}),
    ...(Object.hasOwn(r,'after_id')?{after_id:r.after_id}:{}),...(Object.hasOwn(r,'limit')?{limit:r.limit}:{})});}
  catch{throw new UltraError('invalid_params','Invalid candidate cursor or page size');}
  return Object.freeze({...r,limit:r.limit??20});
}
export async function readAutomationCandidates(client,selection,settings,{signal}={}){
  const r=automationCandidatesRequest(selection,settings);
  requireThat(!signal?.aborted,'cancelled','Candidate read cancelled');
  const request=Object.freeze({request_id:randomUUID(),limit:r.limit,
    ...(r.scope==='global-and-project'?{project_id:settings.candidateProject}:{}),
    ...(Object.hasOwn(r,'after_id')?{after_id:r.after_id}:{})});
  const wire=await client.callTool({name:'ultra_personal_candidates',arguments:request},undefined,{signal,timeout:settings.timeoutMs});
  requireThat(!signal?.aborted,'cancelled','Candidate delivery cancelled');
  let page;
  try{
    const value=candidateData(wire,['content'],['isError'],'personal_candidates_unconfirmed');
    requireThat(value.isError===undefined||value.isError===false,'personal_candidates_unconfirmed','Rejected response');
    // Copy descriptors before reading array values. No resource, image, hidden or extra channels.
    const d=Object.getOwnPropertyDescriptors(value.content);
    requireThat(Array.isArray(value.content)&&Reflect.ownKeys(d).length===2&&d.length?.value===1&&
      d[0]?.enumerable&&Object.hasOwn(d[0],'value'),'personal_candidates_unconfirmed','Single text result required');
    const item=candidateData(d[0].value,['type','text'],[],'personal_candidates_unconfirmed');
    requireThat(item.type==='text'&&typeof item.text==='string'&&Buffer.byteLength(item.text)<=CANDIDATES_MAX_BYTES,
      'personal_candidates_unconfirmed','Bounded text result required');
    page=verifyCandidatePage(parseSnapshotJSON(item.text),request,settings.source);
  }catch{throw new UltraError('personal_candidates_unconfirmed','Candidate page was not confirmed');}
  return Object.freeze({page,memory_writes_requested:false});
}
const codes=new Set(['invalid_params','invalid_credentials','invalid_uri','scope_denied','candidates_disabled','candidates_consent_required',
  'candidates_project_required','personal_candidates_unconfirmed','identity_mismatch','identity_rejected','mcp_contract_changed',
  'cancelled','connection_failed','invalid_endpoint','insecure_endpoint','invalid_token','candidates_cleanup_failed']);
/** Error fields from programmatic transports are not trusted disclosure channels. */
export function automationCandidatesFailure(error){
  let code,delivery;
  try{code=Object.getOwnPropertyDescriptor(error,'code')?.value;delivery=Object.getOwnPropertyDescriptor(error,'read_delivery')?.value;}catch{}
  return {ok:false,error:codes.has(code)?code:'adapter_failed',
    read_delivery:delivery==='unconfirmed'?'unconfirmed':'not_started',memory_writes_requested:false};
}
