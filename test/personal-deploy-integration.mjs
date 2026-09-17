/** Actual user-systemd on the explicitly authorized disposable CI installation. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,readlinkSync,readdirSync,lstatSync,existsSync,unlinkSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {createServer} from 'node:net';
import {randomBytes,createHash} from 'node:crypto';
import {requireMissingUnit} from './personal-services-harness.mjs';
import {connect,ROOT,HOME} from '../src/runtime.mjs';

if(process.env.GITHUB_ACTIONS!=='true'||process.env.ULTRABRAIN_TEST_ALLOW_WRITE!=='1'||process.env.ULTRABRAIN_SYSTEMD_TEST!=='1'||
   typeof process.getuid!=='function'||process.getuid()===0||HOME!==join(homedir(),'ultrabrain-personal-services-test'))
  throw Error('Only the explicitly authorized disposable CI installation may run this test');
const units=['ultrabrain-personal.target','ultrabrain-personal-console.service','ultrabrain-personal-worker.service'];
const [target,consoleUnit,worker]=units,db='ultrabrain-postgres.service';
const privateDir=mkdtempSync(join(homedir(),'.ub-deploy-verification-')),unitDir=join(homedir(),'.config/systemd/user');
let engine,dbLink,dbBytes,dbIdentity,originalUnits,current=null,owned=new Map(),checks=0,complete=false,primaryError;
const fragmentPathForms=new Set();
const pass=()=>checks++,sha=value=>createHash('sha256').update(value).digest('hex');
async function run(command,args,{ok=true,timeout=120000}={}){
 const p=spawn(command,args,{env:process.env,cwd:ROOT,stdio:['ignore','pipe','pipe']});let text='',size=0,overflow=false;
 p.stdout.on('data',b=>{size+=b.length;if(size>262144){overflow=true;p.kill('SIGKILL');}else text+=b;});
 p.stderr.on('data',()=>{});
 const timer=setTimeout(()=>p.kill('SIGKILL'),timeout);
 try{const code=await new Promise((resolve,reject)=>{p.once('error',reject);p.once('close',resolve);});
  assert.equal(overflow,false,'Bounded subprocess output exceeded');if(ok)assert.equal(code,0,'CI subprocess failed: '+command+' '+args[0]);return {code,text};}
 finally{clearTimeout(timer);}
}
const ctl=(...args)=>run('/usr/bin/systemctl',['--user','--no-pager','--no-ask-password',...args]);
const call=(args,options)=>run(process.execPath,[ROOT+'/src/cli.mjs','personal-deploy',...args],options);
async function deploy(args){const r=await call(args,{ok:false}),v=JSON.parse(r.text);
 const code=typeof v.error==='string'&&/^[a-z][a-z_]{0,79}$/.test(v.error)?v.error:'unclassified_failure';
 assert.equal(r.code,0,`Deployment ${args[0]} failed after ${checks} checks: ${code}`);assert.equal(v.ok,true);return v.result;}
async function status(){return deploy(['status','--home',HOME]);}
async function missing(unit){requireMissingUnit(await run('/usr/bin/systemctl',['--user','show',unit,
 '--property=LoadState,ActiveState,FragmentPath','--no-pager'],{ok:false}));}
async function property(unit,key){return (await ctl('show',unit,'--property='+key,'--value')).text.trim();}
async function failureObservation(){
 // Only fixed unit properties from this disposable fixture; no environment,
 // tokens, configuration contents, or raw service journal enter CI output.
 const keys=['Id','Names','LoadState','ActiveState','SubState','FragmentPath','DropInPaths','NeedDaemonReload','Job'];
 const result=await run('/usr/bin/systemctl',['--user','--no-pager','--all','show',
  '--property='+keys.join(','),'--',...units],{ok:false,timeout:10000});
 const rows=result.text.trim().split(/\n\n+/).map(block=>Object.fromEntries(block.split('\n').map(line=>{
  const at=line.indexOf('=');return [line.slice(0,at),line.slice(at+1)];
 }).filter(([key,value])=>keys.includes(key)&&value.length<=2048&&!/[\x00-\x1f\x7f]/.test(value))));
 console.log(JSON.stringify({deployment_failure_after_checks:checks,manager_observation:rows}));
}
function recordOwned(paths){assert.deepEqual(Object.keys(paths).sort(),[...units].sort());
 owned=new Map(units.filter(n=>{if(paths[n]===null){assert.equal(existsSync(join(unitDir,n)),false);return false;}return true;}).map(n=>{
 const file=join(unitDir,n),stat=lstatSync(file),link=readlinkSync(file);
 assert.equal(stat.isSymbolicLink(),true);assert.equal(link,paths[n]);assert.ok(link.startsWith(HOME+'/personal-deployment/generations/'));
 return [n,{link,ino:stat.ino,dev:stat.dev}];}));}
function ownsLinks(){return units.every(n=>{const file=join(unitDir,n),saved=owned.get(n);
 try{const st=lstatSync(file);return !!saved&&st.isSymbolicLink()&&st.ino===saved.ino&&st.dev===saved.dev&&readlinkSync(file)===saved.link;}
 catch(e){if(e.code==='ENOENT')return !saved;throw e;}});}
function ownsDatabase(){const st=lstatSync(join(unitDir,db));return !!dbIdentity&&st.isSymbolicLink()
 &&st.dev===dbIdentity.dev&&st.ino===dbIdentity.ino&&readlinkSync(join(unitDir,db))===dbLink&&sha(readFileSync(dbLink))===dbBytes;}
function unrelatedUnits(relative=''){
 const result=[];for(const name of readdirSync(join(unitDir,relative)).sort()){
  if(!relative&&units.includes(name))continue;const path=join(relative,name),file=join(unitDir,path),st=lstatSync(file);
  if(!relative&&/^\.ultrabrain-personal-deploy-[a-f0-9]{32}$/.test(name)){
   assert.equal(st.isDirectory(),true);assert.equal(st.uid,process.getuid());assert.equal(st.mode&0o777,0o700);continue;}
  if(st.isSymbolicLink())result.push([path,'link',readlinkSync(file)]);
  else if(st.isDirectory())result.push([path,'directory',st.mode],...unrelatedUnits(path));
  else{assert.equal(st.isFile(),true);assert.ok(st.size<262144);result.push([path,'file',st.mode,sha(readFileSync(file))]);}
 }return result;
}
async function port(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function until(fn,label){const end=Date.now()+15000;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,250));}throw Error('Timed out: '+label);}
async function verifyStopped(spec){
 for(const name of units){if(name===worker&&!spec.worker){await missing(name);continue;}
  assert.equal(await property(name,'ActiveState'),'inactive');assert.equal(await property(name,'Job'),'');
  assert.equal(await property(name,'DropInPaths'),'');
  const fragment=await property(name,'FragmentPath'),installed=join(unitDir,name),generation=readlinkSync(installed);
  assert.ok(fragment===installed||fragment===generation,'Manager fragment must name the verified installed link or its generation');
  fragmentPathForms.add(fragment===installed?'installed-link':'generation');}
 assert.equal(readlinkSync(join(unitDir,db)),dbLink);assert.equal(sha(readFileSync(dbLink)),dbBytes);
 // Preserve every unrelated file/dependency directory, including all enablement links.
 assert.deepEqual(unrelatedUnits(),originalUnits);
}
async function verifyHTTP(spec){
 const url='http://127.0.0.1:'+spec.port;await ctl('start',target);
 await until(async()=>{try{return (await fetch(url,{signal:AbortSignal.timeout(1000)})).ok;}catch{return false;}},'console HTTP');
 const token=readFileSync(HOME+'/personal-console-token','utf8').trim();
 const response=await fetch(url+'/api/call',{method:'POST',signal:AbortSignal.timeout(5000),
  headers:{Origin:url,'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({operation:'info'})});
 assert.equal(response.status,200);assert.equal((await response.json()).result.source_id,spec.source);
 const anonymous=await fetch(url+'/api/call',{method:'POST',signal:AbortSignal.timeout(5000),
  headers:{Origin:url,'Content-Type':'application/json'},body:'{"operation":"info"}'});assert.equal(anonymous.status,401);
}
async function stop(){
 await ctl('stop',target);
 // The target's completed stop job can precede its PartOf service's final
 // transition out of deactivating. Keep the deployer's strict stopped guard.
 await until(async()=>{for(const n of [target,consoleUnit]){
  if(await property(n,'ActiveState')!=='inactive'||await property(n,'Job')!=='')return false;
 }return true;},'personal target and console fully stopped');
}
async function exported(name,workerEnabled=false){
 const spec={dir:join(privateDir,name),source:'deploy-'+randomBytes(5).toString('hex'),port:await port(),worker:workerEnabled};
 await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)',[spec.source]);
 spec.options=['--home',HOME,'--bun',process.execPath,'--source',spec.source,'--port',String(spec.port),
  ...(workerEnabled?['--worker','--allow-model-call','--interval','30']:[])];
 const generator=ROOT+'/scripts/personal-services.py';
 const plan=JSON.parse((await run('python3',['-I','-B',generator,...spec.options])).text).result;
 spec.plan=plan.plan_sha256;
 await run('python3',['-I','-B',generator,...spec.options,'--output',spec.dir,'--expected-plan',spec.plan]);
 spec.args=['--export',spec.dir,'--expected-plan',spec.plan,...spec.options];return spec;
}
async function reviewed(spec){return deploy(['plan',...spec.args]);}
async function apply(spec,plan=undefined){plan??=await reviewed(spec);const r=await deploy(['apply',...spec.args,'--expected-deployment',plan.deployment_sha256]);
 assert.match(r.current_sha256,/^[a-f0-9]{64}$/);current=r.current_sha256;recordOwned(r.unit_paths);return current;}
async function rollback(){const r=await deploy(['rollback','--home',HOME,'--expected-current',current]);current=r.current_sha256;recordOwned(r.unit_paths);return current;}

try{
 for(const n of [...units,db])await missing(n);
 assert.equal(existsSync(HOME+'/personal-deployment'),false,'No prior deployment fixture may be adopted');
 mkdirSync(unitDir,{recursive:true,mode:0o700});
 const base=join(privateDir,'database');await run('python3',[ROOT+'/scripts/install-service.py','--output',base]);
 dbLink=join(base,db);dbBytes=sha(readFileSync(dbLink));
 try{await ctl('link',dbLink);}finally{if(existsSync(join(unitDir,db))&&lstatSync(join(unitDir,db)).isSymbolicLink()
  &&readlinkSync(join(unitDir,db))===dbLink)dbIdentity=lstatSync(join(unitDir,db));}
 assert.equal(ownsDatabase(),true);
 originalUnits=unrelatedUnits();
 await ctl('daemon-reload');await ctl('start',db);engine=await connect();
 const originalConfig=sha(readFileSync(HOME+'/gbrain/.gbrain/config.json'));
 const a=await exported('a'),b=await exported('b'),c=await exported('c-worker',true);
 const before=await status();assert.equal(before.current_sha256,null);assert.equal(before.pending_sha256,null);pass();
 const aid=await apply(a);await verifyStopped(a);pass();
 const savedContent=readFileSync(readlinkSync(join(unitDir,consoleUnit)));
 rmSync(a.dir,{recursive:true});assert.deepEqual(readFileSync(readlinkSync(join(unitDir,consoleUnit))),savedContent);pass();
 const bplan=await reviewed(b);await verifyHTTP(a);pass();
 const refused=await call(['apply',...b.args,'--expected-deployment',bplan.deployment_sha256],{ok:false});
 assert.notEqual(refused.code,0);assert.equal(JSON.parse(refused.text).ok,false);assert.equal((await status()).current_sha256,aid);
 assert.equal(ownsLinks(),true);pass();await stop();
 const crashPlan=await reviewed(b);
 const interrupted=await run('python3',['-I','-B',ROOT+'/test/personal-deploy-crash.py',
  'apply','--expected-deployment',crashPlan.deployment_sha256,...b.args],{ok:false});
 assert.equal(interrupted.code,73,'The fixture must interrupt the actual transaction after a durable link change');
 const pending=await status();assert.match(pending.pending_sha256,/^[a-f0-9]{64}$/);pass();
 const recovered=await deploy(['recover','--home',HOME,'--expected-pending',pending.pending_sha256]);
 assert.equal(recovered.current_sha256,aid);assert.equal(recovered.pending_sha256,null);current=aid;recordOwned(recovered.unit_paths);
 await verifyStopped(a);await verifyHTTP(a);await stop();pass();
 // A second crash during recovery must not leave the newer parsed config in
 // systemd merely because the restored link pathname is unchanged.
 const cachedPlan=await reviewed(b);
 const afterReload=await run('python3',['-I','-B',ROOT+'/test/personal-deploy-crash.py','apply',
  '--checkpoint','after_reload','--expected-deployment',cachedPlan.deployment_sha256,...b.args],{ok:false});
 assert.equal(afterReload.code,73);const cachedPending=await status();
 assert.ok((await property(consoleUnit,'ExecStart')).includes(b.source));
 const restoreCrash=await run('python3',['-I','-B',ROOT+'/test/personal-deploy-crash.py','recover',
  '--home',HOME,'--expected-pending',cachedPending.pending_sha256],{ok:false});
 assert.equal(restoreCrash.code,73);const restoredPending=await status();
 assert.equal(restoredPending.current_sha256,aid);assert.equal(restoredPending.pending_sha256,cachedPending.pending_sha256);
 assert.ok((await property(consoleUnit,'ExecStart')).includes(b.source),'The actual manager still caches the newer source before recovery reload');pass();
 const recoveredAgain=await deploy(['recover','--home',HOME,'--expected-pending',restoredPending.pending_sha256]);
 assert.equal(recoveredAgain.current_sha256,aid);assert.equal(recoveredAgain.pending_sha256,null);
 assert.equal(recoveredAgain.configuration_changed,false);recordOwned(recoveredAgain.unit_paths);
 assert.ok((await property(consoleUnit,'ExecStart')).includes(a.source),'Recovery must replace the actual cached source even when no links changed');
 await verifyStopped(a);await verifyHTTP(a);await stop();pass();
 const bid=await apply(b);assert.notEqual(bid,aid);await verifyStopped(b);await verifyHTTP(b);await stop();pass();
 const cid=await apply(c);assert.notEqual(cid,bid);await verifyStopped(c);pass();
 assert.equal(await rollback(),bid);await verifyStopped(b);await missing(worker);pass();
 assert.equal(await rollback(),aid);await verifyStopped(a);await verifyHTTP(a);await stop();pass();
 assert.equal(await rollback(),null);for(const n of units)await missing(n);pass();
 assert.equal((await status()).pending_sha256,null);assert.equal(sha(readFileSync(HOME+'/gbrain/.gbrain/config.json')),originalConfig);
 assert.equal(await property(db,'ActiveState'),'active');assert.equal(readlinkSync(join(unitDir,db)),dbLink);pass();complete=true;
}catch(error){primaryError=error;try{await failureObservation();}catch{console.log(JSON.stringify({manager_observation:'unavailable'}));}}finally{
 // On failure retain private evidence unless every remaining link is provably ours.
 const cleanupErrors=[];
 const attempt=async operation=>{try{await operation();}catch(error){cleanupErrors.push(error);}};
 await attempt(async()=>{
  if(!ownsLinks())throw Error('Fixture unit identity changed; preserve deployment evidence');
  if(owned.size){await stop();for(let i=0;i<4&&current;i++)await rollback();assert.equal(current,null);}
 });
 await attempt(async()=>{if(engine)await engine.disconnect();});
 await attempt(async()=>{if(dbIdentity){assert.equal(ownsDatabase(),true,'Database fixture identity changed');
  await ctl('stop',db);assert.equal(ownsDatabase(),true);unlinkSync(join(unitDir,db));}});
 await attempt(()=>ctl('daemon-reload'));
 if(!cleanupErrors.length&&complete)rmSync(privateDir,{recursive:true});
 if(cleanupErrors.length)throw new AggregateError([...(primaryError?[primaryError]:[]),...cleanupErrors],
  'Deployment fixture cleanup failed; private evidence retained');
}
if(primaryError)throw primaryError;
console.log(JSON.stringify({ok:true,checks,systemd:'actual-user-manager',postgresql:'actual',http:'authenticated-local-console',
 interruption:'actual-process-exit-and-cli-recovery',repeated_recovery:'actual-stale-manager-cache-reloaded',
 fragment_path_forms:[...fragmentPathForms].sort(),model_calls:0,user_host_deployed:false}));
