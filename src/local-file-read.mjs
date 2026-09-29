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
// Node fills BigInt64Array stats: high-bit native IDs can be negative.
// Preserve their exact raw representation within one stat domain.
const nativeId=v=>typeof v==='bigint'&&v>=-0x8000000000000000n&&v<=0xffffffffffffffffn;
/** Directional Windows compatibility only: path fast-stat may return the full
 * 64-bit volume serial (possibly signed by Node's BigInt64 buffer), while
 * handle-stat returns its unsigned low 32 bits.
 * Never mask two wide values, reverse the direction, or coerce rounded Numbers.
 * See Node v22.16.0 deps/uv/src/win/fs.c fs__stat_path / fs__stat_handle. */
export function localDeviceCompatible(pathDevice,handleDevice,platform=process.platform){
 if(!nativeId(pathDevice)||!nativeId(handleDevice))return false;
 if(pathDevice===handleDevice)return true;
 const pathBits=BigInt.asUintN(64,pathDevice);
 return platform==='win32'&&pathBits>0xffffffffn&&handleDevice>0n&&handleDevice<=0xffffffffn&&
  (pathBits&0xffffffffn)===handleDevice;
}
const fields=['ino','mode','nlink','uid','gid','size','mtimeNs','ctimeNs','birthtimeNs'];
const same=(a,b)=>a.dev===b.dev&&fields.every(k=>a[k]===b[k]);
const sameFields=(a,b)=>fields.every(k=>a[k]===b[k]);
export function localFileReadDiagnostic(error){return diagnostic.get(error)??null;}
/** Callers check parent-directory/authority bindings; this reader checks the
 * selected leaf before open, both handle observations and the final path.
 * profile permits existing aliases; outbox requires exactly one hard link.
 * Win32 stat domains may not have comparable device IDs. In that case a second
 * read-only descriptor anchors the pathname without relaxing same-domain checks.
 * This is not a hostile same-user sandbox or a Windows ACL/volume attestation.
 * No writes, permission changes, retries or cleanup deletion occur here. */
export function readLocalFileBytes(path,kind,maxBytes=kind==='profile'?16384:220000){
 requireThat(typeof path==='string'&&isAbsolute(path)&&!path.includes('\0')&&['profile','outbox'].includes(kind)&&
  Number.isSafeInteger(maxBytes)&&maxBytes>=1&&maxBytes<=(kind==='profile'?16384:220000),'invalid_params','Invalid local file selection');
 const invalid=kind==='profile'?'insecure_profile':'outbox_corrupt';
 let phase='path-before',fd,anchor,result,primary;
 const failure=(reason,error)=>{
  const e=new UltraError(reason==='permissions'||reason==='type'?(kind==='profile'?'insecure_profile':'insecure_outbox'):invalid,
   'Local file was not confirmed; preserve it for explicit inspection');
  diagnostic.set(e,Object.freeze({kind,phase,reason,system_code:nativeCodes.has(own(error,'code'))?own(error,'code'):null,close_failed:false}));return e;
 };
 const check=(ok,reason)=>{if(!ok)throw failure(reason);};
 const validate=st=>{
  check(st.isFile()&&!st.isSymbolicLink(),'type');
  check(nativeId(st.dev)&&nativeId(st.ino)&&st.ino!==0n&&fields.every(k=>typeof st[k]==='bigint'),'metadata');
  check(st.size>=0n&&st.size<=BigInt(maxBytes),'bounds');
  check(st.nlink>=1n&&(kind!=='outbox'||st.nlink===1n),'aliases');
  if(typeof process.getuid==='function')check(st.uid===BigInt(process.getuid())&&
   (st.mode&BigInt(kind==='profile'?0o022:0o077))===0n,'permissions');
 };
 try{
  const before=lstatSync(path,options);validate(before);
  phase='open';fd=openSync(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  phase='handle-before';const first=fstatSync(fd,options);validate(first);
  check(sameFields(before,first),'identity');
  // Never infer identity by accepting arbitrary unequal device values. On
  // Win32 only, a non-comparable path/handle pair requires a second live open
  // of the selected path. Compare devices FULL-WIDTH within each stat domain.
  // The anchor is held throughout the bounded read and checked a second time.
  const anchored=!localDeviceCompatible(before.dev,first.dev);
  if(anchored){
   check(process.platform==='win32'&&before.dev!==0n&&first.dev!==0n,'identity');
   phase='anchor-open';anchor=openSync(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
   phase='anchor-before';const witness=fstatSync(anchor,options);validate(witness);
   check(same(first,witness),'identity');
   phase='path-anchor';const bound=lstatSync(path,options);validate(bound);
   check(same(before,bound)&&sameFields(bound,witness),'changed');
  }
  // Allocate only after a precise, capped size check; one extra byte detects growth.
  phase='read';const bytes=Buffer.alloc(Number(first.size)+1);let n=0;
  while(n<bytes.length){const got=readSync(fd,bytes,n,bytes.length-n,n);if(got===0)break;
   check(Number.isSafeInteger(got)&&got>0&&got<=bytes.length-n,'read-count');n+=got;}
  phase='handle-after';const end=fstatSync(fd,options);validate(end);
  check(BigInt(n)===first.size&&same(first,end),'changed');
  if(anchored){
   phase='anchor-after';const witness=fstatSync(anchor,options);validate(witness);
   check(same(first,witness)&&same(end,witness),'changed');
  }
  phase='path-after';const last=lstatSync(path,options);validate(last);
  // Keep full-width path/path and handle/handle comparisons even on Windows.
  check(same(before,last)&&sameFields(last,end)&&
   (anchored||localDeviceCompatible(last.dev,end.dev)),'changed');result=bytes.subarray(0,n);
 }catch(error){primary=diagnostic.has(error)?error:failure('io',error);}
 for(const [descriptor,closingPhase]of [[anchor,'anchor-close'],[fd,'close']])if(descriptor!==undefined){
  phase=closingPhase;try{closeSync(descriptor);}catch(error){
  if(primary)diagnostic.set(primary,Object.freeze({...diagnostic.get(primary),close_failed:true}));
  else primary=failure('io',error);
 }}
 if(primary)throw primary;return result;
}
