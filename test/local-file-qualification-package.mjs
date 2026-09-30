/** Actual unpacked offline CLI/SDK; synthetic Windows seams are explicitly named. */
import assert from 'node:assert/strict';import fs from 'node:fs';import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';import {spawnSync} from 'node:child_process';import {createHash} from 'node:crypto';
const pkg=resolve(process.argv[2]),root=fs.mkdtempSync(join(tmpdir(),'ub-qualification-package-'));let checks=0;
try{
 const manifest=JSON.parse(fs.readFileSync(join(pkg,'dist/build-manifest.json')));
 for(const [name,hash]of Object.entries(manifest.artifacts))assert.equal(createHash('sha256').update(fs.readFileSync(join(pkg,'dist',name))).digest('hex'),hash);
 assert.ok(manifest.artifacts['local-check.cjs']&&manifest.artifacts['local-check-cli.cjs']);checks++;
 const guard=join(root,'offline-guard.cjs');
 fs.writeFileSync(guard,`const fs=require('node:fs'),Module=require('node:module'),{syncBuiltinESMExports}=require('node:module');
 const load=Module._load;Module._load=function(name,...args){if(name.startsWith('@modelcontextprotocol/')||['node:http','node:https','node:net','node:tls','node:child_process'].includes(name))throw Error('Unexpected online import');return load.call(this,name,...args);};
 global.fetch=()=>{throw Error('Unexpected fetch');};
 const mode=process.env.QUALIFICATION_SEAM;if(mode){Object.defineProperty(process,'platform',{value:'win32'});
 const ls=fs.lstatSync,stat=fs.fstatSync;
 fs.lstatSync=(...a)=>{const s=ls(...a);if(s.isFile())s.dev=mode==='path-zero'?0n:17n;return s;};
 fs.fstatSync=(...a)=>{const s=stat(...a);s.dev=mode==='path-zero'?211n:0n;return s;};syncBuiltinESMExports();}
 `,{mode:0o600});
 const run=(args=[],seam='',sdk=false)=>{
  const code=`const api=require(${JSON.stringify(join(pkg,'dist/local-check.cjs'))});console.log(JSON.stringify(api.qualifyLocalFileRuntime()));`;
  const r=spawnSync(process.execPath,['--require',guard,...(sdk?['-e',code]:[join(pkg,'dist/local-check-cli.cjs'),...args])],
   {encoding:'utf8',input:'PRIVATE_INPUT_NOT_READ',timeout:15000,maxBuffer:16384,env:{...process.env,TEMP:root,TMP:root,TMPDIR:root,QUALIFICATION_SEAM:seam}});
  assert.ifError(r.error);assert.equal(r.stderr,'');assert.ok(!r.stdout.includes(root)&&!r.stdout.includes('PRIVATE'));return r;
 };
 for(const seam of ['', 'path-zero']){
  const r=run([],seam);assert.equal(r.status,0);const v=JSON.parse(r.stdout);assert.equal(v.passed,true);assert.equal(v.checks.length,2);
  assert.equal(v.network_requests,0);assert.equal(v.production_queue_verified,false);if(seam)assert.equal(v.observation.path_device_zero,true);checks++;
  const sdk=run([],seam,true);assert.equal(sdk.status,0);assert.equal(JSON.parse(sdk.stdout).passed,true);checks++;
 }
 const denied=run([],'handle-zero');assert.equal(denied.status,1);const value=JSON.parse(denied.stdout);
 assert.equal(value.passed,false);assert.ok(value.checks.every(c=>!c.passed));assert.equal(value.observation.handle_device_zero,true);checks++;
 const help=run(['--help']);assert.equal(help.status,0);assert.match(help.stdout,/temporary-directory filesystem/);checks++;
 const invalid=run(['--profile','PRIVATE_PATH']);assert.equal(invalid.status,1);assert.equal(JSON.parse(invalid.stdout).error,'invalid_params');checks++;
 assert.deepEqual(fs.readdirSync(root),['offline-guard.cjs']);checks++;
 console.log(JSON.stringify({passed:true,checks,bundles:Object.keys(manifest.artifacts).length,
  mode:'actual compiled offline CLI/SDK; native Linux and explicit Windows stat seams; no SDK/network imports',server_calls:0,model_calls:0,user_files_selected:false}));
}finally{fs.rmSync(root,{recursive:true,force:true});}
