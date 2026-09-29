/** Actual installed Node package, official MCP/HTTP and private PostgreSQL.
 * --engine additionally exercises actual n8n, not just the synthetic context driver. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';import {once} from 'node:events';import {createServer} from 'node:net';
import {mkdtempSync,writeFileSync,readFileSync,mkdirSync,rmSync} from 'node:fs';import {join,resolve} from 'node:path';import {tmpdir} from 'node:os';
import {randomBytes,createHash} from 'node:crypto';
import {connect,ROOT} from '../src/runtime.mjs';
import {executionFromOutput} from './n8n-cli-output.mjs';
import {Client} from '../vendor/gbrain/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import {StreamableHTTPClientTransport} from '../vendor/gbrain/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';
assert.equal(process.env.ULTRABRAIN_TEST_ALLOW_WRITE,'1','Isolated synthetic DB only');
assert.ok(process.env.ULTRABRAIN_N8N_INSTALLED,'Explicit installed package required');
const pkg=resolve(process.env.ULTRABRAIN_N8N_INSTALLED),hash=s=>createHash('sha256').update(s).digest('hex');
assert.equal(hash(readFileSync(join(pkg,'dist/runtime.cjs'))),JSON.parse(readFileSync(join(pkg,'dist/build-manifest.json'))).runtime_sha256);
const engine=await connect(),source='n8nreview-'+randomBytes(4).toString('hex'),dir=mkdtempSync(join(tmpdir(),'ub-review-integration-'));
const token=[0,1].map(()=> 'gbrain_'+randomBytes(32).toString('hex'));
const tables=['personal_memories','personal_events','personal_consolidations','agent_registry','personal_documents','personal_document_fragments'];
const fingerprint=async()=>{const out={};for(const t of tables)out[t]=(await engine.executeRaw(`SELECT md5(coalesce(string_agg(row_to_json(t)::text,',' ORDER BY row_to_json(t)::text),'')) AS h FROM ultrabrain.${t} t WHERE source_id=$1`,[source]))[0].h;return out;};
let server,clients=[],transports=[],checks=0,engineChecks=0;const pass=()=>checks++;
const listener=createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=listener.address().port;await new Promise(r=>listener.close(r));
const endpoint=`http://127.0.0.1:${port}/mcp`;
const call=async(owner,name,args={})=>{const r=await clients[owner].callTool({name,arguments:args});assert.ok(!r.isError,'Synthetic setup/read rejected: '+name);return JSON.parse(r.content[0].text);};
const record=async id=>(await call(0,'ultra_memory_read',{memory_id:id})).memory;
const params=(m,event,action='active',mode='apply')=>({operation:'personal_review',reviewMode:mode,reviewAction:action,reviewScope:m.project_id?'global-and-project':'global-only',
 reviewMemoryId:m.id,reviewEventId:event,reviewExpectedRevision:m.revision,reviewExpectedHash:m.content_hash,reviewExpectedStatus:m.status,
 reviewExpectedVisibility:m.visibility,reviewExpectedProject:m.project_id??'',reviewConsent:true,reviewAcknowledgeEffects:true,reviewSharedConsent:false,timeoutMs:10000});
async function run(credentials,parameters,{barrier,race}={}){
 const child=spawn('node',[ROOT+'/test/fixtures/n8n-memory-review-driver.cjs',pkg],{cwd:ROOT,stdio:['pipe','pipe','pipe',...(barrier?['ipc']:[])]});
 let out='',err='',raceError;child.stdout.on('data',b=>{out+=b;if(out.length>131072)child.kill('SIGKILL');});child.stderr.on('data',b=>{err+=b;if(err.length>131072)child.kill('SIGKILL');});child.stdin.on('error',()=>{});
 if(race)child.on('message',m=>{if(m.checkpoint==='read')race().then(()=>child.send({continue:true})).catch(e=>{raceError=e;child.kill('SIGKILL');});});
 const timeout=setTimeout(()=>child.kill('SIGKILL'),40000);
 try{
  child.stdin.end(JSON.stringify({credentials,parameters,barrier}));const exit=await new Promise((r,j)=>{child.once('error',j);child.once('close',r);});
  if(raceError)throw raceError;assert.equal(err,'');for(const t of token)assert.ok(!out.includes(t));assert.ok(!out.includes('PRIVATE_'));
  const value=JSON.parse(out);return {exit,value,result:value.items?.[0]?.json.result};
 }finally{clearTimeout(timeout);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
}
async function host(args,env){
 const c=spawn('node',args,{cwd:ROOT,env,stdio:['ignore','pipe','pipe']});let text='';
 const take=b=>{text+=b;if(text.length>4*1024*1024)c.kill('SIGKILL');};c.stdout.on('data',take);c.stderr.on('data',take);
 const timer=setTimeout(()=>c.kill('SIGKILL'),180000);
 try{return {exit:await new Promise((r,j)=>{c.once('error',j);c.once('close',r);}),text};}finally{clearTimeout(timer);}
}
try{
 await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)',[source]);
 for(let i=0;i<2;i++)await engine.executeRaw('INSERT INTO access_tokens(name,token_hash,scopes,permissions) VALUES($1,$2,$3::text[],$4::text::jsonb)',
 [source+'-'+i,hash(token[i]),'{read,write}',JSON.stringify({source_id:source,takes_holders:['world']})]);
 server=spawn(process.execPath,[ROOT+'/src/cli.mjs','mcp','--http','--bind','127.0.0.1','--port',String(port),'--suppress-bootstrap-token'],
 {cwd:ROOT,env:{...process.env,GBRAIN_SWEEP:'0',GBRAIN_ADMIN_BOOTSTRAP_TOKEN:randomBytes(32).toString('hex')},stdio:['ignore','ignore','pipe']});server.stderr.on('data',()=>{});
 let ready=false;for(let i=0;i<120;i++){try{ready=(await fetch(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.timeout(300)})).ok;}catch{}if(ready)break;await new Promise(r=>setTimeout(r,100));}assert.ok(ready);
 const identities=[];
 for(let i=0;i<2;i++){
  const c=new Client({name:'manual-review-fixture',version:'1'}),t=new StreamableHTTPClientTransport(new URL(endpoint),{requestInit:{headers:{Authorization:'Bearer '+token[i]}}});
  await c.connect(t);clients.push(c);transports.push(t);identities.push(await call(i,'ultra_identity'));
  await call(i,'ultra_agent_register',{agent_id:'manual-fixture'});
 }
 const seed=(owner,event,memories)=>call(owner,'ultra_memory_commit',{agent_id:'manual-fixture',event_id:event,consent:true,memories});
 const own=(await seed(0,'own-seed',Array.from({length:8},(_,i)=>({type:'preference',content:'PRIVATE_BODY_'+i,
  ...(i===1?{visibility:'source'}:{}),...(i===2?{project_id:'mine'}:{}),...(i===3?{project_id:'other'}:{})})))).entries;
 const foreign=(await seed(1,'other-seed',[{type:'goal',content:'PRIVATE_OTHER',visibility:'source'}])).entries[0];
 await call(1,'ultra_personal_review',{memory_id:foreign.id,expected_revision:1,event_id:'other-active',status:'active'});
 const docBytes=Buffer.from('PRIVATE_DOCUMENT');const doc=await call(0,'ultra_personal_document_import',{agent_id:'manual-fixture',event_id:'doc-seed',consent:true,label:'test.txt',content_base64:docBytes.toString('base64'),content_sha256:hash(docBytes)});
 const fragment=(await call(0,'ultra_personal_document_queue',{document_id:doc.document_id,event_id:'doc-queue'})).fragments[0].memory_id;
 const creds={endpoint,token:token[0],rootUri:`ultra://${source}/`,expectedInstance:identities[0].instance_id,expectedActor:identities[0].actor_key,
  reviewProject:'mine',allowMemoryActivation:true,allowMemoryArchive:true,allowSourceActivation:false,allowCapture:false};
 let before=await fingerprint();const first=await record(own[0].id),q=params(first,'activate-original');
 let r=await run(creds,{...q,reviewConsent:false});assert.equal(r.value.error,'memory_review_consent_required');assert.equal(r.value.write_delivery,'not_started');pass();
 r=await run({...creds,allowMemoryActivation:false,allowCapture:true},q);assert.equal(r.value.error,'memory_review_disabled');pass();
 r=await run(creds,params(await record(fragment),'reject-fragment'));assert.equal(r.value.error,'memory_inspect_document_bound');pass();
 r=await run(creds,params(await record(foreign.id),'reject-shared','archived'));assert.equal(r.value.error,'memory_inspect_not_owned');pass();
 r=await run(creds,params(await record(own[3].id),'reject-project'));assert.equal(r.value.error,'memory_review_project_mismatch');pass();
 assert.deepEqual(await fingerprint(),before);pass();
 r=await run(creds,q);assert.equal(r.exit,0);assert.equal(r.result.receipt.status,'active');assert.equal((await record(first.id)).revision,2);
 assert.ok((await call(0,'ultra_personal_context',{})).memories.some(m=>m.id===first.id));pass();
 before=await fingerprint();r=await run(creds,q);assert.equal(r.value.error,'memory_review_selected_changed');assert.deepEqual(await fingerprint(),before);pass();
 r=await run(creds,{...q,reviewMode:'replay'});assert.equal(r.result.receipt.replayed,true);assert.deepEqual(await fingerprint(),before);pass();
 r=await run(creds,params(await record(first.id),'archive-original','archived'));assert.equal(r.exit,0);
 assert.ok(!(await call(0,'ultra_personal_context',{})).memories.some(m=>m.id===first.id));pass();
 before=await fingerprint();r=await run(creds,{...q,reviewMode:'replay'});assert.equal(r.result.receipt.status,'active');assert.equal(r.result.observed_revision,3);
 assert.equal((await record(first.id)).status,'archived');assert.deepEqual(await fingerprint(),before);pass();
 r=await run(creds,{...q,reviewMode:'replay',reviewEventId:'nonexistent-event'});assert.equal(r.value.error,'revision_conflict');assert.deepEqual(await fingerprint(),before);pass();
 const shared=params(await record(own[1].id),'shared-activation');r=await run(creds,shared);assert.equal(r.value.error,'memory_review_shared_consent_required');
 r=await run({...creds,allowSourceActivation:true},shared);assert.equal(r.value.error,'memory_review_shared_consent_required');assert.deepEqual(await fingerprint(),before);pass();
 r=await run({...creds,allowSourceActivation:true},{...shared,reviewSharedConsent:true});assert.equal(r.exit,0);pass();
 r=await run(creds,params(await record(own[2].id),'project-activation'));assert.equal(r.exit,0);pass();
 const competing=await record(own[4].id);r=await run(creds,params(competing,'stale-action'),{barrier:'race',race:()=>call(0,'ultra_personal_update',{
  memory_id:competing.id,expected_revision:1,event_id:'competing-edit',memory:{type:'preference',content:'PRIVATE_COMPETING_EDIT'}})});
 assert.equal(r.value.error,'revision_conflict');assert.equal((await record(competing.id)).status,'candidate');assert.equal((await record(competing.id)).revision,2);pass();
 const lost=params(await record(own[5].id),'lost-receipt');r=await run(creds,lost,{barrier:'lost'});
 assert.equal(r.value.write_delivery,'unconfirmed');assert.equal(r.value.attempts,1);assert.equal((await record(own[5].id)).status,'active');pass();
 before=await fingerprint();r=await run(creds,{...lost,reviewMode:'replay'});assert.equal(r.result.receipt.replayed,true);assert.deepEqual(await fingerprint(),before);pass();
 if(process.argv.includes('--engine')){
  const binary=process.env.ULTRABRAIN_N8N_BIN;assert.ok(binary);assert.equal(JSON.parse(readFileSync(resolve(binary,'../../package.json'))).version,'2.38.7');
  assert.match((await host(['--version'],process.env)).text,/^v24\./);
  const env={...process.env,N8N_USER_FOLDER:join(dir,'home'),N8N_ENCRYPTION_KEY:randomBytes(32).toString('hex'),N8N_CUSTOM_EXTENSIONS:join(pkg,'dist'),
   N8N_DIAGNOSTICS_ENABLED:'false',N8N_VERSION_NOTIFICATIONS_ENABLED:'false',N8N_PERSONALIZATION_ENABLED:'false',N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS:'true',
   N8N_COMMUNITY_PACKAGES_ENABLED:'false',N8N_RUNNERS_ENABLED:'false',N8N_LOG_LEVEL:'info',N8N_BLOCK_ENV_ACCESS_IN_NODE:'true',
   EXECUTIONS_DATA_SAVE_ON_SUCCESS:'none',EXECUTIONS_DATA_SAVE_ON_ERROR:'none',EXECUTIONS_DATA_SAVE_MANUAL_EXECUTIONS:'false'};
  mkdirSync(env.N8N_USER_FOLDER,{mode:0o700});const credentialId='reviewFixture01',credFile=join(dir,'credentials.json');
  writeFileSync(credFile,JSON.stringify([{id:credentialId,name:'Review fixture',type:'ultrabrainApi',data:creds}]),{mode:0o600});
  assert.equal((await host([binary,'import:credentials','--input='+credFile],env)).exit,0);engineChecks++;
  const original=params(await record(own[6].id),'engine-activate');
  const flow=JSON.parse(readFileSync(ROOT+'/examples/n8n/personal-review.private.json'));flow.id='manualReview01';
  flow.nodes[1].parameters=original;flow.nodes[1].credentials={ultrabrainApi:{id:credentialId,name:'Review fixture'}};
  const path=join(dir,'workflow.json');
  const execute=async()=>{writeFileSync(path,JSON.stringify(flow),{mode:0o600});assert.equal((await host([binary,'import:workflow','--input='+path],env)).exit,0);
   const run=await host([binary,'execute','--id='+flow.id,'--rawOutput'],env);return {exit:run.exit,data:executionFromOutput(run.text).data.resultData};};
  let value=await execute();assert.equal(value.exit,0);assert.equal(value.data.runData.Review[0].data.main[0][0].json.result.receipt.status,'active');engineChecks++;
  flow.nodes[1].parameters=params(await record(own[6].id),'engine-archive','archived');value=await execute();assert.equal(value.exit,0);assert.equal((await record(own[6].id)).status,'archived');engineChecks++;
  before=await fingerprint();flow.nodes[1].parameters={...original,reviewMode:'replay'};value=await execute();assert.equal(value.exit,0);
  assert.equal(value.data.runData.Review[0].data.main[0][0].json.result.receipt.status,'active');assert.deepEqual(await fingerprint(),before);engineChecks++;
  flow.nodes[1].parameters={...original,reviewConsent:false};value=await execute();assert.ok(JSON.stringify(value.data.error).includes('memory_review_consent_required'));assert.deepEqual(await fingerprint(),before);engineChecks++;
 }
 const readOnly=params(await record(own[7].id),'read-only-denied');before=await fingerprint();
 await engine.executeRaw("UPDATE access_tokens SET scopes='{read}'::text[] WHERE name=$1",[source+'-0']);
 r=await run(creds,readOnly);assert.equal(r.value.error,'insufficient_scope');assert.equal(r.value.write_delivery,'unconfirmed');assert.deepEqual(await fingerprint(),before);pass();
 await engine.executeRaw('UPDATE access_tokens SET revoked_at=now() WHERE name=$1',[source+'-0']);
 r=await run(creds,readOnly);assert.equal(r.value.ok,false);assert.equal(r.value.write_delivery,'not_started');assert.deepEqual(await fingerprint(),before);pass();
 const report={passed:true,checks,engine_checks:engineChecks,mode:process.argv.includes('--engine')?'actual installed n8n plus Node runtime, official MCP/HTTP and PostgreSQL':'actual installed Node runtime with synthetic n8n context, official MCP/HTTP and PostgreSQL; NOT n8n engine',
  lifecycle_writes_explicit:true,read_denial_replay_phases_six_tables_unchanged:true,real_competing_update:true,lost_ack_injected_after_actual_commit:true,
  generator_calls:0,external_model_calls:0,user_deployment_verified:false};
 if(process.env.ULTRABRAIN_N8N_REVIEW_REPORT)writeFileSync(process.env.ULTRABRAIN_N8N_REVIEW_REPORT,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{
 for(let i=0;i<clients.length;i++){try{await transports[i].terminateSession();}catch{}try{await clients[i].close();}catch{}}
 if(server&&server.exitCode===null&&server.signalCode===null){server.kill('SIGTERM');const t=setTimeout(()=>server.kill('SIGKILL'),5000);await once(server,'close');clearTimeout(t);}
 await engine.executeRaw('DELETE FROM access_tokens WHERE name=ANY($1::text[])',[[source+'-0',source+'-1']]);await engine.disconnect();rmSync(dir,{recursive:true,force:true});
}
