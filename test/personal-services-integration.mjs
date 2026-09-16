/** Real user-systemd + managed PG + console + explicit scheduled local provider.
 * Ephemeral CI runner only: never enable units on an ordinary user's workstation.
 */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,unlinkSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir,homedir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
if(process.env.GITHUB_ACTIONS!=='true'||process.env.ULTRABRAIN_TEST_ALLOW_WRITE!=='1'||process.getuid()===0)
  throw Error('Dedicated non-root GitHub Actions test runner and synthetic-install opt-in required');
const {connect,ROOT,HOME}=await import('../src/runtime.mjs');
const {PersonalMemoryStore}=await import('../src/personal-memory-store.mjs');
const dir=mkdtempSync(join(tmpdir(),'ub-personal-services-')),source='service-'+randomBytes(5).toString('hex');
const unitDir=join(homedir(),'.config/systemd/user'),configFile=HOME+'/gbrain/.gbrain/config.json',envFile=HOME+'/service.env';
const original=readFileSync(configFile),oldEnv=existsSync(envFile)?readFileSync(envFile):null;
const names=['ultrabrain-personal.target','ultrabrain-personal-console.service','ultrabrain-personal-mcp.service','ultrabrain-personal-worker.service','ultrabrain-personal-worker.timer','ultrabrain-postgres.service'];
// These names must not already be deployed even on a test runner.
if(names.some(n=>existsSync(join(unitDir,n))))throw Error('Existing service units: refusing to modify them');
let engine,provider,calls=0,installed=false,checks=0;const owned=new Map();const pass=()=>checks++;
let block=false,release;let safeError='';
async function run(command,args,{ok=true,timeout=60000}={}){
 const child=spawn(command,args,{cwd:ROOT,env:{...process.env,GBRAIN_SWEEP:'0'},stdio:['ignore','pipe','pipe']});let output='';
 child.stdout.on('data',b=>output=(output+b).slice(-65536));child.stderr.on('data',()=>{});
 const timer=setTimeout(()=>child.kill('SIGKILL'),timeout);
 try{const code=await new Promise((res,rej)=>{child.once('error',rej);child.once('close',res);});
  if(ok)assert.equal(code,0,'Service test subprocess failed (no private diagnostics)');return {code,output};
 }finally{clearTimeout(timer);}
}
const system=(...args)=>run('systemctl',['--user',...args]);
const state=async name=>(await run('systemctl',['--user','is-active',name],{ok:false})).output.trim();
async function waitFor(fn,ms=30000){const end=Date.now()+ms;let last;while(Date.now()<end){try{if(await fn())return;}catch(e){last=e;}await new Promise(r=>setTimeout(r,150));}throw Error('Service state deadline exceeded (no private diagnostics)');}
const recordUnits=()=>{for(const name of names)if(existsSync(join(unitDir,name)))owned.set(name,readFileSync(join(unitDir,name)));};
async function install(extra=[]){if(!extra.includes('--output'))installed=true;try{return await run('python3',['-B',ROOT+'/scripts/install-service.py','--personal','--source',source,...extra]);}finally{recordUnits();}}
try{
 await system('show-environment');
 engine=await connect();await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)',[source]);
 let store=new PersonalMemoryStore({engine,sourceId:source,remote:false,transport:'stdio'});await store.register({agent_id:'fixture'});
 const m=(await store.commit({agent_id:'fixture',event_id:'seed',consent:true,memories:[{type:'preference',content:'SYNTHETIC_SERVICE_MEMORY',provenance:'fixture'}]})).entries[0];
 await store.review({memory_id:m.id,event_id:'activate',expected_revision:1,status:'active'});
 const captured=await store.capture({agent_id:'fixture',event_id:'queued',consent:true,transcript:'合成测试要求：不要使用 Docker Hub。'});
 await engine.disconnect();engine=null;await run(process.execPath,[ROOT+'/src/cli.mjs','db','stop']);
 const review=join(dir,'review');await install(['--output',review]);
 assert.equal(await state('ultrabrain-personal.target'),'inactive');assert.ok(!existsSync(join(review,'ultrabrain-personal-worker.timer')));pass();
 const verify=await run('systemd-analyze',['--user','verify',...readdirSync(review).filter(n=>/\.(service|target|timer)$/.test(n)).map(n=>join(review,n))]);pass();
 await install(['--enable']);
 await waitFor(async()=>(await fetch('http://127.0.0.1:3132/')).ok);pass();
 const token=readFileSync(HOME+'/personal-console-token','utf8').trim();
 const api=async(operation,input={})=>{
  const r=await fetch('http://127.0.0.1:3132/api/call',{method:'POST',headers:{Origin:'http://127.0.0.1:3132','Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({operation,input})});return r.json();
 };
 const result=await api('profile');assert.equal(result.ok,true);assert.equal(result.result.memories[0].id,m.id);pass();
 const noAuth=await fetch('http://127.0.0.1:3132/api/call',{method:'POST',headers:{Origin:'http://127.0.0.1:3132','Content-Type':'application/json'},body:JSON.stringify({operation:'info'})});assert.equal(noAuth.status,401);pass();
 engine=await connect();
 const [queued]=await engine.executeRaw('SELECT state,attempts FROM ultrabrain.personal_consolidations WHERE id=$1',[captured.job_id]);
 assert.equal(queued.state,'queued');assert.equal(queued.attempts,0);assert.equal(calls,0);pass();
 // A real crashing console is restarted by systemd; token and memory are retained.
 const pidBefore=(await system('show','--property=MainPID','--value','ultrabrain-personal-console.service')).output.trim();
 await system('kill','--signal=SIGKILL','--kill-whom=main','ultrabrain-personal-console.service');
 await waitFor(async()=>{const pid=(await system('show','--property=MainPID','--value','ultrabrain-personal-console.service')).output.trim();return pid!=='0'&&pid!==pidBefore&&(await api('info')).ok;});
 assert.equal(readFileSync(HOME+'/personal-console-token','utf8').trim(),token);pass();
 await system('stop','ultrabrain-personal.target');assert.equal(await state('ultrabrain-personal-console.service'),'inactive');assert.equal(await state('ultrabrain-postgres.service'),'active');pass();
 const denied=await run('python3',['-B',ROOT+'/scripts/install-service.py','--personal','--source',source,'--consolidation-interval','30','--output',join(dir,'denied')],{ok:false});
 assert.notEqual(denied.code,0);assert.ok(!existsSync(join(dir,'denied')));pass();
 provider=createServer(async(req,res)=>{
  try{
   let bytes=0;const chunks=[];for await(const c of req){bytes+=c.length;if(bytes>262144)throw Error();chunks.push(c);}
   const body=JSON.parse(Buffer.concat(chunks));assert.ok(JSON.stringify(body.messages).includes('Docker Hub'));calls++;
   if(block)await new Promise(r=>release=r);
   res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({id:'fixture',object:'chat.completion',model:'synthetic-services',choices:[{index:0,message:{role:'assistant',content:JSON.stringify({memories:[{type:'preference',content:'合成偏好：不用 Docker Hub。',quote:'不要使用 Docker Hub'}]})},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));
  }catch{safeError='fixture_failed';res.statusCode=400;res.end('{}');}
 });
 await new Promise(r=>provider.listen(0,'127.0.0.1',r));const endpoint=`http://127.0.0.1:${provider.address().port}/v1`;
 const cfg=JSON.parse(original);cfg.chat_model='ollama:synthetic-services';cfg.provider_base_urls={...cfg.provider_base_urls,ollama:endpoint};
 cfg.ultrabrain_personal_consolidation={enabled:true,model:'ollama:synthetic-services',revision:'service-test',timeout_ms:15000};writeFileSync(configFile,JSON.stringify(cfg)+'\n',{mode:0o600});
 // Credentials file can't accidentally redirect these services to another home.
 writeFileSync(envFile,`OLLAMA_BASE_URL=${endpoint}\nULTRABRAIN_HOME=/not-the-approved-home\n`,{mode:0o600});
 await install(['--replace','--enable','--with-http-mcp','--consolidation-interval','30','--allow-model-call']);
 await waitFor(async()=>(await api('info')).result?.source_id===source);pass();
 await waitFor(async()=>(await fetch('http://127.0.0.1:3131/health')).ok);
 const r=await fetch('http://127.0.0.1:3131/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});assert.equal(r.status,401);pass();
 await waitFor(async()=>{const [j]=await engine.executeRaw('SELECT state FROM ultrabrain.personal_consolidations WHERE id=$1',[captured.job_id]);return j.state==='completed';},90000);
 assert.equal(calls,1);assert.equal(safeError,'');pass();
 store=new PersonalMemoryStore({engine,sourceId:source,remote:false,transport:'stdio'});
 const candidates=await store.search({status:'candidate'});assert.ok(candidates.memories.some(x=>x.derivation));assert.equal((await store.profile()).memories.length,1);pass();
 // Timer and a manual start must refer to ONE worker instance, not duplicate batches.
 await system('stop','ultrabrain-personal-worker.timer');
 await store.capture({agent_id:'fixture',event_id:'second',consent:true,transcript:'合成测试仍要求：不要使用 Docker Hub。'});block=true;
 await system('start','--no-block','ultrabrain-personal-worker.service');await waitFor(()=>calls===2);
 const invocation=(await system('show','--property=InvocationID','--value','ultrabrain-personal-worker.service')).output.trim();
 await system('start','--no-block','ultrabrain-personal-worker.service');
 assert.equal((await system('show','--property=InvocationID','--value','ultrabrain-personal-worker.service')).output.trim(),invocation);assert.equal(calls,2);pass();
 release();block=false;await waitFor(async()=>await state('ultrabrain-personal-worker.service')==='inactive');
 await system('stop','ultrabrain-personal.target');
 for(const name of names.filter(n=>n!=='ultrabrain-postgres.service'))assert.equal(await state(name),'inactive');
 assert.equal(await state('ultrabrain-postgres.service'),'active');pass();
 console.log(JSON.stringify({passed:true,checks,provider_requests:calls,scope:'actual user-systemd, local managed PostgreSQL, console restart and timer; synthetic provider only; no reboot/production deployment certification'}));
}finally{
 release?.();
 if(installed){await run('systemctl',['--user','disable','--now','ultrabrain-personal.target'],{ok:false});await run('systemctl',['--user','stop',...names.filter(n=>n!=='ultrabrain-personal.target')],{ok:false});}
 await engine?.disconnect();
 writeFileSync(configFile,original,{mode:0o600});if(oldEnv===null){if(existsSync(envFile))unlinkSync(envFile);}else writeFileSync(envFile,oldEnv,{mode:0o600});
 if(provider){provider.closeAllConnections();await new Promise(r=>provider.close(r));}
 for(const [name,data]of owned){const path=join(unitDir,name);if(existsSync(path)&&readFileSync(path).equals(data))unlinkSync(path);}
 if(installed)await run('systemctl',['--user','daemon-reload'],{ok:false});
 rmSync(dir,{recursive:true,force:true});
}
