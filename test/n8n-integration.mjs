/** Real MCP/PostgreSQL adapter tests. --engine additionally runs an installed, real n8n CLI. */
import assert from 'node:assert/strict';
import {executionFromOutput} from './n8n-cli-output.mjs';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {mkdtempSync,writeFileSync,readFileSync,mkdirSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {connect,ROOT} from '../src/runtime.mjs';
import {Client} from '../vendor/gbrain/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import {StreamableHTTPClientTransport} from '../vendor/gbrain/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';
assert.equal(process.env.ULTRABRAIN_TEST_ALLOW_WRITE,'1','Isolated test installation required');
const require=createRequire(import.meta.url);
const adapter=require('../packages/n8n-nodes-ultrabrain/dist/runtime.cjs');
const engine=await connect();
const source='n8n-'+randomBytes(5).toString('hex'),secret='gbrain_'+randomBytes(32).toString('hex');
const readerSecret='gbrain_'+randomBytes(32).toString('hex');
const temp=mkdtempSync(join(tmpdir(),'ub-n8n-'));
let hostVersion=null,hostNodeVersion=null;
let seedClient,server,checks=0;const proof=()=>checks++;
const free=createServer();free.listen(0,'127.0.0.1');await once(free,'listening');const port=free.address().port;await new Promise(r=>free.close(r));
const endpoint=`http://127.0.0.1:${port}/mcp`;
const creds={endpoint,token:secret,rootUri:`ultra://${source}/`,allowCapture:true,allowSharedCapture:false};
const defaults={operation:'identity',sessionId:'n8n-session',projectId:'',query:'n8ncanary',eventId:'n8n-event',
  transcript:'consented n8n capture fixture',captureConsent:true,visibility:'private',memoryPolicy:'current',summary:'prefer',
  budgetBytes:16000,includeFacts:false,factEntity:'',timeoutMs:10000};
function context(rows=[{}],credentials=creds,continueOnFail=false){return {
  getInputData:()=>rows.map(x=>({json:{...x,private_input:'must not be echoed'}})),
  getCredentials:async()=>credentials,
  getNodeParameter:(key,n,fallback)=>Object.hasOwn(rows[n],key)?rows[n][key]:Object.hasOwn(defaults,key)?defaults[key]:fallback,
  continueOnFail:()=>continueOnFail,
};}
const sessionCount=async session=>(await engine.executeRaw('SELECT count(*)::integer AS n FROM ultrabrain.session_receipts WHERE source_id=$1 AND session_id=$2',[source,session]))[0].n;
function diagnostic(output) {
  // Fixed classifications only; never print raw host errors, source input, paths or credentials.
  return JSON.stringify({unsupportedNode:/Node\.js.*(?:support|requir)|node version/i.test(output),
    missingModule:/Cannot find module|ERR_MODULE_NOT_FOUND/i.test(output),
    unknownNode:/Unrecognized node type|Unknown node type/i.test(output),
    credentials:/credentials?.*(?:not found|could not|unknown)|encryption/i.test(output),
    database:/sqlite|database.*(?:fail|error)|SQLITE_/i.test(output),
    ownership:/owner|ownership|personal project/i.test(output),
    expression:/isolated-vm|expression.*(?:fail|error)/i.test(output)});
}
async function executeProcess(command,args,{env=process.env,timeout=180000}={}) {
  const child=spawn(command,args,{env,cwd:ROOT,stdio:['ignore','pipe','pipe']});let output='';
  child.stdout.on('data',x=>{output=(output+x).slice(-262144);});child.stderr.on('data',x=>{output=(output+x).slice(-262144);});
  const timer=setTimeout(()=>child.kill('SIGKILL'),timeout);
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',c=>resolve(c));});clearTimeout(timer);
  // Do not print CLI logs. They can contain synthetic credential or transcript fixtures.
  return {code,output};
}
try{
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)',[source]);
  for(const [token,name,scopes] of [[secret,'writer',['read','write']],[readerSecret,'reader',['read']]])
    await engine.executeRaw('INSERT INTO access_tokens(name,token_hash,scopes,permissions) VALUES($1,$2,$3::text[],$4::text::jsonb)',
      [source+'-'+name,createHash('sha256').update(token).digest('hex'),'{'+scopes.join(',')+'}',JSON.stringify({source_id:source,takes_holders:['world']})]);
  server=spawn(process.execPath,[join(ROOT,'src/cli.mjs'),'mcp','--http','--bind','127.0.0.1','--port',String(port),'--suppress-bootstrap-token'],
    {cwd:ROOT,env:{...process.env,GBRAIN_SWEEP:'0',GBRAIN_ADMIN_BOOTSTRAP_TOKEN:randomBytes(32).toString('hex')},stdio:['ignore','ignore','pipe']});
  server.stderr.on('data',()=>{});
  let ready=false;for(let i=0;i<150;i++){
    if(server.exitCode!==null)throw new Error('MCP server exited before readiness');
    try{ready=(await fetch(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.timeout(1000)})).ok;}catch{}
    if(ready)break;await new Promise(r=>setTimeout(r,100));
  }
  assert.ok(ready);proof();
  const identityResult=await adapter.execute(context());const identity=identityResult[0].json.result.identity;
  assert.equal(identity.source_id,source);assert.match(identity.actor_key,/^[a-f0-9]{64}$/);proof();
  await assert.rejects(adapter.execute(context([{}],{...creds,expectedActor:'0'.repeat(64)})),{code:'identity_mismatch'});proof();
  await assert.rejects(adapter.execute(context([{}],{...creds,rootUri:'ultra://default/'})),{code:'identity_mismatch'});proof();
  const capture=await adapter.execute(context([{operation:'after_turn'}]));
  assert.equal(capture[0].json.result.delivery.storage,'journaled');assert.equal(capture[0].json.result.delivery.state,'queued');
  assert.ok(!JSON.stringify(capture).includes(defaults.transcript));assert.ok(!JSON.stringify(capture).includes(secret));proof();
  await adapter.execute(context([{operation:'after_turn'}]));assert.equal(await sessionCount('n8n-session'),1);proof();
  await assert.rejects(adapter.execute(context([{operation:'after_turn',transcript:'different'}])),{code:'conflict'});proof();
  await assert.rejects(adapter.execute(context([{operation:'after_turn',eventId:'not-consented',captureConsent:false}])),{code:'capture_disabled'});
  assert.equal(await sessionCount('n8n-session'),1);proof();
  await assert.rejects(adapter.execute(context([{operation:'after_turn',eventId:'shared',visibility:'world'}])),{code:'scope_denied'});proof();
  await assert.rejects(adapter.execute(context([{operation:'after_turn'}],{...creds,allowCapture:false})),{code:'capture_disabled'});proof();
  const receiptStatus=await adapter.execute(context([{operation:'session_status'}]));
  assert.equal(receiptStatus[0].json.result.status.state,'queued');proof();
  const otherActor=await adapter.execute(context([{operation:'session_status'}],{...creds,token:readerSecret},true));
  assert.equal(otherActor[0].json.ok,false);assert.ok(!JSON.stringify(otherActor).includes(secret));proof();
  const reads=await adapter.execute(context([{operation:'before_turn',query:'absent-one'},{operation:'before_turn',query:'absent-two'}]));
  assert.equal(reads.length,2);assert.deepEqual(reads.map(x=>x.pairedItem),[{item:0},{item:1}]);proof();
  assert.ok(reads.every(x=>x.json.result.context.items.length===0));proof();
  const mixed=await adapter.execute(context([{operation:'after_turn',captureConsent:false},{operation:'identity'}],creds,true));
  assert.equal(mixed[0].json.error,'capture_disabled');assert.equal(mixed[1].json.ok,true);proof();
  // Establish personal data through the same authenticated HTTP principal, not SQL impersonation.
  seedClient=new Client({name:'ultrabrain-n8n-personal-fixture',version:'0.10.1'});
  await seedClient.connect(new StreamableHTTPClientTransport(new URL(endpoint),{requestInit:{headers:{Authorization:`Bearer ${secret}`}},reconnectionOptions:{maxRetries:0}}));
  const personalCall=async(name,args)=>{
    const response=await seedClient.callTool({name,arguments:args});
    assert.ok(!response.isError,'Personal fixture operation was rejected');
    return JSON.parse(response.content[0].text);
  };
  await personalCall('ultra_agent_register',{agent_id:'n8n-personal',agent_type:'custom'});
  const learned=await personalCall('ultra_memory_commit',{agent_id:'n8n-personal',event_id:'personal-fixture',consent:true,
    memories:[{type:'preference',content:'Synthetic personal rule: retain stable event identifiers.',provenance:'n8n fixture',importance:'high'}]});
  const personalId=learned.entries[0].id;
  await personalCall('ultra_personal_review',{memory_id:personalId,expected_revision:1,event_id:'personal-activate',status:'active'});
  const withPersonal=await adapter.execute(context([{operation:'before_turn',includePersonal:true,query:'unrelated-task'}]));
  assert.equal(withPersonal[0].json.result.context.personal_context.memories[0].id,personalId);proof();
  const anotherPersonal=await adapter.execute(context([{operation:'before_turn',includePersonal:true}],{...creds,token:readerSecret}));
  assert.equal(anotherPersonal[0].json.result.context.personal_context.memories.length,0);proof();
  if(process.argv.includes('--engine')){
    const binary=process.env.ULTRABRAIN_N8N_BIN,packageDir=process.env.ULTRABRAIN_N8N_INSTALLED;
    assert.ok(binary&&existsSync(binary),'--engine requires the pinned installed n8n CLI');
    assert.ok(packageDir&&existsSync(join(packageDir,'dist/nodes/Ultrabrain/Ultrabrain.node.js')),'--engine requires the installed tgz, not source mocks');
    hostVersion=JSON.parse(readFileSync(join(dirname(binary),'../package.json'),'utf8')).version;
    assert.equal(hostVersion,'2.38.7','Actual host does not match the reviewed baseline');
    hostNodeVersion=(await executeProcess('node',['--version'])).output.trim();
    assert.match(hostNodeVersion,/^v24\./,'Actual n8n engine must run under the reviewed Node.js major');
    const env={...process.env,N8N_USER_FOLDER:join(temp,'n8n-home'),N8N_ENCRYPTION_KEY:randomBytes(32).toString('hex'),
      N8N_CUSTOM_EXTENSIONS:join(packageDir,'dist'),N8N_DIAGNOSTICS_ENABLED:'false',N8N_VERSION_NOTIFICATIONS_ENABLED:'false',
      N8N_PERSONALIZATION_ENABLED:'false',N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS:'true',
      N8N_COMMUNITY_PACKAGES_ENABLED:'false',N8N_RUNNERS_ENABLED:'false',
      N8N_LOG_LEVEL:'error',N8N_BLOCK_ENV_ACCESS_IN_NODE:'true',
      EXECUTIONS_DATA_SAVE_ON_SUCCESS:'none',EXECUTIONS_DATA_SAVE_ON_ERROR:'none',
      EXECUTIONS_DATA_SAVE_MANUAL_EXECUTIONS:'false'};
    mkdirSync(env.N8N_USER_FOLDER,{recursive:true,mode:0o700});
    const credentialId='ubN8nCred00000001',credentialFile=join(temp,'credentials.json');
    writeFileSync(credentialFile,JSON.stringify([{id:credentialId,name:'Ultrabrain Fixture',type:'ultrabrainApi',data:creds}]),{mode:0o600});
    const imported=await executeProcess('node',[binary,'import:credentials',`--input=${credentialFile}`],{env});
    if(imported.code!==0){writeFileSync(join(temp,'engine-import-error.log'),imported.output,{mode:0o600});}
    assert.equal(imported.code,0,'Real n8n credential import failed: '+diagnostic(imported.output));proof();
    const manual={parameters:{},name:'Start',type:'n8n-nodes-base.manualTrigger',typeVersion:1,position:[0,0],id:'start'};
    const save={parameters:{...defaults,operation:'after_turn',sessionId:'real-n8n-cli',eventId:'stable-event'},
      name:'Capture',type:'CUSTOM.ultrabrain',typeVersion:1,position:[260,0],id:'save',credentials:{ultrabrainApi:{id:credentialId,name:'Ultrabrain Fixture'}}};
    const status={...save,name:'Status',id:'status',position:[520,0],parameters:{...save.parameters,operation:'session_status'}};
    const personal={...save,name:'Personal',id:'personal',position:[780,0],parameters:{...save.parameters,operation:'before_turn',includePersonal:true,query:'unrelated-task'}};
    const workflow={id:'ubN8nFlow00000001',name:'Ultrabrain real n8n fixture',active:false,settings:{executionOrder:'v1'},
      nodes:[manual,save,status,personal],connections:{Start:{main:[[{node:'Capture',type:'main',index:0}]]},Capture:{main:[[{node:'Status',type:'main',index:0}]]},Status:{main:[[{node:'Personal',type:'main',index:0}]]}}};
    const file=join(temp,'workflow.json');
    const importWorkflow=async()=>{
      writeFileSync(file,JSON.stringify(workflow),{mode:0o600});
      const importedWorkflow=await executeProcess('node',[binary,'import:workflow',`--input=${file}`],{env});
      if(importedWorkflow.code!==0)writeFileSync(join(temp,'engine-workflow-import-error.log'),importedWorkflow.output,{mode:0o600});
      assert.equal(importedWorkflow.code,0,'Actual n8n workflow import failed: '+diagnostic(importedWorkflow.output));
    };
    await importWorkflow();proof();
    // n8n's --rawOutput still uses BaseCommand.log -> logger.info. Capture info-level
    // output privately for assertions; never echo it into the CI log.
    const executionEnv={...env,N8N_LOG_LEVEL:'info'};
    for(let repeat=0;repeat<2;repeat++){
      const run=await executeProcess('node',[binary,'execute',`--id=${workflow.id}`,'--rawOutput'],{env:executionEnv});
      if(run.code!==0)writeFileSync(join(temp,'engine-execution-error.log'),run.output,{mode:0o600});
      assert.equal(run.code,0,'Real n8n workflow failed: '+diagnostic(run.output));
      // Verify the actual final-node output, not just a potentially successful CLI exit.
      const execution=executionFromOutput(run.output);
      assert.ok(!execution.data.resultData.error,'Actual n8n workflow reported an execution error');
      const last=execution?.data?.resultData?.runData?.Status?.[0]?.data?.main?.[0]?.[0]?.json;
      assert.equal(last?.ok,true,'Actual n8n Status node did not produce a successful result: '+diagnostic(run.output));
      assert.equal(last.result.status.state,'queued');
      assert.equal(last.result.status.session_id,'real-n8n-cli');
      assert.equal(last.result.status.event_id,'stable-event');proof();
      assert.equal(await sessionCount('real-n8n-cli'),1);proof();
      const personalOutput=execution.data.resultData.runData.Personal?.[0]?.data?.main?.[0]?.[0]?.json;
      assert.equal(personalOutput?.ok,true,'Actual n8n Personal node did not produce a result');
      assert.equal(personalOutput.result.context.personal_context.memories[0].id,personalId);proof();
    }
    workflow.nodes[1].parameters.captureConsent=false;workflow.nodes[1].parameters.eventId='no-consent';
    await importWorkflow();
    const blocked=await executeProcess('node',[binary,'execute',`--id=${workflow.id}`,'--rawOutput'],{env:executionEnv});
    assert.match(blocked.output,/capture_disabled/,'Non-consented actual workflow lacked the expected consent rejection');
    assert.equal(await sessionCount('real-n8n-cli'),1);proof();
    console.log('PASS real n8n CLI: private node loading, credential import, Capture -> Status -> Personal workflow, replay, consent refusal');
  }
  await engine.executeRaw('UPDATE access_tokens SET revoked_at=now() WHERE name=$1',[source+'-writer']);
  await assert.rejects(adapter.execute(context([{operation:'after_turn',eventId:'revoked'}])));assert.equal(await sessionCount('n8n-session'),1);proof();
  console.log(`PASS ${checks} n8n adapter checks: real SDK/HTTP/PostgreSQL; ${process.argv.includes('--engine')?'real n8n CLI included':'n8n execution context fixture, not UI/engine certification'}`);
  if(process.env.ULTRABRAIN_N8N_REPORT)writeFileSync(process.env.ULTRABRAIN_N8N_REPORT,JSON.stringify({checks,passed:true,
    engine:process.argv.includes('--engine')?'n8n 2.38.7 CLI':'execution-context fixture',harnessRuntime:typeof Bun==='undefined'?'Node.js '+process.version:'Bun '+Bun.version,hostVersion,hostNodeVersion,sdk:'1.29.0'},null,2)+'\n');
}finally{
  if(seedClient)try{await seedClient.close();}catch{}
  if(server&&server.exitCode===null){server.kill('SIGTERM');const forced=setTimeout(()=>server.kill('SIGKILL'),5000);forced.unref();await once(server,'exit');clearTimeout(forced);}
  await engine.executeRaw('DELETE FROM access_tokens WHERE name=ANY($1::text[])',[[source+'-writer',source+'-reader']]);
  await engine.disconnect();
  // Private diagnostics are retained only on explicit opt-in; never uploaded by CI.
  if(process.env.ULTRABRAIN_KEEP_N8N_DIAGNOSTICS!=='1')rmSync(temp,{recursive:true,force:true});
}
