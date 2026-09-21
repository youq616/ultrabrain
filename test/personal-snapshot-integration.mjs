/** Actual isolated PostgreSQL + console + Chromium. Explicit synthetic records, no provider calls. */
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {connect,ROOT} from '../src/runtime.mjs';
import {PersonalMemoryStore} from '../src/personal-memory-store.mjs';
import {startPersonalConsole} from '../src/personal-console.mjs';
assert.equal(process.env.ULTRABRAIN_TEST_ALLOW_WRITE,'1','Only an isolated synthetic database');
const engine=await connect(),source='snapshot-'+randomBytes(5).toString('hex'),token=randomBytes(32).toString('hex');
const ctx={engine,sourceId:source,remote:false,transport:'stdio'},store=new PersonalMemoryStore(ctx);
const request=()=>({request_id:randomUUID(),consent:true});
let ui,checks=0;const pass=()=>checks++;
const tables=['personal_memories','personal_events','personal_consolidations','agent_registry','personal_documents','personal_document_fragments'];
const snapshot=async()=>{
 const result={};for(const table of tables)result[table]=(await engine.executeRaw(`SELECT md5(coalesce(string_agg(row_to_json(t)::text,',' ORDER BY row_to_json(t)::text),'')) AS digest FROM ultrabrain.${table} t WHERE source_id=$1`,[source]))[0].digest;
 return result;
};
const capture=async(target,event,content,project=null)=>target.commit({agent_id:'snapshot-fixture',event_id:event,consent:true,
 memories:[{type:'preference',content,project_id:project,provenance:'Explicit synthetic snapshot fixture',visibility:'source'}]});
try{
 await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)',[source]);
 await store.register({agent_id:'snapshot-fixture',agent_type:'general_agent'});
 const initial=[];
 for(let i=0;i<23;i++){
  const r=await capture(store,'entry-'+i,'SNAPSHOT_ORIGINAL_'+i+'\r\n🙂',i%2?'project-a':null);initial.push(r.entries[0].id);
  if(i%3)await store.review({memory_id:r.entries[0].id,expected_revision:1,event_id:'review-'+i,status:i%3===1?'active':'archived'});
 }
 const otherCtx={engine,sourceId:source,remote:true,transport:'http',auth:{sourceId:source,scopes:['read','write'],principal:{kind:'oauth_client',id:'other-owner'}}};
 const other=new PersonalMemoryStore(otherCtx);await other.register({agent_id:'snapshot-fixture',agent_type:'general_agent'});
 const foreign=await capture(other,'other','OTHER_OWNER_SHARED');await other.review({memory_id:foreign.entries[0].id,expected_revision:1,event_id:'activate',status:'active'});
 const before=await snapshot();
 const complete=await store.snapshot(request());assert.equal(complete.record_count,23);
 assert.deepEqual(new Set(complete.memories.map(m=>m.status)),new Set(['candidate','active','archived']));
 assert.deepEqual(new Set(complete.memories.map(m=>m.id)),new Set(initial));
 assert.ok(!JSON.stringify(complete).includes('OTHER_OWNER_SHARED'));assert.ok(complete.memories.every(m=>m.owned_by_caller));pass();
 const isolated=await other.snapshot(request());assert.equal(isolated.record_count,1);assert.equal(isolated.memories[0].id,foreign.entries[0].id);pass();
 const empty=new PersonalMemoryStore({...otherCtx,auth:{...otherCtx.auth,principal:{kind:'oauth_client',id:'empty-owner'}}});
 assert.equal((await empty.snapshot(request())).record_count,0);pass();
 for(const bad of [{request_id:randomUUID(),consent:false},{...request(),source_id:'other'},{...request(),actor_key:other.actor},{...request(),offset:0}])await assert.rejects(store.snapshot(bad));
 assert.deepEqual(await snapshot(),before);pass();
 // A real competing transaction commits AFTER preflight but BEFORE the content SELECT.
 // Only the test adapter coordinates this; no production timing hooks or HTTP endpoints.
 let changed=false,inserted;
 const concurrent={kind:engine.kind,executeRaw:(...args)=>engine.executeRaw(...args),transaction:fn=>engine.transaction(tx=>fn({executeRaw:async(sql,args)=>{
  const r=await tx.executeRaw(sql,args);
  if(sql.includes('AS byte_size FROM')&&!changed){
   changed=true;
   assert.equal((await tx.executeRaw('SHOW transaction_read_only'))[0].transaction_read_only,'on');
   assert.equal((await tx.executeRaw('SHOW transaction_isolation'))[0].transaction_isolation,'repeatable read');
   await store.update({memory_id:initial[0],expected_revision:1,event_id:'concurrent-update',memory:{type:'preference',content:'SNAPSHOT_CONCURRENT_UPDATED',provenance:'Synthetic concurrent transaction'}});
   inserted=(await capture(store,'concurrent-insert','SNAPSHOT_CONCURRENT_INSERT')).entries[0].id;
  }
  return r;
 }}))};
 const consistent=await new PersonalMemoryStore({...ctx,engine:concurrent}).snapshot(request());assert.equal(changed,true);
 assert.equal(consistent.record_count,23);assert.equal(consistent.memories.find(m=>m.id===initial[0]).content,'SNAPSHOT_ORIGINAL_0\r\n🙂');
 assert.ok(!consistent.memories.some(m=>m.id===inserted));pass();
 const current=await store.snapshot(request());assert.equal(current.record_count,24);
 assert.equal(current.memories.find(m=>m.id===initial[0]).content,'SNAPSHOT_CONCURRENT_UPDATED');
 assert.ok(current.memories.some(m=>m.id===inserted));pass();
 // Separate bounded owner: reject on byte budget, then record count. Explicit fixture writes.
 const bigSource=source+'-large';await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)',[bigSource]);
 const big=new PersonalMemoryStore({...ctx,sourceId:bigSource});await big.register({agent_id:'snapshot-fixture',agent_type:'general_agent'});
 await engine.executeRaw(`INSERT INTO ultrabrain.personal_memories(source_id,actor_key,type,content,content_hash,source,agent_id,status,visibility)
   SELECT $1,$2,'preference',repeat('x',65536),encode(sha256(convert_to(repeat('x',65536),'UTF8')),'hex'),'Synthetic bounded fixture','snapshot-fixture','candidate','private'
   FROM generate_series(1,129)`,[bigSource,big.actor]);
 await assert.rejects(big.snapshot(request()),{code:'memory_snapshot_too_large'});pass();
 await engine.executeRaw(`INSERT INTO ultrabrain.personal_memories(source_id,actor_key,type,content,content_hash,source,agent_id,status,visibility)
   SELECT $1,$2,'preference','x',encode(sha256(convert_to('x','UTF8')),'hex'),'Synthetic bounded fixture','snapshot-fixture','candidate','private'
   FROM generate_series(1,872)`,[bigSource,big.actor]);
 await assert.rejects(big.snapshot(request()),{code:'memory_snapshot_too_large'});pass();
 // Authenticated console route and real dynamic browser module, after concurrent-write phase.
 ui=await startPersonalConsole({engine,source,token,port:0});
 const readBefore=await snapshot();
 const call=async body=>fetch(ui.origin+'/api/call',{method:'POST',headers:{Origin:ui.origin,Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)});
 const denied=await call({operation:'memory_snapshot',input:{request_id:randomUUID(),consent:false}});
 assert.equal(denied.status,400);assert.equal((await denied.json()).error,'export_consent_required');pass();
 const child=spawn(process.env.ULTRABRAIN_BROWSER_PYTHON??'python3',[ROOT+'/test/personal-snapshot-browser.py'],{
  cwd:ROOT,env:{...process.env,ULTRABRAIN_BROWSER_ORIGIN:ui.origin,ULTRABRAIN_BROWSER_TOKEN:token,ULTRABRAIN_SNAPSHOT_EXPECTED:'24'},stdio:['ignore','inherit','inherit']});
 const deadline=setTimeout(()=>child.kill('SIGKILL'),120000);
 try{assert.equal(await new Promise((done,fail)=>{child.once('error',fail);child.once('close',done);}),0,'Snapshot browser acceptance failed');}
 finally{clearTimeout(deadline);}
 assert.deepEqual(await snapshot(),readBefore);pass();
 console.log(`PASS ${checks} snapshot PostgreSQL/console checks: repeatable-read concurrent update+insert isolation, owner boundary, whole-export limits and six unchanged tables across browser exports; no model calls`);
}finally{await ui?.close();await engine.disconnect();}
