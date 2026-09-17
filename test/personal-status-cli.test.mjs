/** Real CLI entrypoint; unit-state mocks are not live systemd acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,mkdirSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
const ROOT=fileURLToPath(new URL('../',import.meta.url)),SECRET='STATUS_SYNTHETIC_NEVER_PRINT';
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'ub-status-cli-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const path=join(dir,'uncreated-home');return {dir,path,env:{...process.env,ULTRABRAIN_HOME:path,OPENAI_API_KEY:SECRET,
 GBRAIN_DATABASE_URL:'postgresql://'+SECRET+'@untrusted.invalid/private',ULTRABRAIN_DEBUG:'1'}};}
function call(args,f){const p=spawnSync(process.execPath,['src/cli.mjs','personal-status',...args],
 {cwd:ROOT,env:f.env,encoding:'utf8',timeout:15000,maxBuffer:65536});
 assert.ifError(p.error);assert.equal(p.stderr,'');assert.ok(!p.stdout.includes(SECRET));assert.equal(existsSync(f.path),false);
 return {code:p.status,data:JSON.parse(p.stdout)};}
test('Node CLI dispatches without initializing a database or user data directory',t=>{
 const {code,data}=call([],fixture(t));assert.ok([0,1,3].includes(code));assert.equal(data.scope,'local-user-systemd-unit-observation');
 assert.equal(data.configuration_changed,false);assert.equal(data.services_started,false);assert.equal(data.database_connected,false);
 assert.equal(data.model_called,false);assert.equal(data.application_ready,'not_checked');assert.equal(data.installation_binding_verified,false);});
test('expect-worker only changes the requirement',t=>{const {data}=call(['--expect-worker'],fixture(t));assert.equal(data.worker_required,true);
 assert.equal(data.services_stopped,false);assert.equal(data.mcp_checked,false);assert.equal(data.console_http_checked,false);});
test('unknown units, URLs and tokens do not reach native commands or output',t=>{
 const f=fixture(t);for(const args of [['--unit','foreign.service'],['--url',SECRET],['--token',SECRET]]){
 const {code,data}=call(args,f);assert.equal(code,2);assert.equal(data.error,'invalid_arguments');}});
test('duplicate flag rejected',t=>{const {code,data}=call(['--expect-worker','--expect-worker'],fixture(t));assert.equal(code,2);assert.equal(data.error,'invalid_arguments');});
test('isolated Python ignores ambient sitecustomize and writes no bytecode',t=>{
 const f=fixture(t),inject=join(f.dir,'injected'),marker=join(f.dir,'executed');mkdirSync(inject);
 writeFileSync(join(inject,'sitecustomize.py'),`open(${JSON.stringify(marker)},'w').write('unexpected')\n`);f.env.PYTHONPATH=inject;
 call([],f);assert.equal(existsSync(marker),false);assert.equal(existsSync(join(inject,'__pycache__')),false);});
test('actual unavailable manager is not reported as healthy or uninstalled',t=>{
 const {code,data}=call([],fixture(t));if(code===3){assert.equal(data.ok,false);assert.equal(data.status,'unavailable');assert.deepEqual(data.units,[]);}
 else{assert.equal(code===0,data.ok);assert.equal(data.units.length,4);}});
