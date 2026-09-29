/** Shared on-disk capture contract. No filesystem, network or recovery authority. */
import {captureRequest} from './client-kit.mjs';
import {requireThat,UltraError,sha256} from './core.mjs';
export const MAX_RECORD=220000,MAX_FILES=256,MAX_BYTES=8*1024*1024,MAX_ATTEMPTS=8;
export const RECORD=/^[a-f0-9]{64}\.entry$/;
export const TEMP=/^\.tmp-[a-f0-9-]{36}$/;
export const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
export const journalDigest=x=>sha256(JSON.stringify(canonical(x)));
export function journalBinding(p,workspace){
 return {format:1,source:p.source,instance:p.expectedInstance,actor:p.expectedActor,project:p.projectId,
  workspace_sha256:sha256(process.platform==='win32'?workspace.toLowerCase():workspace),server_sha256:journalDigest(p.server)};
}
export function verifyJournalBinding(value,bindingHash){
 requireThat(value?.binding_sha256===bindingHash&&journalDigest(Object.fromEntries(Object.entries(value).filter(([k])=>k!=='binding_sha256')))===bindingHash,
  'identity_mismatch','Outbox is bound to a different destination or workspace');
}
export function verifyJournalRecord(name,r,bindingHash,profile){
 requireThat(r?.format===1&&r.binding_sha256===bindingHash&&['pending','blocked'].includes(r.state)&&
  Number.isInteger(r.attempts)&&r.attempts>=0&&r.attempts<=MAX_ATTEMPTS&&Number.isFinite(r.next_attempt_at)&&r.next_attempt_at>=0,
  'outbox_corrupt','Invalid journal state');
 let normalized;try{normalized=captureRequest(r.payload,{...profile,allowCapture:true});}catch{throw new UltraError('outbox_corrupt','Invalid stored request');}
 requireThat(journalDigest(normalized)===r.request_sha256&&sha256(r.payload.event_id)+'.entry'===name,
  'outbox_corrupt','Journal request fingerprint mismatch');
 return r;
}
