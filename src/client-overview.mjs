/** Explicit owner-wide metadata read. No bodies, model calls, polling or mutations. */
import {randomUUID} from 'node:crypto';
import {requireThat,UltraError} from './core.mjs';
import {matchingWorkspace} from './client-profile-file.mjs';
import {assertClientAuthorized} from './client-authorization.mjs';
import {OVERVIEW_SCOPE,overviewRequest,verifyPersonalOverview} from './personal-overview-contract.mjs';
const attempts=new WeakMap();
const safeCodes=new Set(['invalid_profile','insecure_profile','missing_credentials','invalid_params','overview_disabled',
 'overview_consent_required','workspace_mismatch','personal_overview_unconfirmed','identity_mismatch',
 'client_authorization_revoked','aborted','permission_denied','input_too_large']);
/** Data descriptors avoid running selection getters. All-project scope must be
 * explicit even for a project-bound client; no user-supplied server selectors.
 */
export function clientOverviewRequest(input,profile){
 requireThat(profile?.expectedInstance&&profile.expectedActor&&profile.workspace,'overview_disabled','Observed identity pins and workspace required');
 let value;
 try{
  if(!input||typeof input!=='object'||Array.isArray(input))throw Error();
  const descriptors=Object.getOwnPropertyDescriptors(input),keys=['workspace','consent','scope'];
  if(Reflect.ownKeys(descriptors).length!==keys.length)throw Error();
  value=Object.fromEntries(keys.map(key=>{
   const d=descriptors[key];if(!d?.enumerable||!Object.hasOwn(d,'value'))throw Error();return [key,d.value];
  }));
 }catch{throw new UltraError('invalid_params','Exact overview selection required');}
 requireThat(value.consent===true,'overview_consent_required','Explicit metadata read consent required');
 requireThat(value.scope===OVERVIEW_SCOPE,'invalid_params','Explicit owned-all-projects scope required');
 try{matchingWorkspace(profile,value.workspace);}catch{throw new UltraError('workspace_mismatch','Workspace binding is unavailable or changed');}
 return Object.freeze(value);
}
/** Only locally recorded attempts propagate across the SDK/CLI boundary. Remote
 * errors cannot invent an attempt count or disclose arbitrary diagnostic strings.
 */
export function clientOverviewFailure(error,started=0){
 const n=started===1||attempts.get(error)===1?1:0;
 let candidate;
 try{candidate=Object.getOwnPropertyDescriptor(error,'code')?.value;}catch{/* Untrusted reflection must not escape sanitization. */}
 const code=safeCodes.has(candidate)?candidate:'overview_read_unconfirmed';
 const result=Object.assign(new UltraError(code,'Owner overview was not confirmed'),
  {read_delivery:n?'unconfirmed':'not_started',read_attempts:n});
 attempts.set(result,n);return result;
}
export async function deliverClientOverview(input,profile,{checkIdentity,invoke,signal,authorize=()=>{}}){
 let started=0;
 try{
  assertClientAuthorized(authorize,signal);
  const selection=clientOverviewRequest(input,profile);
  const allowed=()=>{assertClientAuthorized(authorize,signal);matchingWorkspace(profile,selection.workspace);};
  allowed();const request=overviewRequest({request_id:randomUUID()});
  await checkIdentity(signal);allowed();
  // Conservative submission accounting: IO can still fail before sending bytes.
  started=1;const response=await invoke('ultra_personal_overview',request,signal);allowed();
  const overview=verifyPersonalOverview(response,request,profile.source);allowed();
  await checkIdentity(signal);allowed();
  return Object.freeze({format:'ultrabrain-client-overview-v1',read_requests:1,memory_writes_requested:false,overview,
   limitations:Object.freeze(['owner-all-projects-not-project-filtered','metadata-is-private','observation-not-live-health',
    'direct-source-check-not-truth','lease-counts-not-retry-authority'])});
 }catch(error){throw clientOverviewFailure(error,started);}
}
