/** Shared deterministic lifecycle adapter. No shell, filesystem, DB or arbitrary tool dispatch. */
import {AgentMemory} from './agent-memory.mjs';
import {parseUri,text,integer,requireThat,UltraError} from './core.mjs';
import {mode} from './memory-selection.mjs';

const operations = Object.freeze({
  identity: [],
  before_turn: ['session_id','query','project_id'],
  after_turn: ['session_id','event_id','transcript','consent','visibility'],
  session_status: ['session_id','event_id'],
  resume_project: ['session_id','project_id','query'],
});
export const AUTOMATION_OPERATIONS = Object.freeze(Object.keys(operations));
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const id = (value,name) => {
  requireThat(typeof value==='string' && /^[A-Za-z0-9_-]{1,96}$/.test(value),
    'invalid_params', `${name} must be a stable 1..96-character identifier`);
  return value;
};
const boolean = (value,name) => requireThat(typeof value==='boolean','invalid_params',`${name} must be boolean`);
export function automationSettings(input={}) {
  const root=parseUri(input.rootUri);
  const allowCapture=input.allowCapture??false,allowSharedCapture=input.allowSharedCapture??false;
  boolean(allowCapture,'allowCapture');boolean(allowSharedCapture,'allowSharedCapture');
  const expectedInstance=input.expectedInstance??'',expectedActor=input.expectedActor??'';
  requireThat(expectedInstance==='' || uuid.test(expectedInstance),'invalid_params','Expected instance must be a full UUID');
  requireThat(expectedActor==='' || digest.test(expectedActor),'invalid_params','Expected actor must be a full SHA-256');
  const summary=input.summary??'prefer';
  requireThat(['prefer','require','off'].includes(summary),'invalid_params','Invalid summary preference');
  const includeFacts=input.includeFacts??false;boolean(includeFacts,'includeFacts');
  if(input.factEntity)text(input.factEntity,'factEntity',2048);
  return Object.freeze({rootUri:root.uri,source:root.source,rootSlug:root.slug,allowCapture,allowSharedCapture,
    expectedInstance,expectedActor,includeFacts,factEntity:input.factEntity??'',memoryPolicy:mode(input.memoryPolicy??'current'),summary,
    budgetBytes:integer(input.budgetBytes,16000,includeFacts?2048:512,131072),
    timeoutMs:integer(input.timeoutMs,30000,1000,120000),
    factRecall:includeFacts?Object.freeze(input.factEntity?{entity:input.factEntity,limit:8}:{limit:8}):null});
}
export function validateAutomationRequest(operation,request,settings) {
  requireThat(Object.hasOwn(operations,operation),'invalid_params','Unknown lifecycle operation');
  requireThat(request && typeof request==='object'&&!Array.isArray(request) &&
    Object.keys(request).every(k=>operations[operation].includes(k)),
    'invalid_params','Unknown lifecycle field; credentials, source and command overrides are forbidden');
  if(operation==='identity')return;
  id(request.session_id,'session_id');
  if(operation==='before_turn'||operation==='resume_project') {
    text(request.query,'query',4096);
    if(request.project_id!==undefined)id(request.project_id,'project_id');
    if(operation==='resume_project')id(request.project_id,'project_id');
  }
  if(operation==='session_status'||operation==='after_turn')id(request.event_id,'event_id');
  if(operation==='after_turn') {
    requireThat(settings.allowCapture && request.consent===true,'capture_disabled',
      'Saving requires credential-level permission and explicit consent for this item');
    requireThat(!settings.rootSlug,'scope_denied','Session capture requires a source-root credential, not a directory credential');
    const visibility=request.visibility??'private';
    requireThat(['private','world'].includes(visibility),'invalid_params','Invalid visibility');
    requireThat(visibility!=='world'||settings.allowSharedCapture,'scope_denied',
      'Shared capture must be explicitly enabled in the credential');
    text(request.transcript,'transcript',65536);
  }
}
function decode(response) {
  requireThat(response && !response.isError && Array.isArray(response.content),
    'identity_rejected','Identity request was rejected');
  let value;
  try { value=JSON.parse(response.content.filter(x=>x.type==='text').map(x=>x.text).join('\n')); }
  catch { throw new UltraError('mcp_contract_changed','Invalid identity response'); }
  requireThat(value?.format===1 && uuid.test(value.instance_id??'') && digest.test(value.actor_key??'') &&
    typeof value.source_id==='string','mcp_contract_changed','Incomplete server identity');
  return {format:1,instance_id:value.instance_id,actor_key:value.actor_key,source_id:value.source_id};
}
function checkIdentity(identity,settings,previous=null) {
  requireThat(identity.source_id===settings.source &&
    (!settings.expectedInstance||identity.instance_id===settings.expectedInstance) &&
    (!settings.expectedActor||identity.actor_key===settings.expectedActor) &&
    (!previous||(identity.instance_id===previous.instance_id && identity.actor_key===previous.actor_key && identity.source_id===previous.source_id)),
    'identity_mismatch','Authenticated server, actor or source does not match this connection');
}
/** Checks raw delivery only; never labels queued or failed extraction as completed knowledge. */
export function validateJournalReceipt(receipt,source) {
  requireThat(receipt?.deferred===true && receipt.storage==='journaled' &&
    ['queued','processing','completed','needs_model','failed'].includes(receipt.state) &&
    typeof receipt.uri==='string','unconfirmed_capture','No valid durable-delivery acknowledgement');
  requireThat(parseUri(receipt.uri).source===source,'scope_denied','Receipt belongs to a different source');
  return receipt;
}
export async function automationSession(client,input,{signal}={}) {
  requireThat(client&&typeof client.callTool==='function','invalid_params','Connected MCP client required');
  const settings=automationSettings(input);
  const identify=async()=>{
    requireThat(!signal?.aborted,'cancelled','Request cancelled before identity check');
    return decode(await client.callTool({name:'ultra_identity',arguments:{}},undefined,{signal,timeout:settings.timeoutMs}));
  };
  const original=await identify();checkIdentity(original,settings);
  return {
    identity:Object.freeze(original),
    async run(operation,request={}) {
      let submitted=false;
      try {
        validateAutomationRequest(operation,request,settings);
        const identity=await identify();checkIdentity(identity,settings,original);
        requireThat(!signal?.aborted,'cancelled','Request cancelled before operation');
        if(operation==='identity')return {identity};
        const memory=new AgentMemory({client,rootUri:settings.rootUri,sessionId:request.session_id,
          projectId:request.project_id??null,budgetBytes:settings.budgetBytes,timeoutMs:settings.timeoutMs,
          summary:settings.summary,memoryPolicy:settings.memoryPolicy,factRecall:settings.factRecall,
          capture:settings.allowCapture,deferExtraction:true});
        if(operation==='before_turn') {
          const project=request.project_id?await memory.resumeProject(request.query,{signal}):null;
          return {context:await memory.beforeTurn(project?.retrieval_query??request.query,{signal}),project};
        }
        if(operation==='resume_project')return {project:await memory.resumeProject(request.query,{signal})};
        if(operation==='session_status') {
          const status=await memory.sessionStatus(request.event_id,{signal});
          requireThat(status.session_id===request.session_id && status.event_id===request.event_id,
            'mcp_contract_changed','Session status identifiers do not match the request');
          validateJournalReceipt(status,settings.source);
          return {status};
        }
        // No implicit retries. Caller must retain immutable session/event/transcript for retry.
        submitted=true;
        const receipt=validateJournalReceipt(await memory.afterTurn({eventId:request.event_id,
          transcript:request.transcript,visibility:request.visibility??'private',signal}),settings.source);
        return {delivery:receipt,confirmed:true,
          persistence:'server-journal-confirmed; no local filesystem outbox in this adapter'};
      } catch(error) {
        // Input, provider errors and transport errors may contain secrets. Never forward their messages.
        const code=error instanceof UltraError?error.code:'transport_error';
        const safe=new UltraError(code,'Lifecycle operation failed; inspect safe code and delivery status');
        safe.delivery=submitted?'unconfirmed':'not_submitted';
        throw safe;
      }
    },
  };
}
