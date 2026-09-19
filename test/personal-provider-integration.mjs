/** Actual worker subprocess + native gateway/SDK + loopback provider fixture + PostgreSQL.
 * This is wire compatibility, NOT a real language model or semantic-quality test.
 */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {connect,ROOT,HOME} from '../src/runtime.mjs';
import {PersonalMemoryStore} from '../src/personal-memory-store.mjs';
import {PersonalConsolidator} from '../src/personal-consolidation.mjs';
import {configuredPersonalModel} from '../src/adapters/personal-model.mjs';
assert.equal(process.env.ULTRABRAIN_TEST_ALLOW_WRITE,'1','Isolated test installation required');
const engine=await connect(),source='provider-'+randomBytes(5).toString('hex');
const store=new PersonalMemoryStore({engine,sourceId:source,remote:false,transport:'stdio'});
const configFile=HOME+'/gbrain/.gbrain/config.json',original=readFileSync(configFile);
let calls=0,mock,checks=0;
const execute=env=>new Promise((resolve,reject)=>{
  const p=spawn(process.execPath,[ROOT+'/scripts/personal-worker.mjs','--local','--source',source,'--allow-model-call'],{cwd:ROOT,env,stdio:['ignore','pipe','pipe']});
  let out='',err='';p.stdout.on('data',x=>out+=x);p.stderr.on('data',x=>err=(err+x).slice(-1024));
  const timer=setTimeout(()=>p.kill('SIGKILL'),20000);
  p.once('error',e=>{clearTimeout(timer);reject(e);});p.once('close',code=>{clearTimeout(timer);resolve({code,out});});
});
try {
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)',[source]);await store.register({agent_id:'fixture'});
  const captured=await store.capture({agent_id:'fixture',event_id:'real-wire',transcript:'用户说：不要使用 Docker Hub。',consent:true});
  const disabled=await execute(process.env);assert.equal(disabled.code,2);assert.equal(JSON.parse(disabled.out).state,'needs_model');checks++;
  let wireOK=false;
  mock=createServer(async(req,res)=>{
    const chunks=[];for await(const c of req)chunks.push(c);
    const request=JSON.parse(Buffer.concat(chunks));calls++;
    wireOK=req.url==='/v1/chat/completions'&&req.method==='POST'&&!request.tools&&request.model==='ultrabrain-fixture'&&request.messages.some(m=>m.role==='user'&&m.content.includes('不要使用 Docker Hub'));
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({id:'fixture-chat',object:'chat.completion',created:1,model:'ultrabrain-fixture',
      choices:[{index:0,message:{role:'assistant',content:JSON.stringify({memories:[{type:'preference',content:'用户要求不要使用 Docker Hub。',quote:'不要使用 Docker Hub'}]})},finish_reason:'stop'}],
      usage:{prompt_tokens:30,completion_tokens:20,total_tokens:50}}));
  });
  await new Promise(resolve=>mock.listen(0,'127.0.0.1',resolve));const endpoint=`http://127.0.0.1:${mock.address().port}/v1`;
  const cfg=JSON.parse(original);cfg.chat_model='ollama:ultrabrain-fixture';cfg.provider_base_urls={...cfg.provider_base_urls,ollama:endpoint};
  cfg.ultrabrain_personal_consolidation={enabled:true,model:'ollama:ultrabrain-fixture',revision:'wire-fixture-1',timeout_ms:5000};
  writeFileSync(configFile,JSON.stringify(cfg)+'\n',{mode:0o600});
  // Actual pinned native loadConfig must reread the file when a previously configured
  // closure is invoked. Both changes must fail before the loopback provider receives text.
  const binding=await configuredPersonalModel(),beforeRevocation=calls;
  assert.equal(binding.profile.model,cfg.ultrabrain_personal_consolidation.model);
  for(const changed of [{enabled:false},{...cfg.ultrabrain_personal_consolidation,revision:'wire-fixture-2'}]) {
    writeFileSync(configFile,JSON.stringify({...cfg,ultrabrain_personal_consolidation:changed})+'\n',{mode:0o600});
    assert.throws(()=>binding.generate({model:binding.profile.model,system:'Synthetic consent fixture',prompt:'Synthetic input only',maxTokens:16}),{code:'model_profile_changed'});
    assert.equal(calls,beforeRevocation);checks++;
  }
  writeFileSync(configFile,JSON.stringify(cfg)+'\n',{mode:0o600});
  const ran=await execute({...process.env,OLLAMA_BASE_URL:endpoint});
  assert.equal(ran.code,0,'Actual personal worker subprocess failed (raw diagnostics withheld)');
  const report=JSON.parse(ran.out);assert.equal(report.states.completed,1);assert.equal(calls,1);assert.equal(wireOK,true);checks++;
  const job=(await new PersonalConsolidator(store.ctx).status({job_id:captured.job_id})).jobs[0];
  assert.equal(job.state,'completed');assert.equal(job.result.usage.input_tokens,30);checks++;
  const candidate=(await store.search({status:'candidate'})).memories.find(r=>r.id===job.result.entries[0].id);
  assert.equal(candidate.derivation.quote,'不要使用 Docker Hub');assert.equal(candidate.status,'candidate');checks++;
  const again=await execute({...process.env,OLLAMA_BASE_URL:endpoint});assert.equal(again.code,0);assert.equal(JSON.parse(again.out).processed,0);assert.equal(calls,1);checks++;
  console.log(`PASS ${checks} worker/provider wire checks: actual subprocess and native SDK, local synthetic provider only`);
}finally {
  writeFileSync(configFile,original,{mode:0o600});
  if(mock)await new Promise(resolve=>mock.close(resolve));await engine.disconnect();
}
