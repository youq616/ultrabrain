/** Actual packaged Node CLI/proxy -> native MCP -> managed PostgreSQL. No Agent model. */
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {randomBytes,createHash} from 'node:crypto';
import {connect,ROOT} from '../src/runtime.mjs';
import {PersonalMemoryStore} from '../src/personal-memory-store.mjs';
import {Client} from '../vendor/gbrain/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import {StdioClientTransport} from '../vendor/gbrain/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
assert.equal(process.env.ULTRABRAIN_TEST_ALLOW_WRITE,'1');
const engine=await connect(),source='kit-'+randomBytes(5).toString('hex'),dir=mkdtempSync(join(tmpdir(),'ub-client-kit-'));
const cli=join(ROOT,'packages/ultrabrain-client/dist/cli.cjs'),profilePath=join(dir,'profile.json');let httpServer,httpTokenName;let checks=0;const pass=()=>checks++;
const profile={format:1,source,workspace:ROOT,server:{transport:'stdio',command:process.execPath,args:[join(ROOT,'src/cli.mjs'),'mcp'],env:{ULTRABRAIN_HOME:process.env.ULTRABRAIN_HOME,GBRAIN_SOURCE:source,GBRAIN_SWEEP:'0'}}};
function save(p=profile){writeFileSync(profilePath,JSON.stringify(p),{mode:0o600});}
async function run(command,input){const child=spawn('node',[cli,command,'--profile',profilePath],{cwd:ROOT,env:process.env,stdio:['pipe','pipe','pipe']});
 let out='',err='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);child.stdin.end(input===undefined?undefined:JSON.stringify(input));
 const timer=setTimeout(()=>child.kill('SIGKILL'),40000);const [code]=await once(child,'close');clearTimeout(timer);return {code,out,err,json:out?JSON.parse(out):null};}
async function withProxy(fn){const c=new Client({name:'independent-standard-mcp-fixture',version:'1'});const t=new StdioClientTransport({command:'node',args:[cli,'mcp','--profile',profilePath],stderr:'pipe'});t.stderr?.on('data',()=>{});try{await c.connect(t);await fn(c);}finally{await c.close();}}
try{
 await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)',[source]);
 const store=new PersonalMemoryStore({sourceId:source,engine,remote:false,transport:'stdio'});
 await store.register({agent_id:'fixture'});
 const entry=(await store.commit({agent_id:'fixture',event_id:'seed',consent:true,memories:[{type:'preference',content:'SYNTHETIC_PRIVATE_CONTEXT_KEEP_NEGATION',provenance:'integration fixture'}]})).entries[0];
 await store.review({memory_id:entry.id,expected_revision:1,event_id:'activate',status:'active'});save();
 let r=await run('probe');assert.equal(r.code,0,r.out+' '+r.err);assert.equal(r.json.visible_active_memories,1);assert.ok(!r.out.includes('SYNTHETIC_PRIVATE_CONTEXT'));pass();
 const id=r.json.identity;
 r=await run('claude-hook',{hook_event_name:'SessionStart',cwd:ROOT,transcript_path:'/must-not-read',prompt:'MUST_NOT_BE_CAPTURED'});
 assert.equal(r.code,0);assert.match(r.json.hookSpecificOutput.additionalContext,/SYNTHETIC_PRIVATE_CONTEXT/);assert.ok(!r.out.includes('MUST_NOT_BE_CAPTURED'));pass();
 r=await run('claude-hook',{hook_event_name:'UserPromptSubmit',cwd:ROOT});assert.equal(r.json.hookSpecificOutput.hookEventName,'UserPromptSubmit');pass();
 r=await run('claude-hook',{hook_event_name:'SessionStart',cwd:dir});assert.match(r.json.systemMessage,/workspace_mismatch/);assert.ok(!r.out.includes('SYNTHETIC_PRIVATE_CONTEXT'));pass();
 const event={agent_id:'kit-cli',event_id:'capture-1',consent:true,transcript:'Synthetic queued text'};
 r=await run('capture',event);assert.equal(r.code,1);assert.equal(r.json.error,'capture_disabled');pass();
 await withProxy(async c=>{
  assert.match(c.getInstructions(),/untrusted reference data/);pass();
  const tools=(await c.listTools()).tools;assert.equal(tools.length,6);assert.ok(tools.every(x=>!['query','ultra_memory_commit','ultra_personal_consolidate'].includes(x.name)));pass();
  const result=await c.callTool({name:'ultra_personal_context',arguments:{}});assert.ok(!result.isError);assert.equal(JSON.parse(result.content[0].text).memories[0].id,entry.id);pass();
  const denied=await c.callTool({name:'ultra_personal_review',arguments:{memory_id:entry.id,expected_revision:2,event_id:'bad',status:'archived'}});assert.equal(denied.isError,true);pass();
 });
 save({...profile,allow_capture:true,expected_instance:id.instance_id,expected_actor:id.actor_key});
 r=await run('capture',event);assert.equal(r.code,0,r.out+' '+r.err);const job=r.json.result.job_id;pass();
 r=await run('capture',event);assert.equal(r.json.result.job_id,job);assert.equal(r.json.result.replayed,true);pass();
 await withProxy(async c=>{
  assert.equal((await c.listTools()).tools.length,12);pass();
  const denied=await c.callTool({name:'query',arguments:{sql:'select 1'}});assert.equal(denied.isError,true);pass();
  const result=await c.callTool({name:'ultra_personal_jobs',arguments:{job_id:job}});assert.equal(JSON.parse(result.content[0].text).jobs[0].state,'queued');pass();
 });
 save({...profile,expected_actor:'0'.repeat(64)});r=await run('probe');assert.equal(r.code,1);assert.equal(r.json.error,'identity_mismatch');pass();
 // The same packaged Node client also traverses actual authenticated HTTP.
 const free=createServer();free.listen(0,'127.0.0.1');await once(free,'listening');const port=free.address().port;await new Promise(r=>free.close(r));
 const secret='gbrain_'+randomBytes(32).toString('hex');httpTokenName=source+'-http';
 await engine.executeRaw('INSERT INTO access_tokens(name,token_hash,scopes,permissions) VALUES($1,$2,$3::text[],$4::text::jsonb)',[httpTokenName,createHash('sha256').update(secret).digest('hex'),'{read}',JSON.stringify({source_id:source,takes_holders:['world']})]);
 httpServer=spawn(process.execPath,[ROOT+'/src/cli.mjs','mcp','--http','--bind','127.0.0.1','--port',String(port),'--suppress-bootstrap-token'],{cwd:ROOT,env:{...process.env,GBRAIN_SWEEP:'0',GBRAIN_ADMIN_BOOTSTRAP_TOKEN:randomBytes(32).toString('hex')},stdio:['ignore','ignore','pipe']});httpServer.stderr.on('data',()=>{});
 let ready=false;for(let n=0;n<100;n++){try{ready=(await fetch(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.timeout(300)})).ok;}catch{}if(ready)break;await new Promise(r=>setTimeout(r,100));}assert.ok(ready);pass();
 process.env.ULTRABRAIN_KIT_FIXTURE=secret;
 save({format:1,source,server:{transport:'http',url:`http://127.0.0.1:${port}/mcp`,bearer_env:'ULTRABRAIN_KIT_FIXTURE'}});
 r=await run('probe');assert.equal(r.code,0,r.out+' '+r.err);assert.equal(r.json.visible_active_memories,0);assert.notEqual(r.json.identity.actor_key,id.actor_key);assert.ok(!r.out.includes(secret));pass();
 await engine.executeRaw('UPDATE access_tokens SET revoked_at=now() WHERE name=$1',[httpTokenName]);r=await run('probe');assert.equal(r.code,1);assert.ok(!r.out.includes(secret));pass();
 const [count]=await engine.executeRaw('SELECT count(*)::int AS n FROM ultrabrain.personal_memories WHERE source_id=$1',[source]);assert.equal(count.n,2);pass();
 console.log(`PASS ${checks} actual Node client/proxy/native-MCP/PostgreSQL checks; Claude event fixtures, not installed Agent model runs`);
}finally{delete process.env.ULTRABRAIN_KIT_FIXTURE;if(httpServer&&httpServer.exitCode===null){httpServer.kill('SIGTERM');const t=setTimeout(()=>httpServer.kill('SIGKILL'),5000);await once(httpServer,'exit');clearTimeout(t);}if(httpTokenName)await engine.executeRaw('DELETE FROM access_tokens WHERE name=$1',[httpTokenName]);await engine.disconnect();rmSync(dir,{recursive:true,force:true});}
