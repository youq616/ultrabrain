/** Shipped CLI routing, with no systemd call, real model or initialized database. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
const root=new URL('../',import.meta.url).pathname;
function setup(t){const dir=mkdtempSync(join(tmpdir(),'ub-services-cli-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const bin=join(dir,'bin');mkdirSync(bin);writeFileSync(join(bin,'bun'),'#!/bin/sh\nprintf "1.3.13\\n"\n',{mode:0o700});
 return {dir,home:join(dir,'absent'),output:join(dir,'output'),env:{...process.env,PATH:bin+':'+process.env.PATH,
  ULTRABRAIN_HOME:join(dir,'absent'),OPENAI_API_KEY:'SYNTHETIC_NEVER_ECHO_TOKEN'}};}
function run(args,f){const p=spawnSync(process.execPath,['src/cli.mjs','personal-services',...args],{cwd:root,env:f.env,encoding:'utf8',timeout:15000,maxBuffer:65536});
 assert.ifError(p.error);assert.equal(p.stderr,'');assert.ok(!p.stdout.includes('SYNTHETIC_NEVER_ECHO_TOKEN'));
 return {exit:p.status,result:JSON.parse(p.stdout)};}
test('personal service CLI refuses implicit model scheduling before touching the data directory',t=>{
 const f=setup(t);const r=run(['render','--source','default','--output',f.output,'--with-consolidation'],f);
 assert.equal(r.exit,1);assert.equal(r.result.error,'explicit_model_schedule_consent_required');assert.equal(existsSync(f.home),false);assert.equal(existsSync(f.output),false);
});
test('render checks installation but does not initialize missing PostgreSQL',t=>{
 const f=setup(t);const r=run(['render','--source','default','--output',f.output],f);
 assert.equal(r.exit,1);assert.equal(r.result.error,'runtime_preflight_failed');assert.equal(existsSync(f.home),false);assert.equal(existsSync(f.output),false);
});
test('verification does not run database startup and requires a pinned digest',t=>{
 const f=setup(t);const r=run(['verify','--directory',f.output,'--expected-sha','invalid'],f);
 assert.equal(r.exit,1);assert.equal(r.result.error,'expected_manifest_sha_required');assert.equal(existsSync(f.home),false);
});
test('no enable command or private argument is forwarded to the native CLI',t=>{
 const f=setup(t);const r=run(['enable-SYNTHETIC_NEVER_ECHO_TOKEN'],f);
 assert.equal(r.exit,1);assert.equal(r.result.error,'invalid_arguments');assert.equal(r.result.services_started,false);
});
