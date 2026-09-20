/** Real private PostgreSQL + shipped console + Chromium, explicit synthetic preview reads. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {connect,ROOT} from '../src/runtime.mjs';
import {startPersonalConsole} from '../src/personal-console.mjs';
import {PersonalMemoryStore} from '../src/personal-memory-store.mjs';
assert.equal(process.env.ULTRABRAIN_TEST_ALLOW_WRITE,'1','Only use an isolated synthetic database');
const engine=await connect(),source='preview-'+randomBytes(5).toString('hex'),token=randomBytes(32).toString('hex');let ui;
async function snapshot(){
 const out={};for(const table of ['personal_memories','personal_events','personal_consolidations','agent_registry','personal_documents'])
  out[table]=(await engine.executeRaw(`SELECT md5(coalesce(string_agg(row_to_json(t)::text,',' ORDER BY row_to_json(t)::text),'')) AS digest FROM ultrabrain.${table} t WHERE source_id=$1`,[source]))[0].digest;
 return out;
}
try{
 await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)',[source]);
 const store=new PersonalMemoryStore({engine,sourceId:source,remote:false,transport:'stdio'});
 await store.register({agent_id:'preview-fixture',agent_type:'general_agent'});
 const entries=[
  ['global',null,'active','<img src=x onerror="window.previewInjected=1"> PREVIEW_GLOBAL Docker 配置：不要删除。'],
  ['a','project-a','active','PREVIEW_PROJECT_A Docker 配置：必须先备份。'],
  ['b','project-b','active','PREVIEW_PROJECT_B Docker 隔离项目。'],
  ['candidate',null,'candidate','PREVIEW_CANDIDATE Docker 不应召回。'],
  ['archived',null,'archived','PREVIEW_ARCHIVED Docker 不应召回。'],
  ['oversized',null,'active','PREVIEW_OVERSIZED Docker '+('不要删除。'.repeat(800))],
 ];
 for(const [event,project,status,content]of entries){
  const created=await store.commit({agent_id:'preview-fixture',event_id:event,consent:true,memories:[{
   type:'preference',importance:'high',project_id:project,content,provenance:'Explicit synthetic fixture, no user data'}]});
  if(status!=='candidate')await store.review({memory_id:created.entries[0].id,expected_revision:1,event_id:'review-'+event,status});
 }
 const before=await snapshot();ui=await startPersonalConsole({engine,source,token,port:0});
 const child=spawn(process.env.ULTRABRAIN_BROWSER_PYTHON??'python3',[ROOT+'/test/personal-recall-browser.py'],{
  env:{...process.env,ULTRABRAIN_BROWSER_ORIGIN:ui.origin,ULTRABRAIN_BROWSER_TOKEN:token},cwd:ROOT,stdio:['ignore','inherit','inherit']});
 const timer=setTimeout(()=>child.kill('SIGKILL'),120000);
 try{const code=await new Promise((done,fail)=>{child.once('error',fail);child.once('close',done);});assert.equal(code,0,'Task-preview Chromium validation failed');}
 finally{clearTimeout(timer);}
 assert.deepEqual(await snapshot(),before,'Preview must not mutate memory, events, agents, documents or jobs');
 console.log('PASS task-preview database snapshots unchanged; actual console/Chromium/PostgreSQL, no model calls');
 // Separate AFTER the read-only snapshot assertion: explicit correction lifecycle
 // fixture writes. Do not present this second phase as a no-write preview.
 const selected=await store.commit({agent_id:'preview-fixture',event_id:'lookup-browser',consent:true,memories:[{
   type:'preference',importance:'high',content:'LOOKUP_BEFORE',provenance:'Synthetic exact-lookup browser fixture'}]});
 const memoryId=selected.entries[0].id;
 await store.review({memory_id:memoryId,expected_revision:1,event_id:'lookup-browser-active',status:'active'});
 const correction=spawn(process.env.ULTRABRAIN_BROWSER_PYTHON??'python3',[ROOT+'/test/personal-memory-lookup-browser.py'],{
  env:{...process.env,ULTRABRAIN_BROWSER_ORIGIN:ui.origin,ULTRABRAIN_BROWSER_TOKEN:token,ULTRABRAIN_BROWSER_MEMORY_ID:memoryId,
   ULTRABRAIN_BROWSER_REPORT:process.env.ULTRABRAIN_LOOKUP_REPORT,ULTRABRAIN_BROWSER_SCREENSHOT:process.env.ULTRABRAIN_LOOKUP_SCREENSHOT},
  cwd:ROOT,stdio:['ignore','inherit','inherit']});
 const stop=setTimeout(()=>correction.kill('SIGKILL'),120000);
 try{const code=await new Promise((done,fail)=>{correction.once('error',fail);correction.once('close',done);});assert.equal(code,0,'Exact-lookup Chromium lifecycle failed');}
 finally{clearTimeout(stop);}
 const [final]=await engine.executeRaw('SELECT content,status,revision,confidence FROM ultrabrain.personal_memories WHERE source_id=$1 AND actor_key=$2 AND id=$3::uuid',[source,store.actor,memoryId]);
 assert.deepEqual({...final,confidence:Number(final.confidence)},{content:'LOOKUP_MANUAL_MERGE',status:'candidate',revision:8,confidence:0.4});
 assert.equal((await snapshot()).personal_consolidations,before.personal_consolidations);
 console.log('PASS exact lookup browser final database state: manual reconciliation retained, repeated stale overwrite refused, no consolidation jobs');
 // Separate synthetic receipt-fault phase. Replays must not create additional events,
 // rows or jobs; the browser intentionally injects malformed replies after real commits.
 const counts=async()=>{
   const result={};for(const table of ['personal_memories','personal_events','personal_consolidations','personal_documents'])
     result[table]=(await engine.executeRaw(`SELECT count(*)::integer AS n FROM ultrabrain.${table} WHERE source_id=$1`,[source]))[0].n;
   return result;
 };
 const receiptBefore=await counts();
 const receipts=spawn(process.env.ULTRABRAIN_BROWSER_PYTHON??'python3',[ROOT+'/test/personal-console-receipts-browser.py'],{
   env:{...process.env,ULTRABRAIN_BROWSER_ORIGIN:ui.origin,ULTRABRAIN_BROWSER_TOKEN:token,
     ULTRABRAIN_BROWSER_REPORT:process.env.ULTRABRAIN_RECEIPT_REPORT,ULTRABRAIN_BROWSER_SCREENSHOT:process.env.ULTRABRAIN_RECEIPT_SCREENSHOT},
   cwd:ROOT,stdio:['ignore','inherit','inherit']});
 const receiptTimer=setTimeout(()=>receipts.kill('SIGKILL'),120000);
 try{const code=await new Promise((done,fail)=>{receipts.once('error',fail);receipts.once('close',done);});assert.equal(code,0,'Receipt Chromium validation failed');}
 finally{clearTimeout(receiptTimer);}
 const receiptAfter=await counts();
 assert.deepEqual(Object.fromEntries(Object.keys(receiptBefore).map(k=>[k,receiptAfter[k]-receiptBefore[k]])),
   {personal_memories:5,personal_events:8,personal_consolidations:1,personal_documents:0});
 const [draftLeak]=await engine.executeRaw("SELECT count(*)::integer AS n FROM ultrabrain.personal_memories WHERE source_id=$1 AND content LIKE 'RECEIPT_NEWER_UNSAVED_DRAFT%'",[source]);
 assert.equal(draftLeak.n,0);
 console.log('PASS receipt database deltas: 8 events, 5 memories, 1 queued job, 0 documents; replay does not duplicate writes, newer local draft not stored');
 // Independent document receipt phase: actual import/dedup/queue/archive writes,
 // damaged browser replies, exact replay and retained-original downloads.
 const documentBefore=await counts();
 const documents=spawn(process.env.ULTRABRAIN_BROWSER_PYTHON??'python3',[ROOT+'/test/personal-document-receipts-browser.py'],{
   env:{...process.env,ULTRABRAIN_BROWSER_ORIGIN:ui.origin,ULTRABRAIN_BROWSER_TOKEN:token,
     ULTRABRAIN_BROWSER_REPORT:process.env.ULTRABRAIN_DOCUMENT_RECEIPT_REPORT,
     ULTRABRAIN_BROWSER_SCREENSHOT:process.env.ULTRABRAIN_DOCUMENT_RECEIPT_SCREENSHOT},
   cwd:ROOT,stdio:['ignore','inherit','inherit']});
 const documentTimer=setTimeout(()=>documents.kill('SIGKILL'),120000);
 try{const code=await new Promise((done,fail)=>{documents.once('error',fail);documents.once('close',done);});assert.equal(code,0,'Document receipt Chromium validation failed');}
 finally{clearTimeout(documentTimer);}
 const documentAfter=await counts();
 assert.deepEqual(Object.fromEntries(Object.keys(documentBefore).map(k=>[k,documentAfter[k]-documentBefore[k]])),
   {personal_memories:2,personal_events:6,personal_consolidations:2,personal_documents:2});
 const archived=await engine.executeRaw("SELECT status,revision FROM ultrabrain.personal_documents WHERE source_id=$1 ORDER BY id",[source]);
 assert.deepEqual(archived.map(r=>({...r})),[{status:'archived',revision:2},{status:'archived',revision:2}]);
 const fragments=await engine.executeRaw(`SELECT m.status,m.revision,j.state,j.attempts
   FROM ultrabrain.personal_document_fragments f
   JOIN ultrabrain.personal_memories m ON m.id=f.memory_id AND m.source_id=f.source_id AND m.actor_key=f.actor_key
   JOIN ultrabrain.personal_consolidations j ON j.input_id=m.id AND j.source_id=m.source_id AND j.actor_key=m.actor_key
   WHERE f.source_id=$1 ORDER BY f.byte_start`,[source]);
 assert.deepEqual(fragments.map(r=>({...r})),Array.from({length:2},()=>({status:'archived',revision:2,state:'stale',attempts:0})));
 const [unsaved]=await engine.executeRaw("SELECT count(*)::integer AS n FROM ultrabrain.personal_memories WHERE source_id=$1 AND content='DOCUMENT_UNRELATED_UNSAVED_DRAFT'",[source]);
 assert.equal(unsaved.n,0);
 console.log('PASS document receipt DB deltas: 6 events, 2 documents, 2 fragments, 2 stale zero-attempt jobs; replays/dedup do not duplicate records');
 // Snapshot after prior synthetic document writes, then prove this new phase is read-only.
 const readBefore=await snapshot();
 const reads=spawn(process.env.ULTRABRAIN_BROWSER_PYTHON??'python3',[ROOT+'/test/personal-document-read-browser.py'],{
   env:{...process.env,ULTRABRAIN_BROWSER_ORIGIN:ui.origin,ULTRABRAIN_BROWSER_TOKEN:token,
     ULTRABRAIN_BROWSER_REPORT:process.env.ULTRABRAIN_DOCUMENT_READ_REPORT,
     ULTRABRAIN_BROWSER_SCREENSHOT:process.env.ULTRABRAIN_DOCUMENT_READ_SCREENSHOT},
   cwd:ROOT,stdio:['ignore','inherit','inherit']});
 const readTimer=setTimeout(()=>reads.kill('SIGKILL'),120000);
 try{const code=await new Promise((done,fail)=>{reads.once('error',fail);reads.once('close',done);});assert.equal(code,0,'Document read Chromium validation failed');}
 finally{clearTimeout(readTimer);}
 assert.deepEqual(await snapshot(),readBefore,'Document reads must leave all five tables unchanged');
 console.log('PASS document read five-table snapshots unchanged; no write or model calls in this phase');
}finally{await ui?.close();await engine.disconnect();}
