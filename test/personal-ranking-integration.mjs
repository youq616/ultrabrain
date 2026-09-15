/** Real PostgreSQL personal-ranking integration: rank-before-window recall, canonical
 * SQL/JavaScript agreement over a 450-row corpus, isolation, literal task terms and
 * connection-safety regressions. Synthetic data only; no model is called.
 */
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {connect,loadNative} from '../src/runtime.mjs';
import {buildPersonalContext,taskTerms} from '../src/personal-context-engine.mjs';
import {PersonalMemoryStore,PERSONAL_DERIVATION_CURRENT} from '../src/personal-memory-store.mjs';
assert.equal(process.env.ULTRABRAIN_TEST_ALLOW_WRITE,'1','Isolated test database required');
const engine=await connect({migrate:true}),tag=randomBytes(5).toString('hex'),source='rank-'+tag;
const {dispatchToolCall}=await loadNative('src/mcp/dispatch.ts');
const auth={token:'synthetic',clientId:'a',principal:{kind:'oauth_client',id:'a'},sourceId:source,scopes:['read','write']};
const options={engine,sourceId:source,remote:true,transport:'http',auth};
const second={auth:{...auth,clientId:'b',principal:{kind:'oauth_client',id:'b'}}};
const reader={auth:{...auth,clientId:'c',principal:{kind:'oauth_client',id:'c'},scopes:['read']}};
const call=async(name,p={},extra={})=>{
  const result=await dispatchToolCall(engine,name,p,{...options,...extra});
  const data=JSON.parse(result.content[0].text);
  if(result.isError)throw Object.assign(new Error(data.error),{code:data.error});
  return data;
};
const SHA=s=>createHash('sha256').update(s).digest('hex');
let actor,checks=0;const pass=()=>checks++;
async function insert(rows) { // Direct synthetic fixtures: agent labels registered through the real tool below.
  for(const r of rows)await engine.executeRaw(`INSERT INTO ultrabrain.personal_memories
    (source_id,actor_key,type,content,content_hash,importance,source,agent_id,project_id,status,visibility,origin_kind,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,'ranking fixture',$7,$8,$9,$10,'agent',$11)`,
    [source,actor,r.type,r.content,SHA(r.content),r.importance,r.agent_id??'codex',r.project_id??null,
     r.status??'active',r.visibility??'private',r.updated_at]);
}
try {
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)',[source]);
  await call('ultra_agent_register',{agent_id:'codex',agent_type:'coding_agent'});
  await call('ultra_agent_register',{agent_id:'helper',agent_type:'automation_agent'});
  [actor]=await engine.executeRaw('SELECT actor_key FROM ultrabrain.agent_registry WHERE source_id=$1 AND agent_id=$2 LIMIT 1',[source,'codex']);
  const day=(n,h=0)=>new Date(Date.UTC(2026,8,1,0,0,0,n*1000+h)); // deterministic, sub-second spread
  // 1) Rank-before-window: one old high preference outranks 110 newer normal entries.
  await insert([{type:'preference',content:'Always prefer full CLI commands in the terminal',importance:'high',updated_at:new Date('2023-06-01T00:00:00.000Z')}]);
  await insert(Array.from({length:110},(_,i)=>({type:'experience',content:'routine log entry '+i,importance:'normal',updated_at:day(i)})));
  const recalled=await call('ultra_personal_context',{limit:100,budget_bytes:131072,task:'full CLI commands'});
  assert.equal(recalled.memories[0].content,'Always prefer full CLI commands in the terminal');pass(); // window no longer hides it
  assert.ok(recalled.memories.length<=100);
  assert.equal(recalled.exhaustive,false);assert.equal(recalled.recall!==undefined,true);pass();
  // 2) Duplicate task words count once; ASCII case folds; CJK and emoji match literally.
  const once=await call('ultra_personal_context',{limit:5,budget_bytes:131072,task:'prefer prefer PREFER full'});
  const hit=once.memories.find(m=>m.content.startsWith('Always prefer'));
  assert.ok(hit&&once.memories[0].id===hit.id);pass(); // 3+2 = 5 beats plain normals (2)
  await insert([
    {type:'preference',content:'喜欢用 中文 记录 偏好，不要改写否定词',importance:'normal',updated_at:day(200)},
    {type:'preference',content:'deploy checklist 🚀 use emoji markers',importance:'normal',updated_at:day(201)},
  ]);
  const cjk=await call('ultra_personal_context',{limit:3,budget_bytes:131072,task:'中文 偏好'});
  assert.ok(cjk.memories[0].content.includes('中文'));pass();
  const emoji=await call('ultra_personal_context',{limit:3,budget_bytes:131072,task:'🚀 emoji'});
  assert.ok(emoji.memories[0].content.includes('🚀'));pass();
  // 3) Tie order: equal scores break on millisecond time desc, then full UUID asc.
  await insert([
    {type:'preference',content:'tie-ms-early',importance:'low',updated_at:'2026-09-05T00:00:00.250Z'},
    {type:'preference',content:'tie-ms-late',importance:'low',updated_at:'2026-09-05T00:00:00.750Z'},
  ]);
  const msOrder=await call('ultra_personal_context',{limit:2,budget_bytes:131072,types:['preference'],task:'tie-ms'});
  assert.equal(msOrder.memories[0].content,'tie-ms-late');pass();
  const uuidRows=await engine.executeRaw(`INSERT INTO ultrabrain.personal_memories
    (source_id,actor_key,type,content,content_hash,importance,source,agent_id,status,visibility,origin_kind,updated_at)
    VALUES($1,$2,'preference',$3,$4,'low','ranking fixture','codex','active','private','agent','2026-09-06T00:00:00.000Z')
    RETURNING id::text AS id, content`,[source,actor,'tie-uuid-zzz',SHA('tie-uuid-zzz')]);
  await engine.executeRaw(`INSERT INTO ultrabrain.personal_memories
    (source_id,actor_key,type,content,content_hash,importance,source,agent_id,status,visibility,origin_kind,updated_at)
    VALUES($1,$2,'preference',$3,$4,'low','ranking fixture','codex','active','private','agent','2026-09-06T00:00:00.000Z')`,
    [source,actor,'tie-uuid-aaa',SHA('tie-uuid-aaa')]);
  const uuidOrder=await call('ultra_personal_context',{limit:3,budget_bytes:131072,types:['preference'],task:'tie-uuid'});
  assert.equal(uuidOrder.memories[0].content,'tie-uuid-aaa');pass(); // smaller UUID first at equal score+time
  // 4) Project scoping: context project rows exclude other projects but include global.
  await insert([
    {type:'project',content:'project-a rule: run tests before merge',importance:'normal',project_id:'proj-a',updated_at:day(300)},
    {type:'project',content:'project-b note',importance:'high',project_id:'proj-b',updated_at:day(301)},
  ]);
  const projA=await call('ultra_personal_context',{limit:50,budget_bytes:131072,project_id:'proj-a',task:'project'});
  assert.ok(projA.memories.some(m=>m.project_id==='proj-a'||m.project_id===null));
  assert.ok(!projA.memories.some(m=>m.project_id==='proj-b'));pass();
  // 5) Principal isolation and explicit source sharing.
  assert.equal((await call('ultra_personal_context',{limit:100,budget_bytes:131072},second)).memories.filter(m=>m.owned_by_caller===false).length,0);pass();
  await insert([{type:'preference',content:'shared preference for the whole source',importance:'high',visibility:'source',updated_at:day(400)}]);
  const shared=await call('ultra_personal_context',{limit:100,budget_bytes:131072},second);
  assert.ok(shared.memories.some(m=>m.content==='shared preference for the whole source'&&m.owned_by_caller===false));pass();
  // 6) Candidate, archived and stale-derivation entries never reach context.
  await insert([
    {type:'preference',content:'candidate invisible',importance:'high',status:'candidate',updated_at:day(500)},
    {type:'preference',content:'archived invisible',importance:'high',status:'archived',updated_at:day(501)},
  ]);
  const [staleOrigin]=await engine.executeRaw(`INSERT INTO ultrabrain.personal_memories
    (source_id,actor_key,type,content,content_hash,importance,source,agent_id,status,visibility,origin_kind,updated_at)
    VALUES($1,$2,'experience','stale origin input',$3,'normal','ranking fixture','codex','archived','private','agent',$4) RETURNING id::text AS id`,
    [source,actor,SHA('stale origin input'),day(502)]);
  await engine.executeRaw(`INSERT INTO ultrabrain.personal_memories
    (source_id,actor_key,type,content,content_hash,importance,source,agent_id,status,visibility,origin_kind,derivation,updated_at)
    VALUES($1,$2,'preference','derived from stale origin',$3,'high','ranking fixture','codex','active','private','agent',
      jsonb_build_object('input_id',$4::text,'input_revision',1,'input_hash',$5),day(503))`,
    [source,actor,SHA('derived from stale origin'),staleOrigin.id,SHA('stale origin input')]);
  const visible=await call('ultra_personal_context',{limit:100,budget_bytes:131072});
  assert.ok(!visible.memories.some(m=>m.content==='candidate invisible'||m.content==='archived invisible'||m.content==='derived from stale origin'));pass();
  // 7) Read-only authenticated identity may read context; write stays denied for it.
  const readOnly=await call('ultra_personal_context',{limit:5,budget_bytes:131072},reader);
  assert.equal(readOnly.memories.length,5);pass();
  await assert.rejects(call('ultra_memory_commit',{agent_id:'codex',event_id:'deny',consent:true,
    memories:[{type:'preference',content:'must not store',importance:'normal'}]},reader),{code:'permission_denied'});pass();
  // 8) Hostile task text is matched literally; no SQL is formed from it and the table survives.
  const hostile="'; DROP TABLE ultrabrain.personal_memories; --";
  const hostileResult=await call('ultra_personal_context',{limit:5,budget_bytes:131072,task:hostile});
  assert.ok(Array.isArray(hostileResult.memories));pass();
  assert.equal((await engine.executeRaw('SELECT count(*)::integer AS n FROM ultrabrain.personal_memories WHERE source_id=$1',[source]))[0].n>0,true);pass();
  // 9) Search keeps time-ordered pagination, independent of ranking.
  const page1=await call('ultra_memory_search',{status:'active',limit:20,offset:0,budget_bytes:131072,types:['experience']});
  const page2=await call('ultra_memory_search',{status:'active',limit:20,offset:20,budget_bytes:131072,types:['experience']});
  assert.equal(page1.next_offset,20);
  assert.ok(!page1.memories.some(a=>page2.memories.some(b=>b.id===a.id)));
  const times=page1.memories.map(m=>Date.parse(m.updated_at));
  assert.ok(times.every((t,i)=>i===0||times[i-1]>=t));pass();
  // 10) Byte budget drops whole entries only and never truncates a negation.
  const tight=await call('ultra_personal_context',{limit:100,budget_bytes:2000,task:'prefer'});
  assert.ok(tight.memories.every(m=>m.content.includes('不要')?m.content.endsWith('否定词')||m.content.includes('不要改写否定词'):true));
  assert.ok(Buffer.byteLength(JSON.stringify(tight))<=2000+tight.memories.length*80); // bounded envelope, whole rows
  pass();
  // 11) Local timeouts and read-only settings never leak past the context transaction.
  const [before]=await engine.executeRaw("SELECT current_setting('statement_timeout') AS t, current_setting('default_transaction_read_only') AS r");
  await call('ultra_personal_context',{limit:5,budget_bytes:131072,task:'leak check prefer'});
  const [after]=await engine.executeRaw("SELECT current_setting('statement_timeout') AS t, current_setting('default_transaction_read_only') AS r");
  assert.equal(after.t,before.t);assert.equal(after.r,before.r);pass();
  await call('ultra_memory_commit',{agent_id:'codex',event_id:'post-context-write',consent:true,
    memories:[{type:'experience',content:'connection still writable after read-only context',importance:'low'}]});pass();
  // 12) Canonical agreement: 450 synthetic rows, 20 query groups, SQL order == JavaScript order.
  const corpus=Array.from({length:450},(_,i)=>({
    type:['preference','experience','project','goal'][i%4],
    content:`note ${i} ${['cli','中文','deploy','🚀','docker','editor'][i%6]} ${i%7===0?'highlight':''}`,
    importance:['high','normal','low'][i%3],
    agent_id:i%5===0?'helper':'codex',
    project_id:i%9===0?(i%2?'proj-a':'proj-b'):null,
    updated_at:new Date(Date.UTC(2025,0,1,0,0,0,i*997)),
  }));
  await insert(corpus);
  const queryGroups=[
    {task:'',types:undefined},{task:'cli'},{task:'CLI Docker'},{task:'中文'},{task:'🚀 deploy'},
    {task:'cli cli cli'},{task:'editor highlight'},{task:'note 429'},{task:'proj project'},
    {task:'',types:['preference']},{task:'',types:['goal','project']},{task:'cli',types:['preference','experience']},
    {task:'中文 🚀'},{task:'DOCKER'},{task:'helper note'},{task:'',project_id:'proj-a'},
    {task:'cli',project_id:'proj-b'},{task:'',agent_id:'helper'},{task:'deploy',agent_id:'codex',types:['project']},
    {task:"'; DROP TABLE x; --"},
  ];
  const allRows=(await engine.executeRaw(`SELECT id::text AS id,type,content,importance,agent_id,project_id,status,visibility,
    updated_at,(actor_key=$2) AS owned_by_caller,CASE WHEN actor_key=$2 THEN derivation ELSE NULL END AS derivation,
    ${PERSONAL_DERIVATION_CURRENT} AS derivation_current
    FROM ultrabrain.personal_memories m WHERE m.source_id=$1 AND m.actor_key=$2 AND m.status='active'`,[source,actor]))
    .map(row=>({...row,confidence:null,trust:'untrusted-memory-data'}));
  for(const group of queryGroups) {
    const params={limit:100,budget_bytes:131072,...(group.task!==undefined?{task:group.task}:{}),...(group.types?{types:group.types}:{}),
      ...(group.project_id?{project_id:group.project_id}:{}),...(group.agent_id?{agent_id:group.agent_id}:{})};
    const sql=await call('ultra_personal_context',params);
    const js=buildPersonalContext(allRows,params);
    assert.deepEqual(sql.memories.map(m=>m.id),js.memories.map(m=>m.id),
      `SQL/JS disagreement for ${JSON.stringify(group)}`);
  }
  pass(); // 20 groups compared
  console.log(`PASS ${checks} personal ranking checks: rank-before-window recall, canonical SQL/JS agreement (450 rows x 20 groups), isolation, literal terms, pagination, budget, connection safety`);
} finally {
  await engine.disconnect();
}
