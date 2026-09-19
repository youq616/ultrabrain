/** Actual application dispatch; no runtime/database or user configuration needed. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,delimiter} from 'node:path';
const cli=new URL('../src/cli.mjs',import.meta.url).pathname;
function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'ub-setup-cli-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 return {dir,home:join(dir,'absent'),env:{...process.env,ULTRABRAIN_HOME:join(dir,'absent'),ULTRABRAIN_DEBUG:'1'}};
}
function refused(args,f){
 const p=spawnSync(process.execPath,[cli,'personal-setup',...args],{env:f.env,encoding:'utf8',timeout:5000,maxBuffer:16384});
 assert.ifError(p.error);assert.equal(p.status,1);assert.equal(p.stderr,'');
 const r=JSON.parse(p.stdout);assert.equal(r.ok,false);assert.equal(r.prepared,false);
 assert.equal(r.identity_verified,false);assert.equal(r.application_readiness,'not_checked');
 for(const key of ['services_started','services_stopped','model_called','memory_read','credentials_returned'])assert.equal(r[key],false);
 assert.equal('instance_id'in r,false);assert.equal(existsSync(f.home),false);
 assert.ok(!p.stdout.includes('SYNTHETIC_SECRET'));return r;
}
test('setup command is exposed in the actual help without database initialization',()=>{
 const p=spawnSync(process.execPath,[cli,'help'],{encoding:'utf8',timeout:5000});assert.equal(p.status,0);assert.match(p.stdout,/personal-setup check\|prepare/);
});
test('setup strictly rejects unsupported actions, inputs and implicit creation',t=>{
 const f=fixture(t);for(const args of [[],['start'],['check','--token','SYNTHETIC_SECRET'],['prepare','--source=default'],
  ['check','--source','default','--source','other'],['prepare','--home'],['check','--expected-instance','SYNTHETIC_SECRET'],
  ['prepare','--source','../bad'],['check','--hom','/tmp'],['check','--home','relative']])refused(args,f);
});
test('setup refuses an absent installation for both check and prepare without bootstrap',t=>{
 const f=fixture(t);for(const action of ['check','prepare'])refused([action],f);
});
test('setup dispatch isolates distro Python and never executes ambient startup code',t=>{
 const f=fixture(t),poison=join(f.dir,'poison'),marker=join(f.dir,'executed');mkdirSync(poison);
 writeFileSync(join(poison,'sitecustomize.py'),`from pathlib import Path\nPath(${JSON.stringify(marker)}).touch()\n`);
 writeFileSync(join(poison,'python3'),`#!/bin/sh\ntouch '${marker}'\nexit 97\n`,{mode:0o700});
 Object.assign(f.env,{PATH:poison+delimiter+process.env.PATH,PYTHONPATH:poison,PYTHONHOME:join(poison,'absent')});
 refused(['check'],f);assert.equal(existsSync(marker),false);assert.equal(existsSync(join(poison,'__pycache__')),false);
});
