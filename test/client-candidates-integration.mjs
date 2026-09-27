/** Installed Node CLI/SDK, native MCP and isolated PostgreSQL; no external model.
 * Explicit synthetic setup uses writes. Every list/inspection/denial is read-only.
 */
import assert from 'node:assert/strict';import {randomBytes,createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {spawn} from 'node:child_process';import {once} from 'node:events';import {createServer} from 'node:net';
import {connect,ROOT} from '../src/runtime.mjs';import {PersonalMemoryStore} from '../src/personal-memory-store.mjs';
import {PersonalDocumentStore} from '../src/personal-documents.mjs';
import {Client} from '../vendor/gbrain/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import {StreamableHTTPClientTransport} from '../vendor/gbrain/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';
assert.equal(process.env.ULTRABRAIN_TEST_ALLOW_WRITE,'1');const pkg=process.env.ULTRABRAIN_TASK_CLIENT_ROOT;assert.ok(pkg);
const dir=mkdtempSync(join(tmpdir(),'ub-candidates-real-')),file=join(dir,'profile.json'),source='candidates-'+randomBytes(4).toString('hex');
const engine=await connect(),ctx={engine,sourceId:source,remote:false,transport:'stdio'},store=new PersonalMemoryStore(ctx),docs=new PersonalDocumentStore(ctx);
let profile={format:1,source,workspace:dir,server:{transport:'stdio',command:process.execPath,args:[ROOT+'/src/cli.mjs','mcp'],
 env:{ULTRABRAIN_HOME:process.env.ULTRABRAIN_HOME,GBRAIN_SOURCE:source,GBRAIN_SWEEP:'0'}}};
const save=()=>writeFileSync(file,JSON.stringify(profile),{mode:0o600});
const selection=(extra={})=>({workspace:dir,consent:true,limit:10,...extra});
const hash=s=>createHash('sha256').update(s).digest('hex');let checks=0,server,tokenName,secret;const pass=()=>checks++;
const tables=['personal_memories','personal_events','personal_consolidations','agent_registry','personal_documents','personal_document_fragments'];
const fingerprint=async()=>{const out={};for(const t of tables)out[t]=(await engine.executeRaw(`SELECT md5(coalesce(string_agg(row_to_json(t)::text,',' ORDER BY row_to_json(t)::text),'')) AS h FROM ultrabrain.${t} t WHERE source_id=$1`,[source]))[0].h;return out;};
async function run(input,{sdk=false,probe=false,inspect=false}={}){
 const program=`const fs=require('node:fs'),{listClientCandidates}=require(process.argv[1]);listClientCandidates(JSON.parse(fs.readFileSync(process.argv[2],'utf8')),JSON.parse(fs.readFileSync(0,'utf8'))).then(r=>process.stdout.write(JSON.stringify(r)+'\\n')).catch(e=>{process.stdout.write(JSON.stringify({ok:false,error:e.code,read_delivery:e.read_delivery})+'\\n');process.exitCode=1;});`;
 const args=probe?[join(pkg,'dist/cli.cjs'),'probe','--profile',file]:sdk?['-e',program,join(pkg,'dist/candidates.cjs'),file]:
  [join(pkg,'dist',inspect?'memory-review-cli.cjs':'candidates-cli.cjs'),'--profile',file];
 const child=spawn('node',args,{cwd:ROOT,env:process.env,stdio:['pipe','pipe','pipe']});let out='',err='';
 child.stdout.on('data',b=>{out+=b;if(out.length>1048576)child.kill('SIGKILL');});child.stderr.on('data',b=>{err+=b;if(err.length>1048576)child.kill('SIGKILL');});child.stdin.on('error',()=>{});
 const timer=setTimeout(()=>child.kill('SIGKILL'),40000);
 try{child.stdin.end(input?JSON.stringify(input):'');const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  assert.equal(err,'');assert.ok(!out.includes('PRIVATE_CANDIDATE'));if(secret)assert.ok(!out.includes(secret));return {code,r:JSON.parse(out)};
 }finally{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
}
try{
 await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)',[source]);await store.register({agent_id:'list-fixture',agent_type:'custom'});
 const entries=[];const sourceRows=Array.from({length:33},(_,i)=>({type:'preference',content:'PRIVATE_CANDIDATE_'+i+'x'.repeat(i===0?60000:1000),
  ...(i>=27?{project_id:i<31?'mine':'foreign'}:{}),visibility:i%2?'source':'private',confidence:i===0?0.37:null}));
 for(let i=0;i<sourceRows.length;i+=8)entries.push(...(await store.commit({agent_id:'list-fixture',event_id:'seed-'+i,consent:true,memories:sourceRows.slice(i,i+8)})).entries);
 await store.review({memory_id:entries[25].id,expected_revision:1,event_id:'activate',status:'active'});
 await store.review({memory_id:entries[26].id,expected_revision:1,event_id:'archive',status:'archived'});
 const captured=await store.capture({agent_id:'list-fixture',event_id:'raw',transcript:'PRIVATE_CANDIDATE raw input',consent:true});
 const bytes=Buffer.from('PRIVATE_CANDIDATE document'),d=await docs.documentImport({agent_id:'list-fixture',event_id:'doc',consent:true,
  label:'test.txt',content_base64:bytes.toString('base64'),content_sha256:hash(bytes)});
 const queued=await docs.documentQueue({document_id:d.document_id,event_id:'fragments'});
 save();let v=await run(null,{probe:true});assert.equal(v.code,0);Object.assign(profile,{expected_instance:v.r.identity.instance_id,expected_actor:v.r.identity.actor_key});save();
 const expected=entries.slice(0,25).map(r=>r.id).concat(captured.input_id).sort(),before=await fingerprint();
 // The independent expected set comes from explicit seed receipts, not list output.
 let all=[],next;do{v=await run(selection(next?{after_id:next}:{}));assert.equal(v.code,0,JSON.stringify(v.r));
  assert.ok(v.r.page.returned<=10);all.push(...v.r.page.memories.map(m=>m.id));next=v.r.page.next_after;
  assert.equal(v.r.page.has_more,next!==null);
 }while(next);
 assert.deepEqual(all,expected);assert.equal(new Set(all).size,expected.length);pass();
 v=await run(selection({limit:50}),{sdk:true});assert.equal(v.code,0);assert.equal(v.r.page.returned,26);assert.equal(v.r.page.has_more,false);pass();
 assert.ok(v.r.page.memories.some(m=>m.id===entries[0].id),'Long content must not crowd metadata out');pass();
 assert.ok(v.r.page.memories.some(m=>m.id===captured.input_id),'Explicit capture input remains a candidate, not confirmed knowledge');pass();
 assert.ok(v.r.page.memories.every(m=>m.origin_kind==='agent'&&m.status==='candidate'));assert.ok(!all.includes(queued.fragments[0].memory_id));pass();
 v=await run(selection({after_id:expected.at(-1)}));assert.equal(v.code,0);assert.equal(v.r.page.returned,0);assert.equal(v.r.page.next_after,null);pass();
 v=await run({operation:'inspect',workspace:dir,consent:true,memory_id:all[0]},{inspect:true});assert.equal(v.code,0);assert.equal(v.r.memory.id,all[0]);pass();
 profile.project_id='mine';save();v=await run(selection({limit:50}),{sdk:true});assert.equal(v.code,0);
 assert.deepEqual(v.r.page.memories.map(m=>m.id),expected.concat(entries.slice(27,31).map(e=>e.id)).sort());pass();
 for(const bad of [{project_id:'foreign'},{limit:51},{consent:false},{include_text:true},{after_id:'bad'}]){
  v=await run(selection(bad));assert.equal(v.code,1);assert.equal(v.r.page,undefined);
 }pass();delete profile.project_id;save();
 assert.deepEqual(await fingerprint(),before);pass();
 // A candidate activated between pages drops out; ID-based continuation still
 // returns strictly later IDs. No global snapshot or count is claimed.
 const first=await run(selection({limit:2})),cursor=first.r.page.next_after,id=first.r.page.memories[0].id;
 await store.review({memory_id:id,expected_revision:1,event_id:'between-pages',status:'active'});
 const changed=await fingerprint();v=await run(selection({after_id:cursor,limit:50}));assert.equal(v.code,0);
 assert.deepEqual(v.r.page.memories.map(m=>m.id),expected.filter(n=>n>cursor));assert.deepEqual(await fingerprint(),changed);pass();
 const listener=createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=listener.address().port;await new Promise(r=>listener.close(r));
 tokenName=source+'-http';secret='gbrain_'+randomBytes(32).toString('hex');
 await engine.executeRaw('INSERT INTO access_tokens(name,token_hash,scopes,permissions) VALUES($1,$2,$3::text[],$4::text::jsonb)',
  [tokenName,hash(secret),'{read,write}',JSON.stringify({source_id:source,takes_holders:['world']})]);
 server=spawn(process.execPath,[ROOT+'/src/cli.mjs','mcp','--http','--bind','127.0.0.1','--port',String(port),'--suppress-bootstrap-token'],
  {cwd:ROOT,env:{...process.env,GBRAIN_SWEEP:'0',GBRAIN_ADMIN_BOOTSTRAP_TOKEN:randomBytes(32).toString('hex')},stdio:['ignore','ignore','pipe']});server.stderr.on('data',()=>{});
 let ready=false;for(let i=0;i<100;i++){try{ready=(await fetch(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.timeout(300)})).ok;}catch{}if(ready)break;await new Promise(r=>setTimeout(r,100));}assert.ok(ready);
 const url=`http://127.0.0.1:${port}/mcp`,client=new Client({name:'candidates-fixture',version:'1'}),transport=new StreamableHTTPClientTransport(new URL(url),{requestInit:{headers:{Authorization:'Bearer '+secret}}});let own;
 try{
  await client.connect(transport);let found=false,offset;
  do{const list=await client.listTools(offset?{cursor:offset}:{});const tool=list.tools.find(t=>t.name==='ultra_personal_candidates');
   if(tool){found=true;assert.ok(tool.inputSchema.properties.request_id);assert.ok(!tool.inputSchema.properties.include_text);}offset=list.nextCursor;
  }while(offset);assert.ok(found);pass();
  const call=async(name,args)=>{const response=await client.callTool({name,arguments:args});assert.ok(!response.isError);return JSON.parse(response.content[0].text);};
  await call('ultra_agent_register',{agent_id:'http-fixture'});
  own=(await call('ultra_memory_commit',{agent_id:'http-fixture',event_id:'http',consent:true,memories:[{type:'goal',content:'PRIVATE_CANDIDATE different owner'}]})).entries[0];
  const invalid=await client.callTool({name:'ultra_personal_candidates',arguments:{request_id:'bad',include_text:true}});assert.equal(invalid.isError,true);pass();
 }finally{try{await transport.terminateSession();}finally{await client.close();}}
 const ownedBefore=await fingerprint();v=await run(selection({limit:50}));assert.equal(v.code,0);assert.ok(!v.r.page.memories.some(m=>m.id===own.id));pass();
 process.env.ULTRABRAIN_CANDIDATES_TEST_TOKEN=secret;
 profile={format:1,source,workspace:dir,server:{transport:'http',url,bearer_env:'ULTRABRAIN_CANDIDATES_TEST_TOKEN'}};save();
 v=await run(null,{probe:true});assert.equal(v.code,0);Object.assign(profile,{expected_instance:v.r.identity.instance_id,expected_actor:v.r.identity.actor_key});save();
 await engine.executeRaw("UPDATE access_tokens SET scopes='{read}'::text[] WHERE name=$1",[tokenName]);
 v=await run(selection(),{sdk:true});assert.equal(v.code,0);assert.deepEqual(v.r.page.memories.map(m=>m.id),[own.id]);pass();
 assert.deepEqual(await fingerprint(),ownedBefore);pass();
 const actor=profile.expected_actor;profile.expected_actor='b'.repeat(64);save();v=await run(selection());assert.equal(v.code,1);assert.equal(v.r.error,'identity_mismatch');pass();
 profile.expected_actor=actor;save();await engine.executeRaw('UPDATE access_tokens SET revoked_at=now() WHERE name=$1',[tokenName]);
 v=await run(selection());assert.equal(v.code,1);assert.equal(v.r.page,undefined);assert.deepEqual(await fingerprint(),ownedBefore);pass();
 const report={passed:true,checks,mode:'actual installed Node CLI/SDK, official MCP and PostgreSQL, stdio/authenticated HTTP',
  global_candidates:26,project_candidates:30,read_denial_phases_six_tables_unchanged:true,body_fields_returned:0,
  generator_calls:0,external_model_calls:0,user_host_verified:false};
 if(process.env.ULTRABRAIN_CANDIDATES_REPORT)writeFileSync(process.env.ULTRABRAIN_CANDIDATES_REPORT,JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report));
}finally{
 delete process.env.ULTRABRAIN_CANDIDATES_TEST_TOKEN;
 if(server&&server.exitCode===null&&server.signalCode===null){server.kill('SIGTERM');const timer=setTimeout(()=>server.kill('SIGKILL'),5000);await once(server,'close');clearTimeout(timer);}
 if(tokenName)await engine.executeRaw('DELETE FROM access_tokens WHERE name=$1',[tokenName]);await engine.disconnect();rmSync(dir,{recursive:true,force:true});
}
