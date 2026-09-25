/** Disposable PostgreSQL + native MCP/official stdio SDK + actual console browser.
 * Preparation performs explicit synthetic writes; the observed/read phase is not allowed to mutate six application tables.
 */
import assert from 'node:assert/strict';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {connect,ROOT,loadNative} from '../src/runtime.mjs';
import {PersonalMemoryStore} from '../src/personal-memory-store.mjs';
import {PersonalDocumentStore} from '../src/personal-documents.mjs';
import {PersonalConsolidator} from '../src/personal-consolidation.mjs';
import {personalModelProfile} from '../src/personal-consolidation-core.mjs';
import {PersonalOverview} from '../src/personal-overview.mjs';
import {startPersonalConsole} from '../src/personal-console.mjs';
import {Client} from '../vendor/gbrain/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import {StdioClientTransport} from '../vendor/gbrain/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
assert.equal(process.env.ULTRABRAIN_TEST_ALLOW_WRITE,'1','Disposable database only');
const engine=await connect(),source='overview-'+randomBytes(5).toString('hex'),emptySource=source+'-empty';
const ctx={engine,sourceId:source,remote:false,transport:'stdio'},store=new PersonalMemoryStore(ctx);
const documentStore=new PersonalDocumentStore(ctx),overview=new PersonalOverview(ctx),token=randomBytes(32).toString('hex');
const {dispatchToolCall}=await loadNative('src/mcp/dispatch.ts');
const tables=['personal_memories','personal_events','personal_consolidations','personal_documents','personal_document_fragments','agent_registry'];
let checks=0,ui,generators=0;const pass=()=>checks++;
const stamp=async()=>{
 const result={};for(const table of tables)result[table]=(await engine.executeRaw(`SELECT md5(coalesce(string_agg(row_to_json(t)::text,',' ORDER BY row_to_json(t)::text),'')) AS hash FROM ultrabrain.${table} t WHERE source_id=$1`,[source]))[0].hash;
 return result;
};
const query=()=>({request_id:randomUUID()});
const selectGroups=r=>Object.fromEntries(['memories','jobs','documents','agents'].map(k=>[k,r[k]]));
const assertNoText=r=>{const raw=JSON.stringify(r);for(const marker of ['PRIVATE_ORIGINAL','PRIVATE_CANDIDATE','PRIVATE_SHARED','PRIVATE_DOCUMENT',token,store.actor])assert.ok(!raw.includes(marker));};
const call=async(input=query(),context=ctx)=>{
 const result=await dispatchToolCall(engine,'ultra_personal_overview',input,context),body=JSON.parse(result.content[0].text);
 if(result.isError)throw Object.assign(Error(body.error),{code:body.error});return body;
};
try{
 for(const id of [source,emptySource])await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)',[id]);
 for(const agent_id of ['overview-a','overview-b'])await store.register({agent_id});
 for(const [i,status,project]of [[0,'candidate',null],[1,'active','project-a'],[2,'archived','project-b'],[3,'active',null]]){
  const r=await store.commit({agent_id:'overview-a',event_id:'plain-'+i,consent:true,
   memories:[{type:'preference',content:'PRIVATE_CANDIDATE_plain_'+i,project_id:project}]});
  if(status!=='candidate')await store.review({memory_id:r.entries[0].id,expected_revision:1,event_id:'plain-review-'+i,status});
 }
 const profile=personalModelProfile({enabled:true,model:'fixture:overview',revision:'synthetic',timeout_ms:120000});
 const worker=new PersonalConsolidator(ctx,async()=>({profile,generate:async()=>{
  generators++;return {text:JSON.stringify({memories:[{type:'preference',content:'PRIVATE_CANDIDATE_derived',quote:'PRIVATE_ORIGINAL'}]})};
 }}));
 // One current active derivation, one stale active derivation, one stale candidate.
 for(let i=0;i<3;i++){
  const c=await store.capture({agent_id:'overview-b',event_id:'generated-'+i,transcript:'PRIVATE_ORIGINAL '+i,consent:true});
  const r=await worker.process({expected_source:source,job_id:c.job_id,allow_model_call:true});
  assert.equal(r.results[0].state,'completed');
  if(i<2)await store.review({memory_id:r.results[0].result.entries[0].id,expected_revision:1,event_id:'generated-review-'+i,status:'active'});
  if(i>0)await store.review({memory_id:c.input_id,expected_revision:1,event_id:'source-archive-'+i,status:'archived'});
 }
 // Controlled durable fixture states. No provider activity, leases stay far from wall-clock boundaries.
 for(const [name,state,attempts,minutes]of [['queued','queued',0,0],['live','processing',1,60],['expired','processing',1,-60],
  ['failed-one','failed',1,0],['failed-three','failed',3,0],['stale','stale',0,0]]){
  const c=await store.capture({agent_id:'overview-a',event_id:'state-'+name,transcript:'PRIVATE_ORIGINAL_state_'+name,consent:true});
  if(state!=='queued')await engine.executeRaw(`UPDATE ultrabrain.personal_consolidations SET state=$2,attempts=$3,
   lease_id=CASE WHEN $2='processing' THEN $4::uuid ELSE NULL END,
   lease_until=CASE WHEN $2='processing' THEN clock_timestamp()+$5*interval '1 minute' ELSE NULL END
   WHERE source_id=$6 AND actor_key=$7 AND id=$1::uuid`,[c.job_id,state,attempts,randomUUID(),minutes,source,store.actor]);
 }
 for(let i=0;i<2;i++){
  const bytes=Buffer.from('PRIVATE_DOCUMENT_'+i+'\n');
  const doc=await documentStore.documentImport({agent_id:'overview-a',event_id:'document-'+i,consent:true,label:'synthetic.txt',
   content_base64:bytes.toString('base64'),content_sha256:createHash('sha256').update(bytes).digest('hex')});
  if(i===0)await documentStore.documentQueue({event_id:'document-queue',document_id:doc.document_id});
  else await documentStore.documentArchive({event_id:'document-archive',document_id:doc.document_id});
 }
 // A same-source shared active record is searchable, but never included in owned aggregates.
 const foreign={engine,sourceId:source,remote:true,transport:'http',auth:{sourceId:source,scopes:['read','write'],principal:{kind:'oauth_client',id:'other-owner'}}};
 const other=new PersonalMemoryStore(foreign);await other.register({agent_id:'overview-a'});
 const shared=await other.commit({agent_id:'overview-a',event_id:'other',consent:true,memories:[{type:'preference',content:'PRIVATE_SHARED',visibility:'source'}]});
 await other.review({memory_id:shared.entries[0].id,expected_revision:1,event_id:'other-active',status:'active'});
 const expected={memories:{total:17,candidate:10,active:4,archived:3,active_current:3,active_stale:1,candidate_stale:1,document_fragments:1},
  jobs:{total:10,queued:2,processing:2,completed:3,failed:2,stale:1,processing_live:1,processing_expired:1,failed_below_attempt_limit:1},
  documents:{total:2,active:1,archived:1},agents:{total:2}};
 const before=await stamp();const r=await call();assert.deepEqual(selectGroups(r),expected);assertNoText(r);pass();
 const readOnly={...foreign,auth:{...foreign.auth,scopes:['read']}};
 const otherResult=await call(query(),readOnly);assert.equal(otherResult.memories.total,1);assert.equal(otherResult.agents.total,1);
 assert.equal(otherResult.jobs.total,0);assert.equal(otherResult.documents.total,0);pass();
 const blank=await call(query(),{...ctx,sourceId:emptySource});
 for(const group of Object.values(selectGroups(blank)))assert.ok(Object.values(group).every(v=>v===0));pass();
 for(const auth of [{...foreign.auth,scopes:[]},{...foreign.auth,hasSourceGrant:false},{...foreign.auth,allowedSources:[source,emptySource]}])
  await assert.rejects(call(query(),{...foreign,auth}),{code:'permission_denied'});pass();
 for(const extra of [{source_id:emptySource},{actor_key:other.actor},{project_id:'project-a'},{limit:1}])
  await assert.rejects(call({...query(),...extra}),{code:'invalid_params'});pass();
 // Check real transaction settings at the actual aggregate boundary, not a mocked receipt.
 let checked=false;
 const instrumented={kind:engine.kind,executeRaw:(...args)=>engine.executeRaw(...args),transaction:fn=>engine.transaction(tx=>fn({executeRaw:async(sql,args)=>{
  if(sql.startsWith('WITH ')){
   assert.equal((await tx.executeRaw('SHOW transaction_read_only'))[0].transaction_read_only,'on');
   assert.equal((await tx.executeRaw('SHOW statement_timeout'))[0].statement_timeout,'5s');
   assert.equal((await tx.executeRaw('SHOW lock_timeout'))[0].lock_timeout,'1s');checked=true;
  }
  return tx.executeRaw(sql,args);
 }}))};
 assert.deepEqual(selectGroups(await new PersonalOverview({...ctx,engine:instrumented}).read(query())),expected);assert.ok(checked);pass();
 const client=new Client({name:'overview-fixture',version:'1'}),transport=new StdioClientTransport({command:process.execPath,
  args:[ROOT+'/src/cli.mjs','mcp'],cwd:ROOT,env:{...process.env,GBRAIN_SOURCE:source,GBRAIN_SWEEP:'0'},stderr:'pipe'});
 transport.stderr?.on('data',()=>{});
 try{
  await client.connect(transport);let cursor,found;
  do{const catalog=await client.listTools(cursor?{cursor}:{});found??=catalog.tools.find(t=>t.name==='ultra_personal_overview');cursor=catalog.nextCursor;}while(cursor);
  assert.ok(found);assert.deepEqual(found.inputSchema.required,['request_id']);
  const result=await client.callTool({name:found.name,arguments:query()});assert.ok(!result.isError);
  assert.deepEqual(selectGroups(JSON.parse(result.content[0].text)),expected);pass();
 }finally{await client.close();}
 assert.deepEqual(await stamp(),before);pass();
 ui=await startPersonalConsole({engine,source,token,port:0,configureModel:()=>assert.fail('Overview must not configure a model')});
 const child=spawn(process.env.ULTRABRAIN_BROWSER_PYTHON??'python3',[ROOT+'/test/personal-overview-browser.py'],{
  cwd:ROOT,env:{...process.env,ULTRABRAIN_BROWSER_ORIGIN:ui.origin,ULTRABRAIN_BROWSER_TOKEN:token,ULTRABRAIN_OVERVIEW_EXPECTED:JSON.stringify(r)},
  stdio:['ignore','inherit','inherit']});
 const timer=setTimeout(()=>child.kill('SIGKILL'),120000);
 try{assert.equal(await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);}),0,'Overview real browser failed');}
 finally{clearTimeout(timer);}
 assert.deepEqual(await stamp(),before);assert.equal(generators,3);pass();
 console.log(`PASS ${checks} overview PostgreSQL/native-MCP checks; six application tables unchanged during reads, 3 synthetic generators in preparation, zero external models`);
}finally{await ui?.close();await engine.disconnect();}
