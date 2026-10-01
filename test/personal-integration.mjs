/** Actual PostgreSQL + native dispatcher + stdio and authenticated HTTP MCP. Synthetic data only. */
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {randomBytes,createHash} from 'node:crypto';
import {connect,loadNative,ROOT} from '../src/runtime.mjs';
import {PERSONAL_TOOL_NAMES} from '../src/personal-plugin.mjs';
import {PersonalMemoryStore} from '../src/personal-memory-store.mjs';
import {applyMigrations,migrationStatus} from '../src/migrations.mjs';
import {Client} from '../vendor/gbrain/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import {StdioClientTransport} from '../vendor/gbrain/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import {StreamableHTTPClientTransport} from '../vendor/gbrain/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';
assert.equal(process.env.ULTRABRAIN_TEST_ALLOW_WRITE,'1','Isolated test database required');
const engine=await connect({migrate:true}),tag=randomBytes(5).toString('hex'),source='personal-'+tag,otherSource='personal-other-'+tag;
const {dispatchToolCall}=await loadNative('src/mcp/dispatch.ts');
const auth={token:'synthetic',clientId:'a',principal:{kind:'oauth_client',id:'a'},sourceId:source,scopes:['read','write']};
const options={engine,sourceId:source,remote:true,transport:'http',auth};
const second={auth:{...auth,clientId:'b',principal:{kind:'oauth_client',id:'b'}}};
const call=async(name,p={},extra={})=>{
  const result=await dispatchToolCall(engine,name,p,{...options,...extra});
  const data=JSON.parse(result.content[0].text);
  if(result.isError)throw Object.assign(new Error(data.error),{code:data.error});
  assert.ok(!result._meta?.brain_hot_memory);return data;
};
const reg=(extra={},metadata={})=>call('ultra_agent_register',{agent_id:'codex',agent_type:'coding_agent',...metadata},extra);
const commit=(event,memories,extra={})=>call('ultra_memory_commit',{agent_id:'codex',event_id:event,consent:true,memories},extra);
const sample={type:'preference',content:'Use complete CLI commands; do not use Docker Hub',importance:'high'};
let checks=0;const pass=()=>checks++;
const clients=[],transports=[],children=[],tokenNames=[];
async function rpc(client,name,p={}){const r=await client.callTool({name,arguments:p});const v=JSON.parse(r.content[0].text);if(r.isError)throw Object.assign(new Error(v.error),{code:v.error});assert.ok(!r._meta?.brain_hot_memory);return v;}

// Read database precision as text before relying on fixture order or returned JS dates.
const timestampText=stamp=>stamp.includes('.')?stamp.replace(/\.(\d+)Z$/,(_,f)=>'.'+f.padEnd(6,'0')+'Z'):stamp.replace('Z','.000000Z');
async function assertStoredTimestamp(id,stamp){
  const [row]=await engine.executeRaw(`SELECT to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS stamp
    FROM ultrabrain.personal_memories WHERE id=$1::uuid`,[id]);
  assert.equal(row.stamp,timestampText(stamp));
}

async function wireTimeSearch(client,id,label){
  const tools=(await client.listTools()).tools;
  for(const name of ['ultra_memory_search','ultra_personal_context','ultra_memory_profile']){
    const schema=tools.find(x=>x.name===name).inputSchema;
    for(const field of ['updated_from','updated_before']){
      if(name==='ultra_memory_search'){
        assert.equal(schema.properties[field].type,'string');assert.ok(!schema.required?.includes(field));
      }else assert.ok(!Object.hasOwn(schema.properties,field));
    }
  }
  const from='2024-02-29T12:00:00.123456Z',before='2024-02-29T12:00:00.123457Z';
  await engine.executeRaw('UPDATE ultrabrain.personal_memories SET updated_at=$2::text::timestamptz WHERE id=$1::uuid',[id,from]);
  await assertStoredTimestamp(id,from);
  for(const bounds of [{},{updated_from:from},{updated_before:before},{updated_from:from,updated_before:before}])
    assert.ok((await rpc(client,'ultra_memory_search',{query:label,...bounds})).memories.some(x=>x.id===id));
  assert.ok(!(await rpc(client,'ultra_memory_search',{query:label,updated_before:from})).memories.some(x=>x.id===id));
  assert.ok(!(await rpc(client,'ultra_memory_search',{query:label,updated_from:before})).memories.some(x=>x.id===id));
  for(const bounds of [{updated_from:'invalid'},{updated_from:from,updated_before:from},{updated_from:before,updated_before:from},
    {updated_from:'2024-02-29T12:00:00.1234567Z'}])await assert.rejects(rpc(client,'ultra_memory_search',bounds));
  for(const name of ['ultra_personal_context','ultra_memory_profile'])for(const field of ['updated_from','updated_before'])
    await assert.rejects(rpc(client,name,{[field]:from}));
  pass();
}
try {
  for(const id of [source,otherSource])await engine.executeRaw('INSERT INTO public.sources(id,name) VALUES($1,$1)',[id]);
  const first=await reg();assert.match(first.actor_key,/^[a-f0-9]{64}$/);assert.equal(first.revision,1);pass();
  assert.equal((await reg()).replayed,true);pass();
  assert.equal((await reg(second)).revision,1);assert.notEqual((await reg(second)).actor_key,first.actor_key);pass();
  assert.equal((await call('ultra_agent_list')).agents.length,1);pass();
  await assert.rejects(reg({},{capabilities:['new'],expected_revision:0}),{code:'revision_conflict'});pass();
  assert.equal((await reg({},{capabilities:['new'],expected_revision:1})).revision,2);pass();
  await assert.rejects(reg({auth:null}),{code:'permission_denied'});pass();
  await assert.rejects(reg({auth:{...auth,scopes:['read']}}),{code:'permission_denied'});pass();
  for(const restriction of [{boundSlugPrefixes:['p/']},{grantProjectionDegraded:true},{hasSourceGrant:false},{allowedSources:[source,otherSource]}])await assert.rejects(reg({auth:{...auth,...restriction}}));pass();
  await assert.rejects(call('ultra_agent_register',{agent_id:'fake',actor_key:first.actor_key}));pass();
  const initial=await commit('capture1',[sample]);assert.equal(initial.entries[0].status,'candidate');assert.equal(initial.storage,'stored');pass();
  const id=initial.entries[0].id;
  assert.equal((await commit('capture1',[sample])).entries[0].id,id);pass();
  await assert.rejects(commit('capture1',[{...sample,content:'changed'}]),{code:'conflict'});pass();
  assert.equal((await call('ultra_personal_context')).memories.length,0);pass();
  const ownCandidates=await call('ultra_memory_search',{status:'candidate'});assert.equal(ownCandidates.memories.length,1);assert.equal(ownCandidates.memories[0].confidence,null);pass();
  assert.equal((await call('ultra_memory_search',{status:'candidate'},second)).memories.length,0);pass();
  await call('ultra_personal_review',{memory_id:id,event_id:'review1',expected_revision:1,status:'active'});pass();
  assert.equal((await call('ultra_memory_profile')).memories[0].id,id);pass();
  assert.equal((await call('ultra_memory_profile',{},second)).memories.length,0);pass();
  await assert.rejects(call('ultra_personal_update',{memory_id:id,event_id:'steal',expected_revision:2,memory:sample},second),{code:'not_found'});pass();
  const shared=await commit('shared',[{...sample,visibility:'source'}]);const sharedId=shared.entries[0].id;
  assert.equal((await call('ultra_memory_search',{status:'candidate'},second)).memories.length,0);
  await call('ultra_personal_review',{memory_id:sharedId,event_id:'share-review',expected_revision:1,status:'active'});
  assert.equal((await call('ultra_memory_profile',{},second)).memories[0].id,sharedId);pass();
  const foreign={sourceId:otherSource,auth:{...auth,sourceId:otherSource}};
  assert.equal((await call('ultra_memory_profile',{},foreign)).memories.length,0);
  await assert.rejects(call('ultra_personal_review',{memory_id:sharedId,event_id:'cross-source',expected_revision:2,status:'active'},foreign),{code:'not_found'});pass();
  const concurrent=await Promise.allSettled([
    call('ultra_personal_update',{memory_id:id,event_id:'update-a',expected_revision:2,memory:{...sample,content:'first update'}}),
    call('ultra_personal_update',{memory_id:id,event_id:'update-b',expected_revision:2,memory:{...sample,content:'second update'}})]);
  assert.equal(concurrent.filter(x=>x.status==='fulfilled').length,1);assert.equal(concurrent.find(x=>x.status==='rejected').reason.code,'revision_conflict');pass();
  const updated=(await call('ultra_memory_search',{status:'candidate'})).memories.find(x=>x.id===id);assert.equal(updated.revision,3);assert.equal(updated.last_confirmed,null);pass();
  await call('ultra_personal_review',{memory_id:sharedId,event_id:'archive-shared',expected_revision:2,status:'archived'});
  assert.equal((await call('ultra_memory_profile',{},second)).memories.length,0);pass();
  assert.equal((await call('ultra_memory_search',{status:'archived'})).memories[0].id,sharedId);pass();
  await assert.rejects(call('ultra_memory_commit',{agent_id:'codex',event_id:'deny-consent',consent:false,memories:[sample]}),{code:'capture_disabled'});pass();
  await assert.rejects(call('ultra_memory_commit',{agent_id:'not-registered',event_id:'unregistered',consent:true,memories:[sample]}),{code:'agent_not_registered'});pass();
  const before=(await engine.executeRaw('SELECT count(*)::integer AS n FROM ultrabrain.personal_memories WHERE source_id=$1',[source]))[0].n;
  const dry=await call('ultra_memory_commit',{agent_id:'codex',event_id:'dry',consent:true,memories:[sample],dry_run:true});assert.equal(dry.storage,'not_stored');
  assert.equal((await engine.executeRaw('SELECT count(*)::integer AS n FROM ultrabrain.personal_memories WHERE source_id=$1',[source]))[0].n,before);pass();
  const batch=await Promise.all([commit('concurrent-replay',[sample]),commit('concurrent-replay',[sample])]);assert.equal(batch[0].entries[0].id,batch[1].entries[0].id);pass();
  const projects=await commit('projects',[{...sample,project_id:'one',content:'Project one rules'}, {...sample,project_id:'two',content:'Project two rules'},sample]);
  for(const x of projects.entries)await call('ultra_personal_review',{memory_id:x.id,event_id:'activate-'+x.id,expected_revision:1,status:'active'});
  const ctx1=await call('ultra_personal_context',{project_id:'one'});assert.ok(ctx1.memories.some(x=>x.project_id==='one'));assert.ok(!ctx1.memories.some(x=>x.project_id==='two'));pass();
  assert.ok((await call('ultra_memory_profile')).memories.every(x=>x.project_id===null));pass();
  assert.equal((await call('ultra_memory_search',{query:"%' OR 1=1 --"})).memories.length,0);pass();
  assert.ok(Buffer.byteLength(JSON.stringify(await call('ultra_personal_context',{budget_bytes:512})))<=512);pass();
  // Intentional mid-batch database failure proves writes and idempotency receipts roll back together.
  let inserted=0;
  const faulty={...options,engine:{kind:'postgres',executeRaw:(...a)=>engine.executeRaw(...a),transaction:fn=>engine.transaction(tx=>fn({executeRaw:async(q,p)=>{
    if(q.includes('INSERT INTO ultrabrain.personal_memories')&&++inserted===2)throw Error('injected storage failure');return tx.executeRaw(q,p);
  }}))}};
  const countBefore=(await engine.executeRaw('SELECT count(*)::integer AS n FROM ultrabrain.personal_memories WHERE source_id=$1',[source]))[0].n;
  await assert.rejects(new PersonalMemoryStore(faulty).commit({agent_id:'codex',event_id:'rollback',consent:true,memories:[sample,sample]}));
  assert.equal((await engine.executeRaw('SELECT count(*)::integer AS n FROM ultrabrain.personal_memories WHERE source_id=$1',[source]))[0].n,countBefore);
  assert.equal((await engine.executeRaw("SELECT count(*)::integer AS n FROM ultrabrain.personal_events WHERE source_id=$1 AND event_id='rollback'",[source]))[0].n,0);pass();
  assert.equal((await migrationStatus(engine)).pending.length,0);assert.deepEqual((await applyMigrations(engine)).applied,[]);pass();
  // Deterministic current-row timestamps; synthetic fixtures only, no model or clock sleeps.
  const timeLabel='updated-time-'+tag,from='2024-02-29T12:00:00.000001Z',until='2024-02-29T12:00:00.000003Z';
  const stamps=['2024-02-29T12:00:00Z',from,'2024-02-29T12:00:00.000002Z',until,'2024-02-29T12:00:01Z',from];
  const timed=await commit('timed-active',stamps.map((_,i)=>({type:'goal',content:timeLabel+' row '+i,project_id:timeLabel})));
  for(const [i,row] of timed.entries.entries()){
    await call('ultra_personal_review',{memory_id:row.id,event_id:'timed-review-'+i,expected_revision:1,status:'active'});
    await engine.executeRaw('UPDATE ultrabrain.personal_memories SET updated_at=$2::text::timestamptz WHERE id=$1::uuid',[row.id,stamps[i]]);
    await assertStoredTimestamp(row.id,stamps[i]);
  }
  const ids=timed.entries.map(x=>x.id),ties=[ids[1],ids[5]].sort(),expected=[ids[2],...ties];
  const timedSearch=(bounds={},extra={})=>call('ultra_memory_search',{query:timeLabel,project_id:timeLabel,agent_id:'codex',types:['goal'],...bounds},extra);
  const rowIds=result=>result.memories.map(x=>x.id);
  const baseline=await engine.executeRaw('SELECT id::text,revision,status,updated_at::text FROM ultrabrain.personal_memories WHERE source_id=$1 ORDER BY id',[source]);
  assert.deepEqual(rowIds(await timedSearch()),[ids[4],ids[3],ids[2],...ties,ids[0]]);pass();
  assert.deepEqual(rowIds(await timedSearch({updated_from:from})),[ids[4],ids[3],...expected]);pass();
  assert.deepEqual(rowIds(await timedSearch({updated_before:until})),[...expected,ids[0]]);pass();
  assert.deepEqual(rowIds(await timedSearch({updated_from:from,updated_before:until})),expected);pass();
  assert.deepEqual(rowIds(await timedSearch({updated_from:from,updated_before:until,limit:1})),[ids[2]]);
  const page=await timedSearch({updated_from:from,updated_before:until,limit:1,offset:1});
  assert.deepEqual(rowIds(page),[ties[0]]);assert.equal(page.next_offset,2);
  assert.deepEqual(rowIds(await timedSearch({updated_from:from,updated_before:until,limit:1,offset:2})),[ties[1]]);
  assert.deepEqual(rowIds(await timedSearch({updated_from:from,updated_before:until,offset:3})),[]);pass();
  assert.deepEqual(rowIds(await timedSearch({updated_from:from,updated_before:'2024-02-29T12:00:00.000002Z'})),ties);pass();
  assert.equal((await timedSearch({updated_from:from,updated_before:until,query:timeLabel+' row 2'})).memories[0].id,ids[2]);
  assert.equal((await timedSearch({updated_from:from,updated_before:until,types:['identity']})).memories.length,0);
  assert.equal((await timedSearch({updated_from:from,updated_before:until,agent_id:'different'})).memories.length,0);
  assert.equal((await timedSearch({updated_from:from,updated_before:until,project_id:'different'})).memories.length,0);pass();
  assert.equal((await timedSearch({updated_from:from,updated_before:until},second)).memories.length,0);
  assert.equal((await timedSearch({updated_from:from,updated_before:until},foreign)).memories.length,0);pass();
  // PostgreSQL itself must preserve accepted precision; never compare JS Date round trips.
  for(const stamp of ['0001-01-01T00:00:00Z','9999-12-31T23:59:59.999999Z','2000-02-29T00:00:00.1Z',from,until]){
    const [roundtrip]=await engine.executeRaw(`SELECT to_char($1::text::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS stamp`,[stamp]);
    assert.equal(roundtrip.stamp,timestampText(stamp));
    await timedSearch({updated_from:stamp});
  }
  const [parameterType]=await engine.executeRaw('SELECT pg_typeof($1::text)::text AS bound_type',[from]);
  assert.equal(parameterType.bound_type,'text');
  const [precision]=await engine.executeRaw('SELECT $1::text::timestamptz < $2::text::timestamptz AS distinct_microseconds',[from,'2024-02-29T12:00:00.000002Z']);
  assert.equal(precision.distinct_microseconds,true);pass();
  for(const value of [null,42,'2023-02-29T00:00:00Z','1900-02-29T00:00:00Z','2024-01-01T24:00:00Z','2024-01-01T00:00:00.0000001Z','2024-01-01T00:00:00+00:00'])
    await assert.rejects(timedSearch({updated_from:value}));
  for(const bounds of [{updated_from:until,updated_before:from},{updated_from:from,updated_before:from},
    {updated_from:'2024-01-01T00:00:00.1Z',updated_before:'2024-01-01T00:00:00.100000Z'}])
    await assert.rejects(timedSearch(bounds),{code:'invalid_params'});
  for(const name of ['ultra_personal_context','ultra_memory_profile'])for(const field of ['updated_from','updated_before'])
    await assert.rejects(call(name,{[field]:from}));pass();
  assert.deepEqual(await engine.executeRaw('SELECT id::text,revision,status,updated_at::text FROM ultrabrain.personal_memories WHERE source_id=$1 ORDER BY id',[source]),baseline);pass();
  // State and derivation visibility are independent of the selected modification interval.
  const visibilityLabel='time-visibility-'+tag;
  const states=await commit('timed-states',Array.from({length:4},()=>({type:'goal',content:visibilityLabel,visibility:'source'})));
  const [activeTime,candidateTime,archivedTime,derivedTime]=states.entries;
  for(const row of [activeTime,derivedTime])await call('ultra_personal_review',{memory_id:row.id,event_id:'activate-time-'+row.id,expected_revision:1,status:'active'});
  await call('ultra_personal_review',{memory_id:archivedTime.id,event_id:'archive-time',expected_revision:1,status:'archived'});
  const [origin]=await engine.executeRaw('SELECT revision,content_hash FROM ultrabrain.personal_memories WHERE id=$1::uuid',[candidateTime.id]);
  await engine.executeRaw('UPDATE ultrabrain.personal_memories SET derivation=$2::text::jsonb WHERE id=$1::uuid',
    [derivedTime.id,JSON.stringify({input_id:candidateTime.id,input_revision:origin.revision,input_hash:origin.content_hash})]);
  await engine.executeRaw('UPDATE ultrabrain.personal_memories SET updated_at=$2::text::timestamptz WHERE id=ANY($1::uuid[])',[states.entries.map(x=>x.id),from]);
  for(const row of states.entries)await assertStoredTimestamp(row.id,from);
  const visibleSearch=(status='active',extra={})=>call('ultra_memory_search',{query:visibilityLabel,status,updated_from:from,updated_before:until},extra);
  assert.deepEqual(rowIds(await visibleSearch('active',second)).sort(),[activeTime.id,derivedTime.id].sort());
  assert.deepEqual(rowIds(await visibleSearch('candidate')),[candidateTime.id]);assert.deepEqual(rowIds(await visibleSearch('archived')),[archivedTime.id]);
  assert.equal((await visibleSearch('candidate',second)).memories.length,0);assert.equal((await visibleSearch('archived',second)).memories.length,0);
  assert.equal((await visibleSearch('active',foreign)).memories.length,0);pass();
  await call('ultra_personal_update',{memory_id:candidateTime.id,event_id:'stale-time-source',expected_revision:1,memory:{type:'goal',content:visibilityLabel+' changed'}});
  assert.deepEqual(rowIds(await visibleSearch('active',second)),[activeTime.id]);
  const stale=(await visibleSearch()).memories.find(x=>x.id===derivedTime.id);assert.equal(stale.derivation_current,false);assert.equal(stale.owned_by_caller,true);
  assert.ok((await call('ultra_memory_search',{query:visibilityLabel},second)).memories.every(x=>x.id!==derivedTime.id));pass();
  if(process.env.ULTRABRAIN_PERSONAL_LEGACY_FIXTURE){
    const legacy=JSON.parse(readFileSync(process.env.ULTRABRAIN_PERSONAL_LEGACY_FIXTURE,'utf8'));
    const [row]=await engine.executeRaw('SELECT source_id,actor_key,content FROM ultrabrain.personal_memories WHERE id=$1::uuid',[legacy.memory]);
    assert.equal(row.source_id,null);assert.equal(row.actor_key,null);assert.equal(row.content,'Synthetic legacy ownerless entry');
    assert.ok(!(await call('ultra_memory_search')).memories.some(x=>x.id===legacy.memory));pass();
  }
  // Actual stdio tools/list and CRUD chain: local process owner is the authority, not agent labels.
  const stdio=new Client({name:'personal-stdio-test',version:'1'});clients.push(stdio);
  const stdioTransport=new StdioClientTransport({command:process.execPath,args:[ROOT+'/src/cli.mjs','mcp'],cwd:ROOT,
    env:{...process.env,GBRAIN_SOURCE:source,GBRAIN_SWEEP:'0'},stderr:'pipe'});transports.push(stdioTransport);
  stdioTransport.stderr?.on('data',()=>{});await stdio.connect(stdioTransport);
  const catalog=(await stdio.listTools()).tools.map(x=>x.name);assert.ok(PERSONAL_TOOL_NAMES.every(n=>catalog.includes(n)));pass();
  await rpc(stdio,'ultra_agent_register',{agent_id:'claude-code',agent_type:'coding_agent'});
  const wire=await rpc(stdio,'ultra_memory_commit',{agent_id:'claude-code',event_id:'stdio-event',consent:true,summary:'Synthetic local experience'});
  await rpc(stdio,'ultra_personal_review',{memory_id:wire.entries[0].id,expected_revision:1,event_id:'stdio-review',status:'active'});
  assert.ok((await rpc(stdio,'ultra_personal_context')).memories.some(x=>x.id===wire.entries[0].id));pass();
  assert.equal((await rpc(stdio,'ultra_memory_read',{memory_id:wire.entries[0].id})).memory.revision,2);pass();
  await wireTimeSearch(stdio,wire.entries[0].id,'Synthetic local experience');
  // Actual two HTTP token identities; sharing is explicit and private entries stay private.
  const socket=createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r));
  const server=spawn(process.execPath,[ROOT+'/src/cli.mjs','mcp','--http','--bind','127.0.0.1','--port',String(port),'--suppress-bootstrap-token'],
    {cwd:ROOT,env:{...process.env,GBRAIN_SWEEP:'0',GBRAIN_ADMIN_BOOTSTRAP_TOKEN:randomBytes(32).toString('hex')},stdio:['ignore','ignore','pipe']});children.push(server);server.stderr.on('data',()=>{});
  let ready=false;for(let n=0;n<150;n++){if(server.exitCode!==null)break;try{ready=(await fetch(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.timeout(500)})).ok;}catch{}if(ready)break;await new Promise(r=>setTimeout(r,100));}assert.ok(ready);
  const http=[];
  for(let i=0;i<2;i++){
    const name=source+'-http-'+i,token='gbrain_'+randomBytes(32).toString('hex');tokenNames.push(name);
    await engine.executeRaw('INSERT INTO access_tokens(name,token_hash,scopes,permissions) VALUES($1,$2,$3::text[],$4::text::jsonb)',
      [name,createHash('sha256').update(token).digest('hex'),'{read,write}',JSON.stringify({source_id:source,takes_holders:['world']})]);
    const c=new Client({name:'personal-http-test',version:'1'});clients.push(c);http.push(c);
    const tr=new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`),{requestInit:{headers:{Authorization:'Bearer '+token}},reconnectionOptions:{maxRetries:0}});transports.push(tr);await c.connect(tr);
    await rpc(c,'ultra_agent_register',{agent_id:'same-label'});
  }
  const httpCatalog=(await http[0].listTools()).tools.map(x=>x.name);assert.ok(PERSONAL_TOOL_NAMES.every(n=>httpCatalog.includes(n)));pass();
  const queuedHttp=await rpc(http[0],'ultra_personal_capture',{agent_id:'same-label',event_id:'raw-http',transcript:'Synthetic owned input for consolidation',consent:true});
  await assert.rejects(rpc(http[1],'ultra_personal_jobs',{job_id:queuedHttp.job_id}),{code:'not_found'});
  assert.equal((await rpc(http[0],'ultra_personal_consolidate',{job_id:queuedHttp.job_id,expected_source:source,allow_model_call:true})).state,'needs_model');
  await rpc(http[0],'ultra_personal_cancel',{job_id:queuedHttp.job_id});pass();
  const secret=await rpc(http[0],'ultra_memory_commit',{agent_id:'same-label',event_id:'private-wire',consent:true,memories:[sample]});
  assert.ok(!(await rpc(http[1],'ultra_memory_search',{status:'candidate'})).memories.some(x=>x.id===secret.entries[0].id));pass();
  assert.equal((await rpc(http[0],'ultra_memory_read',{memory_id:secret.entries[0].id})).memory.status,'candidate');
  await assert.rejects(rpc(http[1],'ultra_memory_read',{memory_id:secret.entries[0].id}),{code:'not_found'});pass();
  const share=await rpc(http[0],'ultra_memory_commit',{agent_id:'same-label',event_id:'shared-wire',consent:true,memories:[{...sample,visibility:'source'}]});
  await rpc(http[0],'ultra_personal_review',{memory_id:share.entries[0].id,event_id:'wire-activate',expected_revision:1,status:'active'});
  assert.ok((await rpc(http[1],'ultra_memory_profile')).memories.some(x=>x.id===share.entries[0].id));pass();
  assert.equal((await rpc(http[1],'ultra_memory_read',{memory_id:share.entries[0].id})).memory.owned_by_caller,false);pass();
  await wireTimeSearch(http[0],share.entries[0].id,sample.content);
  assert.ok((await rpc(http[1],'ultra_memory_search',{updated_from:'2024-02-29T12:00:00.123456Z',updated_before:'2024-02-29T12:00:00.123457Z'})).memories.some(x=>x.id===share.entries[0].id));
  assert.ok(!(await rpc(http[1],'ultra_memory_search',{status:'candidate',updated_from:'0001-01-01T00:00:00Z'})).memories.some(x=>x.id===secret.entries[0].id));pass();
  await engine.executeRaw('UPDATE access_tokens SET revoked_at=now() WHERE name=$1',[tokenNames[0]]);
  await assert.rejects(rpc(http[0],'ultra_memory_commit',{agent_id:'same-label',event_id:'revoked',consent:true,summary:'must not be stored'}));pass();
  console.log(`PASS ${checks} personal core checks: PostgreSQL SQL/identity/CAS/replay/rollback, legacy preservation, real stdio and authenticated HTTP`);
} finally {
  for(const tr of transports)try{await tr.terminateSession?.();}catch{}
  for(const c of clients)try{await c.close();}catch{}
  for(const p of children)if(p.exitCode===null){p.kill('SIGTERM');const timer=setTimeout(()=>p.kill('SIGKILL'),5000);await once(p,'exit');clearTimeout(timer);}
  if(tokenNames.length)await engine.executeRaw('DELETE FROM access_tokens WHERE name=ANY($1::text[])',[tokenNames]);
  await engine.disconnect();
}
