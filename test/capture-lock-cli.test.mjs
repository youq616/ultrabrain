/** Actual Node CLI processes, synthetic SDK and deterministic cancellation/errno injection. */
import test from 'node:test';import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,readdirSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';import {fileURLToPath} from 'node:url';
import {CaptureOutbox} from '../src/capture-outbox.mjs';
const cli=fileURLToPath(new URL('../packages/ultrabrain-client/src/cli.mjs',import.meta.url));
const preload=new URL('./fixtures/capture-lock-cli-preload.mjs',import.meta.url).href;
for(const command of ['queue-status','queue-capture','queue-flush'])test('queue CLI: cancellation reaches '+command+' lock wait',async t=>{
 const root=mkdtempSync(join(tmpdir(),'ub-lock-cli-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const workspace=join(root,'work');mkdirSync(workspace,{mode:0o700});
 const input={format:1,source:'default',workspace,outbox_directory:join(root,'queue'),allow_capture:true,
  expected_actor:'a'.repeat(64),expected_instance:'11111111-1111-4111-8111-111111111111',server:{transport:'stdio',command:'never-executed',args:[]}};
 const q=new CaptureOutbox(input);await q.status();
 const file=join(root,'profile.json');writeFileSync(file,JSON.stringify(input),{mode:0o600});
 const lock=join(q.directory,'.queue.lock'),bytes=JSON.stringify({pid:process.pid});writeFileSync(lock,bytes,{mode:0o600});
 const child=spawn(process.execPath,['--import',preload,cli,command,'--profile',file],{stdio:['pipe','pipe','pipe']});
 let output='',stderr='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>stderr+=b);child.stdin.on('error',()=>{});
 child.stdin.end(JSON.stringify({agent_id:'fixture',event_id:'fixed',consent:true,transcript:'PRIVATE_SYNTHETIC'}));
 const timer=setTimeout(()=>child.kill('SIGKILL'),5000);
 let exit;try{exit=await new Promise((r,j)=>{child.once('error',j);child.once('close',r);});}finally{clearTimeout(timer);}
 assert.equal(exit,1);assert.equal(stderr,'');const report=JSON.parse(output);assert.equal(report.error,'aborted');
 assert.ok(!output.includes('PRIVATE')&&!output.includes(root));assert.equal(readFileSync(lock,'utf8'),bytes);
 assert.equal(readdirSync(q.directory).filter(n=>n.endsWith('.entry')).length,0);
});
test('queue CLI: native lock permission error gives safe phase diagnostics, no paths',async t=>{
 const root=mkdtempSync(join(tmpdir(),'ub-lock-error-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const workspace=join(root,'work');mkdirSync(workspace,{mode:0o700});const file=join(root,'profile.json');
 writeFileSync(file,JSON.stringify({format:1,source:'default',workspace,outbox_directory:join(root,'queue'),allow_capture:true,
  expected_actor:'a'.repeat(64),expected_instance:'11111111-1111-4111-8111-111111111111',server:{transport:'stdio',command:'never-executed',args:[]}}),{mode:0o600});
 const child=spawn(process.execPath,['--import',preload,cli,'queue-status','--profile',file],{env:{...process.env,ULTRABRAIN_LOCK_CLI_FIXTURE:'denied'},stdio:['ignore','pipe','pipe']});
 let output='',err='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>err+=b);
 const timer=setTimeout(()=>child.kill('SIGKILL'),5000);let exit;try{exit=await new Promise((r,j)=>{child.once('error',j);child.once('close',r);});}finally{clearTimeout(timer);}
 assert.equal(exit,1);assert.equal(err,'');const result=JSON.parse(output);assert.equal(result.error,'outbox_lock_io');
 assert.deepEqual(result.lock,{kind:'queue',phase:'create',system_code:'EACCES'});assert.ok(!output.includes(root)&&!output.includes('PRIVATE'));
});
