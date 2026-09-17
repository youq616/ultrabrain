/** Actual built Node CLI -> stdio/HTTP MCP -> managed PostgreSQL.
 * Claude stdin events are fixtures, not installed-Claude or real-model validation.
 */
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {spawn} from 'node:child_process';import {once} from 'node:events';
import {createServer} from 'node:net';import {randomBytes,createHash} from 'node:crypto';
import {connect,ROOT} from '../src/runtime.mjs';
import {PersonalMemoryStore} from '../src/personal-memory-store.mjs';
import {connectClient} from '../packages/ultrabrain-client/src/runtime.mjs';
assert.equal(process.env.ULTRABRAIN_TEST_ALLOW_WRITE,'1','Isolated synthetic test installation required');
const engine=await connect(),source='task-'+randomBytes(5).toString('hex'),dir=mkdtempSync(join(tmpdir(),'ub-task-e2e-'));
const workspace=join(dir,'workspace');mkdirSync(workspace,{mode:0o700});
const packageRoot=process.env.ULTRABRAIN_TASK_CLIENT_ROOT??join(ROOT,'packages/ultrabrain-client');
const cli=join(packageRoot,'dist/cli.cjs'),profilePath=join(dir,'profile.json');
let checks=0,httpServer,tokenName;const pass=()=>checks++;
const sha=s=>createHash('sha256').update(s).digest('hex');
const profile={format:1,source,project_id:'alpha',workspace,server:{transport:'stdio',command:process.execPath,args:[ROOT+'/src/cli.mjs','mcp'],env:{ULTRABRAIN_HOME:process.env.ULTRABRAIN_HOME,GBRAIN_SOURCE:source,GBRAIN_SWEEP:'0'}}};
const task='taskneedle QUERY_PRIVATE_MARKER_'+randomBytes(8).toString('hex'),request={task,workspace,consent:true};
const event={hook_event_name:'UserPromptSubmit',session_id:'synthetic-main',cwd:workspace,prompt:task,transcript_path:'/never/read',tool_output:'TOOL_PRIVATE_MARKER'};
const save=(p=profile)=>writeFileSync(profilePath,JSON.stringify(p),{mode:0o600});
async function run(command,input,{swap}={}) {
 const args=[cli,command,'--profile',profilePath];
 if(swap){
  const preload=join(dir,'stdin-boundary.cjs');
  writeFileSync(preload,`const original=process.stdin[Symbol.asyncIterator];process.stdin[Symbol.asyncIterator]=function(...args){process.send({ready:true},()=>process.disconnect());return original.apply(this,args);};`,{mode:0o600});
  args.unshift('--require',preload);
 }
 const p=spawn('node',args,{cwd:ROOT,env:process.env,stdio:swap?['pipe','pipe','pipe','ipc']:['pipe','pipe','pipe']});let out='',err='';
 p.stdout.on('data',b=>{out+=b;if(Buffer.byteLength(out)>100000)p.kill('SIGKILL');});p.stderr.on('data',b=>{err+=b;if(Buffer.byteLength(err)>100000)p.kill('SIGKILL');});p.stdin.on('error',()=>{});
 const ended=new Promise((done,fail)=>{p.once('error',fail);p.once('close',done);}),timer=setTimeout(()=>p.kill('SIGKILL'),35000);
 try{
  if(swap){const ready=new Promise(done=>p.on('message',m=>{if(m?.ready)done();}));await Promise.race([ready,ended.then(()=>{throw Error('Exited before synchronized input');})]);save(swap);}
  p.stdin.end(input===undefined?undefined:JSON.stringify(input));const code=await ended;
  assert.ok(!out.includes('QUERY_PRIVATE_MARKER')&&!err.includes('QUERY_PRIVATE_MARKER'),'Query text exposed in CLI diagnostic');
  assert.ok(!out.includes('TOOL_PRIVATE_MARKER')&&!err.includes('TOOL_PRIVATE_MARKER'),'Tool body exposed');
  return {code,out,data:JSON.parse(out)};
 }finally{clearTimeout(timer);if(p.exitCode===null&&p.signalCode===null){p.kill('SIGKILL');await ended.catch(()=>{});}if(swap)save();}
}
async function snapshot() {
 const values={};
 for(const table of ['personal_memories','agent_registry','personal_consolidations','personal_documents'])
  values[table]=(await engine.executeRaw(`SELECT md5(coalesce(string_agg(row_to_json(t)::text,',' ORDER BY row_to_json(t)::text),'')) AS hash FROM ultrabrain.${table} t WHERE source_id=$1`,[source]))[0].hash;
 return values;
}
try {
 await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)',[source]);
 const store=new PersonalMemoryStore({sourceId:source,engine,remote:false,transport:'stdio'});await store.register({agent_id:'fixture'});
 const [{actor_key:actor}]=await engine.executeRaw('SELECT actor_key FROM ultrabrain.agent_registry WHERE source_id=$1',[source]);assert.match(actor,/^[a-f0-9]{64}$/);
 async function insert(content,{project='alpha',status='active',visibility='private',date='2020-01-01'}={}) {
  return (await engine.executeRaw(`INSERT INTO ultrabrain.personal_memories(source_id,actor_key,type,content,content_hash,importance,source,agent_id,project_id,status,visibility,updated_at)
    VALUES($1,$2,'preference',$3,$4,'normal','synthetic fixture','fixture',$5,$6,$7,$8) RETURNING id::text`,[source,actor,content,sha(content),project,status,visibility,date]))[0].id;
 }
 const target=await insert('taskneedle 不要删除部署配置。');
 for(let n=0;n<105;n++)await insert('routine preference '+n,{date:new Date(Date.UTC(2026,0,1,0,0,n))});
 const otherProject=await insert('taskneedle different-project SECRET_OTHER_PROJECT',{project:'beta'});
 const candidate=await insert('taskneedle SECRET_CANDIDATE',{status:'candidate'});
 const archived=await insert('taskneedle SECRET_ARCHIVED',{status:'archived'});
 const shared=await insert('sharedneedle approved source rule',{project:null,visibility:'source'});
 save();let r=await run('probe');assert.equal(r.code,0);Object.assign(profile,{expected_instance:r.data.identity.instance_id,expected_actor:r.data.identity.actor_key});save();pass();
 const original=await snapshot();
 r=await run('task-context',request);assert.equal(r.data.error,'task_context_disabled');pass();
 Object.assign(profile,{allow_task_context:true});save();
 r=await run('context');assert.equal(r.code,0);assert.ok(!r.data.memories.some(m=>m.id===target));pass();
 r=await run('task-context',request);assert.equal(r.code,0);assert.equal(r.data.memories[0].id,target);assert.ok(Buffer.byteLength(r.out.trim())<=6000);pass();
 assert.ok(!r.data.memories.some(m=>[otherProject,candidate,archived].includes(m.id)));pass();
 r=await run('task-context',{...request,task:"taskneedle '; DROP TABLE ultrabrain.personal_memories; --"});assert.equal(r.code,0);assert.equal(r.data.memories[0].id,target);pass();
 for(const p of [{...request,consent:false},{...request,workspace:dir},{...request,task:'x'.repeat(4097)},{...request,task:'\ud800'},{...request,project_id:'beta'}]){r=await run('task-context',p);assert.equal(r.code,1);assert.ok(!r.out.includes('不要删除'));}pass();
 r=await run('claude-task-hook',event);assert.match(r.data.systemMessage,/task_context_disabled/);pass();
 profile.automatic_task_context=['claude-user'];save();
 r=await run('claude-task-hook',event);assert.equal(r.code,0);assert.equal(JSON.parse(r.data.hookSpecificOutput.additionalContext).memories[0].id,target);pass();
 // Legacy read Hook still sends no task, even when the NEW scope is present in the profile.
 r=await run('claude-hook',event);assert.ok(!JSON.parse(r.data.hookSpecificOutput.additionalContext).memories.some(m=>m.id===target));pass();
 for(const patch of [{agent_id:'child'},{hook_event_name:'SessionStart'},{cwd:dir},{session_id:undefined}]){r=await run('claude-task-hook',{...event,...patch});assert.ok(r.data.systemMessage);assert.ok(!r.out.includes('不要删除'));}pass();
 for(const command of ['task-context','claude-task-hook']) {
  for(const swap of [{...profile,project_id:'beta'},{...profile,allow_task_context:false,automatic_task_context:[]},
    {...profile,server:{transport:'stdio',command:'this-must-not-run',args:[]}}]) {
   r=await run(command,command==='task-context'?request:event,{swap});
   assert.ok((r.data.error??r.data.systemMessage).includes('task_context_disabled'),'Original authority not preserved at stdin wait');
  }
 }pass();
 // Real runtime last-mile assertion: identity may finish, but revoked task must not be sent.
 const c=await connectClient(profile);let permitted=0;
 try{await assert.rejects(c.taskContext(request,{authorize:()=>++permitted<2}),{code:'task_context_disabled'});}finally{await c.close();}pass();
 save({...profile,expected_actor:'0'.repeat(64)});r=await run('task-context',request);assert.equal(r.data.error,'identity_mismatch');save();pass();
 profile.budget_bytes=700;save();r=await run('task-context',request);assert.equal(r.code,0);assert.ok(Buffer.byteLength(r.out.trim())<=700);delete profile.budget_bytes;save();pass();
 assert.deepEqual(await snapshot(),original,'Task reads must not save memories, jobs, documents or mutate Agent registration');pass();
 // Read-only token on real HTTP: source-shared context only, private text never crosses principals.
 const free=createServer();free.listen(0,'127.0.0.1');await once(free,'listening');const port=free.address().port;await new Promise(r=>free.close(r));
 tokenName=source+'-reader';const secret='gbrain_'+randomBytes(32).toString('hex');
 await engine.executeRaw('INSERT INTO access_tokens(name,token_hash,scopes,permissions) VALUES($1,$2,$3::text[],$4::text::jsonb)',[tokenName,sha(secret),'{read}',JSON.stringify({source_id:source,takes_holders:['world']})]);
 httpServer=spawn(process.execPath,[ROOT+'/src/cli.mjs','mcp','--http','--bind','127.0.0.1','--port',String(port),'--suppress-bootstrap-token'],
  {cwd:ROOT,env:{...process.env,GBRAIN_SWEEP:'0',GBRAIN_ADMIN_BOOTSTRAP_TOKEN:randomBytes(32).toString('hex')},stdio:['ignore','ignore','pipe']});httpServer.stderr.on('data',()=>{});
 let ready=false;for(let n=0;n<100;n++){try{ready=(await fetch(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.timeout(300)})).ok;}catch{}if(ready)break;await new Promise(r=>setTimeout(r,100));}assert.ok(ready);
 process.env.ULTRABRAIN_TASK_TEST_TOKEN=secret;
 const hp={format:1,source,workspace,project_id:'alpha',server:{transport:'http',url:`http://127.0.0.1:${port}/mcp`,bearer_env:'ULTRABRAIN_TASK_TEST_TOKEN'}};
 save(hp);r=await run('probe');assert.equal(r.code,0);assert.notEqual(r.data.identity.actor_key,actor);
 Object.assign(hp,{allow_task_context:true,expected_instance:r.data.identity.instance_id,expected_actor:r.data.identity.actor_key});save(hp);
 r=await run('task-context',{...request,task:'sharedneedle QUERY_PRIVATE_MARKER_HTTP'});assert.equal(r.code,0);assert.deepEqual(r.data.memories.map(m=>m.id),[shared]);assert.ok(!r.out.includes(secret));pass();
 await engine.executeRaw('UPDATE access_tokens SET revoked_at=now() WHERE name=$1',[tokenName]);r=await run('task-context',request);assert.equal(r.code,1);assert.ok(!r.out.includes(secret));pass();
 assert.deepEqual(await snapshot(),original);pass();
 console.log(`PASS ${checks} task recall integrations: packaged Node CLI/Claude event fixtures, stdio+read-only HTTP, real PostgreSQL ranking and identity, no memory writes`);
}finally {
 delete process.env.ULTRABRAIN_TASK_TEST_TOKEN;
 if(httpServer&&httpServer.exitCode===null&&httpServer.signalCode===null){httpServer.kill('SIGTERM');const timer=setTimeout(()=>httpServer.kill('SIGKILL'),5000);await once(httpServer,'close');clearTimeout(timer);}
 if(tokenName)await engine.executeRaw('DELETE FROM access_tokens WHERE name=$1',[tokenName]);
 await engine.disconnect();rmSync(dir,{recursive:true,force:true});
}
