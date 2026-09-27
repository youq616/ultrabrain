/** Actual packaged adapter -> official MCP/HTTP -> isolated PostgreSQL.
 * --engine additionally runs the installed n8n engine, not a context double.
 * Synthetic consented setup only; read/rejection phases fingerprint all six personal tables.
 */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {mkdtempSync,writeFileSync,readFileSync,mkdirSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes,createHash} from 'node:crypto';
import {connect,ROOT} from '../src/runtime.mjs';
import {executionFromOutput} from './n8n-cli-output.mjs';
import {Client} from '../vendor/gbrain/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import {StreamableHTTPClientTransport} from '../vendor/gbrain/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';
assert.equal(process.env.ULTRABRAIN_TEST_ALLOW_WRITE,'1','Use only an isolated synthetic database');
assert.ok(process.env.ULTRABRAIN_N8N_INSTALLED,'Select the actual packaged adapter root');
const pkg=resolve(process.env.ULTRABRAIN_N8N_INSTALLED),require=createRequire(import.meta.url),adapter=require(join(pkg,'dist/runtime.cjs'));
const hash=b=>createHash('sha256').update(b).digest('hex');
const manifest=JSON.parse(readFileSync(join(pkg,'dist/build-manifest.json'),'utf8'));
assert.equal(hash(readFileSync(join(pkg,'dist/runtime.cjs'))),manifest.runtime_sha256);
const engine=await connect(),source='n8ncand-'+randomBytes(5).toString('hex'),temp=mkdtempSync(join(tmpdir(),'ub-n8n-candidates-'));
const tokens=[0,1].map(()=> 'gbrain_'+randomBytes(32).toString('hex'));
const tables=['personal_memories','personal_events','personal_consolidations','agent_registry','personal_documents','personal_document_fragments'];
const fingerprint=async()=>{const out={};for(const t of tables)out[t]=(await engine.executeRaw(
 `SELECT md5(coalesce(string_agg(row_to_json(t)::text,',' ORDER BY row_to_json(t)::text),'')) AS h FROM ultrabrain.${t} t WHERE source_id=$1`,[source]))[0].h;return out;};
const inspectEnabled=process.argv.includes('--inspect');
let inspectChecks=0,inspectEngineChecks=0,sharedId;
let server,checks=0,engineChecks=0,hostVersion=null;const pass=()=>checks++;
const listener=createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=listener.address().port;await new Promise(r=>listener.close(r));
const endpoint=`http://127.0.0.1:${port}/mcp`;
const defaults={operation:'personal_candidates',candidateScope:'global-only',candidateConsent:true,candidateLimit:10,candidateAfter:'',timeoutMs:10000};
const context=(credentials,rows=[{}],keepGoing=false)=>({getInputData:()=>rows.map(()=>({json:{PRIVATE_INPUT:'not read or output'}})),
 getCredentials:async()=>credentials,continueOnFail:()=>keepGoing,
 getNodeParameter:(k,i,fallback)=>Object.hasOwn(rows[i],k)?rows[i][k]:Object.hasOwn(defaults,k)?defaults[k]:fallback});
async function processResult(args,env){
 const child=spawn('node',args,{cwd:ROOT,env,stdio:['ignore','pipe','pipe']});let output='';
 const append=b=>{output+=b;if(output.length>4*1024*1024)child.kill('SIGKILL');};child.stdout.on('data',append);child.stderr.on('data',append);
 const timer=setTimeout(()=>child.kill('SIGKILL'),180000);
 try{return {code:await new Promise((res,rej)=>{child.once('error',rej);child.once('close',res);}),output};}
 finally{clearTimeout(timer);}
}
try{
 await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)',[source]);
 for(let i=0;i<2;i++)await engine.executeRaw('INSERT INTO access_tokens(name,token_hash,scopes,permissions) VALUES($1,$2,$3::text[],$4::text::jsonb)',
  [source+'-'+i,hash(tokens[i]),'{read,write}',JSON.stringify({source_id:source,takes_holders:['world']})]);
 server=spawn(process.execPath,[join(ROOT,'src/cli.mjs'),'mcp','--http','--bind','127.0.0.1','--port',String(port),'--suppress-bootstrap-token'],
  {cwd:ROOT,env:{...process.env,GBRAIN_SWEEP:'0',GBRAIN_ADMIN_BOOTSTRAP_TOKEN:randomBytes(32).toString('hex')},stdio:['ignore','ignore','pipe']});
 server.stderr.on('data',()=>{});let ready=false;
 for(let i=0;i<150;i++){if(server.exitCode!==null)throw Error('Synthetic MCP startup failed');
  try{ready=(await fetch(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.timeout(300)})).ok;}catch{}
  if(ready)break;await new Promise(r=>setTimeout(r,100));}assert.ok(ready);
 const identities=[],own=[],other=[];let capturedId,fragmentId;
 for(let owner=0;owner<2;owner++){
  const c=new Client({name:'n8n-candidate-fixture',version:'1'}),t=new StreamableHTTPClientTransport(new URL(endpoint),{
   requestInit:{headers:{Authorization:'Bearer '+tokens[owner]}},reconnectionOptions:{maxRetries:0}});
  try{
   await c.connect(t);const call=async(name,args={})=>{const r=await c.callTool({name,arguments:args});assert.ok(!r.isError,'Synthetic setup rejected');return JSON.parse(r.content[0].text);};
   identities.push(await call('ultra_identity'));await call('ultra_agent_register',{agent_id:'n8n-candidate-fixture',agent_type:'custom'});
   const list=owner?other:own,count=owner?2:30;
   for(let start=0;start<count;start+=8){const memories=Array.from({length:Math.min(8,count-start)},(_,j)=>{
    const i=start+j;return {type:'preference',content:'PRIVATE_N8N_CANDIDATE_'+owner+'_'+i+'x'.repeat(i===0?60000:32),
     ...(i>=26?{project_id:i<29?'mine':'foreign'}:{}),visibility:i%2?'source':'private'};});
    list.push(...(await call('ultra_memory_commit',{agent_id:'n8n-candidate-fixture',event_id:'seed-'+start,consent:true,memories})).entries);
   }
   if(owner===1&&inspectEnabled){
    sharedId=(await call('ultra_memory_commit',{agent_id:'n8n-candidate-fixture',event_id:'shared-inspection-fixture',consent:true,
     memories:[{type:'goal',content:'PRIVATE_INSPECT_OTHER_SHARED',visibility:'source'}]})).entries[0].id;
    await call('ultra_personal_review',{memory_id:sharedId,expected_revision:1,event_id:'activate-shared-inspection',status:'active'});
   }
   if(owner===0){
    await call('ultra_personal_review',{memory_id:own[24].id,expected_revision:1,event_id:'activate',status:'active'});
    await call('ultra_personal_review',{memory_id:own[25].id,expected_revision:1,event_id:'archive',status:'archived'});
    capturedId=(await call('ultra_personal_capture',{agent_id:'n8n-candidate-fixture',event_id:'capture',transcript:'PRIVATE_N8N_CANDIDATE raw input',consent:true})).input_id;
    const body=Buffer.from('PRIVATE_N8N_CANDIDATE document');const doc=await call('ultra_personal_document_import',{
     agent_id:'n8n-candidate-fixture',event_id:'doc',consent:true,label:'fixture.txt',content_base64:body.toString('base64'),content_sha256:hash(body)});
    const queue=await call('ultra_personal_document_queue',{document_id:doc.document_id,event_id:'queue'});fragmentId=queue.fragments[0].memory_id;
   }
  }finally{try{await t.terminateSession();}finally{await c.close();}}
 }
 // Listing must work with genuine read-only tokens and without capture permission.
 await engine.executeRaw("UPDATE access_tokens SET scopes='{read}'::text[] WHERE name=ANY($1::text[])",[[source+'-0',source+'-1']]);
 const credentials=identities.map((id,i)=>({endpoint,token:tokens[i],rootUri:`ultra://${source}/`,allowCapture:false,allowSharedCapture:false,
  expectedInstance:id.instance_id,expectedActor:id.actor_key,candidateProject:'mine',...(inspectEnabled?{inspectProject:'mine'}:{})}));
 const expected=own.slice(0,24).map(r=>r.id).concat(capturedId).sort(),before=await fingerprint();
 const read=async(rows=[{}],credential=credentials[0],keepGoing=false)=>{
  const r=await adapter.execute(context(credential,rows,keepGoing));const s=JSON.stringify(r);
  assert.ok(!s.includes('PRIVATE_N8N_CANDIDATE')&&!s.includes('PRIVATE_INPUT'));for(const token of tokens)assert.ok(!s.includes(token));return r;
 };
 const first=(await read())[0].json.result.page;assert.equal(first.returned,10);assert.equal(first.has_more,true);pass();
 let all=[...first.memories.map(m=>m.id)],next=first.next_after;
 while(next){const p=(await read([{candidateAfter:next}]))[0].json.result.page;all.push(...p.memories.map(m=>m.id));next=p.next_after;}
 assert.deepEqual(all,expected);assert.equal(new Set(all).size,25);pass();
 assert.ok(all.includes(own[0].id)&&all.includes(capturedId)&&!all.includes(fragmentId));pass();
 const withProject=(await read([{candidateScope:'global-and-project',candidateLimit:50,projectId:'foreign'}]))[0].json.result.page;
 assert.deepEqual(withProject.memories.map(m=>m.id),expected.concat(own.slice(26,29).map(m=>m.id)).sort());pass();
 const empty=(await read([{candidateAfter:expected.at(-1)}]))[0].json.result.page;assert.equal(empty.returned,0);assert.equal(empty.has_more,false);pass();
 const onlyOther=(await read([{candidateLimit:50}],credentials[1]))[0].json.result.page;
 assert.deepEqual(onlyOther.memories.map(m=>m.id),other.map(m=>m.id).sort());pass();
 const multi=await read([{},{}]);assert.deepEqual(multi.map(r=>r.pairedItem),[{item:0},{item:1}]);
 assert.notEqual(multi[0].json.result.page.request_id,multi[1].json.result.page.request_id);pass();
 const partial=await read([{candidateConsent:false},{}],credentials[0],true);assert.equal(partial[0].json.error,'candidates_consent_required');assert.equal(partial[1].json.ok,true);pass();
 for(const row of [{candidateScope:''},{candidateLimit:51},{candidateAfter:'bad'}])await assert.rejects(read([row]));pass();
 await assert.rejects(read([{}],{...credentials[0],expectedActor:'a'.repeat(64)}),{code:'identity_mismatch'});pass();
 await assert.rejects(read([{candidateScope:'global-and-project'}],{...credentials[0],candidateProject:''}),{code:'candidates_project_required'});pass();
 assert.deepEqual(await fingerprint(),before);pass();
 const inspectDefaults=()=>({operation:'personal_inspect',inspectMemoryId:own[0].id,inspectScope:'global-only',inspectConsent:true,inspectIncludeText:false,timeoutMs:10000});
 const inspect=async(extra={},credential=credentials[0],keepGoing=false)=>{
  const result=await adapter.execute(context(credential,[{...inspectDefaults(),...extra}],keepGoing));
  const json=JSON.stringify(result);for(const token of tokens)assert.ok(!json.includes(token));assert.ok(!json.includes('PRIVATE_INPUT'));
  if(!extra.inspectIncludeText)assert.ok(!json.includes('PRIVATE_N8N_CANDIDATE'));
  return result[0].json;
 };
 if(inspectEnabled){
  // Pick an ID from the actual list, but never treat its metadata as write authority.
  let r=await inspect({inspectMemoryId:first.memories[0].id});assert.equal(r.ok,true);assert.equal(r.result.memory.id,first.memories[0].id);
  assert.equal(r.result.text,undefined);assert.equal(r.result.read_requests,1);inspectChecks++;
  r=await inspect({inspectIncludeText:true});assert.equal(r.result.text.content,'PRIVATE_N8N_CANDIDATE_0_0'+'x'.repeat(60000));inspectChecks++;
  for(const [entry,status]of [[own[24],'active'],[own[25],'archived']]){r=await inspect({inspectMemoryId:entry.id});assert.equal(r.result.memory.status,status);inspectChecks++;}
  await assert.rejects(inspect({inspectMemoryId:own[26].id}),{code:'memory_inspect_project_mismatch'});inspectChecks++;
  r=await inspect({inspectMemoryId:own[26].id,inspectScope:'global-and-project'});assert.equal(r.result.memory.project_id,'mine');inspectChecks++;
  await assert.rejects(inspect({inspectMemoryId:own[29].id,inspectScope:'global-and-project'}),{code:'memory_inspect_project_mismatch'});inspectChecks++;
  await assert.rejects(inspect({inspectMemoryId:other[0].id}),{code:'not_found'});inspectChecks++;
  await assert.rejects(inspect({inspectMemoryId:sharedId}),{code:'memory_inspect_not_owned'});inspectChecks++;
  await assert.rejects(inspect({inspectMemoryId:fragmentId}),{code:'memory_inspect_document_bound'});inspectChecks++;
  r=await inspect({inspectMemoryId:capturedId});assert.equal(r.ok,true);inspectChecks++;
  r=await inspect({inspectConsent:false},credentials[0],true);assert.equal(r.error,'memory_inspect_consent_required');assert.equal(r.read_delivery,'not_started');inspectChecks++;
  await assert.rejects(inspect({}, {...credentials[0],expectedActor:'a'.repeat(64)}),{code:'identity_mismatch'});inspectChecks++;
  assert.deepEqual(await fingerprint(),before);inspectChecks++;
 }
 if(process.argv.includes('--engine')){
  const binary=process.env.ULTRABRAIN_N8N_BIN;assert.ok(binary,'Actual n8n binary required');
  hostVersion=JSON.parse(readFileSync(resolve(binary,'../../package.json'),'utf8')).version;assert.equal(hostVersion,'2.38.7');
  const version=await processResult(['--version'],process.env);assert.match(version.output,/^v24\./);
  const env={...process.env,N8N_USER_FOLDER:join(temp,'n8n-home'),N8N_ENCRYPTION_KEY:randomBytes(32).toString('hex'),N8N_CUSTOM_EXTENSIONS:join(pkg,'dist'),
   N8N_DIAGNOSTICS_ENABLED:'false',N8N_VERSION_NOTIFICATIONS_ENABLED:'false',N8N_PERSONALIZATION_ENABLED:'false',N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS:'true',
   N8N_COMMUNITY_PACKAGES_ENABLED:'false',N8N_RUNNERS_ENABLED:'false',N8N_LOG_LEVEL:'info',N8N_BLOCK_ENV_ACCESS_IN_NODE:'true',
   EXECUTIONS_DATA_SAVE_ON_SUCCESS:'none',EXECUTIONS_DATA_SAVE_ON_ERROR:'none',EXECUTIONS_DATA_SAVE_MANUAL_EXECUTIONS:'false'};
  mkdirSync(env.N8N_USER_FOLDER,{recursive:true,mode:0o700});
  const credentialId='ubCandidateCred01',credentialFile=join(temp,'credentials.json');
  writeFileSync(credentialFile,JSON.stringify([{id:credentialId,name:'Candidate Fixture',type:'ultrabrainApi',data:credentials[0]}]),{mode:0o600});
  assert.equal((await processResult([binary,'import:credentials','--input='+credentialFile],env)).code,0,'n8n credential import');engineChecks++;
  const flow={id:'ubCandidateFlow01',name:'Synthetic candidate page',active:false,
   settings:{executionOrder:'v1',saveDataSuccessExecution:'none',saveDataErrorExecution:'none',saveManualExecutions:false},
   nodes:[{id:'start',name:'Start',type:'n8n-nodes-base.manualTrigger',typeVersion:1,parameters:{},position:[0,0]},
    {id:'list',name:'Candidates',type:'CUSTOM.ultrabrain',typeVersion:1,position:[260,0],parameters:{...defaults},credentials:{ultrabrainApi:{id:credentialId,name:'Candidate Fixture'}}}],
   connections:{Start:{main:[[{node:'Candidates',type:'main',index:0}]]}}};
  const workflowFile=join(temp,'workflow.json');
  const execute=async()=>{
   writeFileSync(workflowFile,JSON.stringify(flow),{mode:0o600});
   assert.equal((await processResult([binary,'import:workflow','--input='+workflowFile],env)).code,0,'n8n workflow import');
   const r=await processResult([binary,'execute','--id='+flow.id,'--rawOutput'],env);
   // Logs are inspected only, not echoed or uploaded: they may contain fixture credentials.
   return {code:r.code,execution:executionFromOutput(r.output)};
  };
  let run=await execute();assert.equal(run.code,0);assert.ok(!run.execution.data.resultData.error);
  const result=run.execution.data.resultData.runData.Candidates[0].data.main[0][0];assert.equal(result.json.ok,true);
  assert.deepEqual(result.json.result.page.memories.map(m=>m.id),expected.slice(0,10));assert.ok(!JSON.stringify(result).includes('PRIVATE_'));engineChecks++;
  flow.nodes[1].parameters.candidateAfter=result.json.result.page.next_after;
  run=await execute();assert.equal(run.code,0);const second=run.execution.data.resultData.runData.Candidates[0].data.main[0][0].json.result.page;
  assert.deepEqual(second.memories.map(m=>m.id),expected.slice(10,20));engineChecks++;
  Object.assign(flow.nodes[1].parameters,{candidateAfter:'',candidateScope:'global-and-project',candidateLimit:50});
  run=await execute();assert.equal(run.code,0);const project=run.execution.data.resultData.runData.Candidates[0].data.main[0][0].json.result.page;
  assert.deepEqual(project.memories.map(m=>m.id),expected.concat(own.slice(26,29).map(m=>m.id)).sort());engineChecks++;
  flow.nodes[1].parameters.candidateConsent=false;run=await execute();
  assert.ok(run.execution.data.resultData.error,'Actual engine must refuse lack of consent');
  assert.ok(JSON.stringify(run.execution.data.resultData.error).includes('candidates_consent_required'));engineChecks++;
  assert.deepEqual(await fingerprint(),before);engineChecks++;
  if(inspectEnabled){
   flow.nodes[1].parameters=inspectDefaults();run=await execute();assert.equal(run.code,0);
   let result=run.execution.data.resultData.runData.Candidates[0].data.main[0][0];
   assert.equal(result.json.result.memory.id,own[0].id);assert.equal(result.json.result.text,undefined);inspectEngineChecks++;
   flow.nodes[1].parameters.inspectIncludeText=true;run=await execute();assert.equal(run.code,0);
   result=run.execution.data.resultData.runData.Candidates[0].data.main[0][0];
   assert.equal(result.json.result.text.content,'PRIVATE_N8N_CANDIDATE_0_0'+'x'.repeat(60000));inspectEngineChecks++;
   Object.assign(flow.nodes[1].parameters,{inspectMemoryId:own[26].id,inspectScope:'global-and-project',inspectIncludeText:false});
   run=await execute();assert.equal(run.code,0);result=run.execution.data.resultData.runData.Candidates[0].data.main[0][0];
   assert.equal(result.json.result.memory.project_id,'mine');inspectEngineChecks++;
   flow.nodes[1].parameters.inspectMemoryId=sharedId;run=await execute();
   assert.ok(JSON.stringify(run.execution.data.resultData.error).includes('memory_inspect_not_owned'));inspectEngineChecks++;
   flow.nodes[1].parameters.inspectConsent=false;run=await execute();
   assert.ok(JSON.stringify(run.execution.data.resultData.error).includes('memory_inspect_consent_required'));inspectEngineChecks++;
   assert.deepEqual(await fingerprint(),before);inspectEngineChecks++;
  }
 }
 await engine.executeRaw('UPDATE access_tokens SET revoked_at=now() WHERE name=$1',[source+'-0']);
 await assert.rejects(read());assert.deepEqual(await fingerprint(),before);pass();
 if(inspectEnabled){await assert.rejects(inspect());assert.deepEqual(await fingerprint(),before);inspectChecks++;}
 const report={passed:true,adapter_checks:checks,engine_checks:engineChecks,
  mode:process.argv.includes('--engine')?'actual installed n8n engine, official MCP/HTTP, PostgreSQL':'actual packaged runtime, synthetic execution context, official MCP/HTTP, PostgreSQL; NOT n8n engine',
  ...(inspectEnabled?{inspection_adapter_checks:inspectChecks,inspection_engine_checks:inspectEngineChecks}:{}),
  host_version:hostVersion,six_personal_tables_unchanged:true,body_fields_returned:inspectEnabled?'only with explicit disclosure':0,generator_calls:0,external_model_calls:0,user_host_verified:false};
 if(process.env.ULTRABRAIN_N8N_CANDIDATES_REPORT)writeFileSync(process.env.ULTRABRAIN_N8N_CANDIDATES_REPORT,JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report));
}finally{
 if(server&&server.exitCode===null&&server.signalCode===null){server.kill('SIGTERM');const timeout=setTimeout(()=>server.kill('SIGKILL'),5000);await once(server,'close');clearTimeout(timeout);}
 await engine.executeRaw('DELETE FROM access_tokens WHERE name=ANY($1::text[])',[[source+'-0',source+'-1']]);await engine.disconnect();rmSync(temp,{recursive:true,force:true});
}
