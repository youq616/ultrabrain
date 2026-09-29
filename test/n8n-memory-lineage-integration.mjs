/** Actual packaged Node runtime -> official MCP/HTTP -> isolated PostgreSQL.
 * --engine additionally runs real n8n. References are explicitly synthetic fixtures. */
import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import {once} from 'node:events';
import {createServer} from 'node:net';import {mkdtempSync,writeFileSync,readFileSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {connect,ROOT} from '../src/runtime.mjs';import {executionFromOutput} from './n8n-cli-output.mjs';
import {Client} from '../vendor/gbrain/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import {StreamableHTTPClientTransport} from '../vendor/gbrain/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';
assert.equal(process.env.ULTRABRAIN_TEST_ALLOW_WRITE,'1');assert.ok(process.env.ULTRABRAIN_N8N_INSTALLED);
const pkg=resolve(process.env.ULTRABRAIN_N8N_INSTALLED),hash=v=>createHash('sha256').update(v).digest('hex');
assert.equal(hash(readFileSync(join(pkg,'dist/runtime.cjs'))),JSON.parse(readFileSync(join(pkg,'dist/build-manifest.json'))).runtime_sha256);
const engine=await connect(),source='n8nlineage-'+randomBytes(4).toString('hex'),dir=mkdtempSync(join(tmpdir(),'ub-lineage-db-'));
const tokens=[0,1].map(()=> 'gbrain_'+randomBytes(32).toString('hex')),clients=[],transports=[];
const tables=['personal_memories','personal_events','personal_consolidations','agent_registry','personal_documents','personal_document_fragments'];
const fingerprint=async()=>{const r={};for(const t of tables)r[t]=(await engine.executeRaw(`SELECT md5(coalesce(string_agg(row_to_json(t)::text,',' ORDER BY row_to_json(t)::text),'')) AS h FROM ultrabrain.${t} t WHERE source_id=$1`,[source]))[0].h;return r;};
let server,checks=0,engineChecks=0;
const listener=createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=listener.address().port;await new Promise(r=>listener.close(r));
const endpoint=`http://127.0.0.1:${port}/mcp`;
const call=async(i,name,args={})=>{const v=await clients[i].callTool({name,arguments:args});assert.ok(!v.isError,'Synthetic setup/read rejected: '+name);return JSON.parse(v.content[0].text);};
async function run(credentials,parameters,race){
 const child=spawn('node',[ROOT+'/test/fixtures/n8n-memory-correction-driver.cjs',pkg],{cwd:ROOT,stdio:['pipe','pipe','pipe',...(race?['ipc']:[])]});
 let out='',err='',raceError;child.stdout.on('data',b=>{out+=b;if(out.length>1048576)child.kill('SIGKILL');});child.stderr.on('data',b=>err+=b);child.stdin.on('error',()=>{});
 if(race)child.on('message',m=>{if(m.checkpoint==='read')race().then(()=>child.send({continue:true})).catch(e=>{raceError=e;child.kill('SIGKILL');});});
 const timer=setTimeout(()=>child.kill('SIGKILL'),40000);
 try{child.stdin.end(JSON.stringify({credentials,parameters,...(race?{barrier:'race'}:{})}));const exit=await new Promise((r,j)=>{child.once('error',j);child.once('close',r);});
  if(raceError)throw raceError;assert.equal(err,'');for(const token of tokens)assert.ok(!out.includes(token));
  if(!parameters.lineageIncludeText)assert.ok(!out.includes('PRIVATE_'));const value=JSON.parse(out);return {exit,value,result:value.items?.[0]?.json.result};
 }finally{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
}
async function host(args,env){
 const c=spawn('node',args,{cwd:ROOT,env,stdio:['ignore','pipe','pipe']});let text='';const take=b=>{text+=b;if(text.length>4*1024*1024)c.kill('SIGKILL');};
 c.stdout.on('data',take);c.stderr.on('data',take);const timer=setTimeout(()=>c.kill('SIGKILL'),120000);
 try{return {exit:await new Promise((r,j)=>{c.once('error',j);c.once('close',r);}),text};}finally{clearTimeout(timer);}
}
try{
 await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)',[source]);
 for(let i=0;i<2;i++)await engine.executeRaw('INSERT INTO access_tokens(name,token_hash,scopes,permissions) VALUES($1,$2,$3::text[],$4::text::jsonb)',
  [source+'-'+i,hash(tokens[i]),'{read,write}',JSON.stringify({source_id:source,takes_holders:['world']})]);
 server=spawn(process.execPath,[ROOT+'/src/cli.mjs','mcp','--http','--bind','127.0.0.1','--port',String(port),'--suppress-bootstrap-token'],
  {env:{...process.env,GBRAIN_SWEEP:'0',GBRAIN_ADMIN_BOOTSTRAP_TOKEN:randomBytes(32).toString('hex')},stdio:['ignore','ignore','pipe']});server.stderr.on('data',()=>{});
 let ready=false;for(let i=0;i<120;i++){try{ready=(await fetch(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.timeout(300)})).ok;}catch{}if(ready)break;await new Promise(r=>setTimeout(r,100));}assert.ok(ready);
 const ids=[];
 for(let i=0;i<2;i++){
  const c=new Client({name:'source-verification-fixture',version:'1'}),t=new StreamableHTTPClientTransport(new URL(endpoint),{requestInit:{headers:{Authorization:'Bearer '+tokens[i]}}});
  await c.connect(t);clients.push(c);transports.push(t);ids.push(await call(i,'ultra_identity'));await call(i,'ultra_agent_register',{agent_id:'fixture'});
 }
 const seed=async(i,event,memories)=>(await call(i,'ultra_memory_commit',{agent_id:'fixture',event_id:event,consent:true,memories})).entries;
 const own=await seed(0,'seed',[{type:'experience',content:'PRIVATE_SOURCE original evidence'},
  {type:'preference',content:'PRIVATE_CHILD derived observation'},{type:'goal',content:'PRIVATE_UNLINKED'},
  {type:'experience',content:'PRIVATE_PROJECT_SOURCE',project_id:'mine'},
  {type:'preference',content:'PRIVATE_PROJECT_CHILD'}, {type:'preference',content:'PRIVATE_MISSING_SOURCE'},
  {type:'preference',content:'PRIVATE_SHARED_SOURCE_CHILD'}]);
 const other=(await seed(1,'seed',[{type:'experience',content:'PRIVATE_SHARED_OTHER',visibility:'source'}]))[0];
 await call(1,'ultra_personal_review',{memory_id:other.id,expected_revision:1,event_id:'shared-active',status:'active'});
 const record=async id=>(await call(0,'ultra_memory_read',{memory_id:id})).memory;
 const link=async(child,input,body)=>{
  assert.equal((await record(child)).owned_by_caller,true);
  const reference={job_id:randomUUID(),input_id:input,input_revision:1,input_hash:hash(body),profile_hash:'c'.repeat(64),quote:'PRIVATE',start:0,end:7,offset_unit:'UTF-16 code units'};
  const r=await engine.executeRaw('UPDATE ultrabrain.personal_memories SET derivation=$3::text::jsonb WHERE source_id=$1 AND id=$2::uuid RETURNING id',[source,child,JSON.stringify(reference)]);assert.equal(r.length,1);
 };
 await link(own[1].id,own[0].id,'PRIVATE_SOURCE original evidence');await link(own[4].id,own[3].id,'PRIVATE_PROJECT_SOURCE');
 await link(own[5].id,randomUUID(),'PRIVATE_MISSING');await link(own[6].id,other.id,'PRIVATE_SHARED_OTHER');
 const credentials={endpoint,token:tokens[0],rootUri:`ultra://${source}/`,expectedInstance:ids[0].instance_id,expectedActor:ids[0].actor_key,lineageProject:'mine',allowCapture:false};
 const parameters={operation:'personal_lineage',lineageMemoryId:own[1].id,lineageScope:'global-only',lineageConsent:true,lineageFollowConsent:true,lineageIncludeText:false,timeoutMs:10000};
 let before=await fingerprint(),r;
 r=await run(credentials,parameters);assert.equal(r.exit,0);assert.equal(r.result.verdict.state,'matched');assert.equal(r.result.read_requests,3);checks++;
 r=await run(credentials,{...parameters,lineageIncludeText:true});assert.equal(r.result.text.quote,'PRIVATE');assert.equal(r.result.text.source,'PRIVATE_SOURCE original evidence');checks++;
 r=await run(credentials,{...parameters,lineageMemoryId:own[2].id});assert.equal(r.result.verdict.state,'unlinked');assert.equal(r.result.read_requests,1);checks++;
 r=await run(credentials,{...parameters,lineageMemoryId:own[5].id});assert.equal(r.result.verdict.state,'unavailable');assert.equal(r.result.read_requests,3);checks++;
 r=await run(credentials,{...parameters,lineageMemoryId:own[4].id});assert.equal(r.value.error,'memory_inspect_project_mismatch');checks++;
 r=await run(credentials,{...parameters,lineageMemoryId:own[4].id,lineageScope:'global-and-project'});assert.equal(r.result.verdict.state,'matched');checks++;
 r=await run(credentials,{...parameters,lineageMemoryId:own[6].id});assert.equal(r.value.error,'memory_inspect_not_owned');checks++;
 r=await run(credentials,{...parameters,lineageFollowConsent:false});assert.equal(r.value.error,'memory_lineage_consent_required');checks++;
 assert.deepEqual(await fingerprint(),before);checks++;
 // Real modification of the selected memory while its first read is in flight.
 let raced=false;r=await run(credentials,parameters,async()=>{if(!raced){raced=true;await call(0,'ultra_personal_review',{memory_id:own[1].id,expected_revision:1,event_id:'competing-parent',status:'archived'});}});
 assert.equal(r.value.error,'memory_lineage_selected_changed');assert.equal((await record(own[1].id)).status,'archived');checks++;
 await call(0,'ultra_personal_review',{memory_id:own[0].id,expected_revision:1,event_id:'source-advance',status:'active'});
 before=await fingerprint();r=await run(credentials,parameters);assert.equal(r.result.verdict.state,'changed');assert.equal(r.result.verdict.quote_matches,true);assert.deepEqual(await fingerprint(),before);checks++;
 await call(0,'ultra_personal_review',{memory_id:own[0].id,expected_revision:2,event_id:'source-archive',status:'archived'});
 before=await fingerprint();r=await run(credentials,parameters);assert.equal(r.result.verdict.state,'archived');assert.deepEqual(await fingerprint(),before);checks++;
 // Read-only actual token still supports the entire traversal.
 await engine.executeRaw("UPDATE access_tokens SET scopes='{read}'::text[] WHERE name=$1",[source+'-0']);
 r=await run(credentials,parameters);assert.equal(r.exit,0);assert.equal(r.result.verdict.state,'archived');checks++;
 if(process.argv.includes('--engine')){
  const binary=process.env.ULTRABRAIN_N8N_BIN;assert.ok(binary);assert.equal(JSON.parse(readFileSync(resolve(binary,'../../package.json'))).version,'2.38.7');assert.match((await host(['--version'],process.env)).text,/^v24\./);
  const env={...process.env,N8N_USER_FOLDER:join(dir,'home'),N8N_ENCRYPTION_KEY:randomBytes(32).toString('hex'),N8N_CUSTOM_EXTENSIONS:join(pkg,'dist'),
   N8N_DIAGNOSTICS_ENABLED:'false',N8N_VERSION_NOTIFICATIONS_ENABLED:'false',N8N_PERSONALIZATION_ENABLED:'false',N8N_COMMUNITY_PACKAGES_ENABLED:'false',
   N8N_RUNNERS_ENABLED:'false',N8N_LOG_LEVEL:'info',N8N_BLOCK_ENV_ACCESS_IN_NODE:'true',N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS:'true',
   EXECUTIONS_DATA_SAVE_ON_SUCCESS:'none',EXECUTIONS_DATA_SAVE_ON_ERROR:'none',EXECUTIONS_DATA_SAVE_MANUAL_EXECUTIONS:'false'};
  mkdirSync(env.N8N_USER_FOLDER,{mode:0o700});const credId='lineageFixture01',credFile=join(dir,'credentials.json');
  writeFileSync(credFile,JSON.stringify([{id:credId,name:'Lineage fixture',type:'ultrabrainApi',data:credentials}]),{mode:0o600});
  assert.equal((await host([binary,'import:credentials','--input='+credFile],env)).exit,0);engineChecks++;
  const flow=JSON.parse(readFileSync(ROOT+'/examples/n8n/personal-lineage.private.json'));flow.id='lineageFixtureFlow01';
  flow.nodes[1].parameters={...parameters};flow.nodes[1].credentials={ultrabrainApi:{id:credId,name:'Lineage fixture'}};const path=join(dir,'workflow.json');
  const execute=async()=>{writeFileSync(path,JSON.stringify(flow),{mode:0o600});assert.equal((await host([binary,'import:workflow','--input='+path],env)).exit,0);
   const r=await host([binary,'execute','--id='+flow.id,'--rawOutput'],env);return {exit:r.exit,data:executionFromOutput(r.text).data.resultData};};
  let v=await execute();assert.equal(v.exit,0);assert.equal(v.data.runData.Lineage[0].data.main[0][0].json.result.verdict.state,'archived');engineChecks++;
  flow.nodes[1].parameters.lineageIncludeText=true;v=await execute();assert.equal(v.exit,0);assert.equal(v.data.runData.Lineage[0].data.main[0][0].json.result.text.source,'PRIVATE_SOURCE original evidence');engineChecks++;
  Object.assign(flow.nodes[1].parameters,{lineageMemoryId:own[4].id,lineageScope:'global-and-project',lineageIncludeText:false});v=await execute();assert.equal(v.exit,0);assert.equal(v.data.runData.Lineage[0].data.main[0][0].json.result.verdict.state,'matched');engineChecks++;
  flow.nodes[1].parameters.lineageFollowConsent=false;v=await execute();assert.ok(JSON.stringify(v.data.error).includes('memory_lineage_consent_required'));engineChecks++;
  assert.deepEqual(await fingerprint(),before);engineChecks++;
 }
 await engine.executeRaw('UPDATE access_tokens SET revoked_at=now() WHERE name=$1',[source+'-0']);r=await run(credentials,parameters);assert.equal(r.value.ok,false);assert.deepEqual(await fingerprint(),before);checks++;
 const report={passed:true,checks,engine_checks:engineChecks,mode:process.argv.includes('--engine')?'actual n8n engine and Node package, official MCP/HTTP, PostgreSQL':'actual Node package, synthetic n8n context, official MCP/HTTP, PostgreSQL; NOT actual n8n engine',
  synthetic_references:true,actual_parent_race:true,read_phases_six_tables_unchanged:true,model_calls:0,generator_calls:0,user_deployment_verified:false};
 if(process.env.ULTRABRAIN_N8N_LINEAGE_REPORT)writeFileSync(process.env.ULTRABRAIN_N8N_LINEAGE_REPORT,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{
 for(let i=0;i<clients.length;i++){try{await transports[i].terminateSession();}catch{}try{await clients[i].close();}catch{}}
 if(server&&server.exitCode===null&&server.signalCode===null){server.kill('SIGTERM');const timer=setTimeout(()=>server.kill('SIGKILL'),5000);await once(server,'close');clearTimeout(timer);}
 await engine.executeRaw('DELETE FROM access_tokens WHERE name=ANY($1::text[])',[[source+'-0',source+'-1']]);await engine.disconnect();rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
