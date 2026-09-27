/** Installed Node CLI/SDK correction -> official MCP -> new synthetic PostgreSQL source.
 * One explicit synthetic consolidation establishes a real derivation; no external model.
 */
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {once} from 'node:events';import {createServer} from 'node:net';
import {Client} from '../vendor/gbrain/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import {StreamableHTTPClientTransport} from '../vendor/gbrain/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';
import {join} from 'node:path';import {tmpdir} from 'node:os';import {spawn} from 'node:child_process';
import {connect,ROOT} from '../src/runtime.mjs';import {PersonalMemoryStore} from '../src/personal-memory-store.mjs';
import {PersonalConsolidator} from '../src/personal-consolidation.mjs';import {personalModelProfile} from '../src/personal-consolidation-core.mjs';
import {memoryReadBarrierPreload} from './helpers/installed-client-preload.mjs';
assert.equal(process.env.ULTRABRAIN_TEST_ALLOW_WRITE,'1');
const pkg=process.env.ULTRABRAIN_TASK_CLIENT_ROOT;assert.ok(pkg,'Installed package required');
const dir=mkdtempSync(join(tmpdir(),'ub-correction-real-')),file=join(dir,'profile.json');
const source='correction-'+randomBytes(5).toString('hex'),engine=await connect(),ctx={engine,sourceId:source,remote:false,transport:'stdio'},store=new PersonalMemoryStore(ctx);
let server,tokenName,secret;
const hash=s=>createHash('sha256').update(s).digest('hex'),checks=[];let generations=0;
const tables=['personal_memories','personal_events','personal_consolidations','agent_registry','personal_documents','personal_document_fragments'];
const fingerprint=async()=>{const f={};for(const t of tables)f[t]=(await engine.executeRaw(`SELECT md5(coalesce(string_agg(row_to_json(t)::text,',' ORDER BY row_to_json(t)::text),'')) AS h FROM ultrabrain.${t} t WHERE source_id=$1`,[source]))[0].h;return f;};
const profile={format:1,source,workspace:dir,allow_capture:true,project_id:'chosen',server:{transport:'stdio',command:process.execPath,args:[ROOT+'/src/cli.mjs','mcp'],
 env:{ULTRABRAIN_HOME:process.env.ULTRABRAIN_HOME,GBRAIN_SOURCE:source,GBRAIN_SWEEP:'0'}}};
const save=()=>writeFileSync(file,JSON.stringify(profile),{mode:0o600});
const inspect=id=>({operation:'inspect',workspace:dir,consent:true,memory_id:id});
const editable=m=>Object.fromEntries(['type','content','provenance','importance','confidence','visibility','project_id'].map(k=>[k,m[k]]));
const pins=(m,event)=>({...inspect(m.id),event_id:event,expected_revision:m.revision,expected_content_hash:m.content_hash,
 expected_status:m.status,expected_visibility:m.visibility,expected_project_id:m.project_id});
const correction=(m,event,changes={})=>({...pins(m,event),operation:'correct',acknowledge_reset:true,memory:{...editable(m),...changes}});
const activate=(m,event)=>({...pins(m,event),operation:'apply',status:'active'});
const read=id=>store.read({memory_id:id}).then(x=>x.memory);
async function run(input,{sdk=false,probe=false,race}={}){
 const script=`const fs=require('node:fs'),{reviewClientMemory}=require(process.argv[1]);reviewClientMemory(JSON.parse(fs.readFileSync(process.argv[2],'utf8')),JSON.parse(fs.readFileSync(0,'utf8')))
 .then(r=>process.stdout.write(JSON.stringify(r)+'\\n')).catch(e=>{process.stdout.write(JSON.stringify({ok:false,error:e.code,write_delivery:e.write_delivery})+'\\n');process.exitCode=1;});`;
 const args=probe?[join(pkg,'dist/cli.cjs'),'probe','--profile',file]:sdk?['-e',script,join(pkg,'dist/memory-review.cjs'),file]:[join(pkg,'dist/memory-review-cli.cjs'),'--profile',file];
 if(race){const p=join(dir,'preload.cjs');writeFileSync(p,memoryReadBarrierPreload(pkg));args.unshift('--require',p);}
 const c=spawn('node',args,{cwd:ROOT,env:process.env,stdio:['pipe','pipe','pipe',...(race?['ipc']:[])]});let out='',err='',raceError;
 c.stdout.on('data',b=>{out+=b;if(out.length>1048576)c.kill('SIGKILL');});c.stderr.on('data',b=>{err+=b;if(err.length>1048576)c.kill('SIGKILL');});c.stdin.on('error',()=>{});
 if(race)c.on('message',m=>{if(m.observed)race().then(()=>c.send({continue:true})).catch(e=>{raceError=e;c.kill('SIGKILL');});});
 const timer=setTimeout(()=>c.kill('SIGKILL'),40000);
 try{c.stdin.end(input?JSON.stringify(input):'');const status=await new Promise((res,rej)=>{c.once('error',rej);c.once('close',res);});
  if(raceError)throw raceError;assert.equal(err,'');if(secret)assert.ok(!out.includes(secret));assert.ok(!out.includes('PRIVATE_CORRECTION')&&!out.includes(dir));return {status,r:JSON.parse(out)};
 }finally{clearTimeout(timer);if(c.exitCode===null&&c.signalCode===null)c.kill('SIGKILL');}
}
const pass=name=>checks.push(name);
try{
 await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)',[source]);await store.register({agent_id:'correction-fixture'});
 const ids=(await store.commit({agent_id:'correction-fixture',event_id:'seed',consent:true,memories:[
  {type:'preference',content:'PRIVATE_CORRECTION original',provenance:'Synthetic original',visibility:'source',importance:'high',confidence:0.5},
  {type:'goal',content:'PRIVATE_CORRECTION competing',provenance:'Synthetic competing'}]})).entries.map(x=>x.id);
 await store.review({memory_id:ids[0],expected_revision:1,event_id:'first-activate',status:'active'});
 // Derivation from the real consolidator, not a fabricated ownership hash.
 const transcript='PRIVATE_CORRECTION captured quote';
 const captured=await store.capture({agent_id:'correction-fixture',event_id:'capture',transcript,consent:true});
 const model=personalModelProfile({enabled:true,model:'fixture:correction',revision:'synthetic',timeout_ms:120000});
 const worker=new PersonalConsolidator(ctx,async()=>({profile:model,generate:async()=>{generations++;return {text:JSON.stringify({memories:[
  {type:'preference',content:'PRIVATE_CORRECTION derived',quote:transcript}]})};}}));
 const processed=await worker.process({expected_source:source,job_id:captured.job_id,allow_model_call:true});assert.equal(processed.results[0].state,'completed');
 const derivedId=processed.results[0].result.entries[0].id;
 await store.review({memory_id:derivedId,expected_revision:1,event_id:'derived-activate',status:'active'});
 save();let v=await run(null,{probe:true});assert.equal(v.status,0);Object.assign(profile,{expected_instance:v.r.identity.instance_id,expected_actor:v.r.identity.actor_key});save();
 const m=await read(ids[0]),q=correction(m,'replace',{content:'  PRIVATE_CORRECTION replacement e\u0301🙂\r\n  ',provenance:'Synthetic user correction',confidence:null,visibility:'private',project_id:'chosen'});
 const before=await fingerprint();v=await run(inspect(m.id));assert.equal(v.r.memory.importance,'high');assert.equal(v.r.memory.confidence,0.5);pass('complete editable inspection metadata');
 for(const [name,bad]of [['consent',{...q,consent:false}],['reset',{...q,acknowledge_reset:false}],['destination',{...q,memory:{...q.memory,project_id:'elsewhere'}}],
  ['missing field',{...q,memory:(({confidence,...rest})=>rest)(q.memory)}]]){
  v=await run(bad);assert.equal(v.status,1);assert.equal(v.r.write_delivery,'not_started');pass('preflight rejects '+name);
 }
 assert.deepEqual(await fingerprint(),before);pass('six tables unchanged during inspection and refusal');
 v=await run(q);assert.equal(v.status,0);assert.equal(v.r.receipt.status,'candidate');assert.equal(v.r.review_required,true);
 let current=await read(m.id);assert.equal(current.content,q.memory.content);assert.equal(current.project_id,'chosen');assert.equal(current.confidence,null);
 assert.equal(current.visibility,'private');assert.equal(current.last_confirmed,null);assert.equal(current.derivation,null);assert.equal(current.revision,m.revision+1);
 assert.ok(!(await store.context({project_id:'chosen'})).memories.some(x=>x.id===m.id));pass('full replacement candidate excluded from recall');
 const corrected=await fingerprint();for(const t of tables.filter(t=>!['personal_memories','personal_events'].includes(t)))assert.equal(corrected[t],before[t]);pass('only memory and event tables change');
 v=await run(q);assert.equal(v.status,1);assert.equal(v.r.write_delivery,'not_started');pass('stale apply does not repeat correction');
 v=await run({...q,operation:'replay-correction'},{sdk:true});assert.equal(v.status,0);assert.equal(v.r.receipt.replayed,true);pass('replay survives explicit project move');
 v=await run({...q,operation:'replay-correction',memory:{...q.memory,content:'PRIVATE_CORRECTION tampered replay'}});assert.equal(v.status,1);assert.equal(v.r.error,'conflict');pass('changed event payload refuses');
 v=await run({...q,operation:'replay-correction',event_id:'no-such-event'});assert.equal(v.status,1);assert.equal(v.r.error,'revision_conflict');pass('unknown historical event cannot mutate');
 assert.deepEqual(await fingerprint(),corrected);pass('six tables unchanged after replay and failed replay');
 v=await run(activate(current,'confirm-corrected'));assert.equal(v.status,0);assert.ok((await store.context({project_id:'chosen'})).memories.some(x=>x.id===m.id&&x.content===q.memory.content));pass('separate explicit confirmation enters recall');
 const confirmed=await fingerprint();v=await run({...q,operation:'replay-correction'});assert.equal(v.r.receipt.status,'candidate');assert.equal(v.r.current_state_verified,false);
 assert.equal((await read(m.id)).status,'active');assert.deepEqual(await fingerprint(),confirmed);pass('historical candidate receipt cannot downgrade current active state');
 const concurrent=await read(ids[1]);v=await run(correction(concurrent,'stale-correct',{content:'PRIVATE_CORRECTION stale draft'}),{race:()=>store.update({memory_id:concurrent.id,
 expected_revision:concurrent.revision,event_id:'winner',memory:{...editable(concurrent),content:'PRIVATE_CORRECTION concurrent winner'}})});
 assert.equal(v.status,1);assert.equal(v.r.error,'revision_conflict');assert.equal((await read(concurrent.id)).content,'PRIVATE_CORRECTION concurrent winner');pass('real concurrent update wins CAS');
 const input=await read(captured.input_id);v=await run(correction(input,'change-source',{content:transcript+' corrected'}),{sdk:true});assert.equal(v.status,0);
 assert.equal((await read(derivedId)).derivation_current,false);assert.ok(!(await store.context({})).memories.some(x=>x.id===derivedId));pass('corrected source invalidates dependent recall');
 const derived=await read(derivedId);assert.ok(derived.derivation);v=await run(correction(derived,'reconcile',{content:'PRIVATE_CORRECTION manually reconciled',provenance:'Explicit synthetic human reconciliation'}));
 assert.equal(v.status,0);const reconciled=await read(derivedId);assert.equal(reconciled.derivation,null);assert.equal(reconciled.last_confirmed,null);assert.equal(reconciled.status,'candidate');pass('explicit reconciliation clears real prior derivation and confirmation');
 v=await run(activate(reconciled,'reconfirm-reconciled'));assert.equal(v.status,0);assert.ok((await store.context({})).memories.some(x=>x.id===derivedId));pass('reconciled record requires separate confirmation');
 // A different owner created through actual authenticated MCP; never guessed actor keys.
 const share=(await store.commit({agent_id:'correction-fixture',event_id:'http-share',consent:true,memories:[
  {type:'goal',content:'PRIVATE_CORRECTION shared nonowner',visibility:'source'}]})).entries[0];
 await store.review({memory_id:share.id,expected_revision:1,event_id:'activate-share',status:'active'});
 const shared=await read(share.id),listener=createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');
 const port=listener.address().port;await new Promise(r=>listener.close(r));
 secret='gbrain_'+randomBytes(32).toString('hex');tokenName=source+'-http';
 await engine.executeRaw('INSERT INTO access_tokens(name,token_hash,scopes,permissions) VALUES($1,$2,$3::text[],$4::text::jsonb)',
  [tokenName,hash(secret),'{read,write}',JSON.stringify({source_id:source,takes_holders:['world']})]);
 server=spawn(process.execPath,[ROOT+'/src/cli.mjs','mcp','--http','--bind','127.0.0.1','--port',String(port),'--suppress-bootstrap-token'],
  {cwd:ROOT,env:{...process.env,GBRAIN_SWEEP:'0',GBRAIN_ADMIN_BOOTSTRAP_TOKEN:randomBytes(32).toString('hex')},stdio:['ignore','ignore','pipe']});server.stderr.on('data',()=>{});
 let ready=false;for(let i=0;i<100;i++){try{ready=(await fetch(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.timeout(300)})).ok;}catch{}if(ready)break;await new Promise(r=>setTimeout(r,100));}assert.ok(ready);
 const url=`http://127.0.0.1:${port}/mcp`,client=new Client({name:'correction-http-fixture',version:'1'});
 const transport=new StreamableHTTPClientTransport(new URL(url),{requestInit:{headers:{Authorization:'Bearer '+secret}}});let httpMemory;
 try{
  await client.connect(transport);const call=async(name,args)=>{const r=await client.callTool({name,arguments:args});assert.ok(!r.isError);return JSON.parse(r.content[0].text);};
  await call('ultra_agent_register',{agent_id:'http-correction'});
  const id=(await call('ultra_memory_commit',{agent_id:'http-correction',event_id:'http-seed',consent:true,memories:[
   {type:'preference',content:'PRIVATE_CORRECTION http owner'}]})).entries[0].id;
  httpMemory=(await call('ultra_memory_read',{memory_id:id})).memory;
 }finally{try{await transport.terminateSession();}finally{await client.close();}}
 process.env.ULTRABRAIN_CORRECTION_TEST_TOKEN=secret;
 profile.server={transport:'http',url,bearer_env:'ULTRABRAIN_CORRECTION_TEST_TOKEN'};delete profile.expected_actor;delete profile.expected_instance;save();
 v=await run(null,{probe:true});assert.equal(v.status,0);Object.assign(profile,{expected_instance:v.r.identity.instance_id,expected_actor:v.r.identity.actor_key});save();
 const httpRequest=correction(httpMemory,'http-correct',{content:'PRIVATE_CORRECTION HTTP corrected',provenance:'Explicit synthetic HTTP correction'});
 v=await run(httpRequest,{sdk:true});assert.equal(v.status,0);assert.equal(v.r.receipt.status,'candidate');pass('authenticated HTTP owner correction');
 const httpBefore=await fingerprint();v=await run({...httpRequest,operation:'replay-correction'});assert.equal(v.status,0);assert.equal(v.r.receipt.replayed,true);pass('authenticated HTTP correction journal replay');
 v=await run(correction(shared,'not-owned',{content:'PRIVATE_CORRECTION must not change shared record'}));assert.equal(v.status,1);assert.equal(v.r.error,'memory_review_not_owned');pass('shared nonowner correction refused');
 await engine.executeRaw("UPDATE access_tokens SET scopes='{read}'::text[] WHERE name=$1",[tokenName]);
 v=await run({...httpRequest,event_id:'read-only-correction',expected_revision:2,expected_status:'candidate',expected_content_hash:hash(httpRequest.memory.content),
  memory:{...httpRequest.memory,content:'PRIVATE_CORRECTION denied'}});assert.equal(v.status,1);assert.equal(v.r.error,'insufficient_scope');pass('read-only HTTP cannot correct');
 await engine.executeRaw('UPDATE access_tokens SET revoked_at=now() WHERE name=$1',[tokenName]);v=await run(httpRequest);assert.equal(v.status,1);pass('revoked token cannot start correction');
 assert.deepEqual(await fingerprint(),httpBefore);pass('six tables unchanged during HTTP replay and permission denials');
 assert.equal(generations,1);
 const report={passed:true,checks:checks.length,check_names:checks,mode:'actual installed Node CLI/SDK, official MCP stdio and authenticated HTTP, isolated PostgreSQL',
  injected_synthetic_generations:generations,external_model_calls:0,user_host_verified:false,read_replay_refusal_six_tables_unchanged:true};
 if(process.env.ULTRABRAIN_MEMORY_CORRECTION_REPORT)writeFileSync(process.env.ULTRABRAIN_MEMORY_CORRECTION_REPORT,JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report));
}finally{
 delete process.env.ULTRABRAIN_CORRECTION_TEST_TOKEN;
 if(server&&server.exitCode===null&&server.signalCode===null){server.kill('SIGTERM');const timer=setTimeout(()=>server.kill('SIGKILL'),5000);await once(server,'close');clearTimeout(timer);}
 if(tokenName)await engine.executeRaw('DELETE FROM access_tokens WHERE name=$1',[tokenName]);
 await engine.disconnect();rmSync(dir,{recursive:true,force:true});
}
