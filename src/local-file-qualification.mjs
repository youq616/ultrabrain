/** Local runtime qualification against one NEW synthetic file, never a user
 * profile or queue. Passing covers this temporary-directory filesystem only. */
import {mkdtempSync, writeFileSync, openSync, closeSync, lstatSync, fstatSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {readLocalFileBytes, localDeviceCompatible, localFileReadDiagnostic} from './local-file-read.mjs';
const FIELDS=Object.freeze(['dev','ino','mode','nlink','uid','gid','size','mtimeNs','ctimeNs','birthtimeNs']);
const CODES=new Set(['EACCES','EPERM','ENOENT','EIO','EBADF','ENOSPC','EEXIST','EBUSY','EMFILE','ENFILE','ELOOP','EINVAL','ENOTDIR','ENOTSUP','EROFS']);
const own=(x,k)=>{try{return Object.getOwnPropertyDescriptor(x,k)?.value;}catch{return undefined;}};
const freeze=x=>{if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
const fail=(code)=>{throw Object.assign(Error(code),{code});};
/** Metadata values are never emitted: only exact comparison names and zero flags.
 * Unknown/getter fields cannot be used as an information disclosure channel. */
export function localFileObservation(pathStat,handleStat){
 const left=Object.fromEntries(FIELDS.map(k=>[k,own(pathStat,k)]));
 const right=Object.fromEntries(FIELDS.map(k=>[k,own(handleStat,k)]));
 if(!FIELDS.every(k=>typeof left[k]==='bigint'&&typeof right[k]==='bigint'))fail('invalid_stat_observation');
 return freeze({device_relation:left.dev===right.dev?'exact':localDeviceCompatible(left.dev,right.dev)?'windows-wide-path-narrow-handle':'unrecognized',
  path_device_zero:left.dev===0n,handle_device_zero:right.dev===0n,
  path_device_negative:left.dev<0n,handle_device_negative:right.dev<0n,
  inode_zero:left.ino===0n||right.ino===0n,changed_fields:FIELDS.filter(k=>left[k]!==right[k])});
}
function options(value){
 let properties,keys,prototype;
 try{prototype=Object.getPrototypeOf(value);properties=Object.getOwnPropertyDescriptors(value);keys=Reflect.ownKeys(properties);}catch{fail('invalid_params');}
 if(!value||typeof value!=='object'||Array.isArray(value)||(prototype!==null&&prototype!==Object.prototype)||!keys.every(k=>k==='signal'&&properties[k].enumerable&&Object.hasOwn(properties[k],'value')))
  fail('invalid_params');
 const signal=Object.hasOwn(properties,'signal')?properties.signal.value:undefined;
 if(signal!==undefined&&!(signal instanceof AbortSignal))fail('invalid_params');
 return signal;
}
/** No path argument by design. Environment-selected OS temp location is trusted.
 * No permission repair, retries of reads, persistent capability cache or server.
 * Cancellation is observed at synchronous boundaries, not during blocked syscalls. */
export function qualifyLocalFileRuntime(input={}){
 const signal=options(input),checks=[];let root,fd,phase='prepare',observation=null,primary=null,cleanupFailure=null;
 const allowed=()=>{if(signal?.aborted)fail('aborted');};
 const errorReport=error=>({phase,error:own(error,'code')==='aborted'?'aborted':'local_qualification_failed',
  system_code:CODES.has(own(error,'code'))?own(error,'code'):null,diagnostic:localFileReadDiagnostic(error)});
 const close=()=>{const held=fd;fd=undefined;if(held!==undefined)closeSync(held);};
 try{
  allowed();root=mkdtempSync(join(tmpdir(),'ub-local-qualification-'));allowed();
  const path=join(root,'synthetic'),expected=Buffer.from('ultrabrain synthetic local file qualification\n');
  writeFileSync(path,expected,{__proto__:null,mode:0o600,flag:'wx'});allowed();
  phase='path-observation';const before=lstatSync(path,{__proto__:null,bigint:true});allowed();
  phase='observation-open';fd=openSync(path,'r');allowed();
  phase='handle-observation';const handle=fstatSync(fd,{__proto__:null,bigint:true});allowed();
  observation=localFileObservation(before,handle);
  phase='observation-close';close();allowed();
  // These are two separate policy checks, not retries of one failed read.
  for(const kind of ['profile','outbox']){
   phase=kind+'-read';allowed();
   try{const bytes=readLocalFileBytes(path,kind);allowed();
    if(!bytes.equals(expected))fail('synthetic_content_mismatch');checks.push({kind,passed:true,failure:null});
   }catch(error){if(own(error,'code')==='aborted')throw error;checks.push({kind,passed:false,failure:errorReport(error)});}
  }
  phase='delivery';allowed();
 }catch(error){primary=errorReport(error);}
 finally{
  phase='cleanup-close';try{close();}catch(error){cleanupFailure=errorReport(error);}
  phase='cleanup-directory';if(root!==undefined)try{rmSync(root,{__proto__:null,recursive:true,force:true});}catch(error){cleanupFailure??=errorReport(error);}
 }
 // A cancellation observed during cleanup withholds a positive qualification.
 if(signal?.aborted&&!primary){phase='delivery';primary={phase,error:'aborted',system_code:null,diagnostic:null};}
 const passed=!primary&&!cleanupFailure&&checks.length===2&&checks.every(c=>c.passed);
 return freeze({format:'ultrabrain-local-qualification-v1',passed,platform:process.platform,node:process.version,uv:process.versions.uv,
  scope:'temporary-directory-filesystem',observation,checks,failure:primary,cleanup_failure:cleanupFailure,
  user_files_selected:false,synthetic_writes_only:true,memory_writes_requested:false,network_requests:0,model_calls:0,
  production_queue_verified:false,atomic_snapshot:false,
  limitations:['temporary-filesystem-only','observations-not-an-atomic-snapshot','no-ACL-or-volume-attestation','no-permission-or-lock-repair','trusted-process-and-temp-directory']});
}
