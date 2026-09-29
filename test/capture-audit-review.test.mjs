/** Separate implementer review pass. NOT a separate reviewer agent. */
import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {CaptureOutbox} from '../src/capture-outbox.mjs';import {auditCaptureOutbox} from '../src/capture-audit.mjs';
function setup(t){const root=fs.mkdtempSync(join(tmpdir(),'ub-audit-review-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const workspace=join(root,'work');fs.mkdirSync(workspace,{mode:0o700});const input={format:1,source:'fixture',workspace,outbox_directory:join(root,'queue'),allow_capture:true,expected_actor:'a'.repeat(64),expected_instance:'11111111-1111-4111-8111-111111111111',server:{transport:'stdio',command:'never-executed',args:[]}};
 return {input,q:new CaptureOutbox(input)};}
const payload=n=>({agent_id:'fixture',event_id:'event-'+n,transcript:'SYNTHETIC',consent:true});
function patch(t,key,fn){const orig=fs[key];fs[key]=fn(orig);syncBuiltinESMExports();t.after(()=>{fs[key]=orig;syncBuiltinESMExports();});}
test('review: duplicate directory observations cannot manufacture validated record counts',async t=>{
 const {input,q}=setup(t);await q.enqueue(payload(1));
 patch(t,'opendirSync',orig=>(...args)=>{
  const dir=orig(...args),read=dir.readSync.bind(dir);let pending;
  dir.readSync=()=>{if(pending){const p=pending;pending=null;return p;}const p=read();if(p?.name.endsWith('.entry'))pending=p;return p;};return dir;
 });
 const r=await auditCaptureOutbox(input);assert.equal(r.status,'changed');assert.equal(r.counts,null);
});
test('review: aggregate blocked finding count matches the number of blocked entries',async t=>{
 const {input,q}=setup(t);for(let i=0;i<3;i++)await q.enqueue(payload(i));
 for(const name of fs.readdirSync(q.directory).filter(n=>n.endsWith('.entry'))){const path=join(q.directory,name),r=JSON.parse(fs.readFileSync(path));r.state='blocked';r.attempts=8;fs.writeFileSync(path,JSON.stringify(r));}
 const r=await auditCaptureOutbox(input);assert.equal(r.counts.blocked,3);assert.equal(r.findings.find(f=>f.code==='blocked_delivery').count,3);
});
for(const where of ['file','directory'])test('review: close failure at '+where+' cannot report a healthy audit',async t=>{
 const {input,q}=setup(t);await q.enqueue(payload(1));
 if(where==='file')patch(t,'closeSync',orig=>fd=>{orig(fd);throw Object.assign(Error('PRIVATE'),{code:'EIO'});});
 else patch(t,'opendirSync',orig=>(...args)=>{const dir=orig(...args),close=dir.closeSync.bind(dir);dir.closeSync=()=>{close();throw Object.assign(Error('PRIVATE'),{code:'EIO'});};return dir;});
 const r=await auditCaptureOutbox(input);assert.equal(r.status,'unavailable');assert.equal(r.counts,null);assert.ok(!JSON.stringify(r).includes('PRIVATE'));
});
test('review: bound queue directory still cannot be a regular file',async t=>{
 const {input,q}=setup(t);fs.rmdirSync(q.directory);fs.writeFileSync(q.directory,'SYNTHETIC',{mode:0o600});
 const r=await auditCaptureOutbox(input);assert.equal(r.status,'unavailable');assert.equal(r.findings[0].code,'insecure_outbox');
});
test('review: entry growth during descriptor read discards partial aggregate counts',async t=>{
 const {input,q}=setup(t);await q.enqueue(payload(1));const path=join(q.directory,fs.readdirSync(q.directory).find(n=>n.endsWith('.entry')));let fd,changed=false;
 patch(t,'openSync',orig=>(p,...args)=>{const f=orig(p,...args);if(String(p)===path)fd=f;return f;});
 patch(t,'readSync',orig=>(f,...args)=>{const n=orig(f,...args);if(f===fd&&!changed){changed=true;fs.appendFileSync(path,' ');}return n;});
 const r=await auditCaptureOutbox(input);assert.equal(r.status,'changed');assert.equal(r.counts,null);assert.equal(r.records_validated,0);
});
test('review: replacing binding actor without recomputing binding digest is rejected',async t=>{
 const {input,q}=setup(t);await q.enqueue(payload(1));const path=join(q.directory,'binding.json'),v=JSON.parse(fs.readFileSync(path));v.actor='b'.repeat(64);fs.writeFileSync(path,JSON.stringify(v));
 const r=await auditCaptureOutbox(input);assert.equal(r.status,'attention');assert.equal(r.records_validated,0);
});
