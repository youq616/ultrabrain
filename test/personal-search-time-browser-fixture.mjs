/** Actual isolated PostgreSQL + shipped authenticated console/CSP + Chromium.
 * All data is newly generated synthetic data. Native runtime is required.
 */
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {connect} from '../src/runtime.mjs';
import {startPersonalConsole} from '../src/personal-console.mjs';
import {PersonalMemoryStore} from '../src/personal-memory-store.mjs';
import {specifications,runBrowser,saveReport} from './personal-search-time-http-browser.mjs';

assert.equal(process.env.ULTRABRAIN_TEST_ALLOW_WRITE,'1','Use only the isolated synthetic test database');
const engine=await connect(),source='search-time-'+randomBytes(5).toString('hex'),foreign=source+'-foreign';
const token=randomBytes(32).toString('hex');let ui,error,before,after,tables=[],reads=0,seeded=[];
async function snapshot(){
  const out={};
  for(const table of tables){
    assert.match(table,/^[a-z_]+$/);
    out[table]=(await engine.executeRaw(`SELECT count(*)::integer AS count,
      md5(coalesce(string_agg(row_to_json(t)::text,',' ORDER BY row_to_json(t)::text),'')) AS digest
      FROM ultrabrain.${table} t WHERE source_id=ANY($1::text[])`,[[source,foreign]]))[0];
  }
  return out;
}
try{
  for(const id of [source,foreign])await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)',[id]);
  const owner=new PersonalMemoryStore({engine,sourceId:source,remote:false,transport:'stdio'});
  const peer=new PersonalMemoryStore({engine,sourceId:source,remote:true,transport:'http',auth:{sourceId:source,
    scopes:['admin'],allowedSources:[source],hasSourceGrant:true,principal:{kind:'synthetic',id:'search-time-peer'}}});
  const other=new PersonalMemoryStore({engine,sourceId:foreign,remote:false,transport:'stdio'});
  const stores={'owner':owner,'peer':peer,'foreign-source':other};
  for(const store of Object.values(stores))await store.register({agent_id:'search-time-fixture',agent_type:'general_agent'});
  for(const spec of specifications()){
    const store=stores[spec.owner];
    const result=await store.commit({agent_id:'search-time-fixture',event_id:spec.key,consent:true,memories:[{
      type:'preference',content:spec.content,confidence:0.625,importance:'normal',visibility:spec.visibility,
      provenance:'Synthetic search-time browser fixture; no personal data'}]});
    assert.equal(result.model_calls,0);const id=result.entries[0].id;
    if(spec.status!=='candidate')await store.review({memory_id:id,expected_revision:1,event_id:'review-'+spec.key,status:spec.status});
    // Do not let the driver serialize Date/timestamptz and discard microseconds.
    await engine.executeRaw('UPDATE ultrabrain.personal_memories SET updated_at=$4::text::timestamptz WHERE source_id=$1 AND actor_key=$2 AND id=$3::uuid',
      [store.source,store.actor,id,spec.updated_at]);
    const [readback]=await engine.executeRaw(`SELECT id::text,status,
      to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS exact_time
      FROM ultrabrain.personal_memories WHERE source_id=$1 AND actor_key=$2 AND id=$3::uuid`,[store.source,store.actor,id]);
    assert.deepEqual({...readback},{id,status:spec.status,exact_time:spec.updated_at});
    seeded.push({...spec,id});
  }
  // Discover every personal source-scoped table, including empty document/fragment/job
  // tables and agent_registry. New personal tables cannot silently evade the proof.
  tables=(await engine.executeRaw(`SELECT table_name FROM information_schema.columns
    WHERE table_schema='ultrabrain' AND column_name='source_id'
      AND (table_name LIKE 'personal\\_%' ESCAPE '\\' OR table_name='agent_registry') ORDER BY table_name`)).map(row=>row.table_name);
  for(const name of ['agent_registry','personal_memories','personal_events','personal_consolidations','personal_documents','personal_document_fragments'])assert.ok(tables.includes(name),name+' must be snapshotted');
  before=await snapshot();
  // The browser cannot write even if a UI regression tries: the real engine wrapper
  // permits only the reviewed SELECT path, and the browser report checks operation names.
  const browserEngine={kind:'postgres',transaction:()=>assert.fail('Search browser started a transaction'),executeRaw:async(sql,args)=>{
    assert.ok(sql==='SELECT id FROM public.sources WHERE id=$1'||sql.startsWith('SELECT id::text')&&sql.includes('FROM ultrabrain.personal_memories m'),'Unexpected browser database operation');
    reads++;return engine.executeRaw(sql,args);
  }};
  ui=await startPersonalConsole({engine:browserEngine,source,token,port:0,configureModel:()=>assert.fail('Browser invoked a model')});
  await runBrowser(ui,token,seeded,'native-postgresql');
  assert.ok(reads>30,'Exercise the full browser matrix');
}catch(e){error=e;}
finally{
  try{
    await ui?.close();
    if(before){after=await snapshot();assert.deepEqual(after,before,'All source-scoped personal tables must remain unchanged');}
  }catch(e){error??=e;}
  saveReport('database-report.json',{mode:'native-postgresql',passed:!error,seeded_rows:seeded.length,
    exact_microsecond_readback:seeded.length===specifications().length,tables,before,after,
    unchanged:!!before&&JSON.stringify(before)===JSON.stringify(after),browser_read_queries:reads,
    browser_write_queries:0,model_calls:0,error:error?.stack??null});
  await engine.disconnect();
}
if(error)throw error;
console.log('PASS search-time real PostgreSQL/authenticated console/Chromium; six-digit readbacks, all personal table snapshots unchanged, no browser writes/models');
