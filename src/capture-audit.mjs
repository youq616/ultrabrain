/** Explicit local read-only audit. No writer construction, lock acquisition,
 * repair, capture grant, SDK, credentials or network. A scan is NOT a snapshot.
 * Reads consented entry bytes into memory for validation, never returns them. */
import {constants,lstatSync,fstatSync,openSync,readSync,closeSync,opendirSync,realpathSync} from 'node:fs';
import {resolve,dirname,parse,isAbsolute,relative,sep,join} from 'node:path';
import {setImmediate as yieldTurn} from 'node:timers/promises';
import {clientProfile} from './client-kit.mjs';
import {checkCaptureSignal} from './capture-lock.mjs';
import {parseSnapshotJSON} from './personal-snapshot-contract.mjs';
import {MAX_RECORD,MAX_FILES,MAX_BYTES,RECORD,TEMP,journalDigest,journalBinding,verifyJournalBinding,verifyJournalRecord} from './capture-journal-contract.mjs';
import {UltraError,requireThat} from './core.mjs';
const MAX_SCAN=MAX_FILES+16,READ_BUDGET=MAX_BYTES+4096+MAX_FILES+1;
const nativeCodes=new Set(['EACCES','EPERM','EBUSY','ENOENT','EIO','EMFILE','ENFILE','ENOTDIR','EISDIR','EINVAL','ELOOP','ENOTSUP']);
const ownCode=e=>{try{return Object.getOwnPropertyDescriptor(e,'code')?.value;}catch{return undefined;}};
const fail=code=>{throw new UltraError(code,'Read-only queue audit could not complete this check');};
const meta=s=>[s.dev,s.ino,s.mode,s.uid,s.nlink,s.size,s.mtimeMs,s.ctimeMs];
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function privatePath(s,kind){
 if(s.isSymbolicLink()||!(kind==='directory'?s.isDirectory():s.isFile()))fail('insecure_outbox');
 if(typeof process.getuid==='function'&&(s.uid!==process.getuid()||(s.mode&0o077)!==0))fail('insecure_outbox');
 if(kind!=='directory'&&s.nlink!==1)fail('insecure_outbox');
}
function parents(path){
 for(let p=dirname(path);p!==parse(p).root;p=dirname(p)){
  const s=lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink())fail('insecure_outbox');
 }
}
const outside=(workspace,path)=>{const r=relative(workspace,path);return r!==''&&(r==='..'||r.startsWith('..'+sep)||isAbsolute(r));};
function dirStat(path){parents(path);const s=lstatSync(path);privatePath(s,'directory');return s;}
function inventory(path,check){
 check();const before=dirStat(path),dir=opendirSync(path,{bufferSize:16});const items=[],seen=new Set();
 try{
  for(let entry;(entry=dir.readSync())!==null;){
   check();if(seen.has(entry.name))fail('audit_changed');seen.add(entry.name);
   if(items.length===MAX_SCAN)fail('audit_limit');
   const s=lstatSync(join(path,entry.name));items.push({name:entry.name,stat:s,meta:meta(s)});
  }
 }finally{dir.closeSync();}
 check();const after=dirStat(path);if(!same(meta(before),meta(after)))fail('audit_changed');
 items.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
 return {items,stamp:[meta(after),...items.map(i=>[i.name,...i.meta])]};
}
function readJSON(path,item,max,budget,check){
 check();privatePath(item.stat,'file');
 if(item.stat.size>max)fail('audit_oversize');
 if(budget.remaining<item.stat.size+1)fail('audit_limit');
 // Charge even a failed or growing read; the bound includes the detection byte.
 budget.remaining-=item.stat.size+1;
 const fd=openSync(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));
 let bytes;
 try{
  const s=fstatSync(fd);privatePath(s,'file');if(!same(meta(s),item.meta))fail('audit_changed');
  bytes=Buffer.alloc(s.size+1);let n=0;
  while(n<bytes.length){check();const got=readSync(fd,bytes,n,bytes.length-n,null);if(!got)break;n+=got;}
  if(n!==s.size||!same(meta(fstatSync(fd)),item.meta)||!same(meta(lstatSync(path)),item.meta))fail('audit_changed');
  bytes=bytes.subarray(0,n);
 }finally{closeSync(fd);}
 check();try{return parseSnapshotJSON(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
 catch{fail('outbox_corrupt');}
}
/** Counts are null when a locked, changed, foreign, unbound or over-budget queue
 * prevents a complete entry pass. No hashes/names/PIDs are recovery approvals. */
export async function auditCaptureOutbox(input,{signal,authorize=()=>{}}={}){
 let controlError;
 const check=()=>{try{
  checkCaptureSignal(signal);requireThat(typeof authorize==='function','invalid_params','Use synchronous local authorization');
  const v=authorize();if(v&&typeof v.then==='function'){Promise.resolve(v).catch(()=>{});fail('invalid_params');}
  requireThat(v!==false,'capture_disabled','Local audit authorization declined');checkCaptureSignal(signal);
 }catch(e){controlError=e;throw e;}};
 check();const profile=clientProfile(structuredClone(input));
 requireThat(profile.outboxDirectory&&isAbsolute(profile.outboxDirectory)&&profile.workspace&&profile.expectedActor&&profile.expectedInstance,
  'invalid_profile','Audit requires an outbox, workspace and identity pins');
 const path=resolve(profile.outboxDirectory),budget={remaining:READ_BUDGET};
 const report={format:1,storage:'client_journal_audit',read_only:true,status:'unavailable',complete:false,
  snapshot_consistent:false,server_confirmation:false,counts:null,locks:{queue:false,delivery:false},
  records_validated:0,bytes_read_budget_used:0,findings:[],next_action:'inspect_local_files',
  limits:{directory_entries:MAX_SCAN,record_bytes:MAX_RECORD,total_read_bytes:READ_BUDGET}};
 const finding=(kind,code,system_code=null,count=1)=>{
  const f=report.findings.find(f=>f.kind===kind&&f.code===code&&f.system_code===system_code);
  if(f)f.count+=count;else report.findings.push({kind,code,system_code,count});
 };
 const finish=(status,complete=false)=>{
  check();report.status=status;report.complete=complete;report.bytes_read_budget_used=READ_BUDGET-budget.remaining;
  report.next_action=['healthy','absent','uninitialized'].includes(status)?'none':status==='busy'?'wait_for_writers':status==='changed'?'stop_writers_and_recheck':'inspect_local_files';
  return report;
 };
 let phase='directory',observed=false;
 try{
  parents(path);const workspace=realpathSync(profile.workspace),candidate=resolve(realpathSync(dirname(path)),path.slice(dirname(path).length+1));
  if(!outside(workspace,candidate))fail('insecure_outbox');
  let initial;
  try{initial=dirStat(path);}catch(e){if(ownCode(e)!=='ENOENT')throw e;
   // Missing parent/workspace is not an absent queue. parents() must still pass.
   parents(path);check();try{lstatSync(path);fail('audit_changed');}catch(e2){if(ownCode(e2)!=='ENOENT')throw e2;}
   return finish('absent',true);
  }
  observed=true;
  if(!outside(workspace,realpathSync(path)))fail('insecure_outbox');
  const first=inventory(path,check);if(!same(meta(initial),first.stamp[0]))fail('audit_changed');
  const entries=first.items.filter(i=>RECORD.test(i.name)),temps=first.items.filter(i=>TEMP.test(i.name));
  const binding=first.items.find(i=>i.name==='binding.json');
  report.locks={queue:first.items.some(i=>i.name==='.queue.lock'),delivery:first.items.some(i=>i.name==='.delivery.lock')};
  if(report.locks.queue||report.locks.delivery)return finish('busy'); // Never open even malformed locks.
  if(entries.length>MAX_FILES||[...entries,...temps].reduce((n,i)=>n+i.stat.size,0)>MAX_BYTES)fail('audit_limit');
  const unknown=first.items.filter(i=>!RECORD.test(i.name)&&!TEMP.test(i.name)&&i.name!=='binding.json');
  if(temps.length)finding('temporary','interrupted_or_active_write',null,temps.length);
  if(unknown.length)finding('unexpected','unrecognized_files',null,unknown.length);
  for(const i of [...temps,...unknown]){try{privatePath(i.stat,'file');}catch{finding('metadata','insecure_outbox');}}
  let bindingOK=false,counts={entries:entries.length,pending:0,blocked:0,invalid:0,temporary:temps.length,unexpected:unknown.length};
  phase='binding';
  if(binding){
   const hash=journalDigest(journalBinding(profile,workspace));
   try{verifyJournalBinding(readJSON(join(path,binding.name),binding,4096,budget,check),hash);bindingOK=true;}
   catch(e){
    if(e===controlError)throw e;
    if(!['identity_mismatch','outbox_corrupt','insecure_outbox','audit_oversize'].includes(ownCode(e)))throw e;
    finding('binding',ownCode(e));
   }
   if(bindingOK){
    phase='entry';
    for(let index=0;index<entries.length;index++){
     // Make cancellation/profile changes observable during larger inspections.
     if(index%8===0){await yieldTurn(undefined,{signal});check();}
     const i=entries[index];
     try{
      const r=verifyJournalRecord(i.name,readJSON(join(path,i.name),i,MAX_RECORD,budget,check),hash,profile);
      counts[r.state]++;report.records_validated++;
     }catch(e){
      if(e===controlError)throw e;
      if(!['outbox_corrupt','insecure_outbox','audit_oversize'].includes(ownCode(e)))throw e;
      counts.invalid++;finding('entry',ownCode(e));
     }
    }
   }
  }else if(first.items.length)finding('binding','outbox_unbound');
  phase='directory';const last=inventory(path,check);if(!same(first.stamp,last.stamp))fail('audit_changed');
  if(first.items.length===0){report.counts=counts;return finish('uninitialized',true);}
  if(bindingOK){report.counts=counts;if(counts.blocked)finding('entry','blocked_delivery',null,counts.blocked);}
  return finish(report.findings.length?'attention':'healthy',bindingOK);
 }catch(e){
  // No arbitrary exception messages, paths, properties or attacker-controlled codes.
  if(e===controlError)throw e;
  check();const code=ownCode(e);
  if(['aborted','capture_disabled','invalid_params'].includes(code))throw e;
  report.counts=null;report.records_validated=0;
  if(code==='audit_changed'||code==='ENOENT'&&observed){finding('directory','changed_during_scan');return finish('changed');}
  if(code==='audit_limit'){finding(phase,'scan_limit');return finish('limited');}
  finding(phase,code==='insecure_outbox'?'insecure_outbox':'read_failed',nativeCodes.has(code)?code:null);
  return finish('unavailable');
 }
}
