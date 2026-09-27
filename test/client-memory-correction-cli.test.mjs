/** Actual CLI process and controlled MCP transport; no real database claims. */
import test from 'node:test';import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';import {join} from 'node:path';import {fileURLToPath} from 'node:url';import {spawn} from 'node:child_process';
import {identity} from './fixtures/client-sdk-stub.mjs';import {fixture,hash} from './helpers/memory-correction-fixture.mjs';
const cli=fileURLToPath(new URL('../packages/ultrabrain-client/src/memory-review-cli.mjs',import.meta.url));
const preload=new URL('./fixtures/client-memory-review-cli-preload.mjs',import.meta.url).href;
async function run(t,{mode='success',edit=()=>{},raw}={}){
 const f=fixture(t),profile={format:1,source:'default',workspace:f.profile.workspace,allow_capture:true,expected_instance:identity.instance_id,
  expected_actor:identity.actor_key,server:{transport:'stdio',command:'not-executed',args:[]}},path=join(f.profile.workspace,'profile.json');
 f.request.expected_content_hash=hash('PRIVATE_BODY');f.request.expected_status='candidate';edit(f.request);
 const save=()=>writeFileSync(path,JSON.stringify(profile),{mode:0o600});save();
 const c=spawn(process.execPath,['--import',preload,cli,'--profile',path],{env:{...process.env,ULTRABRAIN_REVIEW_FIXTURE:mode},stdio:['pipe','pipe','pipe','ipc']});
 let out='',err='',observed;c.stdout.on('data',b=>out+=b);c.stderr.on('data',b=>err+=b);c.stdin.on('error',()=>{});
 c.on('message',m=>{if(m.phase==='input'){if(mode==='input-change'){profile.source='other';save();}c.stdin.end(raw??JSON.stringify(f.request));}
  else if(m.phase){profile.source='other';save();c.send({continue:true});}if(m.observed)observed=m;});
 const timer=setTimeout(()=>c.kill('SIGKILL'),15000);
 try{const status=await new Promise((res,rej)=>{c.once('error',rej);c.once('close',res);});assert.equal(err,'');assert.ok(!out.includes('PRIVATE')&&!out.includes(f.profile.workspace));return {status,r:JSON.parse(out),observed};}
 finally{clearTimeout(timer);}
}
test('correction CLI: successful full request without leaking replacement',async t=>{
 const x=await run(t);assert.equal(x.status,0);assert.equal(x.r.receipt.status,'candidate');assert.equal(x.r.review_required,true);
 assert.equal(x.observed.calls.filter(c=>c==='ultra_personal_update').length,1);
});
test('correction CLI: valid 64 KiB content is accepted within 128 KiB input bound',async t=>{
 const x=await run(t,{edit:q=>q.memory.content='A'.repeat(65536)});assert.equal(x.status,0);
});
test('correction CLI: explicit replay reports historical candidate only',async t=>{
 const x=await run(t,{mode:'correction-replay',edit:q=>q.operation='replay-correction'});assert.equal(x.status,0);assert.equal(x.r.receipt.replayed,true);
});
for(const mode of ['input-change','response-change','cleanup-change','lost'])test('correction CLI: '+mode+' fences data delivery',async t=>{
 const x=await run(t,{mode});assert.equal(x.status,1);assert.equal(x.r.receipt,undefined);
 assert.equal(x.r.write_delivery,mode==='input-change'?'not_started':mode==='cleanup-change'?'confirmed':'unconfirmed');
});
for(const raw of ['x'.repeat(131073),'\ufeff{}','{"operation":"correct","operation":"inspect"}',Buffer.from([0xff])])
 test('correction CLI: bounded ambiguous/invalid bytes refused',async t=>{
  const x=await run(t,{raw});assert.equal(x.status,1);assert.equal(x.observed.connections,0);
 });
