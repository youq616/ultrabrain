/** Real PostgreSQL safety regression. Synthetic data only, isolated test DB required.
 * A single native connection proves transaction settings revert on the SAME backend;
 * a separate transaction holds a table lock to cause an actual ranking query timeout.
 */
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {connect,prepareEnvironment,loadNative} from '../src/runtime.mjs';
import {PersonalMemoryStore} from '../src/personal-memory-store.mjs';
import {sha256} from '../src/core.mjs';
assert.equal(process.env.ULTRABRAIN_TEST_ALLOW_WRITE,'1','Use an isolated synthetic test installation');
const engine=await connect(),source='rank-safe-'+randomBytes(5).toString('hex');
const auth={sourceId:source,principal:{kind:'oauth_client',id:'ranking-safety'},scopes:['read','write']};
const context={engine,sourceId:source,transport:'http',remote:true,auth};
const store=new PersonalMemoryStore(context);
let single,releaseLock,lockTask,guard,checks=0;
const pass=()=>checks++;
try {
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)',[source]);
  const registered=await store.register({agent_id:'safety'});
  const learned=await store.commit({agent_id:'safety',event_id:'old',consent:true,memories:[
    {type:'preference',importance:'high',content:'请提供完整命令行，不要删除已有配置。'}]});
  const old=learned.entries[0].id;
  await store.review({memory_id:old,event_id:'activate',expected_revision:1,status:'active'});
  await engine.executeRaw("UPDATE ultrabrain.personal_memories SET updated_at='2023-01-01T00:00:00Z' WHERE id=$1::uuid",[old]);
  // More than a thousand new ordinary preferences must not hide the older high entry.
  await engine.transaction(async tx=>{
    for(let i=0;i<1005;i++)await tx.executeRaw(`INSERT INTO ultrabrain.personal_memories
      (source_id,actor_key,type,content,content_hash,importance,source,agent_id,status)
      VALUES($1,$2,'preference',$3,$4,'normal','synthetic ranking safety','safety','active')`,
      [source,registered.actor_key,'recent observation '+i,sha256('recent observation '+i)]);
  });
  const recent=await engine.executeRaw('SELECT id::text FROM ultrabrain.personal_memories WHERE source_id=$1 ORDER BY updated_at DESC,id LIMIT 100',[source]);
  assert.ok(!recent.some(r=>r.id===old),'The old time-window defect must be reproduced by this fixture');
  assert.equal((await store.profile({limit:100,budget_bytes:131072})).memories[0].id,old);pass();
  assert.equal((await store.context({task:'完整 命令行',limit:100,budget_bytes:131072})).memories[0].id,old);pass();
  for(const budget of [512,700,2000,8192]){
    const result=await store.context({budget_bytes:budget});
    assert.ok(Buffer.byteLength(JSON.stringify(result))<=budget);
    assert.ok(result.memories.every(m=>sha256(m.content)===m.content_hash));
    assert.equal(result.exhaustive,false);
  }pass();
  // Global query searches remain ordinary literal filters, with no authority from task text.
  assert.equal((await store.context({query:"%' OR 1=1 --"})).memories.length,0);pass();
  const otherSource='rank-other-'+randomBytes(5).toString('hex');
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)',[otherSource]);
  const other=new PersonalMemoryStore({...context,sourceId:otherSource,auth:{...auth,sourceId:otherSource}});
  assert.equal((await other.context({task:'完整'})).memories.length,0);
  assert.throws(()=>new PersonalMemoryStore({...context,sourceId:otherSource}),{code:'permission_denied'});pass();
  // Case-folding of TASK words is ASCII-only; query keeps existing DB literal semantics.
  const special=await store.commit({agent_id:'safety',event_id:'unicode',consent:true,memories:[
    {type:'preference',importance:'normal',content:'ЖУРНАЛ İstanbul emoji 🚀 不要删除'},
    {type:'preference',importance:'normal',content:'журнал istanbul emoji 🚀 不要删除'}]});
  for(const row of special.entries)await store.review({memory_id:row.id,event_id:'active-'+row.id,expected_revision:1,status:'active'});
  assert.equal((await store.context({task:'ЖУРНАЛ',query:'emoji'})).memories[0].id,special.entries[0].id);
  assert.equal((await store.context({task:'ISTANBUL',query:'emoji'})).memories[0].id,special.entries[1].id);pass();
  // The ordinary adapter's single-connection mode makes PID equality meaningful.
  const {PostgresEngine}=await loadNative('src/core/postgres-engine.ts');
  single=new PostgresEngine();await single.connect({...prepareEnvironment(),poolSize:1});
  const snapshot=async()=>{
    const [row]=await single.executeRaw("SELECT pg_backend_pid() AS pid,current_setting('statement_timeout') AS timeout,current_setting('transaction_read_only') AS readonly");
    return row;
  };
  const baseline=await snapshot(),singleStore=new PersonalMemoryStore({...context,engine:single});
  assert.equal((await singleStore.context({limit:1})).memories.length,1);
  assert.deepEqual(await snapshot(),baseline);pass();
  let acquired;
  const ready=new Promise(resolve=>acquired=resolve),unblock=new Promise(resolve=>releaseLock=resolve);
  // Only this explicitly isolated test DB is locked; never runs against production.
  lockTask=engine.transaction(async tx=>{
    await tx.executeRaw("SET LOCAL statement_timeout='15s'");
    await tx.executeRaw('LOCK TABLE ultrabrain.personal_memories IN ACCESS EXCLUSIVE MODE');
    acquired();await unblock;
  });
  guard=setTimeout(()=>releaseLock(),10000);
  await Promise.race([ready,lockTask.then(()=>{throw Error('Lock transaction ended before acquisition');})]);
  // Dispatch runs the real store and maps a PG timeout to a safe MCP error, not success [].
  const {dispatchToolCall}=await loadNative('src/mcp/dispatch.ts');
  let rawCode;
  const instrumented=Object.create(single);
  instrumented.transaction=fn=>single.transaction(tx=>{
    const checked=Object.create(tx);
    checked.executeRaw=async(...args)=>{try{return await tx.executeRaw(...args);}catch(e){rawCode=e.code;throw e;}};
    return fn(checked);
  });
  const response=await dispatchToolCall(instrumented,'ultra_personal_context',{}, {...context,engine:instrumented});
  assert.equal(rawCode,'57014','The actual ranking SELECT must time out in PostgreSQL');
  assert.equal(response.isError,true);assert.equal(JSON.parse(response.content[0].text).error,'personal_storage_error');
  releaseLock();await lockTask;clearTimeout(guard);guard=null;pass();
  assert.deepEqual(await snapshot(),baseline,'SET LOCAL must revert on the same backend after rollback');
  const receipt=await singleStore.commit({agent_id:'safety',event_id:'after-timeout',consent:true,summary:'Synthetic write after actual timeout'});
  assert.equal(receipt.storage,'stored');assert.deepEqual(await snapshot(),baseline);pass();
  assert.equal((await singleStore.context({query:'nonexistent-value'})).memories.length,0);pass();
  console.log(`PASS ${checks} ranking safety checks: 1005 newer preferences, exact budgets, source/case boundaries, actual PG timeout and same-backend recovery`);
} finally {
  releaseLock?.();if(guard)clearTimeout(guard);
  try{await lockTask;}finally{try{await single?.disconnect();}finally{await engine.disconnect();}}
}
