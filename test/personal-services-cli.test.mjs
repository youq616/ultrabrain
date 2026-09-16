/** Shipped CLI/Python wiring, not a service or database mock presented as a live test. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
function fixture(t){const base=mkdtempSync(join(tmpdir(),'ub-services-cli-'));t.after(()=>rmSync(base,{recursive:true,force:true}));return {base,home:join(base,'uninstalled')};}
function cli(args,f){const r=spawnSync(process.execPath,['src/cli.mjs','personal-services','--home',f.home,'--bun','/usr/bin/bun',...args],{encoding:'utf8',timeout:15000,env:{...process.env,ULTRABRAIN_HOME:f.home}});assert.ifError(r.error);assert.equal(r.stderr,'');return {code:r.status,data:JSON.parse(r.stdout)};}
test('CLI planning never initializes database or starts processes',t=>{const f=fixture(t),r=cli([],f);assert.equal(r.code,0);assert.equal(r.data.result.services_started,false);assert.equal(r.data.result.model_called,false);assert.equal(existsSync(f.home),false);assert.equal(Object.keys(r.data.result.units).length,2);});
test('CLI worker consent is independently required',t=>{const f=fixture(t);assert.equal(cli(['--worker'],f).code,1);assert.equal(cli(['--allow-model-call'],f).code,1);const r=cli(['--worker','--allow-model-call'],f);assert.equal(r.code,0);assert.equal(Object.keys(r.data.result.units).length,3);assert.equal(existsSync(f.home),false);});
test('CLI plan, exclusive export and verification execute end to end',t=>{const f=fixture(t),plan=cli([],f).data.result;const output=join(f.base,'units');assert.equal(cli(['--output',output],f).code,1);assert.equal(existsSync(output),false);assert.equal(cli(['--output',output,'--expected-plan',plan.plan_sha256],f).code,0);assert.equal(cli(['--verify',output,'--expected-plan',plan.plan_sha256],f).code,0);assert.equal(cli(['--output',output,'--expected-plan',plan.plan_sha256],f).code,1);assert.equal(existsSync(f.home),false);});
