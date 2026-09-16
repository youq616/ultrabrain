/** Actual systemd USER manager -> console/worker -> managed PostgreSQL + local model fixture.
 * Never run on a production installation; requires two explicit test-only environment gates.
 */
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,renameSync,rmSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
assert.equal(process.env.ULTRABRAIN_TEST_ALLOW_WRITE,'1','Only an isolated synthetic installation');
assert.equal(process.env.ULTRABRAIN_TEST_SYSTEMD,'1','Explicit test-only user-manager permission required');
assert.notEqual(process.getuid(),0,'Never run this fixture as root');
// Import only after gates: no implicit configuration setup on a refused invocation.
const {connect,ROOT,HOME}=await import('../src/runtime.mjs');
const {PersonalMemoryStore}=await import('../src/personal-memory-store.mjs');
const {PersonalConsolidator}=await import('../src/personal-consolidation.mjs');
const dir=mkdtempSync(join(homedir(),'ub-personal-services-test-'));
const name='ub-services-'+randomBytes(6).toString('hex'),source=name;
const database=name+'-db.service',consoleUnit=name+'-console.service',worker=name+'-worker.service',timer=name+'-worker.timer';
const unitNames=[timer,worker,consoleUnit,database];
let engine,provider,linked=false,originalConfig,configFile,calls=0,checks=0,token,report;
const pass=()=>checks++;
async function processRun(binary,args,{acceptable=[0],timeout=30000}={}) {
  const child=spawn(binary,args,{cwd:ROOT,env:process.env,stdio:['ignore','pipe','pipe']});
  let out='',err='';let overflow=false;
  for(const [stream,key] of [[child.stdout,'out'],[child.stderr,'err']])stream.on('data',chunk=>{
    if(key==='out')out+=chunk;else err+=chunk;
    if(out.length+err.length>262144){overflow=true;child.kill('SIGKILL');}
  });
  const deadline=setTimeout(()=>child.kill('SIGKILL'),timeout);
  try{const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
    assert.equal(overflow,false,'Subprocess output exceeded bound');
    assert.ok(acceptable.includes(code),`Synthetic service command failed: ${binary.split('/').at(-1)} ${args[0]} exit ${code}; private logs suppressed`);
    return {code,out,err};
  }finally{clearTimeout(deadline);}
}
const ctl=(...args)=>processRun('systemctl',['--user',...args]);
const cli=(...args)=>processRun(process.execPath,[join(ROOT,'src/cli.mjs'),'personal-services',...args]);
const state=async unit=>(await ctl('show',unit,'--property=ActiveState','--value')).out.trim();
async function until(check,timeout=60000) {
  const end=Date.now()+timeout;
  while(Date.now()<end){if(await check())return;await new Promise(r=>setTimeout(r,250));}
  throw new Error('Synthetic user-service readiness deadline exceeded');
}
try {
  await ctl('list-jobs','--no-legend');pass();
  // Random test-specific unit names must not already exist in this user's manager.
  for(const unit of unitNames)assert.equal((await processRun('systemctl',['--user','show',unit,'--property=LoadState','--value'],{acceptable:[0,1]})).out.trim(),'not-found');
  engine=await connect();await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)',[source]);
  const ctx={engine,sourceId:source,remote:false,transport:'stdio'},store=new PersonalMemoryStore(ctx);
  await store.register({agent_id:'services-fixture'});
  const job=await store.capture({agent_id:'services-fixture',event_id:'timer-once',consent:true,transcript:'合成服务测试：不要使用 Docker Hub。'});
  const jobs=new PersonalConsolidator(ctx);
  const baseline=join(dir,'default');
  const initial=JSON.parse((await cli('render','--source',source,'--name',name,'--output',baseline)).out);
  assert.equal(initial.result.unit_names.length,1);assert.equal(initial.result.model_schedule_authorized,false);pass();
  const refused=await processRun(process.execPath,[join(ROOT,'src/cli.mjs'),'personal-services','render','--source',source,'--output',join(dir,'refused'),'--with-consolidation'],{acceptable:[1]});
  assert.ok(refused.out.includes('explicit_model_schedule_consent_required'));assert.equal(calls,0);pass();
  const free=createServer();await new Promise(r=>free.listen(0,'127.0.0.1',r));const port=free.address().port;await new Promise(r=>free.close(r));
  const bundle=join(dir,'approved');
  const rendered=JSON.parse((await cli('render','--source',source,'--name',name,'--database-unit',database,
    '--output',bundle,'--console-port',String(port),'--interval','30','--with-consolidation','--allow-model-call')).out);
  assert.equal(rendered.result.unit_names.length,3);assert.equal(calls,0);pass();
  assert.equal(JSON.parse((await cli('verify','--directory',bundle,'--expected-sha',rendered.result.manifest_sha256)).out).ok,true);pass();
  const base=join(dir,'base');await processRun('python3',[ROOT+'/scripts/install-service.py','--output',base]);
  const dbPath=join(base,database);renameSync(join(base,'ultrabrain-postgres.service'),dbPath);
  const paths=[dbPath,...rendered.result.unit_names.map(n=>join(bundle,n))];
  await processRun('systemd-analyze',['verify',...paths]);pass();
  // Only now register these exact generated files in the disposable CI user manager.
  linked=true;await ctl('link',...paths);await ctl('daemon-reload');
  await ctl('start',consoleUnit);
  const origin=`http://127.0.0.1:${port}`;
  await until(async()=>{try{return (await fetch(origin,{signal:AbortSignal.timeout(500)})).ok;}catch{return false;}});
  assert.equal(await state(consoleUnit),'active');pass();
  token=readFileSync(join(HOME,'personal-console-token'),'utf8').trim();assert.match(token,/^[a-f0-9]{64}$/);
  const response=await fetch(origin+'/api/call',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({operation:'info'})});
  assert.equal((await response.json()).result.source_id,source);pass();
  const invocation=(await ctl('show',consoleUnit,'--property=InvocationID','--value')).out.trim();
  await ctl('restart',consoleUnit);
  await until(async()=>{try{return (await fetch(origin,{signal:AbortSignal.timeout(500)})).ok;}catch{return false;}});
  assert.notEqual((await ctl('show',consoleUnit,'--property=InvocationID','--value')).out.trim(),invocation);
  assert.equal(readFileSync(join(HOME,'personal-console-token'),'utf8').trim(),token);pass();
  // Explicit scheduling cannot secretly configure a model: disabled native profile remains disabled.
  const noModel=await processRun('systemctl',['--user','start',worker],{acceptable:[1]});
  assert.equal((await ctl('show',worker,'--property=ExecMainStatus','--value')).out.trim(),'2');
  assert.equal((await jobs.status({job_id:job.job_id})).jobs[0].state,'queued');assert.equal(calls,0);pass();
  await ctl('reset-failed',worker);
  configFile=join(HOME,'gbrain/.gbrain/config.json');originalConfig=readFileSync(configFile);
  provider=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>131072){res.writeHead(413);res.end();return;}}
    const input=JSON.parse(raw);calls++;
    assert.equal(req.url,'/v1/chat/completions');assert.equal(input.model,'ultrabrain-fixture');
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({id:'fixture',object:'chat.completion',created:1,model:'ultrabrain-fixture',choices:[{index:0,
      message:{role:'assistant',content:JSON.stringify({memories:[{type:'preference',content:'不要使用 Docker Hub。',quote:'不要使用 Docker Hub'}]})},finish_reason:'stop'}],
      usage:{prompt_tokens:20,completion_tokens:15,total_tokens:35}}));
  });
  await new Promise(r=>provider.listen(0,'127.0.0.1',r));
  const config=JSON.parse(originalConfig);config.chat_model='ollama:ultrabrain-fixture';
  config.provider_base_urls={...config.provider_base_urls,ollama:`http://127.0.0.1:${provider.address().port}/v1`};
  config.ultrabrain_personal_consolidation={enabled:true,model:'ollama:ultrabrain-fixture',revision:'services-fixture-1',timeout_ms:5000};
  writeFileSync(configFile,JSON.stringify(config)+'\n',{mode:0o600});
  await ctl('start',timer);
  await until(async()=> (await jobs.status({job_id:job.job_id})).jobs[0].state==='completed');
  await until(async()=>await state(worker)==='inactive');
  assert.equal(calls,1);assert.equal((await ctl('show',worker,'--property=ExecMainStatus','--value')).out.trim(),'0');pass();
  const final=(await jobs.status({job_id:job.job_id})).jobs[0];
  const candidate=(await store.search({status:'candidate'})).memories.find(m=>m.id===final.result.entries[0].id);
  assert.equal(candidate.visibility,'private');assert.equal(candidate.status,'candidate');assert.equal(candidate.derivation.quote,'不要使用 Docker Hub');pass();
  await ctl('start',worker);assert.equal(calls,1);pass(); // Completed jobs are not repeated.
  assert.equal(await state(timer),'active');
  await engine.disconnect();engine=null;
  await ctl('stop',database);
  await until(async()=>(await state(timer))==='inactive'&&(await state(consoleUnit))==='inactive');
  assert.equal(await state(worker),'inactive');
  let reachable=false;try{reachable=(await fetch(origin,{signal:AbortSignal.timeout(500)})).ok;}catch{}
  assert.equal(reachable,false);pass();
  report={passed:true,checks,actual_user_manager:true,model:'local synthetic fixture only',
    scope:'Real generated units, restart, native preflight, timer batch, PostgreSQL, inactive dependency propagation; not user deployment'};
} finally {
  const cleanupErrors=[];
  if(linked){
    try{await processRun('systemctl',['--user','stop',...unitNames],{acceptable:[0,5]});}catch{cleanupErrors.push('stop');}
    try{await processRun('systemctl',['--user','disable',...unitNames],{acceptable:[0,1]});await ctl('daemon-reload');}catch{cleanupErrors.push('disable');}
    try{await processRun('systemctl',['--user','reset-failed',...unitNames],{acceptable:[0,1]});}catch{}
  }
  if(originalConfig)writeFileSync(configFile,originalConfig,{mode:0o600});
  if(provider)await new Promise(r=>provider.close(r));
  await engine?.disconnect();
  // Only this test's private generated directory is removed, never any user-supplied path.
  if(cleanupErrors.length===0)rmSync(dir,{recursive:true,force:true});
  assert.deepEqual(cleanupErrors,[],'Test service cleanup failed; generated directory retained');
}
console.log(JSON.stringify({...report,test_services_stopped:true}));
