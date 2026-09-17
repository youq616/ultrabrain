/** Public CLI routing/isolation, independent of Bun, PostgreSQL or a live user manager. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,mkdirSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
const ROOT=fileURLToPath(new URL('../',import.meta.url)),SECRET='DEPLOY_SYNTHETIC_NEVER_PRINT';
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'ub-deploy-cli-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const home=join(dir,'uncreated-home');return {dir,home,env:{...process.env,ULTRABRAIN_HOME:home,OPENAI_API_KEY:SECRET,
  GBRAIN_DATABASE_URL:'postgresql://'+SECRET+'@untrusted.invalid/private',ULTRABRAIN_DEBUG:'1'}};}
function call(args,f){const p=spawnSync(process.execPath,['src/cli.mjs','personal-deploy',...args],
 {cwd:ROOT,env:f.env,encoding:'utf8',timeout:15000,maxBuffer:65536});
 assert.ifError(p.error);assert.ok(!p.stdout.includes(SECRET));assert.ok(!p.stderr.includes(SECRET));
 assert.equal(p.stderr,'');assert.equal(existsSync(f.home),false);return {code:p.status,data:JSON.parse(p.stdout)};}
test('deployment CLI rejects incomplete and unsupported operations without initializing an installation',t=>{
 const f=fixture(t);for(const args of [[],['activate'],['apply'],['rollback'],['recover'],['status','--token',SECRET]]){
  const {code,data}=call(args,f);assert.notEqual(code,0);assert.equal(data.ok,false);assert.equal(typeof data.error,'string');}});
test('status on an absent home makes no directories, starts no database and safely reports failure or absence',t=>{
 const {code,data}=call(['status'],fixture(t));assert.equal(typeof data.ok,'boolean');
 if(code!==0)assert.equal(data.ok,false);else{assert.equal(data.result.current_sha256,null);assert.equal(data.result.pending_sha256,null);}});
test('deployment command runs isolated Python without ambient sitecustomize or bytecode',t=>{
 const f=fixture(t),inject=join(f.dir,'injected'),marker=join(f.dir,'executed');mkdirSync(inject);
 writeFileSync(join(inject,'sitecustomize.py'),`open(${JSON.stringify(marker)},'w').write('unexpected')\n`);
 f.env.PYTHONPATH=inject;call(['status'],f);assert.equal(existsSync(marker),false);assert.equal(existsSync(join(inject,'__pycache__')),false);});
test('root execution is explicitly refused when this test itself runs as root',t=>{
 if(typeof process.getuid!=='function'||process.getuid()!==0)return;
 const {code,data}=call(['status'],fixture(t));assert.notEqual(code,0);assert.equal(data.ok,false);assert.match(data.error,/ordinary|root|account/);});
