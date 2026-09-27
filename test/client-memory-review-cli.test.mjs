/** Actual CLI subprocess, explicit synthetic SDK transport. */
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {identity} from './fixtures/client-sdk-stub.mjs';
import {uuid,hash} from './helpers/snapshot-audit-fixture.mjs';
const cli=fileURLToPath(new URL('../packages/ultrabrain-client/src/memory-review-cli.mjs',import.meta.url));
const preload=new URL('./fixtures/client-memory-review-cli-preload.mjs',import.meta.url).href;
async function run(t,{patch={},mode='success',raw}={}){
 const dir=mkdtempSync(join(tmpdir(),'ub-review-cli-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const path=join(dir,'profile.json'),profile={format:1,source:'default',workspace:dir,expected_instance:identity.instance_id,expected_actor:identity.actor_key,
 allow_capture:true,server:{transport:'stdio',command:'not-executed',args:[]}};
 const save=p=>writeFileSync(path,JSON.stringify(p),{mode:0o600});save(profile);
 const q={operation:'apply',workspace:dir,consent:true,memory_id:uuid(1),event_id:'manual-review',expected_revision:1,
 expected_content_hash:hash('PRIVATE_BODY'),expected_status:'candidate',expected_visibility:'private',expected_project_id:null,status:'active',...patch};
 const child=spawn(process.execPath,['--import',preload,cli,'--profile',path],{env:{...process.env,ULTRABRAIN_REVIEW_FIXTURE:mode},stdio:['pipe','pipe','pipe','ipc']});
 let out='',err='',observed;child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);child.stdin.on('error',()=>{});
 child.on('message',m=>{
  if(m.phase==='input'){if(mode==='input-change')save({...profile,source:'other'});child.stdin.end(raw??JSON.stringify(q));}
  else if(m.phase){save({...profile,source:'other'});child.send({continue:true});}
  if(m.observed)observed=m;
 });
 const timer=setTimeout(()=>child.kill('SIGKILL'),10000);
 try{
  const code=await new Promise((res,rej)=>{child.once('error',rej);child.once('close',res);});assert.equal(err,'');
  assert.ok(!out.includes(dir)&&!out.includes('PRIVATE_BODY')&&!out.includes('PRIVATE_REMOTE'));
  return {code,data:JSON.parse(out),observed};
 }finally{clearTimeout(timer);}
}
test('review CLI: single compact confirmed receipt, no raw body',async t=>{
 const r=await run(t);assert.equal(r.code,0);assert.equal(r.data.write_delivery,'confirmed');assert.equal(r.observed.closed,1);
});
for(const patch of [{consent:false},{expected_revision:0},{include_text:true},{source_id:'other'}])test('review CLI: invalid request before connection '+JSON.stringify(patch),async t=>{
 const r=await run(t,{patch});assert.equal(r.code,1);assert.equal(r.data.write_delivery,'not_started');assert.equal(r.observed.connections,0);
});
for(const raw of ['x'.repeat(17000),'{bad','{"operation":"inspect","operation":"apply"}','\ufeff{}'])test('review CLI: malformed bounded JSON '+raw.slice(0,10),async t=>{
 const r=await run(t,{raw});assert.equal(r.code,1);assert.equal(r.observed.connections,0);
});
for(const mode of ['input-change','response-change','cleanup-change'])test('review CLI: profile changes fenced '+mode,async t=>{
 const r=await run(t,{mode});assert.equal(r.code,1);assert.equal(r.data.error,'client_authorization_revoked');
 assert.equal(r.data.write_delivery,mode==='input-change'?'not_started':mode==='response-change'?'unconfirmed':'confirmed');assert.equal(r.data.receipt,undefined);
});
test('review CLI: lost reply is unconfirmed, not no-write or repeated submit',async t=>{
 const r=await run(t,{mode:'lost'});assert.equal(r.code,1);assert.equal(r.data.write_delivery,'unconfirmed');
 assert.equal(r.observed.calls.filter(n=>n==='ultra_personal_review').length,1);
});
