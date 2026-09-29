/** Compiled Node CLI -> real pinned SDK/stdio MCP -> isolated PostgreSQL.
 * All payloads are synthetic; no Agent engine, model or user service is invoked. */
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {spawn} from 'node:child_process';import {randomUUID} from 'node:crypto';
import {connect,ROOT} from '../src/runtime.mjs';
import {CaptureOutbox} from '../src/capture-outbox.mjs';
import {connectClient} from '../packages/ultrabrain-client/src/runtime.mjs';
assert.equal(process.env.ULTRABRAIN_TEST_ALLOW_WRITE,'1','Explicit isolated integration opt-in required');
assert.ok(process.env.ULTRABRAIN_HOME,'An explicit isolated managed home is required');
const engine=await connect(),source='control-'+randomUUID().replaceAll('-','').slice(0,20),root=mkdtempSync(join(tmpdir(),'ub-control-mcp-'));
const workspace=join(root,'work');mkdirSync(workspace,{mode:0o700});const profilePath=join(root,'profile.json');
const cli=process.env.ULTRABRAIN_TEST_COMPILED_CLIENT??join(ROOT,'packages/ultrabrain-client/dist/cli.cjs');
const profile={format:1,source,workspace,allow_capture:true,project_id:'control-test',server:{transport:'stdio',command:process.execPath,
 args:[join(ROOT,'src/cli.mjs'),'mcp'],env:{ULTRABRAIN_HOME:process.env.ULTRABRAIN_HOME,GBRAIN_SOURCE:source,GBRAIN_SWEEP:'0'}}};
const save=()=>writeFileSync(profilePath,JSON.stringify(profile),{mode:0o600});
async function run(command,extra=[],payload){
 const p=spawn('node',[cli,command,'--profile',profilePath,...extra],{cwd:ROOT,env:process.env,stdio:['pipe','pipe','pipe']});let out='';
 p.stdout.on('data',b=>{out+=b;if(out.length>65536)p.kill('SIGKILL');});p.stderr.on('data',()=>{});p.stdin.on('error',()=>{});p.stdin.end(payload?JSON.stringify(payload):undefined);
 const timer=setTimeout(()=>p.kill('SIGKILL'),20000);
 try{const status=await new Promise((resolve,reject)=>{p.once('error',reject);p.once('close',resolve);});return {status,body:JSON.parse(out)};}finally{clearTimeout(timer);}
}
const rows=async()=>engine.executeRaw('SELECT id,state,attempts FROM ultrabrain.personal_consolidations WHERE source_id=$1 ORDER BY id',[source]);
const pause=()=>run('queue-pause');const resume=hash=>run('queue-resume',['--expected-sha',hash,'--confirm-resume']);
const payload=id=>({agent_id:'control-fixture',event_id:id,transcript:'SYNTHETIC_CONTROL_INPUT',consent:true});
let checks=0;const pass=()=>checks++;
try{
 assert.equal((await engine.executeRaw("INSERT INTO sources(id,name) VALUES($1,$1) RETURNING id",[source])).length,1);save();
 const probe=await run('probe');assert.equal(probe.status,0,JSON.stringify(probe.body));const id=probe.body.identity;
 Object.assign(profile,{expected_instance:id.instance_id,expected_actor:id.actor_key,outbox_directory:join(root,'queue')});save();pass();
 const q=new CaptureOutbox(profile);let p=await pause();assert.equal(p.status,0);assert.equal(p.body.local_control,'confirmed');assert.deepEqual(await rows(),[]);pass();
 const queued=await run('queue-capture',[],payload('first'));assert.equal(queued.status,1);assert.equal(queued.body.result.delivery.last_error,'outbox_paused');assert.equal((await q.status()).pending,1);assert.deepEqual(await rows(),[]);pass();
 const blocked=await run('queue-flush',['--retry-blocked']);assert.equal(blocked.status,1);assert.equal(blocked.body.error,'outbox_paused');assert.deepEqual(await rows(),[]);pass();
 const stale=p.body.result.control_sha256;p=await pause();const reject=await resume(stale);assert.equal(reject.status,1);assert.equal(reject.body.error,'conflict');assert.deepEqual(await rows(),[]);pass();
 const before=readdirSync(q.directory).filter(n=>n.endsWith('.entry')).map(n=>readFileSync(join(q.directory,n)));const r=await resume(p.body.result.control_sha256);
 assert.equal(r.status,0);assert.equal(r.body.delivery,'not_submitted');assert.deepEqual(await rows(),[]);assert.deepEqual(readdirSync(q.directory).filter(n=>n.endsWith('.entry')).map(n=>readFileSync(join(q.directory,n))),before);pass();
 const flushed=await run('queue-flush');assert.equal(flushed.status,0);assert.equal(flushed.body.result.delivery.delivered,1);assert.equal((await rows()).length,1);assert.equal((await q.status()).pending,0);pass();
 // Actual server commit, then local pause before the queue processes its receipt.
 await q.enqueue(payload('inflight'));const delivered=await q.flush(async(i,o)=>{const c=await connectClient(i,o);return {...c,capture:async(p,o)=>{const receipt=await c.capture(p,o);await q.pauseDelivery();return receipt;}};});
 assert.equal(delivered.delivered,1);assert.equal((await rows()).length,2);assert.equal((await q.status()).delivery.state,'paused');assert.equal((await q.status()).pending,0);pass();
 p=await pause();await resume(p.body.result.control_sha256);await q.enqueue(payload('lost-receipt'));
 const lost=await q.flush(async(i,o)=>{const c=await connectClient(i,o);return {...c,capture:async(p,o)=>{await c.capture(p,o);await q.pauseDelivery();throw Error('Synthetic receipt loss after real commit');}};});
 assert.equal(lost.retained,1);assert.equal((await rows()).length,3);assert.equal((await q.status()).pending,1);pass();
 const stored=readdirSync(q.directory).filter(n=>n.endsWith('.entry'));const eventBefore=readFileSync(join(q.directory,stored[0]));p=await pause();await resume(p.body.result.control_sha256);
 assert.deepEqual(readFileSync(join(q.directory,stored[0])),eventBefore);assert.equal((await rows()).length,3);pass();
 const retry=await run('queue-flush',['--retry-blocked']);assert.equal(retry.status,0);assert.equal(retry.body.result.delivery.delivered,1);assert.equal((await rows()).length,3);assert.equal((await q.status()).pending,0);pass();
 const jobs=await rows();assert.ok(jobs.every(j=>j.state==='queued'&&j.attempts===0));pass();
 const memories=await engine.executeRaw('SELECT status,visibility,confidence,project_id FROM ultrabrain.personal_memories WHERE source_id=$1',[source]);
 assert.equal(memories.length,3);assert.ok(memories.every(m=>m.status==='candidate'&&m.visibility==='private'&&m.confidence===null&&m.project_id==='control-test'));pass();
 console.log(JSON.stringify({format:'ultrabrain-control-integration-v1',passed:true,checks,transport:'real-stdio-MCP',database:'isolated-PostgreSQL',compiled_cli:true,server_commits:3,model_calls:0,synthetic_payloads:true}));
}finally{await engine.disconnect();rmSync(root,{recursive:true,force:true});}
