/** Atomic publication of a private capture journal record. Internal local IO only.
 * A visible directory entry is NOT a server receipt or a power-loss guarantee.
 * Failed writes preserve their temporary evidence; never retry, roll back a
 * published entry, overwrite via a fallback, or delete an unowned temp path. */
import {constants,openSync,writeFileSync,fsyncSync,closeSync,renameSync,linkSync,unlinkSync} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {requireThat,UltraError} from './core.mjs';
import {captureLockDiagnostic} from './capture-lock.mjs';
const diagnostics=new WeakMap();
const systemCodes=new Set(['EEXIST','EACCES','EPERM','EBUSY','ENOENT','ENOSPC','EDQUOT','EIO','EMFILE','ENFILE','EROFS','ENOTDIR','EISDIR','EINVAL','ELOOP','ENOTSUP','EXDEV','ENAMETOOLONG']);
const systemCode=error=>{let code;try{code=Object.getOwnPropertyDescriptor(error,'code')?.value;}catch{}return systemCodes.has(code)?code:null;};
export function captureJournalDiagnostic(error){return diagnostics.get(error)??null;}
/** Preserve only authentic local journal + lock failures at trusted cleanup
 * boundaries. No arbitrary cause/message/property copying or remote receipts. */
export function retainCaptureJournalFailure(primary,cleanup){
 const first=diagnostics.get(primary),lock=captureLockDiagnostic(cleanup);
 if(!first||!lock)return cleanup;
 diagnostics.set(primary,Object.freeze({...first,lock_release:Object.freeze([...(first.lock_release??[]),lock].slice(0,2))}));
 return primary;
}
/** Existing durability boundary. Windows has file fsync only. */
export function syncCaptureDirectory(directory){
 if(process.platform==='win32')return;
 const fd=openSync(directory,constants.O_RDONLY|constants.O_DIRECTORY|(constants.O_NOFOLLOW??0));let failure,failed=false;
 try{fsyncSync(fd);}catch(error){failure=error;failed=true;}
 try{closeSync(fd);}catch(error){if(!failed){failure=error;failed=true;}}
 if(failed)throw failure;
}
/** Caller owns the queue lock and has checked private directory, binding,
 * consent, names and quotas. This low-level primitive grants no authority. */
export function commitCaptureJournal(directory,name,bytes,{replace=true}={}){
 requireThat(typeof directory==='string'&&isAbsolute(directory)&&!directory.includes('\0')&&
  typeof name==='string'&&(name==='binding.json'||/^[a-f0-9]{64}\.entry$/.test(name))&&
  Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<=220000&&typeof replace==='boolean',
  'invalid_params','Invalid capture journal publication');
 const target=name==='binding.json'?'binding':'entry',operation=replace?'replace':'create';
 const temp=join(directory,'.tmp-'+randomUUID()),destination=join(directory,name);
 let fd,phase='create',primary=null,publication='not_attempted',directorySync='not_attempted';const secondary=[];
 const note=error=>{const detail=Object.freeze({phase,system_code:systemCode(error)});if(primary)secondary.push(detail);else primary=detail;};
 try{
  fd=openSync(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW??0),0o600);
  phase='write';writeFileSync(fd,bytes);phase='file-sync';fsyncSync(fd);
 }catch(error){note(error);}
 // Exactly one close attempt; a close error must not replace the write error.
 if(fd!==undefined){phase='close';try{closeSync(fd);}catch(error){note(error);}}
 if(!primary)try{
  phase='publish';publication='unconfirmed';
  if(replace)renameSync(temp,destination);else linkSync(temp,destination);
  publication='visible';
  if(!replace){phase='temporary-unlink';unlinkSync(temp);}
  phase='directory-sync';directorySync=process.platform==='win32'?'unsupported':'unconfirmed';
  syncCaptureDirectory(directory);if(process.platform!=='win32')directorySync='completed';
 }catch(error){note(error);}
 if(primary){
  const error=new UltraError('outbox_journal_io','Capture journal publication failed; preserve files for explicit inspection');
  diagnostics.set(error,Object.freeze({target,operation,...primary,publication,directory_sync:directorySync,
   secondary:Object.freeze(secondary)}));throw error;
 }
}
