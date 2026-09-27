/** Actual installed Node CLI/SDK -> native MCP -> isolated PostgreSQL.
 * Explicit synthetic setup and lifecycle writes. No generators or external models.
 */
import assert from 'node:assert/strict';
import {memoryReadBarrierPreload} from './helpers/installed-client-preload.mjs';
import {randomBytes,createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';import {once} from 'node:events';import {createServer} from 'node:net';
import {connect,ROOT} from '../src/runtime.mjs';
import {PersonalMemoryStore} from '../src/personal-memory-store.mjs';
import {PersonalDocumentStore} from '../src/personal-documents.mjs';
import {Client} from '../vendor/gbrain/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import {StreamableHTTPClientTransport} from '../vendor/gbrain/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';
assert.equal(process.env.ULTRABRAIN_TEST_ALLOW_WRITE,'1');
const pkg=process.env.ULTRABRAIN_TASK_CLIENT_ROOT;assert.ok(pkg,'Use actual installed package');
const dir=mkdtempSync(join(tmpdir(),'ub-review-real-')),file=join(dir,'profile.json');
const source='review-'+randomBytes(5).toString('hex'),engine=await connect(),ctx={engine,sourceId:source,remote:false,transport:'stdio'};
const store=new PersonalMemoryStore(ctx),docs=new PersonalDocumentStore(ctx),hash=s=>createHash('sha256').update(s).digest('hex');
const tables=['personal_memories','personal_events','personal_consolidations','agent_registry','personal_documents','personal_document_fragments'];
const fingerprint=async()=>{const r={};for(const t of tables)r[t]=(await engine.executeRaw(`SELECT md5(coalesce(string_agg(row_to_json(t)::text,',' ORDER BY row_to_json(t)::text),'')) AS h FROM ultrabrain.${t} t WHERE source_id=$1`,[source]))[0].h;return r;};
let profile={format:1,source,workspace:dir,allow_capture:true,server:{transport:'stdio',command:process.execPath,
 args:[ROOT+'/src/cli.mjs','mcp'],env:{ULTRABRAIN_HOME:process.env.ULTRABRAIN_HOME,GBRAIN_SOURCE:source,GBRAIN_SWEEP:'0'}}};
const save=()=>writeFileSync(file,JSON.stringify(profile),{mode:0o600});
const inspect=(id,extra={})=>({operation:'inspect',memory_id:id,workspace:dir,consent:true,...extra});
const apply=(m,event,status='active')=>({...inspect(m.id),operation:'apply',event_id:event,expected_revision:m.revision,
 expected_content_hash:m.content_hash,expected_status:m.status,expected_visibility:m.visibility,expected_project_id:m.project_id,status});
let server,tokenName,secret,checks=0;const pass=()=>checks++;
async function run(input,{sdk=false,probe=false,race}={}){
 const code=`const fs=require('node:fs'),{reviewClientMemory}=require(process.argv[1]);reviewClientMemory(JSON.parse(fs.readFileSync(process.argv[2],'utf8')),JSON.parse(fs.readFileSync(0,'utf8')))
 .then(r=>process.stdout.write(JSON.stringify(r)+'\\n')).catch(e=>{process.stdout.write(JSON.stringify({ok:false,error:e.code,write_delivery:e.write_delivery})+'\\n');process.exitCode=1;});`;
 const args=probe?[join(pkg,'dist/cli.cjs'),'probe','--profile',file]:sdk?['-e',code,join(pkg,'dist/memory-review.cjs'),file]:[join(pkg,'dist/memory-review-cli.cjs'),'--profile',file];
 let raceError;
 if(race){
  const preload=join(dir,'preload.cjs');
  writeFileSync(preload,memoryReadBarrierPreload(pkg),{mode:0o600});
  args.unshift('--require',preload);
 }
 const child=spawn('node',args,{cwd:ROOT,env:process.env,stdio:['pipe','pipe','pipe',...(race?['ipc']:[])]});
 let out='',err='';child.stdout.on('data',b=>{out+=b;if(out.length>1048576)child.kill('SIGKILL');});child.stderr.on('data',b=>{err+=b;if(err.length>1048576)child.kill('SIGKILL');});child.stdin.on('error',()=>{});
 if(race)child.on('message',m=>{if(m.observed)race().then(()=>child.send({continue:true})).catch(e=>{raceError=e;child.kill('SIGKILL');});});
 const timer=setTimeout(()=>child.kill('SIGKILL'),40000);
 try{
  child.stdin.end(input?JSON.stringify(input):'');const status=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  if(raceError)throw raceError;assert.equal(err,'');if(secret)assert.ok(!out.includes(secret));
  if(!input?.include_text)assert.ok(!out.includes('PRIVATE_REVIEW_BODY'));return {status,r:JSON.parse(out)};
 }finally{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
}
try{
 await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)',[source]);await store.register({agent_id:'manual-review-fixture',agent_type:'custom',capabilities:['manual']});
 const entries=(await store.commit({agent_id:'manual-review-fixture',event_id:'seed',consent:true,memories:[
  {type:'preference',content:'PRIVATE_REVIEW_BODY never use Docker Hub'},
  {type:'preference',content:'PRIVATE_REVIEW_BODY source sharing',visibility:'source'},
  {type:'preference',content:'PRIVATE_REVIEW_BODY other project',project_id:'other-project'},
  {type:'preference',content:'PRIVATE_REVIEW_BODY concurrent'}]})).entries;
 const docBytes=Buffer.from('PRIVATE_REVIEW_BODY document'),doc=await docs.documentImport({agent_id:'manual-review-fixture',event_id:'document',consent:true,
 label:'synthetic.txt',content_base64:docBytes.toString('base64'),content_sha256:hash(docBytes)});
 const queued=await docs.documentQueue({document_id:doc.document_id,event_id:'queue'});
 save();let v=await run(null,{probe:true});assert.equal(v.status,0);Object.assign(profile,{expected_instance:v.r.identity.instance_id,expected_actor:v.r.identity.actor_key});save();
 const read=id=>store.read({memory_id:id}).then(r=>r.memory);const m=await read(entries[0].id),q=apply(m,'activate-one');
 const before=await fingerprint();
 v=await run(inspect(m.id));assert.equal(v.status,0);assert.equal(v.r.text_included,false);assert.equal(v.r.memory.revision,1);pass();
 v=await run(inspect(m.id,{include_text:true}),{sdk:true});assert.equal(v.r.text.content,m.content);assert.equal(v.r.write_requests,0);pass();
 v=await run({...q,consent:false});assert.equal(v.status,1);assert.equal(v.r.write_delivery,'not_started');pass();
 v=await run(inspect(entries[2].id));assert.equal(v.status,1);assert.equal(v.r.error,'lineage_project_mismatch');pass();
 const fragment=await read(queued.fragments[0].memory_id);v=await run(apply(fragment,'bad-fragment'));assert.equal(v.status,1);assert.equal(v.r.error,'memory_review_document_bound');pass();
 assert.deepEqual(await fingerprint(),before);pass();
 v=await run(q);assert.equal(v.status,0);assert.equal(v.r.receipt.status,'active');assert.equal(v.r.write_delivery,'confirmed');
 assert.ok((await store.context({})).memories.some(x=>x.id===m.id));assert.equal((await read(m.id)).content,m.content);pass();
 const activated=await fingerprint();v=await run(q);assert.equal(v.status,1);assert.equal(v.r.write_delivery,'not_started');assert.deepEqual(await fingerprint(),activated);pass();
 v=await run({...q,operation:'replay'});assert.equal(v.status,0);assert.equal(v.r.receipt.replayed,true);assert.deepEqual(await fingerprint(),activated);pass();
 v=await run(apply(await read(m.id),'archive-one','archived'),{sdk:true});assert.equal(v.status,0);assert.equal(v.r.receipt.revision,3);
 assert.ok(!(await store.context({})).memories.some(x=>x.id===m.id));pass();
 const archived=await fingerprint();v=await run({...q,operation:'replay'});assert.equal(v.r.receipt.status,'active');assert.equal(v.r.current_state_verified,false);
 assert.equal((await read(m.id)).status,'archived');assert.deepEqual(await fingerprint(),archived);pass();
 v=await run({...q,operation:'replay',event_id:'not-a-prior-event'});assert.equal(v.status,1);assert.deepEqual(await fingerprint(),archived);pass();
 const competing=await read(entries[3].id);
 v=await run(apply(competing,'must-not-activate'),{race:()=>store.update({memory_id:competing.id,expected_revision:1,event_id:'competing-edit',
 memory:{type:'preference',content:'PRIVATE_REVIEW_BODY corrected by concurrent writer'}})});
 assert.equal(v.status,1);assert.equal(v.r.error,'revision_conflict');assert.equal((await read(competing.id)).status,'candidate');pass();
 const shared=await read(entries[1].id);v=await run(apply(shared,'share-one'),{sdk:true});assert.equal(v.status,0);assert.equal((await read(shared.id)).visibility,'source');pass();
 const after=await fingerprint();for(const t of tables.filter(t=>!['personal_memories','personal_events'].includes(t)))assert.equal(after[t],before[t]);pass();
 // Establish a different HTTP owner through the actual authenticated MCP transport,
 // not by writing a guessed principal hash into application rows.
 const listener=createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=listener.address().port;await new Promise(r=>listener.close(r));
 secret='gbrain_'+randomBytes(32).toString('hex');tokenName=source+'-http';
 await engine.executeRaw('INSERT INTO access_tokens(name,token_hash,scopes,permissions) VALUES($1,$2,$3::text[],$4::text::jsonb)',
 [tokenName,hash(secret),'{read,write}',JSON.stringify({source_id:source,takes_holders:['world']})]);
 server=spawn(process.execPath,[ROOT+'/src/cli.mjs','mcp','--http','--bind','127.0.0.1','--port',String(port),'--suppress-bootstrap-token'],
 {cwd:ROOT,env:{...process.env,GBRAIN_SWEEP:'0',GBRAIN_ADMIN_BOOTSTRAP_TOKEN:randomBytes(32).toString('hex')},stdio:['ignore','ignore','pipe']});server.stderr.on('data',()=>{});
 let ready=false;for(let i=0;i<100;i++){try{ready=(await fetch(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.timeout(300)})).ok;}catch{}if(ready)break;await new Promise(r=>setTimeout(r,100));}assert.ok(ready);
 const url=`http://127.0.0.1:${port}/mcp`,client=new Client({name:'synthetic-review-fixture',version:'1'});
 const transport=new StreamableHTTPClientTransport(new URL(url),{requestInit:{headers:{Authorization:'Bearer '+secret}}});
 let httpId;
 try{
  await client.connect(transport);const call=async(name,args)=>{const r=await client.callTool({name,arguments:args});assert.ok(!r.isError);return JSON.parse(r.content[0].text);};
  await call('ultra_agent_register',{agent_id:'http-review-fixture'});
  httpId=(await call('ultra_memory_commit',{agent_id:'http-review-fixture',event_id:'http-seed',consent:true,memories:[{type:'goal',content:'PRIVATE_REVIEW_BODY http owner'}]})).entries[0].id;
 }finally{try{await transport.terminateSession();}finally{await client.close();}}
 process.env.ULTRABRAIN_REVIEW_TEST_TOKEN=secret;
 profile={format:1,source,workspace:dir,allow_capture:true,server:{transport:'http',url,bearer_env:'ULTRABRAIN_REVIEW_TEST_TOKEN'}};save();
 v=await run(null,{probe:true});assert.equal(v.status,0);Object.assign(profile,{expected_instance:v.r.identity.instance_id,expected_actor:v.r.identity.actor_key});save();
 v=await run(inspect(httpId));assert.equal(v.status,0);const httpMemory=v.r.memory;
 v=await run(apply(httpMemory,'http-activate'),{sdk:true});assert.equal(v.status,0);assert.equal(v.r.receipt.status,'active');pass();
 const httpBefore=await fingerprint();v=await run(apply({...shared,status:'active',revision:2},'steal','archived'));assert.equal(v.status,1);assert.equal(v.r.error,'memory_review_not_owned');pass();
 await engine.executeRaw("UPDATE access_tokens SET scopes='{read}'::text[] WHERE name=$1",[tokenName]);
 v=await run(apply({...httpMemory,status:'active',revision:2},'read-only-denied','archived'));assert.equal(v.status,1);assert.equal(v.r.error,'insufficient_scope');
 const denialClient=new Client({name:'scope-denial-fixture',version:'1'}),denialTransport=new StreamableHTTPClientTransport(new URL(url),{requestInit:{headers:{Authorization:'Bearer '+secret}}});
 try{await denialClient.connect(denialTransport);const denial=await denialClient.callTool({name:'ultra_personal_review',arguments:{memory_id:httpId,expected_revision:2,event_id:'direct-scope-denial',status:'archived'}});
  assert.equal(denial.isError,true);assert.equal(JSON.parse(denial.content[0].text).error,'insufficient_scope');
 }finally{try{await denialTransport.terminateSession();}finally{await denialClient.close();}}pass();
 await engine.executeRaw('UPDATE access_tokens SET revoked_at=now() WHERE name=$1',[tokenName]);v=await run(inspect(httpId));assert.equal(v.status,1);pass();
 assert.deepEqual(await fingerprint(),httpBefore);pass();
 const report={passed:true,checks,mode:'actual built Node CLI/SDK, official MCP, PostgreSQL, stdio and authenticated HTTP',
  generator_calls:0,external_model_calls:0,read_replay_denial_phases_six_tables_unchanged:true,lifecycle_writes_explicit:true,user_host_verified:false};
 if(process.env.ULTRABRAIN_MEMORY_REVIEW_REPORT)writeFileSync(process.env.ULTRABRAIN_MEMORY_REVIEW_REPORT,JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report));
}finally{
 delete process.env.ULTRABRAIN_REVIEW_TEST_TOKEN;
 if(server&&server.exitCode===null&&server.signalCode===null){server.kill('SIGTERM');const timer=setTimeout(()=>server.kill('SIGKILL'),5000);await once(server,'close');clearTimeout(timer);}
 if(tokenName)await engine.executeRaw('DELETE FROM access_tokens WHERE name=$1',[tokenName]);await engine.disconnect();rmSync(dir,{recursive:true,force:true});
}
