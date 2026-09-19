/** Last-mile consent boundary shared by direct and journal-backed client capture.
 * The local authorization assertion is synchronous and runs after every awaited
 * identity/registration step, immediately before starting a new write request.
 * It cannot retract a request already sent to the server.
 */
import {captureRequest} from './client-kit.mjs';
import {objectFields} from './personal-memory.mjs';
import {requireThat} from './core.mjs';

export async function deliverCapture(input,profile,{checkIdentity,invoke,signal,authorize=()=>{}}) {
  // Freeze consent and bytes before any asynchronous work. A project override
  // may only repeat the trusted profile selection, never broaden it.
  const snapshot=structuredClone(input);
  objectFields(snapshot,['agent_id','event_id','transcript','consent','project_id']);
  requireThat(!Object.hasOwn(snapshot,'project_id')||snapshot.project_id===profile.projectId,
    'scope_denied','Project differs from the trusted capture profile');
  const {project_id:_project,...fields}=snapshot;
  const request=captureRequest(fields,profile);
  requireThat(typeof authorize==='function','invalid_params','Synchronous authorization assertion required');
  const allowed=()=>{
    requireThat(!signal?.aborted,'aborted','Capture cancelled before transmission');
    const result=authorize();
    if(result&&typeof result.then==='function'){
      Promise.resolve(result).catch(()=>{}); // Do not leak an unsupported async assertion's rejection.
      requireThat(false,'invalid_params','Authorization assertion must be synchronous');
    }
    requireThat(result!==false,'capture_disabled','Capture authorization declined');
    requireThat(!signal?.aborted,'aborted','Capture cancelled during authorization');
  };
  allowed();await checkIdentity();
  allowed();
  await invoke('ultra_agent_register',{agent_id:request.agent_id,agent_type:'custom'});
  await checkIdentity();
  allowed();
  return invoke('ultra_personal_capture',request);
}
