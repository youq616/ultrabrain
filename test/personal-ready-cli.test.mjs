/** Public routing never initializes the installation or relaxes the ordinary-user gate. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,mkdirSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const SECRET='READY_SYNTHETIC_NEVER_PRINT';
const options=['--bun','/usr/bin/bun','--expected-current','a'.repeat(64),
 '--expected-instance','00000000-0000-4000-8000-000000000001'];
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'ub-ready-cli-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const home=join(dir,'uncreated');return {dir,home,env:{...process.env,ULTRABRAIN_HOME:home,OPENAI_API_KEY:SECRET,
 GBRAIN_DATABASE_URL:'postgresql://'+SECRET+'@untrusted.invalid/private',ULTRABRAIN_DEBUG:'1'}};}
function call(args,f){const p=spawnSync(process.execPath,['src/cli.mjs','personal-ready',...args],
 {env:f.env,encoding:'utf8',timeout:15000,maxBuffer:65536});
 assert.ifError(p.error);assert.equal(p.stderr,'');assert.ok(!p.stdout.includes(SECRET));assert.equal(existsSync(f.home),false);
 const value=JSON.parse(p.stdout);assert.equal(value.ok,false);assert.equal(value.application_ready,false);
 for(const name of ['configuration_changed','services_started','services_stopped','enablement_changed','model_called'])assert.equal(value[name],false);
 assert.notEqual(p.status,0);return value;}
test('readiness CLI refuses incomplete, duplicate and unsupported inputs safely',t=>{
 const f=fixture(t);for(const args of [[],['activate'],options.slice(0,4),[...options,'--token',SECRET],
 [...options,'--source','a','--source','b'],[...options,'--por','3132']])call(args,f);
});
test('readiness on absent installation makes no files and does not bootstrap',t=>{call(options,fixture(t));});
test('readiness Python is isolated from ambient sitecustomize and bytecode',t=>{
 const f=fixture(t),inject=join(f.dir,'injected'),marker=join(f.dir,'executed');mkdirSync(inject);
 writeFileSync(join(inject,'sitecustomize.py'),`open(${JSON.stringify(marker)},'w').write('unexpected')\n`);
 f.env.PYTHONPATH=inject;call(options,f);assert.equal(existsSync(marker),false);assert.equal(existsSync(join(inject,'__pycache__')),false);
});
test('ordinary Linux service account remains a mandatory CLI boundary',t=>{
 const value=call(options,fixture(t));
 if(process.platform==='linux'&&typeof process.getuid==='function'&&process.getuid()===0)assert.equal(value.error,'ordinary_linux_account_required');
});
