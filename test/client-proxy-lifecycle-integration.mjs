/** Installed Node proxy -> official SDK -> native MCP -> private PostgreSQL.
 * Explicit scripted user actions and synthetic text, not an installed Agent/model.
 */
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createRequire} from 'node:module';import {randomBytes,createHash} from 'node:crypto';
import {Client} from '../vendor/gbrain/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import {StdioClientTransport} from '../vendor/gbrain/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import {connect,ROOT} from '../src/runtime.mjs';
assert.equal(process.env.ULTRABRAIN_TEST_ALLOW_WRITE,'1');
const engine=await connect(),source='proxy-'+randomBytes(5).toString('hex'),dir=mkdtempSync(join(tmpdir(),'ub-proxy-live-'));
const packageRoot=process.env.ULTRABRAIN_TASK_CLIENT_ROOT??join(ROOT,'packages/ultrabrain-client');
const cli=join(packageRoot,'dist/cli.cjs'),profilePath=join(dir,'profile.json');
const profile={format:1,source,allow_capture:true,server:{transport:'stdio',command:process.execPath,
 args:[join(ROOT,'src/cli.mjs'),'mcp'],env:{ULTRABRAIN_HOME:process.env.ULTRABRAIN_HOME,GBRAIN_SOURCE:source,GBRAIN_SWEEP:'0'}}};
const save=(value=profile)=>writeFileSync(profilePath,JSON.stringify(value),{mode:0o600});
const hash=s=>createHash('sha256').update(s).digest('hex');
let checks=0;const pass=()=>checks++;
async function snapshot(){
 const result={};for(const table of ['personal_memories','personal_events','personal_consolidations','agent_registry'])
  result[table]=(await engine.executeRaw(`SELECT md5(coalesce(string_agg(row_to_json(t)::text,',' ORDER BY row_to_json(t)::text),'')) AS digest FROM ultrabrain.${table} t WHERE source_id=$1`,[source]))[0].digest;
 return result;
}
function value(result){assert.ok(!result.isError,'Unexpected MCP refusal');return JSON.parse(result.content[0].text);}
async function call(c,name,args={}){return value(await c.callTool({name,arguments:args}));}
function revoked(result,{write=false}={}){
 assert.equal(result.isError,true);const error=JSON.parse(result.content[0].text);
 assert.equal(error.error,'client_authorization_revoked');assert.equal(error.delivery,write?'unconfirmed':'not_submitted');
 assert.ok(!JSON.stringify(result).includes('SYNTHETIC_PRIVATE_'));return error;
}
async function withProxy(fn,preload){
 const c=new Client({name:'scripted-explicit-user-acceptance',version:'1'});
 const args=[...(preload?['--require',preload]:[]),cli,'mcp','--profile',profilePath];
 const t=new StdioClientTransport({command:'node',args,stderr:'pipe'});let stderr='';
 t.stderr?.on('data',b=>stderr=(stderr+b).slice(-32768));
 try{await c.connect(t);if(t.stderr&&!t.stderr.listenerCount('data'))t.stderr.on('data',b=>stderr=(stderr+b).slice(-32768));await fn(c);}
 finally{await c.close();assert.ok(!stderr.includes('SYNTHETIC_PRIVATE_'));}
}
// Test-only pause AFTER a real upstream result. The parent changes local authority
// at an observed boundary, not after a guessed delay. Gate files hold no secrets.
function gate(watch){
 const base=join(dir,'gate-'+randomBytes(4).toString('hex')),arm=base+'.arm',hit=base+'.hit',release=base+'.release',preload=base+'.cjs';
 const sdk=createRequire(join(packageRoot,'package.json')).resolve('@modelcontextprotocol/sdk/client/index.js');
 writeFileSync(preload,`const fs=require('node:fs');const {Client}=require(${JSON.stringify(sdk)});const original=Client.prototype.callTool;
Client.prototype.callTool=async function(request,...args){const result=await original.call(this,request,...args);
if(request.name===${JSON.stringify(watch)}&&fs.existsSync(${JSON.stringify(arm)})){
 fs.unlinkSync(${JSON.stringify(arm)});fs.writeFileSync(${JSON.stringify(hit)},'1',{mode:0o600});
 const end=Date.now()+10000;while(!fs.existsSync(${JSON.stringify(release)})){if(Date.now()>end)throw Error('Synthetic gate deadline');await new Promise(r=>setTimeout(r,10));}
}return result;};`,{mode:0o600});
 return {preload,arm:()=>writeFileSync(arm,'1',{mode:0o600}),release:()=>writeFileSync(release,'1',{mode:0o600}),
 async wait(){const end=Date.now()+10000;while(!existsSync(hit)){assert.ok(Date.now()<end,'No real protocol checkpoint');await new Promise(r=>setTimeout(r,10));}}};
}
try{
 await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)',[source]);save();let memory;
 await withProxy(async c=>{
  const who=await call(c,'ultra_identity');assert.equal(who.source_id,source);
  // Identity pins are only adopted by a subsequent explicit connection, never live.
  profile.expected_instance=who.instance_id;profile.expected_actor=who.actor_key;pass();
 });save();
 await withProxy(async c=>{
  await call(c,'ultra_agent_register',{agent_id:'fixture',agent_type:'coding_agent',capabilities:['code'],workspace:'/synthetic/workspace'});
  const receipt=await call(c,'ultra_memory_commit',{agent_id:'fixture',event_id:'commit',consent:true,
   memories:[{type:'preference',content:'SYNTHETIC_PRIVATE_ORIGINAL taskneedle 保留配置文件',provenance:'Explicit synthetic user action'}]});
  memory=receipt.entries[0];assert.equal(memory.status,'candidate');
  assert.equal((await call(c,'ultra_personal_context',{task:'taskneedle'})).memories.length,0);pass();
  const approved=await call(c,'ultra_personal_review',{memory_id:memory.id,expected_revision:1,event_id:'approve',status:'active'});
  assert.equal(approved.revision,2);let context=await call(c,'ultra_personal_context',{task:'taskneedle'});
  assert.equal(context.memories[0].id,memory.id);assert.equal(context.memories[0].content_hash,hash(context.memories[0].content));pass();
  const edited=await call(c,'ultra_personal_update',{memory_id:memory.id,expected_revision:2,event_id:'correct',
   memory:{type:'preference',content:'SYNTHETIC_PRIVATE_CORRECTED taskneedle 只备份配置，不自动删除',provenance:'Explicit synthetic correction'}});
  assert.equal(edited.status,'candidate');assert.equal(edited.revision,3);
  assert.equal((await call(c,'ultra_personal_context',{})).memories.length,0);pass();
  const before=await snapshot(),stale=await c.callTool({name:'ultra_personal_review',arguments:{memory_id:memory.id,expected_revision:2,event_id:'stale',status:'active'}});
  assert.equal(stale.isError,true);assert.equal(JSON.parse(stale.content[0].text).error,'revision_conflict');assert.deepEqual(await snapshot(),before);pass();
  await call(c,'ultra_personal_review',{memory_id:memory.id,expected_revision:3,event_id:'reapprove',status:'active'});
  context=await call(c,'ultra_personal_context',{task:'taskneedle'});assert.equal(context.memories.length,1);
  assert.ok(context.memories[0].content.includes('CORRECTED'));assert.ok(!JSON.stringify(context).includes('ORIGINAL'));pass();
 });
 // An observed profile revoke blocks both reads and writes, and cannot be cleared
 // by silently putting the old file back into the same running proxy.
 await withProxy(async c=>{
  await call(c,'ultra_personal_context',{});const before=await snapshot();
  save({...profile,allow_capture:false});revoked(await c.callTool({name:'ultra_personal_capture',arguments:{agent_id:'fixture',event_id:'must-not-write',consent:true,transcript:'SYNTHETIC_PRIVATE_FORBIDDEN'}}),{write:true});
  await assert.rejects(c.listTools());pass();save();
  revoked(await c.callTool({name:'ultra_personal_context',arguments:{}}));
  assert.deepEqual(await snapshot(),before);pass();
 });
 // Deletion revokes the original connection; restored profile requires restart.
 await withProxy(async c=>{
  const before=await snapshot();rmSync(profilePath);
  revoked(await c.callTool({name:'ultra_personal_context',arguments:{}}));save();
  revoked(await c.callTool({name:'ultra_personal_context',arguments:{}}));assert.deepEqual(await snapshot(),before);pass();
 });
 for(const watch of ['ultra_identity','ultra_personal_context','ultra_personal_capture']){
  save();const pause=gate(watch),isRead=watch==='ultra_personal_context';
  const capture={agent_id:'fixture',event_id:'race-'+watch,transcript:'SYNTHETIC_PRIVATE_RACE_INPUT',consent:true};
  const before=await snapshot();
  await withProxy(async c=>{
   pause.arm();const request=c.callTool({name:isRead?'ultra_personal_context':'ultra_personal_capture',arguments:isRead?{task:'taskneedle'}:capture});
   // Attach immediately so failure while awaiting the gate never becomes unhandled.
   const outcome=request.then(result=>({result}),error=>({error}));
   try{await pause.wait();save({...profile,allow_capture:false});}
   finally{pause.release();}
   const result=await outcome;assert.ok(!result.error,'Unexpected outer MCP failure');revoked(result.result,{write:!isRead});
  },pause.preload);
  if(watch!=='ultra_personal_capture')assert.deepEqual(await snapshot(),before);
  else{
   const committed=await snapshot();assert.notDeepEqual(committed,before);save();
   await withProxy(async c=>{const replay=await call(c,'ultra_personal_capture',capture);assert.equal(replay.replayed,true);assert.equal(replay.storage,'journaled');});
   assert.deepEqual(await snapshot(),committed); // Revocation did not undo the sent write; replay never duplicates it.
  }pass();
 }
 save();await withProxy(async c=>{
  await call(c,'ultra_personal_review',{memory_id:memory.id,expected_revision:4,event_id:'archive',status:'archived'});
  assert.equal((await call(c,'ultra_personal_context',{task:'taskneedle'})).memories.length,0);
  const history=await call(c,'ultra_memory_search',{status:'archived'});assert.ok(history.memories.some(m=>m.id===memory.id));pass();
  const jobs=await call(c,'ultra_personal_jobs',{});assert.ok(jobs.jobs.every(j=>j.state==='queued'&&j.attempts===0));pass();
 });
 console.log(`PASS ${checks} installed-proxy lifecycle checks: official MCP SDK/Node/private PostgreSQL, candidate-confirm-correct-reconfirm-archive, live profile revocation, real in-flight identity/read/write gates and immutable replay; scripted user actions, no Agent model`);
}finally{await engine.disconnect();rmSync(dir,{recursive:true,force:true});}
