/** Real authenticated Streamable HTTP MCP, including a separate consolidation process. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { connect, ROOT } from '../src/runtime.mjs';
import { Client } from '../vendor/gbrain/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StreamableHTTPClientTransport } from '../vendor/gbrain/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';
const engine = await connect();
const suffix = randomBytes(6).toString('hex');
const source = `http-${suffix}`;
const clients = [], tokenNames = [];
const workerDir=mkdtempSync(join(tmpdir(),'ub-worker-http-'));
let worker;
let child, checks = 0;
const proof = () => checks++;
const freePort = async () => {
  const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); return port;
};
const mint = async (name, scopes, sourceId) => {
  const token = `gbrain_${randomBytes(32).toString('hex')}`;
  const label = `http-test-${suffix}-${name}`;
  tokenNames.push(label);
  await engine.executeRaw(`INSERT INTO access_tokens (name,token_hash,scopes,permissions)
    VALUES ($1,$2,$3::text[],$4::text::jsonb)`, [label,createHash('sha256').update(token).digest('hex'),
    `{${scopes.join(',')}}`, JSON.stringify({source_id:sourceId,takes_holders:['world']})]);
  return token;
};
const result = response => {
  assert.ok(!response.isError, JSON.stringify(response));
  return JSON.parse(response.content[0].text);
};
const denied = async promise => {
  try { const value = await promise; assert.equal(value.isError, true, 'Call unexpectedly succeeded'); }
  catch (error) { if (error.code === 'ERR_ASSERTION') throw error; assert.ok(error.code || /403|401|denied|Unknown/i.test(error.message)); }
  proof();
};
try {
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES ($1,$1)', [source]);
  const writerToken = await mint('writer',['read','write'], source);
  const readerToken = await mint('reader',['read'], source);
  const foreignToken = await mint('foreign',['read','write'], 'default');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [`${ROOT}/src/cli.mjs`,'mcp','--http','--bind','127.0.0.1',
    '--port',String(port),'--suppress-bootstrap-token'], {
      cwd:ROOT, env:{...process.env,GBRAIN_SWEEP:'0',GBRAIN_ADMIN_BOOTSTRAP_TOKEN:randomBytes(32).toString('hex')},
      stdio:['ignore','ignore','pipe'],
    });
  child.stderr.on('data', () => {});
  let ready = false;
  for(let attempt=0;attempt<100;attempt++) {
    if(child.exitCode !== null) throw new Error('HTTP server exited before readiness');
    try { ready = (await fetch(`${base}/health`,{signal:AbortSignal.timeout(1000)})).ok; } catch {}
    if(ready) break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.ok(ready,'HTTP server did not become ready'); proof();
  const unauthorized = await fetch(`${base}/mcp`,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{}})});
  assert.equal(unauthorized.status,401); proof();
  const clientFor = async token => {
    const client=new Client({name:'ultrabrain-http-test',version:'0.4.0'});
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`),{
      requestInit:{headers:{Authorization:`Bearer ${token}`}},reconnectionOptions:{maxRetries:0},
    }));
    return client;
  };
  const writer=await clientFor(writerToken),reader=await clientFor(readerToken),foreign=await clientFor(foreignToken);
  const writerCatalog=await writer.listTools(),readerCatalog=await reader.listTools();
  assert.ok(writerCatalog.tools.some(t=>t.name==='ultra_write')); proof();
  assert.ok(readerCatalog.tools.some(t=>t.name==='ultra_read')); proof();
  assert.ok(!readerCatalog.tools.some(t=>t.name==='ultra_write')); proof();
  const uri=`ultra://${source}/resources/${suffix}`;
  const call=(client,name,args)=>client.callTool({name,arguments:args});
  result(await call(writer,'ultra_write',{uri,content:'---\ntype: note\nvisibility: world\n---\nFirst HTTP memory.'})); proof();
  assert.match(result(await call(reader,'ultra_read',{uri,level:'L2'})).content,/First HTTP/); proof();
  await denied(call(reader,'ultra_write',{uri,content:'forbidden'}));
  await denied(call(foreign,'ultra_read',{uri,level:'L2'}));
  await denied(call(foreign,'ultra_write',{uri,content:'cross-source forbidden'}));
  result(await call(writer,'ultra_write',{uri,content:'---\ntype: note\nvisibility: world\n---\nUpdated HTTP memory.'}));
  assert.match(result(await call(reader,'ultra_read',{uri,level:'L2'})).content,/Updated HTTP/); proof();
  result(await call(writer,'ultra_delete',{uri}));
  await denied(call(reader,'ultra_read',{uri}));
  const privateUri=`ultra://${source}/private/${suffix}`;
  result(await call(writer,'ultra_write',{uri:privateUri,content:'---\ntype: note\nvisibility: private\n---\nHost private canary'}));
  await denied(call(writer,'ultra_read',{uri:privateUri,level:'L2'}));
  const project_id=`http-project-${suffix}`;
  const state={goal:'HTTP project scope test',tasks:[]};
  result(await call(writer,'ultra_project_save',{project_id,state,expected_revision:0,event_id:'create'})); proof();
  assert.equal(result(await call(reader,'ultra_project_load',{project_id})).state.goal,state.goal); proof();
  await denied(call(reader,'ultra_project_save',{project_id,state,expected_revision:1,event_id:'forbidden'}));
  await denied(call(foreign,'ultra_project_load',{project_id}));
  assert.ok(!writerCatalog.tools.some(t=>t.name==='ultra_verify_run')); proof();
  const captureArgs={session_id:'http-deferred',event_id:suffix,transcript:'consented HTTP queue canary',defer_extraction:true};
  const capture=result(await call(writer,'ultra_commit_session',captureArgs));
  assert.equal(capture.state,'queued');assert.equal(capture.storage,'journaled');proof();
  await denied(call(reader,'ultra_process_sessions',{expected_source:source}));
  await denied(call(foreign,'ultra_session_status',{session_id:'http-deferred',event_id:suffix}));
  const tokenFile=join(workerDir,'token');writeFileSync(tokenFile,writerToken,{mode:0o600});
  worker=spawn(process.execPath,[`${ROOT}/scripts/consolidate.mjs`,'--url',`${base}/mcp`,'--token-file',tokenFile,'--source',source],
    {cwd:ROOT,env:process.env,stdio:['ignore','pipe','pipe']});
  let output='',diagnostic='';worker.stdout.on('data',x=>output+=x);worker.stderr.on('data',x=>diagnostic+=x);
  const timer=setTimeout(()=>worker.kill('SIGKILL'),20000);
  const [code]=await once(worker,'close');clearTimeout(timer);
  assert.equal(code,0,diagnostic);assert.equal(JSON.parse(output).states.needs_model,1);
  assert.ok(!output.includes(writerToken)&&!output.includes(captureArgs.transcript));proof();
  assert.equal(result(await call(writer,'ultra_session_status',{session_id:'http-deferred',event_id:suffix})).state,'needs_model');proof();
  result(await call(writer,'ultra_commit_session',{...captureArgs,event_id:'revocation-pending'}));
  await engine.executeRaw('UPDATE access_tokens SET revoked_at=now() WHERE name=$1',[tokenNames[0]]);
  await denied(call(writer,'ultra_process_sessions',{expected_source:source}));
  const [pending]=await engine.executeRaw("SELECT state,attempts FROM ultrabrain.session_receipts WHERE source_id=$1 AND session_id='http-deferred' AND event_id='revocation-pending'",[source]);
  assert.equal(pending.state,'queued');assert.equal(pending.attempts,0);proof();
  await denied(call(writer,'ultra_ls',{uri:`ultra://${source}/`}));
  console.log(`PASS ${checks} authenticated HTTP checks: catalog scopes, CRUD, source grants, privacy, live revocation`);
} finally {
  if(worker&&worker.exitCode===null) worker.kill('SIGKILL');
  rmSync(workerDir,{recursive:true,force:true});
  for(const client of clients) { try { await client.close(); } catch {} }
  if(child && child.exitCode===null) {
    child.kill('SIGTERM');
    const force=setTimeout(()=>child.kill('SIGKILL'),5000); force.unref();
    await once(child,'exit'); clearTimeout(force);
  }
  for(const name of tokenNames) await engine.executeRaw('DELETE FROM access_tokens WHERE name=$1',[name]);
  await engine.disconnect();
}
