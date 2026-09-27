/** Actual CLI subprocess, synthetic official transport; no database in this suite. */
import test from 'node:test';import assert from 'node:assert/strict';import {spawn} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {fileURLToPath} from 'node:url';
import {identity} from './fixtures/client-sdk-stub.mjs';
const cli=fileURLToPath(new URL('../packages/ultrabrain-client/src/candidates-cli.mjs',import.meta.url));
const preload=new URL('./fixtures/client-candidates-cli-preload.mjs',import.meta.url).href;
async function run(t,{patch={},mode='success',raw,help=false}={}){
 const dir=mkdtempSync(join(tmpdir(),'ub-candidates-cli-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const file=join(dir,'profile.json');
 const profile={format:1,source:'default',workspace:dir,expected_instance:identity.instance_id,expected_actor:identity.actor_key,
  server:{transport:'stdio',command:'not-executed',args:[]}};const save=p=>writeFileSync(file,JSON.stringify(p),{mode:0o600});save(profile);
 const child=spawn(process.execPath,['--import',preload,cli,...(help?['--help']:['--profile',file])],
  {env:{...process.env,ULTRABRAIN_CANDIDATES_FIXTURE:mode},stdio:['pipe','pipe','pipe','ipc']});
 let out='',err='',observed;child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.stdin.on('error',()=>{});
 child.on('message',m=>{if(m.observed)observed=m;else if(m.phase==='input'){
  if(mode==='input')save({...profile,source:'other'});child.stdin.end(raw??JSON.stringify({workspace:dir,consent:true,limit:20,...patch}));
 }else if(m.phase){save({...profile,source:'other'});child.send({continue:true});}});
 const timer=setTimeout(()=>child.kill('SIGKILL'),10000);
 try{const code=await new Promise((res,rej)=>{child.once('error',rej);child.once('close',res);});assert.equal(err,'');
  assert.ok(!out.includes(dir)&&!out.includes('PRIVATE_RAW'));return {code,r:help?out:JSON.parse(out),observed};
 }finally{clearTimeout(timer);}
}
test('candidates CLI: one explicit page, no write calls',async t=>{
 const r=await run(t);assert.equal(r.code,0);assert.equal(r.r.page.returned,0);assert.equal(r.observed.closed,1);
 assert.deepEqual(r.observed.calls,['ultra_identity','ultra_identity','ultra_personal_candidates','ultra_identity']);
});
test('candidates CLI: help needs no connection',async t=>{const r=await run(t,{help:true});assert.equal(r.code,0);assert.match(r.r,/No body/);assert.equal(r.observed.connections,0);});
for(const patch of [{consent:false},{limit:0},{project_id:'foreign'},{include_text:true}])test('candidates CLI invalid '+JSON.stringify(patch),async t=>{
 const r=await run(t,{patch});assert.equal(r.code,1);assert.equal(r.r.read_delivery,'not_started');assert.equal(r.observed.connections,0);
});
for(const raw of ['x'.repeat(17000),'{bad','{"consent":true,"consent":false}','\ufeff{}'])test('candidates CLI invalid JSON '+raw.slice(0,10),async t=>{
 const r=await run(t,{raw});assert.equal(r.code,1);assert.equal(r.observed.connections,0);
});
for(const mode of ['input','response','cleanup'])test('candidates CLI profile revocation '+mode,async t=>{
 const r=await run(t,{mode});assert.equal(r.code,1);assert.equal(r.r.error,'client_authorization_revoked');assert.equal(r.r.page,undefined);
 assert.equal(r.r.read_delivery,mode==='input'?'not_started':'unconfirmed');
});
test('candidates CLI lost response is not retried or relabelled empty',async t=>{
 const r=await run(t,{mode:'lost'});assert.equal(r.code,1);assert.equal(r.r.read_delivery,'unconfirmed');assert.equal(r.observed.calls.filter(n=>n==='ultra_personal_candidates').length,1);
});
