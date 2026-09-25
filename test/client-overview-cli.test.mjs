/** Actual CLI subprocess; synthetic SDK IO explicitly labelled. */
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {identity} from './fixtures/client-sdk-stub.mjs';
const cli=fileURLToPath(new URL('../packages/ultrabrain-client/src/cli.mjs',import.meta.url));
const preload=new URL('./fixtures/client-overview-cli-preload.mjs',import.meta.url).href;
async function run(t,{patch={},mode='success',raw,profilePatch={}}={}){
 const dir=mkdtempSync(join(tmpdir(),'ub-overview-cli-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const file=join(dir,'profile.json'),profile={format:1,source:'default',workspace:dir,expected_instance:identity.instance_id,expected_actor:identity.actor_key,
 server:{transport:'stdio',command:'not-executed',args:[]},...profilePatch};
 const save=p=>writeFileSync(file,JSON.stringify(p),{mode:0o600});save(profile);
 const child=spawn(process.execPath,['--import',preload,cli,'overview','--profile',file],{
 env:{...process.env,ULTRABRAIN_OVERVIEW_CLI_FIXTURE:mode},stdio:['pipe','pipe','pipe','ipc']});
 let out='',err='',observed;child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.stdin.on('error',()=>{});
 child.on('message',m=>{
  if(m.phase==='input'){
   if(mode==='input-change')save({...profile,source:'other'});
   child.stdin.end((typeof raw==='function'?raw(dir):raw)??JSON.stringify({workspace:dir,consent:true,scope:'owned-all-projects',...patch}));
  }else if(m.phase){save({...profile,source:'other'});child.send({continue:true});}
  if(m.observedCalls)observed=m;
 });
 const timer=setTimeout(()=>child.kill('SIGKILL'),10000);
 try{
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  assert.equal(err,'');assert.ok(!out.includes('PRIVATE_SERVER_ERROR')&&!out.includes(dir));
  assert.equal(out.trim().split('\n').length,1);return {code,data:JSON.parse(out),observed};
 }finally{clearTimeout(timer);}
}
test('CLI explicit one-shot verified aggregate, no fallback context reads',async t=>{
 const r=await run(t);assert.equal(r.code,0);assert.equal(r.data.overview.jobs.total,15);
 assert.equal(r.observed.closed,1);assert.deepEqual(r.observed.observedCalls,['ultra_identity','ultra_identity','ultra_personal_overview','ultra_identity']);
});
for(const patch of [{consent:false},{scope:'project'},{workspace:'relative'},{include_text:true},{source_id:'other'}])test('CLI refuses invalid selection '+JSON.stringify(patch),async t=>{
 const r=await run(t,{patch});assert.equal(r.code,1);assert.equal(r.observed.connections,0);assert.equal(r.data.read_delivery,'not_started');assert.equal(r.data.memory_writes_requested,false);
});
for(const raw of ['{}','[1]','invalid','x'.repeat(17000)])test('CLI refuses bounded malformed stdin '+raw.slice(0,8),async t=>{
 const r=await run(t,{raw});assert.equal(r.code,1);assert.equal(r.observed.connections,0);assert.equal(r.data.read_delivery,'not_started');
});
for(const mode of ['input-change','response-change','cleanup-change'])test('CLI never adopts observed profile change '+mode,async t=>{
 const r=await run(t,{mode});assert.equal(r.code,1);assert.equal(r.data.error,'client_authorization_revoked');
 assert.equal(r.data.read_delivery,mode==='input-change'?'not_started':'unconfirmed');assert.equal(r.data.memory_writes_requested,false);assert.equal(r.data.overview,undefined);
});
for(const mode of ['failure','bad-count'])test('CLI failure has read-only uncertain delivery '+mode,async t=>{
 const r=await run(t,{mode});assert.equal(r.code,1);assert.equal(r.data.read_delivery,'unconfirmed');assert.equal(r.data.memory_writes_requested,false);
 assert.equal(r.data.delivery,undefined);assert.equal(r.observed.closed,1);
});

for(const key of ['consent','con\\u0073ent','scope'])test('self-review: duplicate JSON selection '+key+' is rejected before connection',async t=>{
 const r=await run(t,{raw:dir=>'{"workspace":'+JSON.stringify(dir)+',"consent":true,"scope":"owned-all-projects","'+key+'":'+(key==='scope'?'"owned-all-projects"':'true')+'}'});
 assert.equal(r.code,1);assert.equal(r.observed.connections,0);assert.equal(r.data.read_delivery,'not_started');
});
