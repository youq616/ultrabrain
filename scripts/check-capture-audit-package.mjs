#!/usr/bin/env node
/** Real standalone compiled CLI, synthetic local files, no SDK install or service. */
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,copyFileSync,readdirSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {CaptureOutbox} from '../src/capture-outbox.mjs';
const args=process.argv.slice(2);
assert.ok(args.length===0||args.length===2&&args[0]==='--cli','Use no arguments or --cli COMPILED_ENTRY');
const compiled=args.length?resolve(args[1]):new URL('../packages/ultrabrain-client/dist/queue-audit-cli.cjs',import.meta.url);
const root=mkdtempSync(join(tmpdir(),'ub-audit-package-')),observations=[];
try{
 const exe=join(root,'audit.cjs'),preload=join(root,'deny.cjs');copyFileSync(compiled,exe);
 writeFileSync(preload,`const fs=require('node:fs');
 for(const name of ['writeFileSync','unlinkSync','renameSync','linkSync','mkdirSync','rmSync','chmodSync','truncateSync','fsyncSync'])fs[name]=()=>{throw Error('forbidden mutation');};
 const open=fs.openSync;fs.openSync=(p,f,...rest)=>{if(typeof f==='number'?(f&(fs.constants.O_WRONLY|fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_TRUNC|fs.constants.O_APPEND))!==0:!['r','rs','sr'].includes(f))throw Error('forbidden write flags');return open(p,f,...rest);};
 for(const [module,names] of [['node:child_process',['spawn','spawnSync','exec','execSync','execFile','fork']],['node:http',['request','get']],['node:https',['request','get']],['node:net',['connect','createConnection']],['node:tls',['connect']]])for(const name of names)require(module)[name]=()=>{throw Error('forbidden network/process');};
 global.fetch=()=>{throw Error('forbidden fetch');};require('node:module').syncBuiltinESMExports();\n`);
 const workspace=join(root,'work');mkdirSync(workspace,{mode:0o700});
 const input={format:1,source:'fixture',workspace,outbox_directory:join(root,'queue'),allow_capture:true,
  expected_actor:'a'.repeat(64),expected_instance:'11111111-1111-4111-8111-111111111111',server:{transport:'stdio',command:'never-executed',args:[]}};
 const profile=join(root,'profile.json');
 const writeProfile=()=>writeFileSync(profile,JSON.stringify({...input,allow_capture:false}),{mode:0o600});writeProfile();
 const snap=()=>existsSync(input.outbox_directory)?readdirSync(input.outbox_directory).sort().map(n=>[n,readFileSync(join(input.outbox_directory,n)).toString('hex')]):null;
 function run(name,status,exit=0,argv=['--profile',profile]){
  const before=snap();const p=spawnSync(process.execPath,['--require',preload,exe,...argv],{input:'IGNORED_PRIVATE_STDIN',encoding:'utf8',timeout:5000,env:{...process.env,NODE_PATH:''}});
  assert.ifError(p.error);assert.equal(p.status,exit);assert.equal(p.stderr,'');assert.deepEqual(snap(),before);
  const value=JSON.parse(p.stdout);if(status)assert.equal(value.result?.status,status);
  assert.ok(!p.stdout.includes(root)&&!p.stdout.includes('PRIVATE')&&!p.stdout.includes('SECRET'));
  observations.push({name,passed:true,status:value.result?.status??value.error});
 }
 run('absent directory remains absent','absent');
 const q=new CaptureOutbox(input);run('empty queue is not initialized','uninitialized');
 await q.enqueue({agent_id:'fixture',event_id:'SECRET_EVENT',transcript:'PRIVATE_PAYLOAD',consent:true});run('valid record; capture disabled','healthy');
 const record=join(q.directory,readdirSync(q.directory).find(n=>n.endsWith('.entry'))),r=JSON.parse(readFileSync(record));r.state='blocked';r.attempts=8;writeFileSync(record,JSON.stringify(r));run('blocked entry retained','attention',1);
 writeFileSync(record,'PRIVATE_BROKEN');run('corrupt entry preserved','attention',1);
 writeFileSync(join(q.directory,'.queue.lock'),'PRIVATE_LOCK',{mode:0o600});run('locked queue unopened','busy',1);
 run('invalid flags rejected',null,1,['--repair','PRIVATE']);
 run('missing profile sanitized',null,1,['--profile',join(root,'PRIVATE-missing')]);
 console.log(JSON.stringify({format:1,passed:true,platform:process.platform,node:process.version,compiled_entry:true,isolated_from_sdk:true,
  cases:observations,network_and_mutation_guards:true,user_queue_access:false}));
}finally{rmSync(root,{recursive:true,force:true});}
