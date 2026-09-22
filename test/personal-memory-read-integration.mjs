/** Real PostgreSQL + native MCP dispatch visibility, exact reads and CAS. Synthetic only. */
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {connect,loadNative} from '../src/runtime.mjs';
import {PersonalMemoryStore} from '../src/personal-memory-store.mjs';
import {sha256} from '../src/core.mjs';
assert.equal(process.env.ULTRABRAIN_TEST_ALLOW_WRITE,'1','Explicit disposable test database required');
const engine=await connect(),tag=randomBytes(5).toString('hex'),source='read-'+tag,foreign='read-other-'+tag;
const {dispatchToolCall}=await loadNative('src/mcp/dispatch.ts');
const context=(principal,sourceId=source,scopes=['read','write'])=>({engine,sourceId,remote:true,transport:'http',auth:{sourceId,scopes,principal:{kind:'oauth_client',id:principal}}});
const owner=context('owner'),reader=context('reader',source,['read']),otherSource=context('owner',foreign,['read']);
const store=new PersonalMemoryStore(owner);let checks=0;const pass=()=>checks++;
async function call(name,input,ctx=owner){
 const r=await dispatchToolCall(engine,name,input,ctx),data=JSON.parse(r.content[0].text);
 if(r.isError)throw Object.assign(Error(data.error),{code:data.error});return data;
}
const read=(id,ctx=owner)=>call('ultra_memory_read',{memory_id:id},ctx);
async function snapshot(){
 const out={};for(const table of ['personal_memories','personal_events','personal_consolidations','agent_registry'])
  out[table]=(await engine.executeRaw(`SELECT md5(coalesce(string_agg(row_to_json(t)::text,',' ORDER BY row_to_json(t)::text),'')) AS digest FROM ultrabrain.${table} t WHERE source_id=$1`,[source]))[0].digest;
 return out;
}
try{
 for(const s of [source,foreign])await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)',[s]);
 await store.register({agent_id:'fixture',agent_type:'general_agent'});
 const rows={};
 for(const [name,status,visibility,project] of [['candidate','candidate','private',null],['active','active','private',null],['archived','archived','private',null],
  ['shared','active','source','project-a'],['shared-candidate','candidate','source',null],['shared-archived','archived','source',null]]){
  const r=await store.commit({agent_id:'fixture',event_id:name,consent:true,memories:[{type:'preference',content:'SYNTHETIC_READ_'+name,visibility,project_id:project}]});
  rows[name]=r.entries[0].id;
  if(status!=='candidate')await store.review({memory_id:rows[name],expected_revision:1,event_id:'review-'+name,status});
 }
 const derived=(await store.commit({agent_id:'fixture',event_id:'derived',consent:true,memories:[{type:'preference',content:'SYNTHETIC_DERIVED',visibility:'source'}]})).entries[0].id;
 await store.review({memory_id:derived,expected_revision:1,event_id:'derived-active',status:'active'});
 await engine.executeRaw('UPDATE ultrabrain.personal_memories SET derivation=$1::text::jsonb WHERE source_id=$2 AND actor_key=$3 AND id=$4::uuid',
  [JSON.stringify({input_id:rows.active,input_revision:2,input_hash:sha256('SYNTHETIC_READ_active'),quote:'SYNTHETIC_READ_active'}),source,store.actor,derived]);
 const before=await snapshot();
 for(const [name,id]of Object.entries(rows)){const r=await read(id);assert.equal(r.memory.id,id);assert.equal(r.read_only,true);assert.equal(r.memory.owned_by_caller,true);assert.ok(!Object.hasOwn(r.memory,'actor_key'));pass();}
 for(const [name,id]of Object.entries(rows)){
  if(name==='shared'){const r=await read(id,reader);assert.equal(r.memory.owned_by_caller,false);assert.equal(r.memory.project_id,'project-a');assert.equal(r.memory.derivation,null);}
  else await assert.rejects(read(id,reader),{code:'not_found'});pass();
 }
 for(const id of [rows.active,rows.shared,rows.candidate,randomUUID()]){await assert.rejects(read(id,otherSource),{code:'not_found'});pass();}
 const visibleDerived=await read(derived,reader);assert.equal(visibleDerived.memory.derivation,null);assert.equal(visibleDerived.memory.derivation_current,true);pass();
 for(const invalid of [{memory_id:rows.active,source_id:foreign},{memory_id:rows.active,actor_key:store.actor},{memory_id:rows.active,status:'active'},{memory_id:"%' OR 1=1 --"}])
  await assert.rejects(call('ultra_memory_read',invalid),{code:'invalid_params'});pass();
 assert.deepEqual(await snapshot(),before);pass();
 // An update after an earlier read must yield a newer candidate, not the cached active row.
 const old=await read(rows.active);
 await store.update({memory_id:rows.active,expected_revision:old.memory.revision,event_id:'correct',memory:{type:'preference',content:'SYNTHETIC_READ_CORRECTION'}});
 const afterUpdate=await snapshot(),fresh=await read(rows.active);
 assert.equal(fresh.memory.status,'candidate');assert.equal(fresh.memory.revision,3);assert.equal(fresh.memory.content,'SYNTHETIC_READ_CORRECTION');pass();
 await assert.rejects(store.update({memory_id:rows.active,expected_revision:old.memory.revision,event_id:'stale-overwrite',memory:{type:'preference',content:'SHOULD_NOT_OVERWRITE'}}),{code:'revision_conflict'});
 assert.deepEqual(await snapshot(),afterUpdate);pass();
 assert.equal((await read(derived)).memory.derivation_current,false);
 await assert.rejects(read(derived,reader),{code:'not_found'});pass();
 // Grant loss and readonly scopes remain server-enforced, even with a known ID.
 await assert.rejects(read(rows.shared,{...reader,auth:{...reader.auth,hasSourceGrant:false}}),{code:'permission_denied'});
 await assert.rejects(call('ultra_personal_update',{memory_id:rows.shared,expected_revision:2,event_id:'reader-write',memory:{type:'preference',content:'not authorized'}},reader),{code:'permission_denied'});pass();
 assert.deepEqual(await snapshot(),afterUpdate);pass();
 console.log(`PASS ${checks} exact-memory reads: real PostgreSQL/native dispatch, owner/shared/source isolation, stale derivations, read-only snapshots and revision conflict; no models`);
}finally{await engine.disconnect();}
