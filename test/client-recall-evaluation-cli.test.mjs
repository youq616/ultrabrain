/** Actual CLI subprocess, synthetic SDK; IPC synchronizes profile change tests. */
import test from 'node:test';import assert from 'node:assert/strict';import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {fileURLToPath} from 'node:url';
import {identity} from './fixtures/client-sdk-stub.mjs';
const cli=fileURLToPath(new URL('../packages/ultrabrain-client/src/recall-eval-cli.mjs',import.meta.url));
const preload=new URL('./fixtures/client-recall-evaluation-preload.mjs',import.meta.url).href;
async function run(t,{mode='success',patch={},raw}={}){
 const dir=mkdtempSync(join(tmpdir(),'ub-eval-cli-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const file=join(dir,'profile.json'),profile={format:1,source:'default',workspace:dir,allow_task_context:true,
 expected_instance:identity.instance_id,expected_actor:identity.actor_key,server:{transport:'stdio',command:'not-executed',args:[]}};
 const save=p=>writeFileSync(file,JSON.stringify(p),{mode:0o600});save(profile);
 const request={workspace:dir,consent:true,top_k:1,cases:[{id:'sample',task:'PRIVATE_TASK',relevant_ids:['00000001-1111-4111-8111-111111111111'],forbidden_ids:[]}],...patch};
 const child=spawn(process.execPath,['--import',preload,cli,'--profile',file],{env:{...process.env,ULTRABRAIN_EVAL_TEST_MODE:mode},stdio:['pipe','pipe','pipe','ipc']});
 let out='',err='',observed;child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.stdin.on('error',()=>{});
 child.on('message',m=>{
  if(m.observed){observed=m;return;}
  if(m.phase==='input'){
   if(mode==='input-change')save({...profile,source:'other'});
   child.stdin.end(typeof raw==='function'?raw(request):raw??JSON.stringify(request));
  }else if(m.phase){save({...profile,source:'other'});child.send({continue:true});}
 });
 const timer=setTimeout(()=>child.kill('SIGKILL'),10000);
 try{
  const code=await new Promise((r,j)=>{child.once('error',j);child.once('close',r);});assert.equal(err,'');assert.ok(!out.includes('PRIVATE_')&&!out.includes(dir));
  assert.equal(out.trim().split('\n').length,1);return {code,data:JSON.parse(out),observed};
 }finally{clearTimeout(timer);}
}
test('evaluation CLI: JSON report, no task/body, clean exit and closed transport',async t=>{
 const r=await run(t);assert.equal(r.code,0);assert.equal(r.data.summary.hit_rate_at_k,1);assert.equal(r.observed.closed,1);
 assert.deepEqual(r.observed.calls,['ultra_identity','ultra_identity','ultra_personal_context','ultra_identity']);
});
for(const patch of [{consent:false},{top_k:0},{cases:[]},{unexpected:true}])test('evaluation CLI: invalid selection never connects '+JSON.stringify(patch),async t=>{
 const r=await run(t,{patch});assert.equal(r.code,1);assert.equal(r.observed.connections,0);assert.equal(r.data.query_attempts,0);
});
for(const raw of ['not json','{}','x'.repeat(131073),'\ufeff{}'])test('evaluation CLI: malformed or oversized input '+raw.slice(0,10),async t=>{
 const r=await run(t,{raw});assert.equal(r.code,1);assert.equal(r.observed.connections,0);assert.equal(r.data.query_delivery,'not_started');
});
test('evaluation CLI: duplicate escaped consent rejects before connecting',async t=>{
 const r=await run(t,{raw:q=>JSON.stringify(q).replace('"consent":true','"consent":false,"con\\u0073ent":true')});assert.equal(r.code,1);assert.equal(r.observed.connections,0);
});
for(const mode of ['input-change','response-change','cleanup-change'])test('evaluation CLI: profile changes at '+mode+' do not adopt new identity',async t=>{
 const r=await run(t,{mode});assert.equal(r.code,1);assert.equal(r.data.error,'client_authorization_revoked');
 assert.equal(r.data.query_delivery,mode==='input-change'?'not_started':'unconfirmed');assert.equal(r.data.cases,undefined);
});
test('evaluation CLI: transport diagnostic sanitized, no write delivery field',async t=>{
 const r=await run(t,{mode:'failure'});assert.equal(r.code,1);assert.equal(r.data.error,'recall_evaluation_unconfirmed');
 assert.equal(r.data.query_delivery,'unconfirmed');assert.equal(r.data.memory_writes_requested,false);assert.equal(r.data.delivery,undefined);
});
test('evaluation CLI: help does not launch a client',()=>{
 const r=spawnSync(process.execPath,['--import',preload,cli,'--help'],{encoding:'utf8',timeout:5000});assert.ifError(r.error);assert.equal(r.status,0);assert.match(r.stdout,/not semantic/);
});
