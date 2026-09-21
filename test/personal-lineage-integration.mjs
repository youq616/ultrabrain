/** Actual PostgreSQL, native MCP and Chromium. Synthetic setup, no external provider. */
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {connect,ROOT,loadNative} from '../src/runtime.mjs';
import {PersonalMemoryStore} from '../src/personal-memory-store.mjs';
import {PersonalDocumentStore} from '../src/personal-documents.mjs';
import {PersonalConsolidator} from '../src/personal-consolidation.mjs';
import {personalModelProfile} from '../src/personal-consolidation-core.mjs';
import {startPersonalConsole} from '../src/personal-console.mjs';
import {lineageReference,compareLineage} from '../src/personal-lineage-contract.mjs';
assert.equal(process.env.ULTRABRAIN_TEST_ALLOW_WRITE,'1','Disposable database required');
const engine=await connect(),source='lineage-'+randomBytes(5).toString('hex'),token=randomBytes(32).toString('hex');
const ctx={engine,sourceId:source,remote:false,transport:'stdio'},store=new PersonalMemoryStore(ctx),documents=new PersonalDocumentStore(ctx);
const tables=['personal_memories','personal_events','personal_consolidations','agent_registry','personal_documents','personal_document_fragments'];
const directory=await mkdtemp(join(tmpdir(),'ultra-lineage-workspace-'));
const localSnapshot=join(directory,'owned-snapshot.json');
let ui,invocations=0,checks=0;const pass=()=>checks++;
const snapshot=async()=>{
 const result={};for(const table of tables)result[table]=(await engine.executeRaw(`SELECT md5(coalesce(string_agg(row_to_json(t)::text,',' ORDER BY row_to_json(t)::text),'')) AS digest FROM ultrabrain.${table} t WHERE source_id=$1`,[source]))[0].digest;
 return result;
};
const profile=personalModelProfile({enabled:true,model:'fixture:lineage',revision:'synthetic',timeout_ms:120000});
const quote='不要使用 Docker Hub',body='前言🙂\r\n'+quote+'。 <img src=x onerror="window.lineageInjected=1">';
const worker=new PersonalConsolidator(ctx,async()=>({profile,generate:async()=>{invocations++;
 return {text:JSON.stringify({memories:[{type:'preference',content:'派生候选：'+quote,quote}]})};}}));
const finish=async(job,input)=>{
 const result=await worker.process({expected_source:source,job_id:job,allow_model_call:true});
 assert.equal(result.results[0].state,'completed');return {id:result.results[0].result.entries[0].id,input};
};
const {dispatchToolCall}=await loadNative('src/mcp/dispatch.ts');
const native=async(id,identity=ctx)=>{
 const r=await dispatchToolCall(engine,'ultra_memory_read',{memory_id:id},identity),value=JSON.parse(r.content[0].text);
 if(r.isError)throw Object.assign(new Error(value.error),{code:value.error});return value;
};
const runBrowser=async(fixture,race=false)=>{
 const child=spawn(process.env.ULTRABRAIN_BROWSER_PYTHON??'python3',[ROOT+'/test/personal-lineage-browser.py',...(race?['--race']:[])],{
  cwd:ROOT,env:{...process.env,ULTRABRAIN_BROWSER_ORIGIN:ui.origin,ULTRABRAIN_BROWSER_TOKEN:token,ULTRABRAIN_LINEAGE_FIXTURE:JSON.stringify(fixture),ULTRABRAIN_LINEAGE_SNAPSHOT:localSnapshot},
  stdio:['ignore','inherit','inherit']});
 const deadline=setTimeout(()=>child.kill('SIGKILL'),120000);
 try{assert.equal(await new Promise((done,fail)=>{child.once('error',fail);child.once('close',done);}),0,'Lineage browser failed');}
 finally{clearTimeout(deadline);}
};
try{
 await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)',[source]);await store.register({agent_id:'lineage-fixture'});
 const fixture={};
 for(const name of ['matched','changed','archived']){
  const r=await store.capture({agent_id:'lineage-fixture',event_id:'capture-'+name,transcript:body,consent:true});
  fixture[name]=await finish(r.job_id,r.input_id);
 }
 await store.update({memory_id:fixture.changed.input,expected_revision:1,event_id:'changed-original',
  memory:{type:'experience',content:body+'\n已补充说明',provenance:'Explicit synthetic revision'}});
 await store.review({memory_id:fixture.archived.input,expected_revision:1,event_id:'archived-original',status:'archived'});
 const bytes=Buffer.from(body),document=await documents.documentImport({event_id:'doc-import',agent_id:'lineage-fixture',consent:true,
  label:'lineage.txt',content_base64:bytes.toString('base64'),content_sha256:createHash('sha256').update(bytes).digest('hex')});
 const queued=await documents.documentQueue({event_id:'doc-queue',document_id:document.document_id});
 fixture.fragment=await finish(queued.fragments[0].job_id,queued.fragments[0].memory_id);
 fixture.manual={id:(await store.commit({event_id:'manual',agent_id:'lineage-fixture',consent:true,memories:[{type:'preference',content:'明确输入的普通记忆'}]})).entries[0].id};
 const foreign={engine,sourceId:source,remote:true,transport:'http',auth:{sourceId:source,scopes:['read','write'],principal:{kind:'oauth_client',id:'other-owner'}}};
 const other=new PersonalMemoryStore(foreign);await other.register({agent_id:'lineage-fixture'});
 fixture.shared={id:(await other.commit({event_id:'shared',agent_id:'lineage-fixture',consent:true,memories:[{type:'preference',content:'可见共享记录',visibility:'source'}]})).entries[0].id};
 await other.review({memory_id:fixture.shared.id,expected_revision:1,event_id:'share-active',status:'active'});
 // Actual export for cross-workspace revocation; private temp file, no test upload.
 await writeFile(localSnapshot,JSON.stringify(await store.snapshot({request_id:randomUUID(),consent:true}),null,2)+'\n',{mode:0o600});
 const before=await snapshot();
 for(const name of ['matched','changed','archived','fragment']){
  const memory=(await native(fixture[name].id)).memory,origin=(await native(fixture[name].input)).memory;
  assert.equal(lineageReference(memory).input_id,origin.id);assert.equal(compareLineage(memory,origin).state,name==='fragment'?'matched':name);pass();
 }
 assert.equal((await native(fixture.fragment.input)).memory.origin_kind,'document_fragment');pass();
 assert.equal((await native(fixture.shared.id)).memory.owned_by_caller,false);assert.equal((await native(fixture.shared.id)).memory.derivation,null);pass();
 await assert.rejects(native(fixture.matched.id,foreign),{code:'not_found'});
 await assert.rejects(native(fixture.matched.input,foreign),{code:'not_found'});pass();
 const denied={...foreign,auth:{...foreign.auth,hasSourceGrant:false}};
 await assert.rejects(native(fixture.shared.id,denied),{code:'permission_denied'});pass();
 assert.deepEqual(await snapshot(),before);pass();
 ui=await startPersonalConsole({engine,source,token,port:0});await runBrowser(fixture);
 assert.deepEqual(await snapshot(),before);pass();
 // Separate actual concurrent-edit phase: one explicit synthetic edit, not a read-only claim.
 const unaffected=async()=>(await engine.executeRaw(`SELECT md5(coalesce(string_agg(row_to_json(t)::text,',' ORDER BY row_to_json(t)::text),'')) AS digest
   FROM ultrabrain.personal_memories t WHERE source_id=$1 AND id!=$2::uuid`,[source,fixture.matched.id]))[0].digest;
 const otherRows=await unaffected();
 const eventCount=async()=>(await engine.executeRaw('SELECT count(*)::int AS n FROM ultrabrain.personal_events WHERE source_id=$1',[source]))[0].n;
 const oldEvents=await eventCount();
 await runBrowser(fixture,true);const after=await snapshot();
 for(const table of tables.filter(t=>!['personal_memories','personal_events'].includes(t)))assert.equal(after[table],before[table]);
 assert.equal(await unaffected(),otherRows);assert.equal(await eventCount(),oldEvents+1);
 const final=(await store.read({memory_id:fixture.matched.id})).memory;
 assert.equal(final.revision,2);assert.equal(final.status,'candidate');assert.equal(final.derivation,null);
 assert.equal(final.content,'EXPLICIT_CONCURRENT_CORRECTION');pass();
 assert.equal(invocations,4);
 console.log(`PASS ${checks} lineage PostgreSQL/native-MCP oracles: read-only six-table phase, separate one-event concurrent correction, four injected generators and zero external models`);
}finally{try{await ui?.close();await engine.disconnect();}finally{await rm(directory,{recursive:true,force:true});}}
