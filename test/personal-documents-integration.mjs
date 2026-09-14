/** Real PostgreSQL + native dispatcher + actual stdio MCP for personal documents.
 * Synthetic files only. Verifies byte-exact originals, whole-file rejects, atomic
 * queueing with replay and capacity, archive fencing and restore-grade integrity.
 */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {connect,loadNative,ROOT} from '../src/runtime.mjs';
import {PERSONAL_DOCUMENT_MAX_BYTES} from '../src/personal-documents.mjs';
import {migrationStatus} from '../src/migrations.mjs';
import {Client} from '../vendor/gbrain/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import {StdioClientTransport} from '../vendor/gbrain/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
assert.equal(process.env.ULTRABRAIN_TEST_ALLOW_WRITE,'1','Isolated test database required');
const engine=await connect({migrate:true}),tag=randomBytes(5).toString('hex'),source='pdocs-'+tag;
const {dispatchToolCall}=await loadNative('src/mcp/dispatch.ts');
const auth={token:'synthetic',clientId:'a',principal:{kind:'oauth_client',id:'a'},sourceId:source,scopes:['read','write']};
const options={engine,sourceId:source,remote:true,transport:'http',auth};
const second={auth:{...auth,clientId:'b',principal:{kind:'oauth_client',id:'b'}}};
const call=async(name,p={},extra={})=>{
  const result=await dispatchToolCall(engine,name,p,{...options,...extra});
  const data=JSON.parse(result.content[0].text);
  if(result.isError)throw Object.assign(new Error(data.error),{code:data.error});
  return data;
};
const b64=bytes=>Buffer.from(bytes).toString('base64');
const SHA=bytes=>createHash('sha256').update(bytes).digest('hex');
const original=Buffer.concat([Buffer.from([0xEF,0xBB,0xBF]),Buffer.from('# 笔记\r\n\r\n用户明确表示：不要使用 Docker Hub；偏好完整命令行。\r\n否定样本：这不是授权自动采集。\r\n','utf8')]);
let actor=null,checks=0;const pass=()=>checks++;
const clients=[],transports=[],children=[];
try {
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)',[source]);
  await call('ultra_agent_register',{agent_id:'codex',agent_type:'coding_agent'});
  [actor]=await engine.executeRaw('SELECT actor_key FROM ultrabrain.agent_registry WHERE source_id=$1 ORDER BY created_at LIMIT 1',[source]);
  // Import keeps the exact original bytes (BOM, CRLF, negations, multibyte) and round-trips.
  const imported=await call('ultra_personal_document_import',{agent_id:'codex',event_id:'imp-1',consent:true,
    label:'笔记-2026.md',content_base64:b64(original),content_sha256:SHA(original)});
  assert.equal(imported.storage,'stored');assert.equal(imported.byte_size,original.length);assert.equal(imported.has_bom,true);
  assert.equal(imported.format,'md');assert.equal(imported.model_calls,0);pass();
  const read=await call('ultra_personal_document_read',{document_id:imported.document_id});
  const roundTrip=Buffer.from(read.content_base64,'base64');
  assert.equal(roundTrip.compare(original),0);assert.equal(SHA(roundTrip),read.content_sha256);pass();
  const listed=await call('ultra_personal_document_list',{status:'any'});
  assert.equal(listed.documents[0].document_id,imported.document_id);
  assert.ok(!('content_base64' in listed.documents[0]));pass(); // Listing carries metadata only.
  const replay=await call('ultra_personal_document_import',{agent_id:'codex',event_id:'imp-1',consent:true,
    label:'笔记-2026.md',content_base64:b64(original),content_sha256:SHA(original)});
  assert.equal(replay.replayed,true);assert.equal(replay.document_id,imported.document_id);pass();
  await assert.rejects(call('ultra_personal_document_import',{agent_id:'codex',event_id:'imp-1',consent:true,
    label:'other.md',content_base64:b64(original),content_sha256:SHA(original)}),{code:'conflict'});pass();
  const sameBytes=await call('ultra_personal_document_import',{agent_id:'codex',event_id:'imp-2',consent:true,
    label:'笔记-2026.md',content_base64:b64(original),content_sha256:SHA(original)});
  assert.equal(sameBytes.already_imported,true);assert.equal(sameBytes.document_id,imported.document_id);pass();
  const dry=await call('ultra_personal_document_import',{agent_id:'codex',event_id:'dry-run',consent:true,dry_run:true,
    label:'dry.txt',content_base64:b64(original),content_sha256:SHA(original)});
  assert.equal(dry.storage,'not_stored');
  assert.equal((await call('ultra_personal_document_list',{status:'any'})).documents.length,1);pass();
  // Whole-file rejects: size, UTF-8, fingerprint, path labels, formats, consent. Never truncated.
  const oversize=Buffer.alloc(PERSONAL_DOCUMENT_MAX_BYTES+1,0x61);
  await assert.rejects(call('ultra_personal_document_import',{agent_id:'codex',event_id:'big',consent:true,label:'big.txt',
    content_base64:b64(oversize),content_sha256:SHA(oversize)}),{code:'file_too_large'});pass();
  const invalid=Buffer.from([0xE4,0xBD,0xA0,0xC0,0xAF]);
  await assert.rejects(call('ultra_personal_document_import',{agent_id:'codex',event_id:'utf',consent:true,label:'bad.txt',
    content_base64:b64(invalid),content_sha256:SHA(invalid)}),{code:'invalid_utf8'});pass();
  await assert.rejects(call('ultra_personal_document_import',{agent_id:'codex',event_id:'fp',consent:true,label:'n.txt',
    content_base64:b64(original),content_sha256:'0'.repeat(64)}),{code:'fingerprint_mismatch'});pass();
  for(const [i,label] of ['../escape.txt','a/b.md','C:\\x.txt'].entries()){
    await assert.rejects(call('ultra_personal_document_import',{agent_id:'codex',event_id:'path'+i,consent:true,
      label,content_base64:b64(original),content_sha256:SHA(original)}),{code:'invalid_label'});pass();
  }
  await assert.rejects(call('ultra_personal_document_import',{agent_id:'codex',event_id:'pdf',consent:true,label:'x.pdf',
    content_base64:b64(original),content_sha256:SHA(original)}),{code:'unsupported_format'});pass();
  await assert.rejects(call('ultra_personal_document_import',{agent_id:'codex',event_id:'noconsent',consent:false,
    label:'n.txt',content_base64:b64(original),content_sha256:SHA(original)}),{code:'capture_disabled'});pass();
  // Ownership isolation: another authenticated principal sees and touches nothing.
  assert.equal((await call('ultra_personal_document_list',{},second)).documents.length,0);pass();
  await assert.rejects(call('ultra_personal_document_read',{document_id:imported.document_id},second),{code:'not_found'});pass();
  await assert.rejects(call('ultra_personal_document_archive',{event_id:'steal',document_id:imported.document_id},second),{code:'not_found'});pass();
  // Fragment queueing is atomic: memory rows, jobs and fragment links commit together or not at all.
  await assert.rejects(call('ultra_personal_document_queue',{event_id:'q-bad',document_id:imported.document_id,
    fragments:[{byte_start:1,byte_length:3}]}),{code:'invalid_utf8'});pass(); // splits a multibyte code point
  const queued=await call('ultra_personal_document_queue',{event_id:'q-1',document_id:imported.document_id,
    fragments:[{byte_start:0,byte_length:64},{byte_start:64,byte_length:original.length-64}]});
  assert.equal(queued.fragments.length,2);assert.equal(queued.model_calls,0);assert.equal(queued.review_required,true);
  for(const f of queued.fragments){
    const [link]=await engine.executeRaw('SELECT byte_start,byte_end,fragment_sha256,offset_unit FROM ultrabrain.personal_document_fragments WHERE memory_id=$1::uuid',[f.memory_id]);
    assert.deepEqual([link.byte_start,link.byte_end],[f.byte_start,f.byte_end]);
    assert.equal(link.fragment_sha256,f.fragment_sha256);assert.equal(link.offset_unit,'utf8-bytes');
    assert.equal(SHA(original.subarray(f.byte_start,f.byte_end)),f.fragment_sha256);
  }
  pass();
  const queuedReplay=await call('ultra_personal_document_queue',{event_id:'q-1',document_id:imported.document_id,
    fragments:[{byte_start:0,byte_length:64},{byte_start:64,byte_length:original.length-64}]});
  assert.equal(queuedReplay.replayed,true);assert.equal(queuedReplay.fragments.length,2);
  assert.equal((await engine.executeRaw('SELECT count(*)::integer AS n FROM ultrabrain.personal_document_fragments WHERE source_id=$1 AND actor_key=$2',[source,actor]))[0].n,2);pass();
  // Document fragments are fenced from the plain personal-memory edit interfaces.
  await assert.rejects(call('ultra_personal_update',{memory_id:queued.fragments[0].memory_id,event_id:'edit-frag',expected_revision:1,
    memory:{type:'experience',content:'rewritten',importance:'normal',visibility:'private'}}),{code:'document_bound'});pass();
  await assert.rejects(call('ultra_personal_review',{memory_id:queued.fragments[0].memory_id,event_id:'review-frag',expected_revision:1,status:'active'}),{code:'document_bound'});pass();
  // Queue capacity rejects whole requests without removing existing records.
  await engine.executeRaw(`INSERT INTO ultrabrain.personal_memories(source_id,actor_key,type,content,content_hash,importance,source,agent_id,status,visibility,origin_kind)
    SELECT $1,$2,'experience','capacity probe '||g,md5('capacity probe '||g),'normal','capacity-probe','codex','candidate','private','agent' FROM generate_series(1,300) g`,
    [source,actor]);
  await engine.executeRaw(`INSERT INTO ultrabrain.personal_consolidations(source_id,actor_key,input_id,input_revision,input_hash)
    SELECT source_id,actor_key,id,1,content_hash FROM ultrabrain.personal_memories WHERE source_id=$1 AND actor_key=$2 AND source='capacity-probe'`,
    [source,actor]);
  const small=Buffer.from('synthetic capacity log\n','utf8');
  const third=await call('ultra_personal_document_import',{agent_id:'codex',event_id:'imp-3',consent:true,label:'more.log',
    content_base64:b64(small),content_sha256:SHA(small)});
  await assert.rejects(call('ultra_personal_document_queue',{event_id:'q-full',document_id:third.document_id,
    fragments:[{byte_start:0,byte_length:10}]}),{code:'queue_full'});
  const [retained]=await engine.executeRaw('SELECT count(*)::integer AS n FROM ultrabrain.personal_consolidations WHERE source_id=$1 AND actor_key=$2 AND input_id=ANY($3::uuid[])',
    [source,actor,queued.fragments.map(f=>f.memory_id)]);
  assert.equal(retained.n,2);pass();
  await engine.executeRaw("DELETE FROM ultrabrain.personal_consolidations WHERE source_id=$1 AND actor_key=$2 AND input_id IN (SELECT id FROM ultrabrain.personal_memories WHERE source_id=$1 AND actor_key=$2 AND source='capacity-probe')",[source,actor]);
  await engine.executeRaw("DELETE FROM ultrabrain.personal_memories WHERE source_id=$1 AND actor_key=$2 AND source='capacity-probe'",[source,actor]);
  const afterFill=await call('ultra_personal_document_queue',{event_id:'q-2',document_id:third.document_id,fragments:[{byte_start:0,byte_length:10}]});
  assert.equal(afterFill.fragments.length,1);pass();
  // No model in CI: processing reports needs_model instead of pretending success.
  const processed=await call('ultra_personal_consolidate',{expected_source:source,allow_model_call:true,job_id:queued.fragments[0].job_id});
  assert.equal(processed.state,'needs_model');assert.equal(processed.model_calls,0);pass();
  // An in-flight worker holding a live lease must be fenced by archive before its commit.
  const lease=randomUUID();
  await engine.executeRaw(`UPDATE ultrabrain.personal_consolidations SET state='processing',lease_id=$3::uuid,lease_until=clock_timestamp()+interval '3 minutes',attempts=1
    WHERE source_id=$1 AND actor_key=$2 AND id=$4::uuid`,[source,actor,lease,queued.fragments[1].job_id]);
  // Derived entries reference the fragment; they are current while the fragment is live.
  await engine.executeRaw(`INSERT INTO ultrabrain.personal_memories(source_id,actor_key,type,content,content_hash,importance,source,agent_id,status,visibility,derivation,origin_kind)
    VALUES($1,$2,'preference','Synthetic derived preference',md5('synthetic derived preference'),'normal','synthetic model-derived fixture','codex','active','private',
    jsonb_build_object('input_id',$3::text,'input_revision',1,'input_hash',$4,'job_id',$5::text),'agent')`,
    [source,actor,queued.fragments[0].memory_id,queued.fragments[0].fragment_sha256,queued.fragments[0].job_id]);
  const activeContext=await call('ultra_personal_context');
  assert.ok(activeContext.memories.some(m=>m.content==='Synthetic derived preference'));pass();
  const archived=await call('ultra_personal_document_archive',{event_id:'arch-1',document_id:imported.document_id});
  assert.equal(archived.status,'archived');assert.equal(archived.original_retained,true);
  assert.equal(archived.archived_fragments,2);assert.ok(archived.derived_entries_invalidated>=1);pass();
  const [fenced]=await engine.executeRaw('SELECT state,error_code FROM ultrabrain.personal_consolidations WHERE source_id=$1 AND actor_key=$2 AND id=ANY($3::uuid[])',
    [source,actor,queued.fragments.map(f=>f.job_id)]);
  assert.equal(fenced.state,'stale');assert.equal(fenced.error_code,'source_archived');
  assert.equal((await engine.executeRaw("SELECT count(*)::integer AS n FROM ultrabrain.personal_consolidations WHERE source_id=$1 AND actor_key=$2 AND id=ANY($3::uuid[]) AND state='stale'",[source,actor,queued.fragments.map(f=>f.job_id)]))[0].n,2);pass();
  const postContext=await call('ultra_personal_context');
  assert.ok(!postContext.memories.some(m=>m.content==='Synthetic derived preference'));pass(); // Leaves current use.
  const ownerSearch=await call('ultra_memory_search',{status:'active'});
  const derivedRow=ownerSearch.memories.find(m=>m.content==='Synthetic derived preference');
  assert.ok(derivedRow);assert.equal(derivedRow.derivation_current,false);pass(); // Retained but no longer current.
  const archivedRead=await call('ultra_personal_document_read',{document_id:imported.document_id});
  assert.equal(Buffer.from(archivedRead.content_base64,'base64').compare(original),0);pass(); // Original retained.
  await assert.rejects(call('ultra_personal_document_queue',{event_id:'q-3',document_id:imported.document_id,
    fragments:[{byte_start:0,byte_length:10}]}),{code:'invalid_params'});pass(); // Archived docs no longer queue.
  await assert.rejects(call('ultra_personal_document_archive',{event_id:'arch-2',document_id:imported.document_id}),{code:'invalid_params'});pass();
  // Mid-import database failure rolls the document and its event receipt back together.
  const faulty={...options,engine:{kind:'postgres',executeRaw:(...a)=>engine.executeRaw(...a),transaction:fn=>engine.transaction(tx=>fn({executeRaw:async(q,p)=>{
    if(q.includes('INSERT INTO ultrabrain.personal_documents'))throw Error('injected storage failure');
    return tx.executeRaw(q,p);
  }}))}};
  const {PersonalDocumentStore}=await import('../src/personal-documents.mjs');
  await assert.rejects(new PersonalDocumentStore(faulty).documentImport({agent_id:'codex',event_id:'rollback',consent:true,
    label:'rollback.txt',content_base64:b64(small),content_sha256:SHA(small)}));
  assert.equal((await engine.executeRaw("SELECT count(*)::integer AS n FROM ultrabrain.personal_documents WHERE source_id=$1 AND actor_key=$2 AND label='rollback.txt'",[source,actor]))[0].n,0);
  assert.equal((await engine.executeRaw("SELECT count(*)::integer AS n FROM ultrabrain.personal_events WHERE source_id=$1 AND actor_key=$2 AND event_id='rollback'",[source,actor]))[0].n,0);pass();
  // Actual stdio MCP: the five document tools appear in tools/list and import round-trips on the wire.
  const stdio=new Client({name:'pdocs-stdio-test',version:'1'});clients.push(stdio);
  const stdioTransport=new StdioClientTransport({command:process.execPath,args:[ROOT+'/src/cli.mjs','mcp'],cwd:ROOT,
    env:{...process.env,GBRAIN_SOURCE:source,GBRAIN_SWEEP:'0'},stderr:'pipe'});transports.push(stdioTransport);
  stdioTransport.stderr?.on('data',()=>{});await stdio.connect(stdioTransport);
  const catalog=(await stdio.listTools()).tools.map(x=>x.name);
  for(const name of ['ultra_personal_document_import','ultra_personal_document_list','ultra_personal_document_read','ultra_personal_document_queue','ultra_personal_document_archive'])
    assert.ok(catalog.includes(name),name+' missing from tools/list');
  pass();
  const wire=await stdio.callTool({name:'ultra_personal_document_import',arguments:{agent_id:'codex',event_id:'stdio-imp',consent:true,
    label:'stdio.md',content_base64:b64(original),content_sha256:SHA(original)}});
  const wireResult=JSON.parse(wire.content[0].text);assert.ok(!wire.isError);assert.equal(wireResult.byte_size,original.length);pass();
  assert.equal((await migrationStatus(engine)).pending.length,0);pass();
  console.log(`PASS ${checks} personal document checks: PostgreSQL originals/replay/rollback/capacity/archive fencing, real stdio MCP tools`);
} finally {
  for(const tr of transports)try{await tr.terminateSession?.();}catch{}
  for(const c of clients)try{await c.close();}catch{}
  for(const p of children)if(p.exitCode===null){p.kill('SIGTERM');const timer=setTimeout(()=>p.kill('SIGKILL'),5000);await once(p,'exit');clearTimeout(timer);}
  await engine.disconnect();
}
