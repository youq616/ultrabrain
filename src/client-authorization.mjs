/** Synchronous live connection authority; never treat a Promise as approval. */
import {requireThat,UltraError} from './core.mjs';
export function assertClientAuthorized(authorize,signal) {
  requireThat(typeof authorize==='function','invalid_params','Synchronous client authorization required');
  requireThat(!signal?.aborted,'aborted','Client request cancelled');
  const result=authorize();
  if(result&&typeof result.then==='function') {
    Promise.resolve(result).catch(()=>{});
    throw new UltraError('invalid_params','Client authorization must be synchronous');
  }
  requireThat(result!==false,'client_authorization_revoked','Client authorization revoked');
  requireThat(!signal?.aborted,'aborted','Client request cancelled during authorization');
}

/** Freeze request bytes before awaiting identity; fence dispatch and response.
 * Cancellation/revocation cannot retract a write already sent. On failure after
 * dispatch, callers must report delivery as unconfirmed, not retry automatically.
 */
export async function deliverClientRequest(input,{authorize=()=>{},signal,prepare,checkIdentity,send}) {
  const allowed=()=>assertClientAuthorized(authorize,signal);
  allowed();
  let snapshot;
  try{snapshot=structuredClone(input);}catch{throw new UltraError('invalid_params','Request must be cloneable data');}
  const request=prepare(snapshot);
  allowed();await checkIdentity(signal);allowed();
  const result=await send(request,signal);
  allowed();return result;
}
