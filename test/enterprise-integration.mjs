/** Real PostgreSQL + two independent authenticated HTTP server processes.
 * Controlled handler barriers below validate admission, not model performance.
 */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {connect,ROOT,loadNative} from '../src/runtime.mjs';
import {configureEnterpriseSource,enterpriseStatus,enterpriseAudit,enterpriseGuard} from '../src/enterprise.mjs';
import {GOVERNED_TOOLS} from '../src/enterprise-policy.mjs';
import {Client} from '../vendor/gbrain/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import {StreamableHTTPClientTransport} from '../vendor/gbrain/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';
assert.equal(process.env.ULTRABRAIN_TEST_ALLOW_WRITE,'1');
const engine=await connect(),tag=randomBytes(5).toString('hex'),source='enterprise-'+tag,uri=`ultra://${source}/`;
const {dispatchToolCall}=await loadNative('src/mcp/dispatch.ts');
const {OperationError}=await loadNative('src/core/ops/contract.ts');
const children=[],clients=[],tokens=[];let checks=0;const pass=()=>checks++;
const local=async(name,p)=>{const r=await dispatchToolCall(engine,name,p,{sourceId:source,remote:false,transport:'stdio'});assert.ok(!r.isError,'local fixture creation failed');return JSON.parse(r.content[0].text);};
const mint=async(name)=>{
 const token='gbrain_'+randomBytes(32).toString('hex');tokens.push(source+'-'+name);
 await engine.executeRaw('INSERT INTO access_tokens(name,token_hash,scopes,permissions) VALUES($1,$2,$3::text[],$4::text::jsonb)',
  [source+'-'+name,createHash('sha256').update(token).digest('hex'),'{read,write}',JSON.stringify({source_id:source,takes_holders:['world']})]);return token;
};
async function start(){
 const sock=createServer();sock.listen(0,'127.0.0.1');await once(sock,'listening');const port=sock.address().port;await new Promise(r=>sock.close(r));
 const proc=spawn(process.execPath,[ROOT+'/src/cli.mjs','mcp','--profile','governed','--http','--port',String(port),'--suppress-bootstrap-token'],{
  cwd:ROOT,env:{...process.env,GBRAIN_SWEEP:'0',GBRAIN_ADMIN_BOOTSTRAP_TOKEN:randomBytes(32).toString('hex')},stdio:['ignore','ignore','pipe']});children.push(proc);
 let err='';proc.stderr.on('data',x=>{err=(err+x).slice(-8192);});
 let ready=false;
 for(let i=0;i<150;i++){if(proc.exitCode!==null)break;try{ready=(await fetch(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.timeout(500)})).ok;}catch{}if(ready)break;await new Promise(r=>setTimeout(r,100));}
 assert.ok(ready,'isolated governed server failed to start');return `http://127.0.0.1:${port}/mcp`;
}
async function client(endpoint,token){const c=new Client({name:'enterprise-fixture',version:'0.9.0'});clients.push(c);
 await c.connect(new StreamableHTTPClientTransport(new URL(endpoint),{requestInit:{headers:{Authorization:`Bearer ${token}`}},reconnectionOptions:{maxRetries:0}}));return c;}
const call=(c,name,p={})=>c.callTool({name,arguments:p});
const value=r=>{assert.ok(!r.isError,'governed operation unexpectedly rejected');assert.ok(!r._meta?.brain_hot_memory,'ungoverned metadata returned');return JSON.parse(r.content[0].text);};
const error=r=>{assert.equal(r.isError,true,'operation unexpectedly accepted');return JSON.parse(r.content[0].text).error;};
let revision=0;
const configure=async policy=>{const r=await configureEnterpriseSource(engine,source,revision,policy);revision=r.revision;return r;};
const resetWindow=async()=>engine.executeRaw('DELETE FROM ultrabrain.enterprise_rate_windows WHERE source_id=$1',[source]);
try{
 await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)',[source]);
 await local('put_page',{slug:'guide',content:'---\ntype: note\nvisibility: world\n---\nApproved enterprise fixture.'});
 await local('remember',{fact:'unlinked-retiredcanary-not-for-ambient-metadata',provenance:'Synthetic fixture',visibility:'world'});
 const token=await mint('writer'),otherToken=await mint('other');
 const endpoint=await start(),secondEndpoint=await start();pass();
 const first=await client(endpoint,token),second=await client(secondEndpoint,token),other=await client(endpoint,otherToken);
 const tools=(await first.listTools()).tools.map(x=>x.name);
 assert.equal(tools.length,GOVERNED_TOOLS.length);assert.deepEqual([...tools].sort(),[...GOVERNED_TOOLS].sort());pass();
 for(const [name,p] of [['recall',{}],['get_page',{slug:'guide'}],['query',{sql:'select 1'}],['context_pack',{}],['request_tools',{operations:['recall']}]])
  assert.equal(error(await call(first,name,p)),'unknown_operation');pass();
 assert.equal(error(await call(first,'ultra_identity')),'enterprise_source_not_enrolled');pass();
 await configure({});
 assert.equal(value(await call(first,'ultra_identity')).source_id,source);pass();
 const read=value(await call(first,'ultra_read',{uri:uri+'guide',level:'L2'}));assert.match(read.content,/Approved enterprise/);pass();
 assert.equal(error(await call(first,'ultra_write',{uri:uri+'blocked',content:'DO-NOT-STORE'})),'enterprise_read_only');pass();
 assert.equal(error(await call(first,'ultra_read',{uri:uri+'guide',memory_policy:'history'})),'enterprise_history_disabled');pass();
 assert.equal(error(await call(first,'ultra_project_history',{project_id:'project'})),'enterprise_history_disabled');pass();
 assert.equal(value(await call(first,'ultra_recall',{uri})).facts.length,0);pass();
 // The static raw fact remains, but cannot ride the metadata of ANY allowed identity response.
 assert.ok(!JSON.stringify(await call(first,'ultra_identity')).includes('unlinked-retiredcanary'));pass();
 await configure({mode:'read-write',allow_history:true});
 value(await call(first,'ultra_write',{uri:uri+'new',content:'---\ntype: note\nvisibility: world\n---\nnewcanary'}));
 assert.match(value(await call(second,'ultra_read',{uri:uri+'new',level:'L2'})).content,/newcanary/);pass();
 const capture={session_id:'enterprise-session',event_id:'immutable',transcript:'PRIVATE_TRANSCRIPT_NEVER_IN_AUDIT',defer_extraction:true};
 assert.equal(value(await call(first,'ultra_commit_session',capture)).storage,'journaled');
 assert.equal(value(await call(second,'ultra_commit_session',capture)).storage,'journaled');
 assert.equal((await engine.executeRaw("SELECT count(*)::integer AS n FROM ultrabrain.session_receipts WHERE source_id=$1 AND session_id='enterprise-session'",[source]))[0].n,1);pass();
 await configure({mode:'disabled'});assert.equal(error(await call(second,'ultra_identity')),'enterprise_source_disabled');pass();
 const conflict=await Promise.allSettled([configureEnterpriseSource(engine,source,revision,{mode:'read-only'}),configureEnterpriseSource(engine,source,revision,{mode:'read-write'})]);
 assert.equal(conflict.filter(x=>x.status==='fulfilled').length,1);assert.equal(conflict.find(x=>x.status==='rejected').reason.code,'revision_conflict');revision++;pass();
 // Exact shared fixed-window admission across TWO separate server processes.
 await configure({mode:'read-write',requests_per_minute:5,actor_requests_per_minute:5,max_inflight:32,actor_max_inflight:32});await resetWindow();
 if(Date.now()%60000>56000)await new Promise(r=>setTimeout(r,60050-Date.now()%60000));
 const batch=await Promise.all(Array.from({length:20},(_,i)=>call(i%2?first:second,'ultra_identity')));
 assert.equal(batch.filter(x=>!x.isError).length,5);
 assert.ok(batch.filter(x=>x.isError).every(x=>error(x)==='enterprise_rate_limited'));pass();
 // Independent actor quota with a shared source ceiling, no quota gain on reconnect.
 await configure({mode:'read-write',requests_per_minute:20,actor_requests_per_minute:3,max_inflight:32,actor_max_inflight:32});await resetWindow();
 const a=await Promise.all(Array.from({length:5},()=>call(first,'ultra_identity')));
 const b=await Promise.all(Array.from({length:5},()=>call(other,'ultra_identity')));
 assert.equal(a.filter(x=>!x.isError).length,3);assert.equal(b.filter(x=>!x.isError).length,3);
 assert.equal(error(await call(second,'ultra_identity')),'enterprise_rate_limited');pass();
 // Real SQL with deterministic handler barriers: concurrency is per guard/process.
 await configure({mode:'read-write',max_inflight:1,actor_max_inflight:1});await resetWindow();
 const guard=enterpriseGuard({OperationError}),ctx={engine,sourceId:source,remote:true,transport:'http',auth:{sourceId:source,principal:{kind:'oauth_client',id:'barrier'}}};
 let release,entered;const hold=new Promise(r=>release=r),ready=new Promise(r=>entered=r);let executed=0;
 const op={name:'ultra_identity',mutating:false,handler:async()=>{executed++;entered();await hold;return {fixture:true};}};
 const running=guard.execute(op,ctx,{});await ready;
 await assert.rejects(guard.execute(op,ctx,{}),{code:'enterprise_concurrency_limited'});assert.equal(executed,1);release();await running;assert.equal(guard.gate.tracked,0);pass();
 // Untrusted error text cannot enter the service audit or caller diagnostics.
 await assert.rejects(guard.execute({...op,handler:async()=>{throw new Error('PRIVATE_PROVIDER_TOKEN');}},ctx,{}),{code:'operation_failed'});pass();
 // Missing terminal receipt is visible rather than silently treated as a successful audit.
 let txCount=0,writes=0;
 const failingTerminal={kind:'postgres',transaction:fn=>++txCount===1?engine.transaction(fn):Promise.reject(new Error('injected audit outage'))};
 await assert.rejects(guard.execute({...op,mutating:true,handler:async()=>{writes++;return {stored:true};}},{...ctx,engine:failingTerminal},{}),{code:'enterprise_audit_unconfirmed'});
 assert.equal(writes,1);assert.equal(guard.gate.tracked,0);pass();
 await assert.rejects(guard.execute({...op,handler:async()=>{writes++;}},{...ctx,engine:{kind:'postgres',transaction:()=>Promise.reject(Error('unavailable'))}},{}),{code:'enterprise_admission_unavailable'});
 assert.equal(writes,1);pass();
 const status=await enterpriseStatus(engine,source);assert.equal(status.enrolled,true);assert.equal(status.admissions_without_result_last_24h,1);pass();
 const audit=await enterpriseAudit(engine,source,{limit:1000});const serialized=JSON.stringify(audit);
 for(const secret of [token,otherToken,'PRIVATE_TRANSCRIPT_NEVER_IN_AUDIT','PRIVATE_PROVIDER_TOKEN','Approved enterprise fixture','newcanary'])assert.ok(!serialized.includes(secret));
 assert.ok(audit.events.some(x=>x.outcome==='denied'));assert.ok(audit.events.some(x=>x.outcome==='succeeded'));pass();
 const part=await enterpriseAudit(engine,source,{limit:2}),next=await enterpriseAudit(engine,source,{after:Number(part.next_after),limit:2});
 assert.ok(BigInt(next.events[0].id)>BigInt(part.events.at(-1).id));pass();
 for(const sql of ["UPDATE ultrabrain.enterprise_audit SET code='tampered' WHERE source_id=$1",'DELETE FROM ultrabrain.enterprise_audit WHERE source_id=$1'])
  await assert.rejects(engine.executeRaw(sql,[source]));
 await assert.rejects(engine.executeRaw('TRUNCATE ultrabrain.enterprise_audit'));pass();
 // Host CLI status reads aggregate data, never enrolls a source implicitly.
 const host=spawn(process.execPath,[ROOT+'/src/cli.mjs','enterprise','status','--source',source],{cwd:ROOT,env:process.env,stdio:['ignore','pipe','pipe']});
 let output='';host.stdout.on('data',x=>output+=x);host.stderr.on('data',()=>{});const [code]=await once(host,'close');
 assert.equal(code,0);assert.equal(JSON.parse(output).source_id,source);pass();
 // Run the shipped load tool against an actual governed service, not an in-memory store.
 await configure({mode:'read-write',requests_per_minute:300,actor_requests_per_minute:300});await resetWindow();
 const temp=mkdtempSync(join(tmpdir(),'ub-load-')),tokenFile=join(temp,'token');
 try {
   writeFileSync(tokenFile,token,{mode:0o600});
   const bench=spawn(process.execPath,[ROOT+'/scripts/benchmark-mcp.mjs','--url',endpoint,'--token-file',tokenFile,'--uri',uri+'guide','--requests','50','--concurrency','2','--allow-load'],{cwd:ROOT,env:process.env,stdio:['ignore','pipe','pipe']});
   let report='';bench.stdout.on('data',x=>report+=x);bench.stderr.on('data',()=>{});const t=setTimeout(()=>bench.kill('SIGKILL'),20000);const [exit]=await once(bench,'close');clearTimeout(t);
   assert.equal(exit,0);const measured=JSON.parse(report);assert.equal(measured.successful_requests,50);assert.equal(measured.failed_requests,0);assert.ok(measured.success_latency_ms.p95>0);
   assert.ok(!report.includes(token)&&!report.includes('Approved enterprise fixture'));pass();
   if(process.env.ULTRABRAIN_ENTERPRISE_BENCHMARK_OUTPUT)writeFileSync(process.env.ULTRABRAIN_ENTERPRISE_BENCHMARK_OUTPUT,JSON.stringify(measured,null,2)+'\n',{mode:0o600});
 } finally {rmSync(temp,{recursive:true,force:true});}
 await engine.executeRaw('UPDATE access_tokens SET revoked_at=now() WHERE name=$1',[source+'-writer']);
 const revoked=await call(first,'ultra_identity').then(r=>r.isError,()=>true);assert.ok(revoked);pass();
 console.log(`PASS ${checks} enterprise controls: two-process rate limits, governed HTTP surface, live policies, SQL audit, controlled concurrency and fault injection`);
}finally{
 for(const c of clients)try{await c.close();}catch{}
 for(const p of children)if(p.exitCode===null){p.kill('SIGTERM');const t=setTimeout(()=>p.kill('SIGKILL'),5000);await once(p,'exit');clearTimeout(t);}
 await engine.executeRaw('DELETE FROM access_tokens WHERE name=ANY($1::text[])',[tokens]);await engine.disconnect();
}
