/** Revalidate bounded synthetic worker JSON; serialized diagnostics are reports,
 * not authenticated local errors or server receipts. Never echo arbitrary text. */
import {captureProcessDiagnostic} from './capture-process-diagnostic.mjs';
const object=x=>x&&typeof x==='object'&&!Array.isArray(x);
const one=(x,values)=>values.includes(x)?x:null;
const errno=x=>one(x,['EEXIST','EACCES','EPERM','EBUSY','ENOENT','ENOSPC','EDQUOT','EIO','EMFILE','ENFILE','EROFS','ENOTDIR','EISDIR','EINVAL','ELOOP','ENOTSUP','EXDEV','ENAMETOOLONG']);
function lock(x){
 if(!object(x))return null;
 const kind=one(x.kind,['queue','delivery']),phase=one(x.phase,['create','write','file-sync','close','directory-sync','verify-release','unlink','release-sync']);
 return kind&&phase?{kind,phase,system_code:errno(x.system_code)}:null;
}
function journal(x){
 if(!object(x))return null;
 const phases=['create','write','file-sync','close','publish','temporary-unlink','directory-sync'];
 const target=one(x.target,['binding','entry','control']),operation=one(x.operation,['create','replace']),phase=one(x.phase,phases);
 const publication=one(x.publication,['not_attempted','unconfirmed','visible']),directory_sync=one(x.directory_sync,['not_attempted','unsupported','unconfirmed','completed']);
 if(!target||!operation||!phase||!publication||!directory_sync)return null;
 const secondary=Array.isArray(x.secondary)?x.secondary.slice(0,2).filter(v=>object(v)&&phases.includes(v.phase)).map(v=>({phase:v.phase,system_code:errno(v.system_code)})):[];
 const result={target,operation,phase,system_code:errno(x.system_code),publication,directory_sync,secondary};
 if(Array.isArray(x.lock_release))result.lock_release=x.lock_release.slice(0,2).map(lock).filter(Boolean);
 return result;
}
export function controlWorkerReport(text,{overflow=false}={}){
 let r;try{if(!overflow&&typeof text==='string'&&Buffer.byteLength(text)<=4096)r=JSON.parse(text);}catch{}
 if(!object(r))return {ok:false,code:'invalid_worker_report'};
 if(r.ok===true&&['resumed','conflict'].includes(r.outcome))return {ok:true,outcome:r.outcome};
 if(r.ok!==false)return {ok:false,code:'invalid_worker_report'};
 const safe=captureProcessDiagnostic(r);
 return {ok:false,...safe,lock:lock(r.lock),journal:journal(r.journal),native_code:errno(r.native_code),
  target:one(r.target,['queue-lock','delivery-lock','binding','entry','temporary','other'])};
}
