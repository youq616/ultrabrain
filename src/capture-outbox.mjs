/** Client-only delivery journal for personal capture. Not a second memory database.
 * Entries are removed only after an identity-bound, matching server journal receipt.
 * Separate short queue locks and delivery locks let hooks enqueue during network outages.
 */
import {constants,openSync,closeSync,writeFileSync,readSync,fsyncSync,lstatSync,fstatSync,
  mkdirSync,readdirSync,renameSync,unlinkSync,linkSync,realpathSync} from 'node:fs';
import {resolve,dirname,parse,isAbsolute,relative,sep,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {captureRequest,clientProfile,clientIdentity} from './client-kit.mjs';
import {requireThat,UltraError,sha256,integer} from './core.mjs';
const MAX_RECORD=220000, MAX_FILES=256, MAX_BYTES=8*1024*1024, MAX_ATTEMPTS=8;
const RECORD=/^[a-f0-9]{64}\.entry$/;
const TEMP=/^\.tmp-[a-f0-9-]{36}$/;
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const terminal=new Set(['conflict','permission_denied','capture_disabled','identity_mismatch','revision_conflict','mcp_contract_changed']);
const safeCodes=new Set([...terminal,'mcp_rejected','missing_credentials','outbox_corrupt','outbox_busy','outbox_full','aborted']);
const codeOf=e=>safeCodes.has(e?.code)?e.code:'delivery_unconfirmed';
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const digest=x=>sha256(JSON.stringify(canonical(x)));
function privateStat(st,kind) {
  requireThat(!st.isSymbolicLink()&&(kind==='dir'?st.isDirectory():st.isFile()),'insecure_outbox','Regular private outbox paths required');
  if(typeof process.getuid==='function')requireThat(st.uid===process.getuid()&&!(st.mode&0o077),'insecure_outbox','Outbox must be owner-only');
}
function parents(path) {
  for(let p=dirname(path);p!==parse(p).root;p=dirname(p)){
    const s=lstatSync(p);requireThat(s.isDirectory()&&!s.isSymbolicLink(),'insecure_outbox','Outbox parent links are forbidden');
  }
}
function readBytes(path,max=MAX_RECORD) {
  const before=lstatSync(path);privateStat(before,'file');
  requireThat(before.size<=max&&before.nlink===1,'outbox_corrupt','Outbox file exceeds bounds or has aliases');
  const fd=openSync(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try {
    const st=fstatSync(fd);requireThat(st.dev===before.dev&&st.ino===before.ino&&st.size<=max,'outbox_corrupt','Outbox file changed');
    // A bound read, not readFileSync on an untrusted-sized descriptor.
    const b=Buffer.alloc(st.size+1);let n=0;
    // One extra byte detects concurrent growth.
    while(n<b.length){const got=readSync(fd,b,n,b.length-n,null);if(!got)break;n+=got;}
    const end=fstatSync(fd);requireThat(n===st.size&&end.size===st.size&&end.mtimeMs===st.mtimeMs&&end.ctimeMs===st.ctimeMs,'outbox_corrupt','Outbox changed while reading');return b.subarray(0,n);
  }finally{closeSync(fd);}
}
function decode(path,max) {
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(readBytes(path,max)));}
  catch(e){if(e instanceof UltraError)throw e;throw new UltraError('outbox_corrupt','Invalid journal; preserve it for inspection');}
}
function exists(path){try{lstatSync(path);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
function syncDirectory(path) {
  if(process.platform==='win32')return; // Windows file fsync is used; directory flush is NOT claimed.
  const fd=openSync(path,constants.O_RDONLY|constants.O_DIRECTORY|(constants.O_NOFOLLOW??0));try{fsyncSync(fd);}finally{closeSync(fd);}
}
function newFile(path,bytes) {
  const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW??0),0o600);
  try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}
}
/** Only a trusted local account controls this directory; locks are cooperative, not a sandbox. */
export class CaptureOutbox {
  constructor(input) {
    this.input=structuredClone(input);this.profile=clientProfile(this.input);
    const p=this.profile;
    requireThat(p.outboxDirectory&&isAbsolute(p.outboxDirectory)&&p.expectedInstance&&p.expectedActor&&p.workspace,
      'invalid_profile','Outbox needs directory, workspace and observed identity pins');
    this.directory=resolve(p.outboxDirectory);parents(this.directory);
    const workspace=realpathSync(p.workspace);
    const candidate=resolve(realpathSync(dirname(this.directory)),this.directory.slice(dirname(this.directory).length+1));
    const ahead=relative(workspace,candidate);
    requireThat(ahead!==''&&(ahead==='..'||ahead.startsWith('..'+sep)||isAbsolute(ahead)),'insecure_outbox','Put the private outbox outside the Agent workspace');
    try{mkdirSync(this.directory,{mode:0o700});syncDirectory(dirname(this.directory));}catch(e){if(e.code!=='EEXIST')throw e;}
    privateStat(lstatSync(this.directory),'dir');
    const queue=realpathSync(this.directory),rel=relative(workspace,queue);
    requireThat(rel!==''&&(rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel)),'insecure_outbox','Put the private outbox outside the Agent workspace');
    this.binding={format:1,source:p.source,instance:p.expectedInstance,actor:p.expectedActor,project:p.projectId,
      workspace_sha256:sha256(process.platform==='win32'?workspace.toLowerCase():workspace),server_sha256:digest(p.server)};
    this.bindingHash=digest(this.binding);
    this.durability=process.platform==='win32'?'file-fsync; directory-flush-not-available':'file-and-directory-fsync';
  }
  #path(name){return join(this.directory,name);}
  #checkDir(){parents(this.directory);privateStat(lstatSync(this.directory),'dir');}
  #manifest(){
    this.#checkDir();const path=this.#path('binding.json');
    if(!exists(path)){
      // Never silently assign existing records (or interrupted writes) to new authority.
      requireThat(readdirSync(this.directory).every(n=>['.queue.lock','.delivery.lock'].includes(n)),'outbox_unbound','Nonempty outbox has no binding');
      this.#write('binding.json',{...this.binding,binding_sha256:this.bindingHash},false);
    }
    const value=decode(path,4096);requireThat(value.binding_sha256===this.bindingHash&&digest(Object.fromEntries(Object.entries(value).filter(([k])=>k!=='binding_sha256')))===this.bindingHash,
      'identity_mismatch','Outbox is bound to a different destination or workspace');
  }
  async #acquire(name,wait=1000) {
    this.#checkDir();const path=this.#path(name),deadline=Date.now()+wait;
    for(;;){
      const bytes=Buffer.from(JSON.stringify({format:1,lock_id:randomUUID(),pid:process.pid,created_at:new Date().toISOString()})+'\n');
      try{newFile(path,bytes);syncDirectory(this.directory);
        const hash=sha256(bytes);
        return ()=>{requireThat(exists(path)&&sha256(readBytes(path,2048))===hash,'outbox_lock_changed','Never remove another writer lock');unlinkSync(path);syncDirectory(this.directory);};
      }catch(e){if(e.code!=='EEXIST')throw e;if(Date.now()>=deadline)throw new UltraError('outbox_busy','A journal writer is active or its lock needs explicit recovery');await delay(15);}
    }
  }
  async #queue(action){const release=await this.#acquire('.queue.lock');try{this.#manifest();return action();}finally{release();}}
  #write(name,data,replace=true){
    const temp=this.#path('.tmp-'+randomUUID()),path=this.#path(name),bytes=Buffer.from(JSON.stringify(data)+'\n');
    requireThat(bytes.length<=MAX_RECORD,'outbox_full','Journal record too large');newFile(temp,bytes);
    try{if(replace)renameSync(temp,path);else{linkSync(temp,path);unlinkSync(temp);}syncDirectory(this.directory);}
    finally{if(exists(temp))unlinkSync(temp);}
  }
  #names(){
    const names=readdirSync(this.directory);
    requireThat(names.length<=MAX_FILES+16,'outbox_full','Too many journal files');
    requireThat(names.every(n=>RECORD.test(n)||TEMP.test(n)||['binding.json','.queue.lock','.delivery.lock'].includes(n)),
      'outbox_corrupt','Unexpected journal contents; nothing was removed');
    return names.filter(n=>RECORD.test(n)).sort();
  }
  #record(name){
    const r=decode(this.#path(name));
    requireThat(r?.format===1&&r.binding_sha256===this.bindingHash&&['pending','blocked'].includes(r.state)&&
      Number.isInteger(r.attempts)&&r.attempts>=0&&r.attempts<=MAX_ATTEMPTS&&Number.isFinite(r.next_attempt_at)&&r.next_attempt_at>=0,
      'outbox_corrupt','Invalid journal state');
    let normalized;try{normalized=captureRequest(r.payload,{...this.profile,allowCapture:true});}catch{throw new UltraError('outbox_corrupt','Invalid stored request');}
    requireThat(digest(normalized)===r.request_sha256&&sha256(r.payload.event_id)+'.entry'===name,'outbox_corrupt','Journal request fingerprint mismatch');
    return r;
  }
  async enqueue(payload,{authorize=()=>{}}={}) {
    // Consent is checked BEFORE creating a new raw-text record, independent of the network.
    const snapshot=structuredClone(payload);
    const normalized=captureRequest(snapshot,this.profile);
    return this.#queue(()=>{
      authorize();
      const name=sha256(normalized.event_id)+'.entry',requestHash=digest(normalized);
      if(exists(this.#path(name))){const old=this.#record(name);requireThat(old.request_sha256===requestHash,'conflict','Event already exists with different content');return {storage:'client_journal',event_id:normalized.event_id,state:old.state,replayed:true,durability:this.durability};}
      const names=this.#names();let total=0;
      for(const f of readdirSync(this.directory).filter(n=>RECORD.test(n)||TEMP.test(n))){const st=lstatSync(this.#path(f));privateStat(st,'file');total+=st.size;}
      const record={format:1,binding_sha256:this.bindingHash,request_sha256:requestHash,payload:snapshot,
        state:'pending',attempts:0,next_attempt_at:0,last_error:null,created_at:new Date().toISOString()};
      requireThat(names.length<MAX_FILES&&total+Buffer.byteLength(JSON.stringify(record))<=MAX_BYTES,'outbox_full','Queue full; existing events were preserved');
      this.#write(name,record,false);
      return {storage:'client_journal',event_id:normalized.event_id,state:'pending',replayed:false,durability:this.durability};
    });
  }
  async status() {
    return this.#queue(()=>{
      const counts={pending:0,blocked:0};let bytes=0;
      for(const name of this.#names()){const r=this.#record(name);counts[r.state]++;bytes+=lstatSync(this.#path(name)).size;}
      const locks={};
      for(const kind of ['delivery']){const path=this.#path('.'+kind+'.lock');if(exists(path)){const bytes=readBytes(path,2048);let value;try{value=JSON.parse(bytes);}catch{}
        locks[kind]={sha256:sha256(bytes),pid:Number.isInteger(value?.pid)?value.pid:null};}}
      return {format:1,source_id:this.profile.source,...counts,bytes,limits:{entries:MAX_FILES,bytes:MAX_BYTES,automatic_attempts:MAX_ATTEMPTS},
        temporary_files:readdirSync(this.directory).filter(n=>TEMP.test(n)).length,locks,durability:this.durability,
        warning:'Client journal counts are not server confirmations or completed knowledge; files contain plaintext consented input'};
    });
  }
  /** Snapshot an existing lock without acquiring it, for human-approved crash recovery. */
  inspectLock(kind) {
    requireThat(['queue','delivery'].includes(kind),'invalid_params','Choose queue or delivery lock');this.#checkDir();
    const path=this.#path('.'+kind+'.lock');requireThat(exists(path),'not_found','Lock absent');const bytes=readBytes(path,2048);let r;try{r=JSON.parse(bytes);}catch{}
    return {kind,sha256:sha256(bytes),pid:Number.isInteger(r?.pid)&&r.pid>0&&r.pid<=2147483647?r.pid:null,requires_writer_stopped:true};
  }
  recoverLock(kind,expectedHash,{writerStopped=false}={}) {
    requireThat(writerStopped===true&&/^[a-f0-9]{64}$/.test(expectedHash),'invalid_params','Explicit confirmation and current lock hash required');
    if(exists(this.#path('binding.json'))) {const manifest=decode(this.#path('binding.json'),4096);requireThat(manifest.binding_sha256===this.bindingHash,'identity_mismatch','Cannot recover a foreign journal lock');}
    const r=this.inspectLock(kind);requireThat(r.sha256===expectedHash,'conflict','Lock changed');
    if(r.pid){let gone=false;try{process.kill(r.pid,0);}catch(e){gone=e.code==='ESRCH';}requireThat(gone,'outbox_busy','Lock owner PID still exists or cannot be checked');}
    // No age-based stealing. Exact operator-reviewed lock only; payloads are never removed.
    requireThat(this.inspectLock(kind).sha256===expectedHash,'conflict','Lock changed');unlinkSync(this.#path('.'+kind+'.lock'));syncDirectory(this.directory);
    return {recovered:true,kind,payloads_deleted:0};
  }
  async flush(connect,{limit=4,retryBlocked=false,eventId,signal,authorize=()=>{}}={}) {
    requireThat(this.profile.allowCapture,'capture_disabled','Enable capture explicitly before delivery');
    integer(limit,4,1,16);requireThat(typeof retryBlocked==='boolean','invalid_params','retryBlocked must be boolean');
    const release=await this.#acquire('.delivery.lock',0);let connection;
    const report={storage:'client_journal',delivered:0,retained:0,blocked:0,skipped:0,last_error:null};
    try {
      const names=await this.#queue(()=>this.#names().filter(name=>!eventId||name===sha256(eventId)+'.entry'));
      for(const name of names){
        if(report.delivered+report.retained+report.blocked>=limit||signal?.aborted)break;
        const r=await this.#queue(()=>{
          if(!exists(this.#path(name)))return null;const x=this.#record(name);
          if(x.state==='blocked'&&!retryBlocked||!retryBlocked&&x.next_attempt_at>Date.now())return null;
          if(retryBlocked&&(x.state==='blocked'||x.attempts>=MAX_ATTEMPTS)){x.attempts=0;x.state='pending';}
          x.attempts++;x.next_attempt_at=Date.now()+300000;
          // Persist the attempt before contacting the server; a crash does not reset attempts.
          if(x.attempts>MAX_ATTEMPTS){x.attempts=MAX_ATTEMPTS;x.state='blocked';this.#write(name,x);return null;}
          this.#write(name,x);return x;
        });
        if(!r){report.skipped++;continue;}
        try {
          requireThat(!signal?.aborted,'aborted','Delivery cancelled');
          authorize();connection??=await connect(this.input,{signal});clientIdentity(connection.identity,this.profile);
          // capture() rechecks actual server identity before both register and capture calls.
          authorize();requireThat(!signal?.aborted,'aborted','Delivery cancelled before submission');
          const receipt=await connection.capture(captureRequest(r.payload,{...this.profile,allowCapture:true}));
          requireThat(receipt?.source_id===this.profile.source&&receipt.event_id===r.payload.event_id&&receipt.storage==='journaled'&&UUID.test(receipt.job_id??''),
            'mcp_contract_changed','No matching server journal acknowledgement');
          await this.#queue(()=>{const current=this.#record(name);requireThat(current.request_sha256===r.request_sha256,'outbox_corrupt','Journal changed during delivery');unlinkSync(this.#path(name));syncDirectory(this.directory);});
          report.delivered++;
        }catch(e){
          const code=codeOf(e);report.last_error=code;
          const state=terminal.has(code)||r.attempts>=MAX_ATTEMPTS?'blocked':'pending';
          await this.#queue(()=>{const current=this.#record(name);requireThat(current.request_sha256===r.request_sha256,'outbox_corrupt','Journal changed during delivery');
            this.#write(name,{...current,state,last_error:code,next_attempt_at:Date.now()+Math.min(300000,2000*2**Math.min(8,current.attempts-1))});});
          report[state==='blocked'?'blocked':'retained']++;
          // Do not fan out more attempts after credentials/transport failure or uncertain response.
          break;
        }
      }
      const status=await this.status();report.remaining_pending=status.pending;report.remaining_blocked=status.blocked;
      return report;
    }finally{try{if(connection)await connection.close();}catch{}finally{release();}}
  }
}
