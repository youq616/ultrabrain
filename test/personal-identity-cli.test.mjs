import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,existsSync,rmSync,writeFileSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const cli=resolve('src/cli.mjs');
function run(args,env=process.env){const p=spawnSync(process.execPath,[cli,'personal-identity',...args],{env,encoding:'utf8',timeout:10000,maxBuffer:16384});assert.ifError(p.error);assert.equal(p.status,1);assert.equal(p.stderr,'');return JSON.parse(p.stdout);}
test('identity CLI rejects unknown and duplicated options without echoing credentials',()=>{
 for(const args of [['--url','SECRET'],['--source'],['--home=/tmp/SECRET'],['--source','a','--source','b']]){
  const r=run(args);assert.equal(r.error,'invalid_arguments');assert.ok(!JSON.stringify(r).includes('SECRET'));assert.equal(r.services_started,false);
 }
});
test('identity CLI on an absent installation never creates a home or accepts an instance',()=>{
 const dir=mkdtempSync(join(tmpdir(),'ub-id-cli-')),home=join(dir,'absent');
 try{const r=run(['--home',home]);assert.equal(r.ok,false);assert.equal(r.identity_verified,false);assert.equal(existsSync(home),false);assert.ok(!('instance_id'in r));}
 finally{rmSync(dir,{recursive:true,force:true});}
});
test('identity CLI uses isolated distro Python without ambient Python startup or PATH code',()=>{
 if(process.platform!=='linux')return;
 const dir=mkdtempSync(join(tmpdir(),'ub-id-env-')),marker=join(dir,'executed'),home=join(dir,'absent');
 try{
  writeFileSync(join(dir,'sitecustomize.py'),`open(${JSON.stringify(marker)},'w').write('bad')`);
  writeFileSync(join(dir,'python3'),`#!/bin/sh\ntouch '${marker}'\n`);chmodSync(join(dir,'python3'),0o700);
  const r=run(['--home',home],{...process.env,PATH:dir,PYTHONPATH:dir,PYTHONHOME:dir,ULTRABRAIN_DEBUG:'1'});
  assert.equal(r.ok,false);assert.equal(existsSync(marker),false);assert.equal(existsSync(home),false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
