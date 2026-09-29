/** Real private temporary files; every transcript and identity is synthetic. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {auditCaptureOutbox} from '../src/capture-audit.mjs';
import {CaptureOutbox} from '../src/capture-outbox.mjs';
import {journalDigest} from '../src/capture-journal-contract.mjs';
const payload=id=>({agent_id:'fixture',event_id:id,transcript:'PRIVATE_PAYLOAD:'+id,consent:true});
function setup(t){
 const root=fs.mkdtempSync(join(tmpdir(),'ub-audit-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const workspace=join(root,'work');fs.mkdirSync(workspace,{mode:0o700});
 const input={format:1,source:'synthetic',workspace,outbox_directory:join(root,'queue'),allow_capture:true,
  expected_actor:'a'.repeat(64),expected_instance:'11111111-1111-4111-8111-111111111111',server:{transport:'stdio',command:'never-executed',args:[]}};
 const q=new CaptureOutbox(input);return {root,input,q};
}
const entry=q=>join(q.directory,fs.readdirSync(q.directory).find(n=>n.endsWith('.entry')));
function patch(t,key,fn){const orig=fs[key];fs[key]=fn(orig);syncBuiltinESMExports();t.after(()=>{fs[key]=orig;syncBuiltinESMExports();});}
const safe=(r,root)=>{const s=JSON.stringify(r);assert.ok(!s.includes(root)&&!s.includes('PRIVATE')&&!s.includes('SECRET')&&!s.includes('PAYLOAD'));assert.equal(r.read_only,true);assert.equal(r.snapshot_consistent,false);assert.equal(r.server_confirmation,false);};
const snapshot=q=>fs.readdirSync(q.directory).sort().map(n=>{const p=join(q.directory,n),s=fs.lstatSync(p);return [n,s.mode,s.size,s.mtimeMs,s.ctimeMs,s.isFile()?fs.readFileSync(p).toString('hex'):null];});
test('audit validates mixed states, preserves bytes/metadata and never needs capture consent',async t=>{
 const {root,q,input}=setup(t);await q.enqueue(payload('SECRET_1'));await q.enqueue(payload('SECRET_2'));
 const p=entry(q),r=JSON.parse(fs.readFileSync(p));r.state='blocked';r.attempts=8;fs.writeFileSync(p,JSON.stringify(r));
 const before=snapshot(q);const out=await auditCaptureOutbox({...input,allow_capture:false});
 assert.equal(out.status,'attention');assert.equal(out.complete,true);assert.equal(out.counts.pending,1);assert.equal(out.counts.blocked,1);assert.equal(out.records_validated,2);assert.deepEqual(snapshot(q),before);safe(out,root);
});
test('audit performs no mutations even when queue directory is absent',async t=>{
 const {q,input}=setup(t);fs.rmdirSync(q.directory);
 for(const k of ['mkdirSync','writeFileSync','writeSync','fsyncSync','unlinkSync','renameSync','linkSync','chmodSync','truncateSync'])patch(t,k,()=>()=>assert.fail('Unexpected write '+k));
 const out=await auditCaptureOutbox(input);assert.equal(out.status,'absent');assert.equal(fs.existsSync(q.directory),false);
});
for(const lock of ['.queue.lock','.delivery.lock'])test('audit never opens entries or '+lock+' while lock is present',async t=>{
 const {q,input}=setup(t);await q.enqueue(payload('SECRET'));
 fs.writeFileSync(join(q.directory,lock),'BROKEN_PRIVATE_LOCK',{mode:0o600});
 patch(t,'openSync',()=>()=>assert.fail('No file bytes may be opened for a busy queue'));
 const r=await auditCaptureOutbox(input);assert.equal(r.status,'busy');assert.equal(r.complete,false);assert.equal(r.counts,null);assert.equal(r.records_validated,0);
});
for(const field of ['expected_actor','expected_instance','source','project_id','server'])test('audit refuses foreign binding '+field+' before entry bytes',async t=>{
 const {input,q}=setup(t);await q.enqueue(payload('SECRET'));
 const other={...input,[field]:{expected_actor:'b'.repeat(64),expected_instance:'22222222-2222-4222-8222-222222222222',source:'other',project_id:'other',server:{transport:'stdio',command:'other',args:[]}}[field]};
 patch(t,'openSync',orig=>(path,...args)=>{assert.ok(!String(path).endsWith('.entry'));return orig(path,...args);});
 const out=await auditCaptureOutbox(other);assert.equal(out.status,'attention');assert.equal(out.counts,null);assert.ok(out.findings.some(f=>f.code==='identity_mismatch'));
});
for(const corruption of ['bad_json','duplicate_key','invalid_utf8','too_deep','payload','event','binding','state','attempts','consent','oversize'])test('audit detects '+corruption+' without repairing',async t=>{
 const {input,q,root}=setup(t);await q.enqueue(payload('SECRET'));const p=entry(q),r=JSON.parse(fs.readFileSync(p));
 if(corruption==='payload')r.payload.transcript='PRIVATE_CHANGED';
 if(corruption==='event')r.payload.event_id='other';
 if(corruption==='binding')r.binding_sha256='b'.repeat(64);
 if(corruption==='state')r.state='active';
 if(corruption==='attempts')r.attempts=9;
 if(corruption==='consent')r.payload.consent=false;
 let bytes=JSON.stringify(r);
 if(corruption==='bad_json')bytes='{PRIVATE';
 if(corruption==='duplicate_key')bytes=bytes.replace('"format":1','"format":2,"for\\u006dat":1');
 if(corruption==='invalid_utf8')bytes=Buffer.from([0xff]);
 if(corruption==='too_deep')bytes='['.repeat(40)+'0'+']'.repeat(40);
 if(corruption==='oversize')bytes='X'.repeat(220001);
 fs.writeFileSync(p,bytes);const before=snapshot(q);const out=await auditCaptureOutbox(input);
 assert.equal(out.status,'attention');assert.equal(out.counts.invalid,1);assert.equal(out.records_validated,0);assert.deepEqual(snapshot(q),before);safe(out,root);
});
for(const kind of ['unbound','temporary','unexpected'])test('audit preserves and reports '+kind+' leftovers',async t=>{
 const {input,q,root}=setup(t);if(kind!=='unbound')await q.status();
 const name=kind==='unexpected'?'PRIVATE_FILENAME':'.tmp-11111111-1111-4111-8111-111111111111';
 fs.writeFileSync(join(q.directory,name),'PRIVATE_RESIDUE',{mode:0o600});const before=snapshot(q);
 let auditing=true;patch(t,'openSync',orig=>(path,...args)=>{if(auditing)assert.ok(String(path).endsWith('binding.json'));return orig(path,...args);});
 const out=await auditCaptureOutbox(input);auditing=false;assert.equal(out.status,'attention');assert.deepEqual(snapshot(q),before);safe(out,root);
});
test('audit directory entry bound stops before opening any file bytes',async t=>{
 const {input,q}=setup(t);for(let i=0;i<273;i++)fs.writeFileSync(join(q.directory,'unknown-'+i),'',{mode:0o600});
 patch(t,'openSync',()=>()=>assert.fail('No bytes over directory bound'));
 const out=await auditCaptureOutbox(input);assert.equal(out.status,'limited');assert.equal(out.counts,null);
});
test('audit aggregate record byte bound stops before opening file bytes',async t=>{
 const {input,q}=setup(t);await q.status();
 for(let i=0;i<40;i++){const p=join(q.directory,i.toString(16).padStart(64,'0')+'.entry');fs.writeFileSync(p,'',{mode:0o600});fs.truncateSync(p,220000);}
 patch(t,'openSync',()=>()=>assert.fail('No bytes over aggregate bound'));
 const out=await auditCaptureOutbox(input);assert.equal(out.status,'limited');
});
for(const property of ['signal','false','promise','rejected_promise','throw'])test('audit preflight denies '+property+' before filesystem access',async t=>{
 const {input}=setup(t);const controller=new AbortController();controller.abort();
 patch(t,'lstatSync',()=>()=>assert.fail('No IO before authorization'));
 const opts=property==='signal'?{signal:controller.signal}:{authorize:property==='false'?()=>false:property==='promise'?async()=>true:property==='rejected_promise'?async()=>{throw Error('PRIVATE');}:()=>{throw Error('PRIVATE');}};
 await assert.rejects(auditCaptureOutbox(input,opts));await new Promise(r=>setImmediate(r));
});
test('audit cancellation during yield revokes the report',async t=>{
 const {q,input}=setup(t);await q.enqueue(payload('SECRET'));const controller=new AbortController();
 const result=auditCaptureOutbox(input,{signal:controller.signal});controller.abort();await assert.rejects(result,{code:'aborted'});
});
test('audit profile revocation during yield revokes the report',async t=>{
 const {q,input}=setup(t);await q.enqueue(payload('SECRET'));let allowed=true;
 const result=auditCaptureOutbox(input,{authorize:()=>allowed});allowed=false;await assert.rejects(result,{code:'capture_disabled'});
});
for(const stage of ['entry','binding'])test('audit never swallows one-shot authorization exception at '+stage+' read',async t=>{
 const {q,input}=setup(t);await q.enqueue(payload('SECRET'));let reject=false,done=false;
 const target=stage==='entry'?'.entry':'binding.json';
 patch(t,'openSync',orig=>(path,...args)=>{if(String(path).endsWith(target))reject=true;return orig(path,...args);});
 await assert.rejects(auditCaptureOutbox(input,{authorize:()=>{if(reject&&!done){done=true;throw Object.assign(Error('PRIVATE'),{code:'outbox_corrupt'});}}}),{code:'outbox_corrupt'});
});
for(const kind of ['entry_replace','new_lock','add_file','delete_entry'])test('audit rejects changed scan '+kind,async t=>{
 const {q,input}=setup(t);await q.enqueue(payload('SECRET'));let seen=0;
 patch(t,'opendirSync',orig=>(path,...args)=>{
  if(++seen===2){if(kind==='entry_replace'){const r=JSON.parse(fs.readFileSync(entry(q)));r.attempts=1;fs.writeFileSync(entry(q),JSON.stringify(r));}
   if(kind==='new_lock')fs.writeFileSync(join(q.directory,'.queue.lock'),'{}',{mode:0o600});
   if(kind==='add_file')fs.writeFileSync(join(q.directory,'PRIVATE_NEW'),'',{mode:0o600});
   if(kind==='delete_entry')fs.unlinkSync(entry(q));}
  return orig(path,...args);
 });
 const out=await auditCaptureOutbox(input);assert.equal(out.status,'changed');assert.equal(out.complete,false);assert.equal(out.counts,null);assert.equal(out.records_validated,0);
});
for(const code of ['EACCES','EPERM','EIO','PRIVATE_CODE'])test('audit safe IO diagnostics '+code,async t=>{
 const {q,input,root}=setup(t);await q.status();patch(t,'openSync',()=>()=>{throw Object.assign(Error('PRIVATE_MESSAGE'),{code,path:'PRIVATE_PATH'});});
 const out=await auditCaptureOutbox(input);assert.equal(out.status,'unavailable');assert.equal(out.findings.at(-1).system_code,code==='PRIVATE_CODE'?null:code);safe(out,root);
});
test('audit does not access hostile error properties',async t=>{
 const {q,input}=setup(t);await q.status();let called=0;
 patch(t,'openSync',()=>()=>{throw {get code(){called++;throw Error('PRIVATE');},get message(){called++;return 'PRIVATE';}};});
 const out=await auditCaptureOutbox(input);assert.equal(out.status,'unavailable');assert.equal(called,0);
});
for(const unsafe of ['inside_workspace','symlink','hardlink','mode'])test('audit refuses unsafe path '+unsafe,async t=>{
 const {q,input}=setup(t);await q.enqueue(payload('SECRET'));
 if(unsafe==='inside_workspace')input.outbox_directory=input.workspace;
 if(unsafe==='symlink'){if(process.platform==='win32'){t.skip('POSIX symlink policy; Windows requires platform-specific privileges');return;}fs.renameSync(q.directory,q.directory+'-real');fs.symlinkSync(q.directory+'-real',q.directory);}
 if(unsafe==='hardlink')fs.linkSync(entry(q),join(q.directory,'PRIVATE_ALIAS'));
 if(unsafe==='mode'){if(process.platform==='win32'){t.skip('POSIX mode check, not an ACL check');return;}fs.chmodSync(entry(q),0o644);}
 const out=await auditCaptureOutbox(input);assert.notEqual(out.status,'healthy');assert.ok(out.findings.some(f=>f.code==='insecure_outbox'));
});
test('audit missing workspace is unavailable, not absent or healthy',async t=>{
 const {input}=setup(t);input.workspace=join(input.workspace,'missing');const out=await auditCaptureOutbox(input);assert.equal(out.status,'unavailable');
});
test('audit valid binding with no records is healthy and never initializes or writes',async t=>{
 const {q,input}=setup(t);await q.status();const before=snapshot(q);
 const out=await auditCaptureOutbox(input);assert.equal(out.status,'healthy');assert.equal(out.complete,true);assert.deepEqual(snapshot(q),before);
});
