/** Actual Python + Node CLI entrypoint, with explicitly synthetic dependency executables.
 * No DB initialized, network connection, real keys or source file repair.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,existsSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const ROOT=fileURLToPath(new URL('../',import.meta.url));
function fixture(t){
 const directory=mkdtempSync(join(tmpdir(),'ub-preflight-cli-'));
 t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const bin=join(directory,'bin');mkdirSync(bin,{mode:0o700});
 for(const name of ['bun','bash','git','make','gcc','bison','flex','pkg-config']){
  writeFileSync(join(bin,name),'#!/bin/sh\n'+(name==='bun'?'printf "1.3.13\\n"\n':'exit 0\n'),{mode:0o700});
 }
 const home=join(directory,'future-data');
 return {directory,home,env:{...process.env,PATH:bin+':'+process.env.PATH,ULTRABRAIN_HOME:home,
  ULTRABRAIN_DEBUG:'1',OPENAI_API_KEY:'PREFLIGHT_SYNTHETIC_SECRET_NOT_FOR_REPORT'}};
}
function call(command,args,env){
 const p=spawnSync(command,args,{cwd:ROOT,env,encoding:'utf8',timeout:15000,maxBuffer:65536});
 assert.ifError(p.error);assert.equal(p.stderr,'');
 assert.ok(!p.stdout.includes('PREFLIGHT_SYNTHETIC_SECRET_NOT_FOR_REPORT'));
 return {exit:p.status,report:JSON.parse(p.stdout)};
}
test('preflight works through the shipped CLI without calling runtime connect',t=>{
 const f=fixture(t);
 const r=call(process.execPath,['src/cli.mjs','preflight','--mode','install'],f.env);
 assert.equal(r.exit,0);assert.equal(r.report.ok,true);assert.equal(r.report.database_connected,false);
 assert.equal(r.report.live_service_verified,false);assert.equal(existsSync(f.home),false);
});
test('direct Python preflight and Node CLI use the same contract',t=>{
 const f=fixture(t);
 const a=call('python3',['-B','scripts/preflight.py','--mode','install'],f.env);
 const b=call(process.execPath,['src/cli.mjs','preflight','--mode','install'],f.env);
 assert.equal(a.exit,0);assert.equal(b.exit,0);assert.equal(a.report.scope,b.report.scope);
 assert.deepEqual(a.report.checks,b.report.checks);assert.equal(existsSync(f.home),false);
});
test('runtime preflight refuses an uninitialized home without creating it',t=>{
 const f=fixture(t);const r=call(process.execPath,['src/cli.mjs','preflight','--mode','runtime'],f.env);
 assert.equal(r.exit,1);assert.equal(r.report.ok,false);assert.equal(existsSync(f.home),false);
});
test('argument errors do not leak command-line strings even with parent debugging',t=>{
 const f=fixture(t);const r=call(process.execPath,['src/cli.mjs','preflight','--mode','PREFLIGHT_SYNTHETIC_SECRET_NOT_FOR_REPORT'],f.env);
 assert.equal(r.exit,2);assert.equal(r.report.error,'invalid_arguments');assert.equal(existsSync(f.home),false);
});
test('preflight flags do not reach native gbrain CLI',t=>{
 const f=fixture(t);const r=call(process.execPath,['src/cli.mjs','preflight','--unknown-option'],f.env);
 assert.equal(r.exit,2);assert.equal(r.report.scope,'offline-local-preflight');
 assert.ok(!existsSync(join(f.directory,'gbrain')));
});
