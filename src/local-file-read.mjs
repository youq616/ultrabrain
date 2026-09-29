/** Bounded leaf-file reads for trusted local profiles and capture journals.
 * Native BigInt metadata avoids lossy identity/time comparisons. This is a
 * race detector in a trusted directory, not a hostile same-user sandbox. */
import {constants,lstatSync,fstatSync,openSync,readSync,closeSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {requireThat,UltraError} from './core.mjs';
const options=Object.freeze({bigint:true});
const diagnostic=new WeakMap();
const nativeCodes=new Set(['ENOENT','EACCES','EPERM','EBUSY','EIO','EMFILE','ENFILE','ELOOP','EINVAL','ENOTDIR','EBADF','ENOTSUP']);
const own=(v,k)=>{try{return Object.getOwnPropertyDescriptor(v,k)?.value;}catch{return undefined;}};
const unsigned=v=>typeof v==='bigint'&&v>=0n&&v<=0xffffffffffffffffn;
/** Directional Windows compatibility only: path fast-stat may return the full
 * 64-bit volume serial while handle-stat returns its unsigned low 32 bits.
 * Never mask two wide values, reverse the direction, or coerce rounded Numbers.
 * See Node v22.16.0 deps/uv/src/win/fs.c fs__stat_path / fs__stat_handle. */
export function localDeviceCompatible(pathDevice,handleDevice,platform=process.platform){
 if(!unsigned(pathDevice)||!unsigned(handleDevice))return false;
 if(pathDevice===handleDevice)return true;
 return platform==='win32'&&pathDevice>0xffffffffn&&handleDevice>0n&&handleDevice<=0xffffffffn&&
  (pathDevice&0xffffffffn)===handleDevice;
}
const fields=['ino','mode','nlink','uid','gid','size','mtimeNs','ctimeNs','birthtimeNs'];
const same=(a,b)=>a.dev===b.dev&&fields.every(k=>a[k]===b[k]);
const bridge=(path,handle)=>localDeviceCompatible(path.dev,handle.dev)&&fields.every(k=>path[k]===handle[k]);
export function localFileReadDiagnostic(error){return diagnostic.get(error)??null;}
/** Callers check parent-directory/authority bindings; this reader checks the
 * selected leaf before open, both handle observations and the final path.
 * profile permits existing aliases; outbox requires exactly one hard link.
 * No writes, permission changes, retries or cleanup deletion occur here. */
export function readLocalFileBytes(path,kind,maxBytes=kind==='profile'?16384:220000){
 requireThat(typeof path==='string'&&isAbsolute(path)&&!path.includes('\0')&&['profile','outbox'].includes(kind)&&
  Number.isSafeInteger(maxBytes)&&maxBytes>=1&&maxBytes<=(kind==='profile'?16384:220000),'invalid_params','Invalid local file selection');
 const invalid=kind==='profile'?'insecure_profile':'outbox_corrupt';
 let phase='path-before',fd,result,primary;
 const failure=(reason,error)=>{
  const e=new UltraError(reason==='permissions'||reason==='type'?(kind==='profile'?'insecure_profile':'insecure_outbox'):invalid,
   'Local file was not confirmed; preserve it for explicit inspection');
  diagnostic.set(e,Object.freeze({kind,phase,reason,system_code:nativeCodes.has(own(error,'code'))?own(error,'code'):null,close_failed:false}));return e;
 };
 const check=(ok,reason)=>{if(!ok)throw failure(reason);};
 const validate=st=>{
  check(st.isFile()&&!st.isSymbolicLink(),'type');
  check(unsigned(st.dev)&&unsigned(st.ino)&&st.ino>0n&&fields.every(k=>typeof st[k]==='bigint'),'metadata');
  check(st.size>=0n&&st.size<=BigInt(maxBytes),'bounds');
  check(st.nlink>=1n&&(kind!=='outbox'||st.nlink===1n),'aliases');
  if(typeof process.getuid==='function')check(st.uid===BigInt(process.getuid())&&
   (st.mode&BigInt(kind==='profile'?0o022:0o077))===0n,'permissions');
 };
 try{
  const before=lstatSync(path,options);validate(before);
  phase='open';fd=openSync(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  phase='handle-before';const first=fstatSync(fd,options);validate(first);check(bridge(before,first),'identity');
  // Allocate only after a precise, capped size check; one extra byte detects growth.
  phase='read';const bytes=Buffer.alloc(Number(first.size)+1);let n=0;
  while(n<bytes.length){const got=readSync(fd,bytes,n,bytes.length-n,n);if(got===0)break;
   check(Number.isSafeInteger(got)&&got>0&&got<=bytes.length-n,'read-count');n+=got;}
  phase='handle-after';const end=fstatSync(fd,options);validate(end);
  check(BigInt(n)===first.size&&same(first,end),'changed');
  phase='path-after';const last=lstatSync(path,options);validate(last);
  // Keep full-width path/path and handle/handle comparisons even on Windows.
  check(same(before,last)&&bridge(last,end),'changed');result=bytes.subarray(0,n);
 }catch(error){primary=diagnostic.has(error)?error:failure('io',error);}
 if(fd!==undefined){phase='close';try{closeSync(fd);}catch(error){
  if(primary)diagnostic.set(primary,Object.freeze({...diagnostic.get(primary),close_failed:true}));
  else primary=failure('io',error);
 }}
 if(primary)throw primary;return result;
}
