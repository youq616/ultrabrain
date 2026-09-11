/** Real native PostgreSQL + pinned GBrain adapter + MCP wire integration. No fake DB. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { connect, loadNative, ROOT } from '../src/runtime.mjs';
const engine = await connect({ migrate: true });
const { dispatchToolCall } = await loadNative('src/mcp/dispatch.ts');
const opts = { remote: true, transport: 'stdio', sourceId: 'default' };
const run = async (name, params, extra={}) => {
  const r = await dispatchToolCall(engine, name, params, {...opts,...extra});
  const value = JSON.parse(r.content[0].text);
  if(r.isError) throw Object.assign(new Error(JSON.stringify(value)),{code:value.error});
  return value;
};
const id = `ultra-it-${Date.now()}`;
let checks=0;
try {
  const [role] = await engine.executeRaw('SELECT rolsuper FROM pg_roles WHERE rolname=current_user');
  assert.equal(role.rolsuper,false); checks++;
  await run('ultra_write',{uri:`ultra://default/resources/${id}`,content:`---\ntype: note\ntitle: ${id}\nvisibility: world\n---\nUltrabrain integration memory ${id}. 中文检索。`}); checks++;
  const read = await run('ultra_read',{uri:`ultra://default/resources/${id}`,level:'L2'});
  assert.ok(read.content.includes(id)); checks++;
  const overview = await run('ultra_read',{uri:`ultra://default/resources/${id}`,level:'L0'});
  assert.equal(overview.summary_method,'extractive-prefix-v1');checks++;
  const list = await run('ultra_ls',{uri:'ultra://default/resources'});
  assert.ok(list.entries.some(x=>x.uri.endsWith(id)));checks++;
  const retrieval = await run('ultra_retrieve',{uri:'ultra://default/resources',query:id,budget_bytes:8000});
  assert.ok(retrieval.items.some(x=>x.content.includes(id)));checks++;
  await engine.executeRaw("INSERT INTO sources(id,name) VALUES ('ultra-secret','ultra-secret') ON CONFLICT DO NOTHING");
  await run('put_page',{slug:`secret/${id}`,content:`---\ntype: note\n---\nOther-source secret ${id}`},
    {remote:false,sourceId:'ultra-secret'});
  await assert.rejects(run('ultra_read',{uri:`ultra://ultra-secret/secret/${id}`,level:'L2'}));checks++;
  await run('put_page',{slug:`private/${id}`,content:'---\ntype: note\nvisibility: private\n---\nHost-private canary'}, {remote:false});
  await assert.rejects(run('ultra_read',{uri:`ultra://default/private/${id}`,level:'L2'}));checks++;
  const session={session_id:id,event_id:'final',transcript:'A test transcript with no configured extraction API.',visibility:'private'};
  const receipt=await run('ultra_commit_session',session);
  assert.equal(receipt.state,'needs_model');checks++;
  const replay=await run('ultra_commit_session',session);
  assert.equal(replay.replayed,true);checks++;
  await assert.rejects(run('ultra_commit_session',{...session,transcript:'Changed'}));checks++;
  await run('ultra_delete',{uri:`ultra://default/resources/${id}`});
  await assert.rejects(run('ultra_read',{uri:`ultra://default/resources/${id}`}));checks++;
  await run('restore_page',{slug:`resources/${id}`});
  assert.ok((await run('ultra_read',{uri:`ultra://default/resources/${id}`})).content.includes(id));checks++;
  console.log(`PASS ${checks} real database/adapter checks`);
} finally { await engine.disconnect(); }
// Verify wrapper registration reaches the real upstream SDK MCP server, not merely direct handlers.
const child=spawn(process.execPath,[`${ROOT}/src/cli.mjs`,'mcp'],{
  cwd:ROOT,env:{...process.env,GBRAIN_SOURCE:'default',GBRAIN_SWEEP:'0'},stdio:['pipe','pipe','pipe']});
const pending=new Map();let seq=0;let stderr='';
child.stderr.on('data',x=>{stderr=(stderr+x).slice(-8000);});
const lines=createInterface({input:child.stdout});
lines.on('line',line=>{
  try {const r=JSON.parse(line);const waiter=pending.get(r.id);if(waiter){pending.delete(r.id);r.error?waiter.reject(new Error(JSON.stringify(r.error))):waiter.resolve(r.result);}}
  catch { /* the test times out if stdout isn't valid MCP; startup diagnostics remain in stderr */ }
});
const request=(method,params={})=>new Promise((resolve,reject)=>{
  const id=++seq;const timer=setTimeout(()=>reject(new Error(`MCP timeout for ${method}; ${stderr}`)),90000);
  pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
});
try {
  const initialized=await request('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'ultrabrain-integration',version:'0.1'}});
  assert.ok(initialized.serverInfo);
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  const catalog=await request('tools/list');
  for(const name of ['get_page','remember','ultra_read','ultra_retrieve','ultra_commit_session'])
    assert.ok(catalog.tools.some(t=>t.name===name),`Missing wire tool: ${name}`);
  const read=await request('tools/call',{name:'ultra_read',arguments:{uri:`ultra://default/resources/${id}`,level:'L0'}});
  assert.ok(!read.isError,JSON.stringify(read));
  assert.ok(read.content[0].text.includes(id));
  console.log('PASS native MCP initialize, tool discovery and ultra_read wire round trip');
} finally {child.stdin.end();child.kill('SIGTERM');lines.close();}
