/** Disposable GitHub-hosted runner only: actual user-systemd, PostgreSQL and loopback model.
 * No user deployment, paid model or test-double systemd process is certified here.
 */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,lstatSync,existsSync,unlinkSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {createServer} from 'node:http';
import {createServer as netServer} from 'node:net';
import {randomBytes,createHash} from 'node:crypto';
import {connect,ROOT,HOME} from '../src/runtime.mjs';
import {PersonalMemoryStore} from '../src/personal-memory-store.mjs';
import {PersonalConsolidator} from '../src/personal-consolidation.mjs';
if(process.env.GITHUB_ACTIONS!=='true'||process.env.ULTRABRAIN_TEST_ALLOW_WRITE!=='1'||process.env.ULTRABRAIN_SYSTEMD_TEST!=='1'||
   typeof process.getuid!=='function'||process.getuid()===0||HOME!==join(homedir(),'ultrabrain-personal-services-test'))
  throw Error('Only the explicitly authorized disposable CI installation may run this test');
const names=['ultrabrain-personal.target','ultrabrain-personal-console.service','ultrabrain-personal-worker.service','ultrabrain-postgres.service'];
const [target,consoleUnit,worker,db]=names;
const privateDir=mkdtempSync(join(homedir(),'.ub-service-verification-'));
const linked=[],unitDir=join(homedir(),'.config/systemd/user');
let engine,provider,original,configFile,checks=0,calls=0;
const pass=()=>checks++;
const sha=b=>createHash('sha256').update(b).digest('hex');
async function run(command,args,{ok=true,timeout=120000}={}){
 const p=spawn(command,args,{env:process.env,cwd:ROOT,stdio:['ignore','pipe','pipe']});let text='',bytes=0,overflow=false;
 p.stdout.on('data',b=>{bytes+=b.length;if(bytes>131072){overflow=true;p.kill('SIGKILL');}else text+=b;});
 p.stderr.on('data',()=>{}); // No raw native output or private config in public CI logs.
 const timer=setTimeout(()=>p.kill('SIGKILL'),timeout);
 try{const code=await new Promise((resolve,reject)=>{p.once('error',reject);p.once('close',resolve);});
  assert.equal(overflow,false,'Bounded subprocess output exceeded');if(ok)assert.equal(code,0,'CI subprocess failed: '+command+' '+args[0]);return {code,text};}
 finally{clearTimeout(timer);}
}
const ctl=(...args)=>run('systemctl',['--user',...args]);
async function property(unit,key){return (await ctl('show',unit,'--property='+key,'--value')).text.trim();}
async function until(fn,label,timeout=15000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,250));}throw Error('Timed out: '+label);}
async function render(dir,workerEnabled,source,port){
 const args=[ROOT+'/scripts/personal-services.py','--bun',process.execPath,'--source',source,'--port',String(port),
  ...(workerEnabled?['--worker','--allow-model-call','--interval','30']:[])];
 const p=JSON.parse((await run('python3',['-B',...args])).text).result;
 assert.equal(p.services_started,false);assert.equal(p.worker_enabled_in_plan,workerEnabled);
 await run('python3',['-B',...args,'--output',dir,'--expected-plan',p.plan_sha256]);
 await run('python3',['-B',...args,'--verify',dir,'--expected-plan',p.plan_sha256]);
 return p;
}
async function link(file){
 const name=file.split('/').at(-1),path=join(unitDir,name);
 if(existsSync(path))throw Error('Never replace an existing CI unit');
 await ctl('link',file);assert.equal(lstatSync(path).isSymbolicLink(),true);linked.push({name,path,file});
}
async function unlinkOwned(name){
 const index=linked.findIndex(x=>x.name===name);if(index<0)return;
 const x=linked[index];const {readlinkSync}=await import('node:fs');
 assert.equal(lstatSync(x.path).isSymbolicLink(),true);assert.equal(readlinkSync(x.path),x.file);
 unlinkSync(x.path);linked.splice(index,1);
}
try{
 for(const n of names){assert.equal(await property(n,'LoadState'),'not-found','Existing service makes test unsafe');}
 engine=await connect();const source='services-'+randomBytes(4).toString('hex');
 await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)',[source]);
 const store=new PersonalMemoryStore({sourceId:source,engine,remote:false,transport:'stdio'});await store.register({agent_id:'service-fixture'});
 const job=await store.capture({agent_id:'service-fixture',event_id:'one',consent:true,transcript:'Synthetic service rule: do not erase source evidence.'});
 const status=async id=>(await new PersonalConsolidator(store.ctx).status({job_id:id})).jobs[0];
 configFile=HOME+'/gbrain/.gbrain/config.json';original=readFileSync(configFile);
 const disabled={...JSON.parse(original),ultrabrain_personal_consolidation:{enabled:false}};
 writeFileSync(configFile,JSON.stringify(disabled)+'\n',{mode:0o600});
 const socket=netServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
 const url='http://127.0.0.1:'+port;
 const ready=async()=>{try{return (await fetch(url,{signal:AbortSignal.timeout(1000)})).ok;}catch{return false;}};
 const minimal=join(privateDir,'read-only');await render(minimal,false,source,port);
 assert.equal(await property(consoleUnit,'LoadState'),'not-found');assert.equal((await status(job.job_id)).attempts,0);pass();
 const base=join(privateDir,'database');await run('python3',[ROOT+'/scripts/install-service.py','--output',base]);
 await link(join(base,db));await link(join(minimal,target));await link(join(minimal,consoleUnit));await ctl('daemon-reload');
 await ctl('start',target);await until(ready,'console HTTP');assert.equal(await property(worker,'LoadState'),'not-found');pass();
 const token=readFileSync(HOME+'/personal-console-token','utf8').trim();
 const response=await fetch(url+'/api/call',{method:'POST',headers:{Origin:url,'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({operation:'info'})});
 assert.equal(response.status,200);assert.equal((await response.json()).result.source_id,source);pass();
 assert.equal((await fetch(url+'/api/call',{method:'POST',headers:{Origin:url,'Content-Type':'application/json'},body:'{"operation":"info"}'})).status,401);pass();
 await ctl('stop',target);await until(async()=>!await ready(),'console stopped');
 assert.equal(await property(db,'ActiveState'),'active');assert.equal((await status(job.job_id)).attempts,0);pass();
 await unlinkOwned(target);await unlinkOwned(consoleUnit);await ctl('daemon-reload');
 const automated=join(privateDir,'explicit-worker');await render(automated,true,source,port);
 for(const n of [target,consoleUnit,worker])await link(join(automated,n));await ctl('daemon-reload');await ctl('start',target);
 await until(async()=>await property(worker,'ActiveState')==='failed','needs_model stops worker');
 assert.equal(await property(worker,'ExecMainStatus'),'2');assert.equal(await property(worker,'NRestarts'),'0');
 assert.equal((await status(job.job_id)).attempts,0);pass();
 provider=createServer(async(req,res)=>{try{
  let body='';for await(const b of req){body+=b;if(body.length>131072)throw Error();}const p=JSON.parse(body);calls++;
  assert.ok(JSON.stringify(p.messages).includes('do not erase source evidence'));
  assert.ok(!p.tools);assert.equal(p.model,'ultrabrain-fixture');
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:'synthetic',object:'chat.completion',created:1,model:p.model,
   choices:[{index:0,message:{role:'assistant',content:JSON.stringify({memories:[{type:'preference',content:'Do not erase source evidence.',quote:'do not erase source evidence'}]})},finish_reason:'stop'}],usage:{prompt_tokens:30,completion_tokens:20,total_tokens:50}}));
 }catch{res.statusCode=400;res.end('{}');}});
 await new Promise(r=>provider.listen(0,'127.0.0.1',r));const endpoint='http://127.0.0.1:'+provider.address().port+'/v1';
 const enabled={...disabled,chat_model:'ollama:ultrabrain-fixture',provider_base_urls:{ollama:endpoint},
  ultrabrain_personal_consolidation:{enabled:true,model:'ollama:ultrabrain-fixture',revision:'service-test',timeout_ms:5000}};
 writeFileSync(configFile,JSON.stringify(enabled)+'\n',{mode:0o600});
 await ctl('reset-failed',worker);await ctl('start',worker);
 await until(async()=> (await status(job.job_id)).state==='completed','first queued observation');assert.equal(calls,1);pass();
 const candidate=(await status(job.job_id)).result.entries[0];
 const memory=(await store.search({status:'candidate'})).memories.find(r=>r.id===candidate.id);
 assert.equal(memory.status,'candidate');assert.equal(memory.visibility,'private');assert.equal(memory.derivation.quote,'do not erase source evidence');pass();
 const second=await store.capture({agent_id:'service-fixture',event_id:'two',consent:true,transcript:'Second synthetic rule: do not erase source evidence.'});
 await until(async()=> (await status(second.job_id)).state==='completed','periodic next batch',50000);assert.equal(calls,2);pass();
 const prior=await property(consoleUnit,'MainPID');await ctl('kill','--kill-who=main','--signal=SIGKILL',consoleUnit);
 await until(async()=>{const pid=await property(consoleUnit,'MainPID');return pid!=='0'&&pid!==prior&&await ready();},'console automatic restart',45000);
 assert.equal(await property(consoleUnit,'NRestarts'),'1');pass();
 await ctl('stop',target);await until(async()=>await property(worker,'ActiveState')==='inactive','worker graceful shutdown');
 assert.equal(await property(consoleUnit,'ActiveState'),'inactive');assert.equal(await property(db,'ActiveState'),'active');pass();
 assert.equal((await store.profile()).memories.length,0);assert.equal(calls,2);pass();
 console.log(JSON.stringify({passed:true,checks,scope:'actual disposable user-systemd, real PostgreSQL and synthetic provider; no live user deployment',model_calls_to_local_fixture:calls}));
}finally{
 for(const n of [target,worker,consoleUnit]){try{if(linked.some(x=>x.name===n))await ctl('stop',n);}catch{}}
 if(configFile&&original)writeFileSync(configFile,original,{mode:0o600});
 try{await engine?.disconnect();}catch{}
 try{if(linked.some(x=>x.name===db))await ctl('stop',db);}catch{}
 for(const n of names)try{await unlinkOwned(n);}catch{}
 try{await ctl('daemon-reload');}catch{}
 if(provider)await new Promise(r=>provider.close(r));
 rmSync(privateDir,{recursive:true,force:true});
}
