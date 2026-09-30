/** Fault injection exercises actual local file IO. It does not emulate Windows. */
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {join} from 'node:path';
import {commitCaptureJournal,captureJournalDiagnostic} from '../src/capture-journal.mjs';
import {captureProcessDiagnostic} from './helpers/capture-process-diagnostic.mjs';
import {setupJournal,patchFS,ioError,payload} from './helpers/capture-journal-fixture.mjs';
const name='b'.repeat(64)+'.entry',bytes=Buffer.from('{"synthetic":1}\n');
for(const replace of [false,true])test('journal: successful '+(replace?'replacement':'exclusive create')+' preserves complete bytes and file mode',t=>{
 const {q}=setupJournal(t),path=join(q.directory,name);
 if(replace)fs.writeFileSync(path,'old',{mode:0o600});
 commitCaptureJournal(q.directory,name,bytes,{replace});assert.deepEqual(fs.readFileSync(path),bytes);
 assert.deepEqual(fs.readdirSync(q.directory),[name]);assert.equal(fs.statSync(path).nlink,1);
 if(process.platform!=='win32')assert.equal(fs.statSync(path).mode&0o777,0o600);
});
for(const [phase,method] of [['create','openSync'],['write','writeFileSync'],['file-sync','fsyncSync'],['close','closeSync'],['publish','linkSync'],['temporary-unlink','unlinkSync']]){
 for(const code of ['EPERM','ENOSPC','EIO'])test('journal: '+phase+' '+code+' reports a bounded phase and never retries',t=>{
  const {q}=setupJournal(t);let fd,attempts=0;const restores=[];
  if(method!=='openSync')restores.push(patchFS('openSync',(native,path,...a)=>{const n=native(path,...a);if(String(path).includes('.tmp-'))fd=n;return n;}));
  restores.push(patchFS(method,(native,first,...a)=>{
   const targeted=method==='openSync'?String(first).includes('.tmp-'):['writeFileSync','fsyncSync','closeSync'].includes(method)?first===fd:true;
   if(!targeted)return native(first,...a);attempts++;if(method==='closeSync')native(first,...a);throw ioError(code);
  }));let error;
  try{commitCaptureJournal(q.directory,name,bytes,{replace:false});}catch(e){error=e;}finally{restores.reverse().forEach(r=>r());}
  assert.equal(attempts,1);assert.equal(error?.code,'outbox_journal_io');const d=captureJournalDiagnostic(error);
  assert.equal(d.phase,phase);assert.equal(d.system_code,code);assert.equal(d.publication,phase==='publish'?'unconfirmed':phase==='temporary-unlink'?'visible':'not_attempted');
  assert.equal(d.directory_sync,'not_attempted');assert.deepEqual(d.secondary,[]);assert.ok(Object.isFrozen(d)&&Object.isFrozen(d.secondary));
  assert.ok(!JSON.stringify(d).includes('PRIVATE')&&!error.message.includes('PRIVATE'));
  const names=fs.readdirSync(q.directory);assert.equal(names.includes(name),phase==='temporary-unlink');
  assert.equal(names.filter(x=>x.startsWith('.tmp-')).length,phase==='create'?0:1);
  assert.equal(captureProcessDiagnostic(error).journal,d);
 });
}
test('journal: simultaneous write and close failures retain primary and secondary without raw errors',t=>{
 const {q}=setupJournal(t);const restores=[patchFS('writeFileSync',()=>{throw ioError('ENOSPC');}),
 patchFS('closeSync',(native,fd)=>{native(fd);throw ioError('EBUSY');})];let e;
 try{commitCaptureJournal(q.directory,name,bytes);}catch(error){e=error;}finally{restores.reverse().forEach(r=>r());}
 const d=captureJournalDiagnostic(e);assert.equal(d.phase,'write');assert.equal(d.system_code,'ENOSPC');
 assert.deepEqual(d.secondary,[{phase:'close',system_code:'EBUSY'}]);assert.ok(Object.isFrozen(d.secondary[0]));assert.equal(e.cause,undefined);
});
for(const replace of [false,true])test('journal: syscall outcome uncertainty never rolls back '+(replace?'replaced':'created')+' data',t=>{
 const {q}=setupJournal(t),path=join(q.directory,name);if(replace)fs.writeFileSync(path,'old',{mode:0o600});
 const restore=patchFS(replace?'renameSync':'linkSync',(native,...a)=>{native(...a);throw ioError('EIO');});let e;
 try{commitCaptureJournal(q.directory,name,bytes,{replace});}catch(error){e=error;}finally{restore();}
 assert.equal(captureJournalDiagnostic(e).publication,'unconfirmed');assert.deepEqual(fs.readFileSync(path),bytes);
 assert.equal(fs.readdirSync(q.directory).filter(n=>n.startsWith('.tmp-')).length,replace?0:1);
});
test('journal: failed exclusive publication cannot overwrite an existing event',t=>{
 const {q}=setupJournal(t),path=join(q.directory,name);fs.writeFileSync(path,'old',{mode:0o600});
 assert.throws(()=>commitCaptureJournal(q.directory,name,bytes,{replace:false}),e=>captureJournalDiagnostic(e)?.system_code==='EEXIST');
 assert.equal(fs.readFileSync(path,'utf8'),'old');assert.equal(fs.readdirSync(q.directory).length,2);
});
test('journal: failed exclusive temporary create never removes an existing temporary file',t=>{
 const {q}=setupJournal(t);let temp;const restore=patchFS('openSync',(native,path,...a)=>{
  temp=path;const fd=native(path,'w',0o600);fs.writeFileSync(fd,'FOREIGN_SYNTHETIC_TEMP');fs.closeSync(fd);return native(path,...a);
 });try{assert.throws(()=>commitCaptureJournal(q.directory,name,bytes),e=>captureJournalDiagnostic(e)?.system_code==='EEXIST');}finally{restore();}
 assert.equal(fs.readFileSync(temp,'utf8'),'FOREIGN_SYNTHETIC_TEMP');
});
for(const input of [null,undefined,42,'PRIVATE_STRING',{get code(){throw Error('getter called');}},new Proxy({}, {getOwnPropertyDescriptor(){throw Error('trap');}})])test('journal: unusual native throw never leaks arbitrary properties '+typeof input,t=>{
 const {q}=setupJournal(t);const restore=patchFS('openSync',()=>{throw input;});let e;
 try{commitCaptureJournal(q.directory,name,bytes);}catch(error){e=error;}finally{restore();}
 assert.equal(e.code,'outbox_journal_io');assert.equal(captureJournalDiagnostic(e).system_code,null);assert.ok(!e.message.includes('PRIVATE'));
});
test('journal: diagnostics cannot be forged or copied to a foreign error',t=>{
 const {q}=setupJournal(t);const restore=patchFS('openSync',()=>{throw ioError('EACCES');});let e;
 try{commitCaptureJournal(q.directory,name,bytes);}catch(error){e=error;}finally{restore();}
 for(const copy of [{...e},Object.assign(Error(e.message),e),{code:'outbox_journal_io',journal:captureJournalDiagnostic(e)},null,42])assert.equal(captureJournalDiagnostic(copy),null);
});
for(const invalid of [{name:'../escape'},{name:'x.entry'},{bytes:Buffer.alloc(220001)},{bytes:Buffer.alloc(0)},{bytes:'not-buffer'},{replace:'true'},{directory:'relative'}])test('journal: input boundary rejects '+Object.keys(invalid)[0],t=>{
 const {q}=setupJournal(t),options={directory:q.directory,name,bytes,replace:false,...invalid};
 assert.throws(()=>commitCaptureJournal(options.directory,options.name,options.bytes,{replace:options.replace}),{code:'invalid_params'});
 assert.deepEqual(fs.readdirSync(q.directory),[]);
});
if(process.platform!=='win32')test('journal: failed directory fsync after publication reports visible data, never success',t=>{
 const {q}=setupJournal(t);let dirfd,closed=false;
 const restores=[patchFS('openSync',(native,path,...a)=>{const n=native(path,...a);if(path===q.directory)dirfd=n;return n;}),
 patchFS('fsyncSync',(native,fd)=>{if(fd===dirfd)throw ioError('EIO');return native(fd);}),
 patchFS('closeSync',(native,fd)=>{const v=native(fd);if(fd===dirfd){closed=true;throw ioError('EBUSY');}return v;})];let e;
 try{commitCaptureJournal(q.directory,name,bytes,{replace:false});}catch(error){e=error;}finally{restores.reverse().forEach(r=>r());}
 const d=captureJournalDiagnostic(e);assert.equal(d.phase,'directory-sync');assert.equal(d.publication,'visible');assert.equal(d.directory_sync,'unconfirmed');assert.equal(d.system_code,'EIO');
 assert.ok(closed);assert.deepEqual(fs.readFileSync(join(q.directory,name)),bytes);assert.deepEqual(fs.readdirSync(q.directory),[name]);
});
test('journal: attempt-persistence failure prevents connection and preserves original event',async t=>{
 const {q}=setupJournal(t);await q.enqueue(payload);const file=fs.readdirSync(q.directory).find(n=>n.endsWith('.entry')),before=fs.readFileSync(join(q.directory,file));
 const restore=patchFS('renameSync',(native,a,b,...rest)=>{if(String(b).endsWith('.entry'))throw ioError('EBUSY');return native(a,b,...rest);});let calls=0;
 try{await assert.rejects(q.flush(async()=>{calls++;throw Error('MUST_NOT_CONNECT');}),e=>captureJournalDiagnostic(e)?.operation==='replace');}finally{restore();}
 assert.equal(calls,0);assert.deepEqual(fs.readFileSync(join(q.directory,file)),before);assert.equal((await q.status()).pending,1);
 assert.equal(fs.readdirSync(q.directory).filter(n=>n.endsWith('.lock')).length,0);
});
