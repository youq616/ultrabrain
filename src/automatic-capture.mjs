/** Explicitly authorized, workspace-bound conversation observations.
 * Never read transcript_path, attachment paths, tools, hidden reasoning or arbitrary files.
 * Observations are not confirmed facts and not a complete transcript/turn ledger.
 */
import {requireThat,UltraError,sha256} from './core.mjs';
import {captureRequest} from './client-kit.mjs';
import {matchingWorkspace,readClientProfile} from './client-profile-file.mjs';
import {CaptureOutbox} from './capture-outbox.mjs';
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(x);
const id=x=>typeof x==='string'&&x.length>0&&x.length<=256&&x.isWellFormed()&&!/[\x00-\x1f\x7f]/.test(x);
export const AUTO_SCOPES=Object.freeze(['claude-user','claude-assistant','opencode-user','opencode-assistant']);
export function captureScope(profile,scope,workspace) {
  requireThat(profile.allowCapture&&profile.automaticCapture.includes(scope),'capture_disabled','This automatic capture scope was not authorized');
  requireThat(profile.expectedInstance&&profile.expectedActor&&profile.outboxDirectory,'invalid_profile','Automatic capture needs observed identity pins and a journal');
  matchingWorkspace(profile,workspace);
}
function observation(profile,host,role,eventKey,texts) {
  requireThat(texts.length>0&&texts.length<=64&&texts.every(x=>typeof x==='string'&&x.isWellFormed()&&!x.includes('\0')),
    'invalid_params','Invalid observation text');
  if(!texts.some(x=>x.trim()))return null;
  const event_id='auto_'+sha256(JSON.stringify([1,host,role,profile.projectId,...eventKey]));
  const payload={agent_id:'autocapture-'+host,event_id,consent:true,
    transcript:JSON.stringify({format:1,origin:host,role,event_key:eventKey,
      trust:'unverified conversation observation; assistant output is not user confirmation',texts})};
  captureRequest(payload,profile); // Reject oversize observations whole; never silently truncate.
  return payload;
}
export function claudeCapture(event,profile) {
  requireThat(event&&typeof event==='object'&&!Array.isArray(event),'invalid_params','Invalid hook event');
  const role=event.hook_event_name==='UserPromptSubmit'?'user':event.hook_event_name==='Stop'?'assistant':null;
  requireThat(role,'unsupported_hook','Only main prompt/final response hooks supported');
  captureScope(profile,'claude-'+role,event.cwd);
  if(Object.hasOwn(event,'agent_id')||event.hook_event_name==='Stop'&&event.stop_hook_active===true)return null;
  // This official stable prompt ID avoids conflating two identical "continue" prompts.
  requireThat(id(event.session_id)&&uuid(event.prompt_id),'stable_event_required','Claude prompt_id is required; no content-hash/timestamp fallback');
  if(role==='assistant')requireThat(event.stop_hook_active===false,'invalid_params','Main Stop status required');
  return observation(profile,'claude',role,[event.session_id,event.prompt_id.toLowerCase()],
    [role==='user'?event.prompt:event.last_assistant_message]);
}
export function openCodeCapture(kind,input,output,profile,workspace) {
  captureScope(profile,'opencode-'+kind,workspace);
  requireThat(input&&id(input.sessionID)&&output,'invalid_params','Session and message evidence required');
  if(kind==='user') {
    const m=output.message;
    requireThat(m?.role==='user'&&m.sessionID===input.sessionID&&id(m.id)&&(!input.messageID||input.messageID===m.id),
      'invalid_params','User message identity differs from host event');
    requireThat(Array.isArray(output.parts)&&output.parts.length<=256,'invalid_params','Bounded host parts required');
    const parts=output.parts.filter(p=>p?.type==='text'&&p.synthetic!==true&&p.ignored!==true);
    // Host-local plain text only: files, tools, synthetic context and attachments are not read.
    if(!parts.length)return null;
    return observation(profile,'opencode','user',[input.sessionID,m.id],parts.map(p=>p.text));
  }
  requireThat(kind==='assistant'&&id(input.messageID)&&id(input.partID),'invalid_params','Stable assistant fragment identifiers required');
  return observation(profile,'opencode','assistant',[input.sessionID,input.messageID,input.partID],[output.text]);
}
const safe=new Set(['capture_disabled','workspace_mismatch','stable_event_required','invalid_params','identity_mismatch',
  'invalid_profile','insecure_profile','insecure_outbox','outbox_full','outbox_busy','outbox_corrupt','conflict']);
export const captureCode=e=>e instanceof UltraError&&safe.has(e.code)?e.code:'capture_unavailable';
/** Shared manager for one immutable trusted profile. Revocation is re-read before capture/send. */
export function automaticCapture(profilePath,connect) {
  const initial=readClientProfile(profilePath),fingerprint=sha256(JSON.stringify(initial.input));let closed=false;
  const active=new Set();
  const current=()=>{
    requireThat(!closed,'capture_disabled','Adapter stopped');const now=readClientProfile(profilePath);
    requireThat(sha256(JSON.stringify(now.input))===fingerprint,'capture_disabled','Capture profile changed; reload before sending');
    return now;
  };
  return {
    scopes:initial.profile.automaticCapture,
    async submit(payload,workspace,scope) {
      const {input,profile}=current();captureScope(profile,scope,workspace);
      const queue=new CaptureOutbox(input),stored=await queue.enqueue(payload,{authorize:()=>captureScope(current().profile,scope,workspace)});
      // The file is committed before network activity. A blocked drainer cannot block enqueue.
      const controller=new AbortController();active.add(controller);const timer=setTimeout(()=>controller.abort(),5000);timer.unref();
      try {
        const delivery=await queue.flush(async(config,options)=>{current();return connect(config,options);},
          {limit:1,eventId:stored.event_id,signal:controller.signal,authorize:()=>current()});
        return {...stored,delivery};
      }catch(e){return {...stored,delivery:{delivered:0,retained:1,last_error:captureCode(e)}};}
      finally{clearTimeout(timer);active.delete(controller);}
    },
    close(){closed=true;for(const controller of active)controller.abort();},
  };
}
