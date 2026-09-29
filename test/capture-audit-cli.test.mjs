/** Actual Node CLI processes; SDK imports are a test double and must not connect. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {CaptureOutbox} from '../src/capture-outbox.mjs';
const cli=fileURLToPath(new URL('../packages/ultrabrain-client/src/cli.mjs',import.meta.url));
const preload=new URL('./fixtures/capture-audit-cli-preload.mjs',import.meta.url).href;
for(const kind of ['absent','empty','healthy','locked','corrupt','foreign'])test('queue-audit CLI: '+kind+' without writes or network',async t=>{
 const root=mkdtempSync(join(tmpdir(),'ub-audit-cli-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const workspace=join(root,'work');mkdirSync(workspace,{mode:0o700});
 const input={format:1,source:'default',workspace,outbox_directory:join(root,'queue'),allow_capture:true,
  expected_actor:'a'.repeat(64),expected_instance:'11111111-1111-4111-8111-111111111111',server:{transport:'stdio',command:'never-executed',args:[]}};
 let q;
 if(kind!=='absent')q=new CaptureOutbox(input);
 if(!['absent','empty'].includes(kind))await q.enqueue({agent_id:'fixture',event_id:'SECRET_EVENT',transcript:'PRIVATE_SYNTHETIC',consent:true});
 if(kind==='locked')writeFileSync(join(q.directory,'.queue.lock'),'not even JSON',{mode:0o600});
 if(kind==='corrupt')writeFileSync(join(q.directory,readdirSync(q.directory).find(n=>n.endsWith('.entry'))),'INVALID_PRIVATE_JSON');
 if(kind==='foreign')input.expected_actor='b'.repeat(64);
 // Reading is useful after capture consent is revoked; no write grant is needed.
 input.allow_capture=false;
 const file=join(root,'profile.json');writeFileSync(file,JSON.stringify(input),{mode:0o600});
 const before=existsSync(input.outbox_directory)?readdirSync(input.outbox_directory).sort().map(n=>[n,readFileSync(join(input.outbox_directory,n)).toString('hex')]):null;
 const r=spawnSync(process.execPath,['--import',preload,cli,'queue-audit','--profile',file],{encoding:'utf8',timeout:5000});
 assert.ifError(r.error);assert.equal(r.stderr,'');const output=JSON.parse(r.stdout);
 const expected={absent:'absent',empty:'uninitialized',healthy:'healthy',locked:'busy',corrupt:'attention',foreign:'attention'}[kind];
 assert.equal(output.result?.status,expected);assert.equal(r.status,['absent','empty','healthy'].includes(kind)?0:1);
 assert.equal(output.result.read_only,true);assert.equal(output.result.server_confirmation,false);
 assert.ok(!r.stdout.includes(root)&&!r.stdout.includes('PRIVATE')&&!r.stdout.includes('SECRET'));
 assert.deepEqual(existsSync(input.outbox_directory)?readdirSync(input.outbox_directory).sort().map(n=>[n,readFileSync(join(input.outbox_directory,n)).toString('hex')]):null,before);
});
