/** Real built Node CLI and MCP proxy; synthetic files and an isolated PostgreSQL only. */
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import {connect,ROOT} from '../src/runtime.mjs';
import {PersonalMemoryStore} from '../src/personal-memory-store.mjs';
import {Client} from '../vendor/gbrain/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import {StdioClientTransport} from '../vendor/gbrain/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
assert.equal(process.env.ULTRABRAIN_TEST_ALLOW_WRITE,'1');
const engine=await connect(),source='docclient-'+randomBytes(4).toString('hex'),dir=mkdtempSync(join(tmpdir(),'ub-document-client-'));
const cli=join(ROOT,'packages/ultrabrain-client/dist/cli.cjs'),profilePath=join(dir,'profile.json'),path=join(dir,'原文.md');
const bytes=Buffer.from('\uFEFF不要删除。🙂\r\n'.repeat(4000)),hash=createHash('sha256').update(bytes).digest('hex');writeFileSync(path,bytes);
const profile={format:1,source,project_id:'file-project',workspace:ROOT,server:{transport:'stdio',command:process.execPath,args:[ROOT+'/src/cli.mjs','mcp'],env:{ULTRABRAIN_HOME:process.env.ULTRABRAIN_HOME,GBRAIN_SOURCE:source,GBRAIN_SWEEP:'0'}}};
let checks=0;const pass=()=>checks++;
const save=()=>writeFileSync(profilePath,JSON.stringify(profile),{mode:0o600});
async function run(command,input){
 const p=spawn('node',[cli,command,'--profile',profilePath],{cwd:ROOT,env:process.env,stdio:['pipe','pipe','pipe']});let out='';
 p.stdout.on('data',b=>{out+=b;if(out.length>1000000)p.kill('SIGKILL');});p.stderr.on('data',()=>{});p.stdin.on('error',()=>{});p.stdin.end(input?JSON.stringify(input):undefined);
 const timer=setTimeout(()=>p.kill('SIGKILL'),40000);
 try{const code=await new Promise((done,fail)=>{p.once('error',fail);p.once('close',done);});return {code,raw:out,result:JSON.parse(out)};}finally{clearTimeout(timer);}
}
async function proxy(fn){
 const c=new Client({name:'document-standard-client',version:'test'}),tr=new StdioClientTransport({command:'node',args:[cli,'mcp','--profile',profilePath],stderr:'pipe'});tr.stderr?.on('data',()=>{});
 try{await c.connect(tr);await fn(c);}finally{await c.close();}
}
const input={path,agent_id:'document-cli',event_id:'stable-import',consent:true};
const count=async()=>Number((await engine.executeRaw('SELECT count(*)::int AS n FROM ultrabrain.personal_documents WHERE source_id=$1',[source]))[0].n);
try{
 await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)',[source]);save();
 let p=await run('probe');assert.equal(p.code,0);Object.assign(profile,{expected_instance:p.result.identity.instance_id,expected_actor:p.result.identity.actor_key});save();pass();
 p=await run('document-import',input);assert.equal(p.result.error,'capture_disabled');assert.equal(await count(),0);pass();
 profile.allow_documents=true;save();
 const store=new PersonalMemoryStore({engine,sourceId:source,remote:false,transport:'stdio'});
 await store.register({agent_id:'document-cli',agent_type:'coding_agent',capabilities:['code','files'],workspace:'/synthetic/workspace'});
 const prior=(await store.agents()).agents[0];
 p=await run('document-import',{...input,consent:false});assert.equal(p.result.error,'capture_disabled');assert.equal(await count(),0);pass();
 p=await run('document-import',input);assert.equal(p.code,0);const document=p.result.result;assert.equal(document.content_sha256,hash);assert.equal(document.project_id,'file-project');assert.ok(!p.raw.includes(bytes.toString('utf8').slice(0,20)));pass();
 const after=(await store.agents()).agents[0];assert.deepEqual(after,prior,'Import must not mutate existing Agent metadata or revision');pass();
 p=await run('document-import',input);assert.equal(p.result.result.document_id,document.document_id);assert.equal(await count(),1);pass();
 await proxy(async c=>{
   const names=(await c.listTools()).tools.map(t=>t.name);for(const suffix of ['import','read','list','queue','archive'])assert.ok(names.includes('ultra_personal_document_'+suffix));
   assert.ok(!names.includes('ultra_personal_capture')&&!names.includes('ultra_memory_commit'));pass();
   const call=async(name,args)=>{const r=await c.callTool({name,arguments:args});assert.ok(!r.isError);return JSON.parse(r.content[0].text);};
   const original=await call('ultra_personal_document_read',{document_id:document.document_id});assert.deepEqual(Buffer.from(original.content_base64,'base64'),bytes);pass();
   const queued=await call('ultra_personal_document_queue',{document_id:document.document_id,event_id:'all-fragments'});
   assert.ok(queued.fragments.length>1);assert.equal(queued.model_calls,0);assert.equal(queued.fragments.at(-1).byte_end,bytes.length);pass();
   const rows=await engine.executeRaw('SELECT content,agent_id,project_id FROM ultrabrain.personal_memories WHERE source_id=$1 ORDER BY created_at,id',[source]);
   assert.ok(rows.every(x=>x.project_id==='file-project'&&x.agent_id==='document-cli'));pass();
   const archived=await call('ultra_personal_document_archive',{document_id:document.document_id,event_id:'archive-file'});assert.equal(archived.original_retained,true);pass();
 });
 profile.allow_documents=false;save();await proxy(async c=>{
   const names=(await c.listTools()).tools.map(x=>x.name);assert.ok(names.includes('ultra_personal_document_read'));assert.ok(!names.includes('ultra_personal_document_import'));pass();
 });
 console.log(`PASS ${checks} packaged document-client checks: actual CLI/MCP/provenance/original bytes/scope/queue/archive`);
}finally{await engine.disconnect();rmSync(dir,{recursive:true,force:true});}
