/** Explicit metadata-only owner-candidate pages. One request, no prefetch or writes. */
import {randomUUID} from 'node:crypto';
import {requireThat,UltraError} from './core.mjs';
import {assertClientAuthorized} from './client-authorization.mjs';
import {matchingWorkspace} from './client-profile-file.mjs';
import {candidateData,candidatePageRequest,verifyCandidatePage} from './personal-candidates-contract.mjs';
const evidence=new WeakMap();
const safe=new Set(['invalid_params','invalid_profile','insecure_profile','missing_credentials','identity_mismatch','workspace_mismatch',
 'client_authorization_revoked','aborted','input_too_large','candidates_disabled','candidates_consent_required',
 'personal_candidates_unconfirmed','candidates_cleanup_failed','insufficient_scope','permission_denied','not_found']);
function workspaceAllowed(profile,value){
 try{matchingWorkspace(profile,value);}catch{throw new UltraError('workspace_mismatch','Bound workspace unavailable or changed');}
}
export function candidatesRequest(input,profile){
 requireThat(profile?.expectedInstance&&profile.expectedActor&&profile.workspace,'candidates_disabled','Observed identity and workspace pins required');
 const r=candidateData(input,['workspace','consent'],['after_id','limit']);
 requireThat(r.consent===true,'candidates_consent_required','Explicit metadata read consent required');
 workspaceAllowed(profile,r.workspace);
 candidatePageRequest({request_id:'00000000-0000-4000-8000-000000000000',
  ...(Object.hasOwn(r,'after_id')?{after_id:r.after_id}:{}),...(Object.hasOwn(r,'limit')?{limit:r.limit}:{})});
 return Object.freeze({...r,limit:r.limit??20});
}
export function candidatesFailure(error,prior){
 const attempts=evidence.get(prior)??evidence.get(error)??0;
 let code;try{code=Object.getOwnPropertyDescriptor(error,'code')?.value;}catch{}
 const e=Object.assign(new UltraError(safe.has(code)?code:'candidates_read_unconfirmed','Candidate page was not confirmed'),
  {read_attempts:attempts,read_delivery:attempts?'unconfirmed':'not_started',memory_writes_requested:false});
 evidence.set(e,attempts);return e;
}
export async function deliverCandidates(input,profile,{checkIdentity,invoke,signal,authorize=()=>{}}){
 let attempts=0;
 try{
  assertClientAuthorized(authorize,signal);const r=candidatesRequest(input,profile);
  const allowed=()=>{assertClientAuthorized(authorize,signal);workspaceAllowed(profile,r.workspace);};
  const request=candidatePageRequest({request_id:randomUUID(),limit:r.limit,
   ...(r.after_id?{after_id:r.after_id}:{}),...(profile.projectId?{project_id:profile.projectId}:{})});
  allowed();await checkIdentity(signal);allowed();
  attempts=1;const response=await invoke('ultra_personal_candidates',request,signal);allowed();
  const page=verifyCandidatePage(response,request,profile.source);
  await checkIdentity(signal);allowed();
  const result=Object.freeze({format:'ultrabrain-client-candidates-v1',page,read_requests:1,read_only:true,
   text_included:false,memory_writes_requested:false,truth_verified:false,
   limitations:Object.freeze(['live-keyset-pages-not-a-snapshot','restart-to-observe-new-or-moved-earlier-ids',
    'candidate-inputs-are-not-confirmed-facts','document-fragments-excluded','ids-are-not-write-authority','metadata-is-private'])});
  evidence.set(result,attempts);return result;
 }catch(error){
  const wrapped=candidatesFailure(error);evidence.set(wrapped,attempts);throw candidatesFailure(wrapped);
 }
}
