/** Explicit task-aware reads. No transcript scan, memory write, model, or local queue.
 * This gates the new helper/Hook, not the pre-existing raw MCP context tool.
 */
import {objectFields} from './personal-memory.mjs';
import {clientContext} from './client-kit.mjs';
import {matchingWorkspace} from './client-profile-file.mjs';
import {requireThat} from './core.mjs';

export function requireTaskProfile(profile,automatic=false) {
  requireThat(profile.allowTaskContext===true,'task_context_disabled','Task recall requires a separate profile opt-in');
  requireThat(profile.expectedInstance&&profile.expectedActor&&profile.workspace,'invalid_profile','Task recall requires observed identity and workspace pins');
  if(automatic)requireThat(profile.automaticTaskContext?.includes('claude-user'),'task_context_disabled','Automatic task recall was not authorized');
}
export function taskContextRequest(input,profile) {
  requireTaskProfile(profile);
  objectFields(input,['task','workspace','consent']);
  requireThat(Object.hasOwn(input,'consent')&&input.consent===true,'task_context_disabled','Explicit task-query consent required');
  matchingWorkspace(profile,input.workspace);
  requireThat(typeof input.task==='string'&&input.task.isWellFormed()&&!input.task.includes('\0')&&input.task.trim()&&
    Buffer.byteLength(input.task)<=4096,'invalid_params','Task must be 1..4096 UTF-8 bytes; oversized tasks are not truncated');
  return {task:input.task,limit:20,budget_bytes:profile.budgetBytes,...(profile.projectId?{project_id:profile.projectId}:{})};
}
export function claudeTaskRequest(event,profile) {
  // Do not even inspect prompt text before checking the separate automatic permission.
  requireTaskProfile(profile,true);
  requireThat(event&&typeof event==='object'&&!Array.isArray(event)&&event.hook_event_name==='UserPromptSubmit',
    'unsupported_hook','Task recall only accepts UserPromptSubmit');
  requireThat(!Object.hasOwn(event,'agent_id'),'scope_denied','Subagents do not inherit primary-session task-query consent');
  requireThat(typeof event.session_id==='string'&&event.session_id.trim()&&event.session_id.isWellFormed()&&event.session_id.length<=256&&
    !/[\x00-\x1f\x7f]/.test(event.session_id),'invalid_params','Primary session metadata required');
  matchingWorkspace(profile,event.cwd);
  // Permission to query is not permission to save. Ignore every transcript/file/tool field.
  const input={task:event.prompt,workspace:event.cwd,consent:true};
  taskContextRequest(input,profile);return input;
}
export async function deliverTaskContext(input,profile,{checkIdentity,invoke,signal,authorize=()=>{}}) {
  const snapshot=structuredClone(input),request=taskContextRequest(snapshot,profile);
  requireThat(typeof authorize==='function','invalid_params','Synchronous authorization assertion required');
  const allowed=()=>{
    requireThat(!signal?.aborted,'aborted','Task recall cancelled');
    const value=authorize();
    if(value&&typeof value.then==='function'){
      Promise.resolve(value).catch(()=>{});
      requireThat(false,'invalid_params','Authorization assertion must be synchronous');
    }
    requireThat(value!==false,'task_context_disabled','Task-query authorization declined');
    matchingWorkspace(profile,snapshot.workspace);
    requireThat(!signal?.aborted,'aborted','Task recall cancelled during authorization');
  };
  allowed();await checkIdentity();allowed();
  // Exactly one read call: no agent registration, capture, automatic retry or consolidation.
  const result=await invoke('ultra_personal_context',request);
  allowed(); // A revoked/expired request must not inject a stale response into the Agent.
  return clientContext(result,profile);
}
