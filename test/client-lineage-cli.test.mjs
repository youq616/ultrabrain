/** Actual Node CLI process with labelled SDK doubles and synchronized profile change. */
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {identity} from './fixtures/client-sdk-stub.mjs';import {uuid} from './helpers/lineage-fixture.mjs';
const cli=fileURLToPath(new URL('../packages/ultrabrain-client/src/cli.mjs',import.meta.url));
const preload=new URL('./fixtures/client-lineage-cli-preload.mjs',import.meta.url).href;
async function run(t,{request={},change,failure=false}={}){
 const dir=mkdtempSync(join(tmpdir(),'ub-lineage-cli-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const file=join(dir,'profile.json');
 const profile={format:1,source:'default',workspace:dir,expected_instance:identity.instance_id,expected_actor:identity.actor_key,
  server:{transport:'stdio',command:'not-executed',args:[]}};
 const save=p=>writeFileSync(file,JSON.stringify(p),{mode:0o600});save(profile);
 const child=spawn(process.execPath,['--import',preload,cli,'lineage','--profile',file],{
  env:{...process.env,ULTRABRAIN_LINEAGE_CLI_FIXTURE:failure?'failure':'success'},stdio:['pipe','pipe','pipe','ipc']});
 let out='',err='',observation=null;child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.stdin.on('error',()=>{});
 child.on('message',m=>{
  if(m.inputReady){if(change)save({...profile,...change});child.stdin.end(JSON.stringify({memory_id:uuid(1),workspace:dir,consent:true,...request}));}
  if(m.observedCalls)observation=m;
 });
 const timer=setTimeout(()=>child.kill('SIGKILL'),10000);
 try{
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  assert.ok(!out.includes('PRIVATE_SERVER_ERROR')&&!err.includes('PRIVATE_SERVER_ERROR'));
  assert.ok(out.trim(),'CLI fixture exited before returning JSON; inspect its platform job log');
  return {code,data:JSON.parse(out),out,err,observation};
 }finally{clearTimeout(timer);}
}
test('client lineage CLI: metadata default and explicit text selection',async t=>{
 const safe=await run(t);assert.equal(safe.code,0);assert.equal(safe.data.verdict.state,'matched');assert.equal(safe.data.text,undefined);
 const full=await run(t,{request:{include_text:true}});assert.equal(full.code,0);assert.match(full.data.text.quote,/Docker Hub/);
});
for(const request of [{consent:false},{memory_id:'bad'},{include_text:'yes'},{source_id:'other'}])test('client lineage CLI: invalid stdin is not a submitted write '+JSON.stringify(request),async t=>{
 const r=await run(t,{request});assert.equal(r.code,1);assert.equal(r.data.read_delivery,'not_started');assert.equal(r.data.memory_writes_requested,false);
 assert.equal(r.data.delivery,undefined);assert.equal(r.observation.connections,0);
});
for(const change of [{source:'other'},{allow_capture:true},{server:{transport:'stdio',command:'must-not-start',args:[]}}])
 test('client lineage CLI: observed profile change while awaiting stdin is never adopted '+JSON.stringify(change),async t=>{
  const r=await run(t,{change});assert.equal(r.code,1);assert.equal(r.data.error,'client_authorization_revoked');assert.equal(r.observation.connections,0);
 });
test('client lineage CLI: post-dispatch failure reports uncertain read without private body/error',async t=>{
 const r=await run(t,{failure:true});assert.equal(r.code,1);assert.equal(r.data.read_delivery,'unconfirmed');assert.equal(r.data.memory_writes_requested,false);
 assert.equal(r.data.error,'lineage_read_unconfirmed');assert.equal(r.data.delivery,undefined);
});

// The actual --import argument must stay a URL on Windows as well as POSIX.
// A drive-letter path is interpreted as an unsupported ESM scheme by Node.
test('client lineage CLI: preload is a file URL with platform-safe path round trip',()=>{
 assert.equal(new URL(preload).protocol,'file:');
 assert.equal(fileURLToPath(preload),fileURLToPath(new URL('./fixtures/client-lineage-cli-preload.mjs',import.meta.url)));
});
