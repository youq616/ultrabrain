/** Exercise the real public route without an installed database or user manager. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,mkdirSync,existsSync,rmSync} from 'node:fs';
import {join,delimiter} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';

const ROOT=fileURLToPath(new URL('../',import.meta.url));
const SECRET='ACTIVATION_SYNTHETIC_NEVER_PRINT';
const current='a'.repeat(64),plan='b'.repeat(64),pending='c'.repeat(64);
const options=['--bun',process.execPath,'--expected-current',current,
 '--expected-instance','00000000-0000-4000-8000-000000000001'];
const valid=[['plan',...options],['apply',...options,'--expected-plan',plan],
 ['status'],['recover','--expected-pending',pending]];

function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'ub-activate-cli-'));
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const home=join(dir,'uncreated-installation');
 return {dir,home,env:{...process.env,ULTRABRAIN_HOME:home,OPENAI_API_KEY:SECRET,
  DATABASE_URL:'postgresql://'+SECRET+'@untrusted.invalid/private',
  GBRAIN_DATABASE_URL:'postgresql://'+SECRET+'@untrusted.invalid/private',
  ULTRABRAIN_DEBUG:'1'}};
}

function call(args,f){
 const result=spawnSync(process.execPath,['src/cli.mjs','personal-activate',...args],
  {cwd:ROOT,env:f.env,encoding:'utf8',timeout:15000,maxBuffer:65536});
 assert.ifError(result.error);assert.equal(result.stderr,'');
 assert.ok(!result.stdout.includes(SECRET),'A refusal must not disclose credentials or argument values');
 assert.equal(existsSync(f.home),false,'The public route must not bootstrap the absent installation');
 assert.notEqual(result.status,0);
 const value=JSON.parse(result.stdout);
 assert.equal(value.ok,false);assert.equal(value.application_ready,false);
 assert.equal(value.activation_outcome,'not_proven');
 assert.match(value.error,/^[a-z][a-z_]{0,79}$/);
 for(const key of ['configuration_changed','services_stopped','enablement_changed','model_called','automatic_stop_authorized'])
  assert.equal(value[key],false,'A refusal must report the fixed action boundary: '+key);
 assert.equal(Object.hasOwn(value,'services_started'),false,'Refusal must not guess whether an activation took effect');
 return value;
}

test('activation CLI safely refuses missing, unsupported, duplicate and abbreviated arguments',t=>{
 const f=fixture(t);
 for(const args of [[],['start',...options],['stop'],['plan'],['apply',...options],['recover'],
  ['status','--source','unrequested'],['plan',...options,'--token',SECRET],
  ['plan',...options,'--source','first','--source','second'],['plan',...options,'--por','3132'],
  ['apply',...options,'--expected-plan',plan,'--expected-pending',pending],
  ['recover','--expected-pending',pending,'--bun',process.execPath],
  ['plan',...options,'--allow-model-call']])assert.equal(call(args,f).error,'invalid_arguments');
});

test('activation commands on an absent installation never create a home, token or service state',t=>{
 const f=fixture(t);for(const args of valid)call(args,f);
 assert.equal(existsSync(join(f.home,'personal-console-token')),false);
 assert.equal(existsSync(join(f.home,'personal-activation')),false);
 assert.equal(existsSync(join(f.home,'postgres')),false);
});

test('activation Python ignores ambient startup code and Python installation overrides',t=>{
 const f=fixture(t),injected=join(f.dir,'injected'),marker=join(f.dir,'startup-executed');
 mkdirSync(injected);
 const payload=`from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text('unexpected')\n`;
 writeFileSync(join(injected,'sitecustomize.py'),payload);
 writeFileSync(join(injected,'usercustomize.py'),payload);
 f.env.PYTHONPATH=injected;f.env.PYTHONHOME=join(injected,'not-a-python-installation');f.env.PYTHONUSERBASE=injected;
 call(['status'],f);
 assert.equal(existsSync(marker),false);assert.equal(existsSync(join(injected,'__pycache__')),false);
});

test('Linux activation selects distro Python without executing an ambient PATH replacement',t=>{
 const f=fixture(t);
 if(process.platform!=='linux'){call(['status'],f);return;}
 const injected=join(f.dir,'bin'),marker=join(f.dir,'replacement-executed');mkdirSync(injected);
 writeFileSync(join(injected,'python3'),`#!/usr/bin/python3\nfrom pathlib import Path\nPath(${JSON.stringify(marker)}).write_text('unexpected')\nraise SystemExit(99)\n`,{mode:0o700});
 f.env.PATH=injected+delimiter+(f.env.PATH??'');
 call(['status'],f);assert.equal(existsSync(marker),false,'Only the fixed distro interpreter may execute on Linux');
});

test('activation refusal keeps ambient credentials and explicit secret arguments out of JSON',t=>{
 const f=fixture(t);
 call(['status','--token',SECRET],f);
 call(['plan',...options,'--source',SECRET],f);
 call(['recover','--expected-pending',SECRET],f);
});

test('ordinary Linux service account remains a mandatory activation boundary',t=>{
 const f=fixture(t);
 for(const args of valid){
  const value=call(args,f);
  if(process.platform!=='linux'||typeof process.getuid==='function'&&process.getuid()===0)
   assert.equal(value.error,'ordinary_linux_account_required');
 }
});
