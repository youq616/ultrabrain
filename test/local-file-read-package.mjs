/** Actual unpacked client CLI and official SDK imports; no server or SDK double.
 * Two extra scenarios substitute unsigned/signed Windows stat metadata on Linux.
 * This seam is not itself Windows execution or an NTFS stress result. */
import assert from 'node:assert/strict';import fs from 'node:fs';import {spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';import {tmpdir} from 'node:os';import {createHash} from 'node:crypto';
const pkg=resolve(process.argv[2]),dir=fs.mkdtempSync(join(tmpdir(),'ub-read-package-'));let checks=0;
try{
 const manifest=JSON.parse(fs.readFileSync(join(pkg,'dist/build-manifest.json')));
 for(const [name,digest]of Object.entries(manifest.artifacts))assert.equal(createHash('sha256').update(fs.readFileSync(join(pkg,'dist',name))).digest('hex'),digest);
 const preload=join(dir,'stat-seam.cjs');
 fs.writeFileSync(preload,`const fs=require('node:fs'),{syncBuiltinESMExports}=require('node:module');
Object.defineProperty(process,'platform',{value:'win32'});
const ls=fs.lstatSync,fsd=fs.fstatSync;
fs.lstatSync=(...a)=>{const s=ls(...a);if(s.isFile())s.dev=typeof s.dev==='bigint'?0x7654321089abcdefn:Number(0x7654321089abcdefn);return s;};
fs.fstatSync=(...a)=>{const s=fsd(...a);s.dev=typeof s.dev==='bigint'?0x89abcdefn:Number(0x89abcdefn);return s;};syncBuiltinESMExports();`,{mode:0o600});
 const signedPreload=join(dir,'signed-stat-seam.cjs');fs.writeFileSync(signedPreload,fs.readFileSync(preload,'utf8').replaceAll('0x7654321089abcdefn','BigInt.asIntN(64,0xf654321089abcdefn)'),{mode:0o600});
 for(const seam of [false,'unsigned','signed']){
  const root=join(dir,seam||'native');fs.mkdirSync(root,{mode:0o700});const workspace=join(root,'work');fs.mkdirSync(workspace,{mode:0o700});
  const path=join(root,'profile.json'),queue=join(root,'queue');fs.writeFileSync(path,JSON.stringify({format:1,source:'synthetic',allow_capture:true,workspace,outbox_directory:queue,
   expected_actor:'a'.repeat(64),expected_instance:'11111111-1111-4111-8111-111111111111',server:{transport:'stdio',command:'MUST_NOT_START_SERVER',args:[]}}),{mode:0o600});
  const run=(command,extra=[],input)=>{
   const r=spawnSync(process.execPath,[...(seam?['--require',seam==='signed'?signedPreload:preload]:[]),join(pkg,'dist/cli.cjs'),command,'--profile',path,...extra],{encoding:'utf8',input,timeout:15000,maxBuffer:131072});
   assert.ifError(r.error);assert.equal(r.stderr,'');assert.ok(!r.stdout.includes('PRIVATE_PACKAGE_BODY'));return {exit:r.status,value:JSON.parse(r.stdout)};
  };
  let r=run('queue-status');assert.equal(r.exit,0);assert.equal(r.value.result.pending,0);checks++;
  r=run('queue-pause');assert.equal(r.exit,0);const observed=r.value.result.control_sha256;assert.equal(r.value.result.state,'paused');checks++;
  r=run('queue-capture',[],JSON.stringify({agent_id:'fixture',event_id:'package-read',consent:true,transcript:'PRIVATE_PACKAGE_BODY'}));
  assert.equal(r.exit,1);assert.equal(r.value.result.delivery.last_error,'outbox_paused');assert.equal(r.value.result.queued.storage,'client_journal');checks++;
  r=run('queue-status');assert.equal(r.exit,0);assert.equal(r.value.result.pending,1);checks++;
  r=run('queue-resume',['--expected-sha',observed,'--confirm-resume']);assert.equal(r.exit,0);assert.equal(r.value.result.state,'running');checks++;
  r=run('queue-status');assert.equal(r.exit,0);assert.equal(r.value.result.pending,1);checks++;
  const names=fs.readdirSync(queue);assert.ok(!names.some(n=>n.endsWith('.lock')||n.startsWith('.tmp-')));
  assert.equal(JSON.parse(fs.readFileSync(join(queue,names.find(n=>n.endsWith('.entry'))))).attempts,0);checks++;
 }
 console.log(JSON.stringify({passed:true,checks,bundles:Object.keys(manifest.artifacts).length,mode:'actual unpacked compiled Node CLI, official SDK; native files plus labelled unsigned/signed Win32 stat seams',server_calls:0,model_calls:0}));
}finally{fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
