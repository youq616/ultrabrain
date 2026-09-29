/** Cooperative local capture locks: bounded, abortable wait and safe IO diagnostics.
 * Only an exclusive-create collision is retried. Never steal an old lock, retry
 * permissions/IO errors, remove an unknown lock, or retry a capture submission. */
import {setTimeout as delay} from 'node:timers/promises';
import {performance} from 'node:perf_hooks';
import {requireThat,UltraError} from './core.mjs';
const details=new WeakMap();
const kinds=new Set(['queue','delivery']);
const phases=new Set(['create','write','file-sync','close','directory-sync','verify-release','unlink','release-sync']);
const systemCodes=new Set(['EEXIST','EACCES','EPERM','EBUSY','ENOENT','ENOSPC','EDQUOT','EIO','EMFILE','ENFILE','EROFS','ENOTDIR','EISDIR','EINVAL','ELOOP','ENOTSUP']);
const typedCodes=new Set(['insecure_outbox','outbox_corrupt','outbox_lock_changed']);
const own=(v,k)=>{try{return Object.getOwnPropertyDescriptor(v,k)?.value;}catch{return undefined;}};
export function checkCaptureSignal(signal){
 requireThat(signal===undefined||signal instanceof AbortSignal,'invalid_params','Use an AbortSignal');
 requireThat(!signal?.aborted,'aborted','Capture operation cancelled');
}
/** Called around actual local IO, not remote/provider errors. Preserve no paths,
 * messages, payloads or arbitrary error properties. A diagnostic is not a receipt. */
export function captureLockError(error,kind,phase){
 requireThat(kinds.has(kind)&&phases.has(phase),'invalid_params','Invalid lock diagnostic boundary');
 const code=own(error,'code');
 let local=false;try{local=error instanceof UltraError;}catch{}
 const result=new UltraError(local&&typedCodes.has(code)?code:'outbox_lock_io',
  'Capture lock operation failed; lock and journal may need explicit inspection');
 details.set(result,Object.freeze({kind,phase,system_code:systemCodes.has(code)?code:null}));
 return result;
}
export function captureLockDiagnostic(error){return details.get(error)??null;}
/** claim() must synchronously create/initialize one exclusive lock and return a
 * synchronous ownership-verifying release. check() is trusted live authority.
 * Both are internal IO ports, not accepted from a capture profile or event. */
export async function acquireCaptureLock(claim,{kind,waitMs=1000,signal,check=()=>{}}={}){
 requireThat(kinds.has(kind)&&typeof claim==='function'&&typeof check==='function'&&
  Number.isSafeInteger(waitMs)&&waitMs>=0&&waitMs<=1000,'invalid_params','Invalid capture lock configuration');
 const allowed=()=>{checkCaptureSignal(signal);const value=check();
  if(value&&typeof value.then==='function'){
   Promise.resolve(value).catch(()=>{});throw new UltraError('invalid_params','Lock checks must be synchronous');
  }
  requireThat(value!==false,'capture_disabled','Capture lock authorization declined');checkCaptureSignal(signal);
 };
 const deadline=performance.now()+waitMs,maxAttempts=1+Math.ceil(waitMs/15);
 let lastCollision;
 const exhausted=()=>{const busy=new UltraError('outbox_busy','Writer active or lock requires explicit recovery');
  if(lastCollision)details.set(busy,lastCollision);return busy;
 };
 for(let attempt=1;;attempt++){
  allowed();
  // The event loop can resume long after the timer's requested delay. Do not
  // perform a new exclusive create after this attempt's acquisition deadline.
  if(attempt>1&&performance.now()>=deadline)throw exhausted();
  let release;
  try{release=claim();}
  catch(error){
   const d=details.get(error);
   // EEXIST from write/fsync/close is not evidence of somebody else's lock.
   if(!d||d.kind!==kind||d.phase!=='create'||d.system_code!=='EEXIST')throw error;
   lastCollision=d;const remaining=deadline-performance.now();
   if(remaining<=0||attempt>=maxAttempts)throw exhausted();
   try{await delay(Math.min(15,remaining),undefined,{signal});}
   catch(error){checkCaptureSignal(signal);throw error;}
   continue;
  }
  requireThat(typeof release==='function','invalid_params','Lock claim must return its release');
  // A claim/check can observe cancellation during a synchronous IO test seam.
  // Once owned, cleanup does not obey cancellation: it must release OUR lock.
  try{allowed();}catch(error){release();throw error;}
  return release;
 }
}
