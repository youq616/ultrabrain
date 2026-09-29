/** Fixed diagnostics for synthetic child-process tests, never raw native errors. */
import {basename} from 'node:path';
import {captureJournalDiagnostic} from '../../src/capture-journal.mjs';
import {captureLockDiagnostic} from '../../src/capture-lock.mjs';
const codes=new Set(['outbox_busy','identity_mismatch','conflict','insecure_outbox','outbox_corrupt','outbox_unbound','outbox_full',
 'capture_disabled','invalid_profile','invalid_params','outbox_lock_changed','outbox_lock_io','outbox_journal_io','aborted']);
const nativeCodes=new Set(['EACCES','EPERM','EEXIST','EBUSY','ENOENT','EIO','ENOSPC','EROFS','EMFILE','ENFILE','EINVAL','EISDIR','ENOTDIR','ELOOP']);
const syscalls=new Set(['open','write','fsync','close','stat','lstat','fstat','mkdir','unlink','rename','link','scandir','read','realpath']);
const own=(o,k)=>{try{return Object.getOwnPropertyDescriptor(o,k)?.value;}catch{}};
export function captureProcessDiagnostic(error){
 const code=own(error,'code'),syscall=own(error,'syscall'),path=own(error,'path');let target=null;
 if(typeof path==='string'){
  const name=basename(path);target=name==='.queue.lock'?'queue-lock':name==='.delivery.lock'?'delivery-lock':
   name==='binding.json'?'binding':/^[a-f0-9]{64}\.entry$/.test(name)?'entry':/^\.tmp-[a-f0-9-]{36}$/.test(name)?'temporary':'other';
 }
 return {code:codes.has(code)?code:'writer_failed',lock:captureLockDiagnostic(error),journal:captureJournalDiagnostic(error),
  native_code:nativeCodes.has(code)?code:null,syscall:syscalls.has(syscall)?syscall:null,target};
}
