/** Public bootstrap route: no installation, manager, provider or secrets required. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {join,delimiter} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
const ROOT=fileURLToPath(new URL('../',import.meta.url)),SECRET='INIT_SYNTHETIC_NEVER_PRINT';
function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'ub-init-cli-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 return {dir,home:join(dir,'absent'),env:{...process.env,ULTRABRAIN_HOME:join(dir,'absent'),
  ULTRABRAIN_DEBUG:'1',OPENAI_API_KEY:SECRET,DATABASE_URL:'postgresql://'+SECRET+'@untrusted.invalid/private'}};
}
function call(args,f){
 const result=spawnSync(process.execPath,['src/cli.mjs','personal-init',...args],
  {cwd:ROOT,env:f.env,encoding:'utf8',timeout:10000,maxBuffer:16384});
 assert.ifError(result.error);assert.equal(result.stderr,'');assert.ok(!result.stdout.includes(SECRET));
 assert.equal(existsSync(f.home),false);assert.notEqual(result.status,0);
 const value=JSON.parse(result.stdout);assert.equal(value.ok,false);
 for(const k of ['services_started','database_connected','model_called','configuration_changed'])assert.equal(value[k],false);
 assert.equal(value.token_creation,'not_proven');return value;
}
test('personal-init rejects unknown, missing, duplicate and abbreviated options before side effects',t=>{
 const f=fixture(t);
 for(const args of [[],['start'],['rotate'],['create-token','--token',SECRET],['status','--home'],
  ['status','--home',f.home,'--home',f.home],['status','--ho',f.home],['create-token','--port','3132'],
  ['create-token','--home='+f.home],['status','--allow-model-call']])
  assert.equal(call(args,f).error,'invalid_arguments');
});
test('personal-init on an absent installation cannot bootstrap or create token/service state',t=>{
 const f=fixture(t);for(const action of ['status','create-token'])call([action],f);
});
test('personal-init uses isolated distro Python and does not execute an ambient interpreter',t=>{
 const f=fixture(t),injected=join(f.dir,'injected'),marker=join(f.dir,'executed');mkdirSync(injected);
 writeFileSync(join(injected,'sitecustomize.py'),`from pathlib import Path\nPath(${JSON.stringify(marker)}).touch()\n`);
 writeFileSync(join(injected,'python3'),`#!/bin/sh\ntouch '${marker}'\nexit 97\n`,{mode:0o700});
 f.env.PATH=injected+delimiter+process.env.PATH;f.env.PYTHONPATH=injected;
 f.env.PYTHONHOME=join(injected,'not-python');f.env.PYTHONUSERBASE=injected;
 call(['status'],f);assert.equal(existsSync(marker),false);assert.equal(existsSync(join(injected,'__pycache__')),false);
});
