/** Release the reusable lock name before deleting its old file on Windows.
 * Cooperative, trusted-directory protocol; not a hostile same-user sandbox.
 * No native retries, unknown-file cleanup, lock stealing or network IO. */
import {constants,openSync,writeFileSync,fsyncSync,closeSync,renameSync,unlinkSync} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {sha256,requireThat} from './core.mjs';
import {readLocalFileBytes} from './local-file-read.mjs';
import {captureLockError} from './capture-lock.mjs';
import {syncCaptureDirectory} from './capture-journal.mjs';
const UUID='[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
export const RETIRED_CAPTURE_LOCK=new RegExp('^\\.retired-(?:queue|delivery)-'+UUID+'\\.lock$');
/** Internal caller has already established source/workspace and lock ownership.
 * Reserve a unique target with exclusive create before rename can replace it.
 * A failure preserves evidence; namespace state never claims a rollback. */
export function retireCaptureLock(directory,kind,expectedHash,checkDirectory){
 requireThat(typeof directory==='string'&&isAbsolute(directory)&&!directory.includes('\0')&&
  ['queue','delivery'].includes(kind)&&typeof expectedHash==='string'&&/^[a-f0-9]{64}$/.test(expectedHash)&&
  typeof checkDirectory==='function','invalid_params','Invalid lock retirement');
 const active=join(directory,'.'+kind+'.lock'),nonce=randomUUID(),retired=join(directory,'.retired-'+kind+'-'+nonce+'.lock');
 const marker=Buffer.from(JSON.stringify({format:1,purpose:'capture-lock-retirement',nonce})+'\n');
 const markerHash=sha256(marker);
 let phase='retire-check',namespace='not_released',fd,primary,primaryPhase,failed=false,closeFailed=false;
 const check=()=>{const r=checkDirectory();if(r&&typeof r.then==='function')Promise.resolve(r).catch(()=>{});requireThat(r!==false&&!(r&&typeof r.then==='function'),'insecure_outbox','Synchronous directory check required');};
 const matches=(path,hash)=>requireThat(sha256(readLocalFileBytes(path,'outbox',2048))===hash,
  'outbox_lock_changed','Lock retirement identity changed; preserve files');
 try{
  check();matches(active,expectedHash);
  phase='retire-create';fd=openSync(retired,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW??0),0o600);
  phase='retire-write';writeFileSync(fd,marker);phase='retire-sync';fsyncSync(fd);
 }catch(error){primary=error;primaryPhase=phase;failed=true;}
 if(fd!==undefined)try{phase='retire-close';closeSync(fd);}catch(error){
  closeFailed=true;if(!failed){primary=error;primaryPhase=phase;failed=true;}
 }
 if(failed)throw captureLockError(primary,kind,primaryPhase,{namespace_state:namespace,close_failed:closeFailed});
 try{
  phase='retire-check';check();matches(retired,markerHash);matches(active,expectedHash);
  // Critical work is over. A new owner may claim the original name as soon as
  // rename succeeds. Never inspect/delete that reusable name after this point.
  phase='retire-rename';namespace='unconfirmed';renameSync(active,retired);namespace='released';
  phase='retire-verify';check();matches(retired,expectedHash);
  phase='retire-unlink';unlinkSync(retired);
  phase='retire-flush';syncCaptureDirectory(directory);
 }catch(error){throw captureLockError(error,kind,phase,{namespace_state:namespace,close_failed:false});}
}
