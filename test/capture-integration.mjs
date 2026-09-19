/** Packaged Node capture hooks/outbox -> native MCP -> private PostgreSQL.
 * Synthetic hook events, not a claim that a live Claude host was executed.
 */
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';import {randomBytes} from 'node:crypto';
import {connect,ROOT} from '../src/runtime.mjs';
import {CaptureOutbox} from '../src/capture-outbox.mjs';
import {connectClient} from '../packages/ultrabrain-client/src/runtime.mjs';
import {UltraError} from '../src/core.mjs';
import {PersonalMemoryStore} from '../src/personal-memory-store.mjs';
import {deliverCapture} from '../src/capture-delivery.mjs';
import {clientIdentity} from '../src/client-kit.mjs';
assert.equal(process.env.ULTRABRAIN_TEST_ALLOW_WRITE,'1');
const engine=await connect(),source='capture-'+randomBytes(5).toString('hex'),dir=mkdtempSync(join(tmpdir(),'ub-capture-e2e-'));
const workspace=join(dir,'workspace'),profilePath=join(dir,'profile.json'),cli=join(ROOT,'packages/ultrabrain-client/dist/cli.cjs');mkdirSync(workspace,{mode:0o700});
let checks=0;const pass=()=>checks++;
const profile={format:1,source,workspace,project_id:'capture-test',allow_capture:true,server:{transport:'stdio',command:process.execPath,args:[join(ROOT,'src/cli.mjs'),'mcp'],env:{ULTRABRAIN_HOME:process.env.ULTRABRAIN_HOME,GBRAIN_SOURCE:source,GBRAIN_SWEEP:'0'}}};
function save(p=profile){writeFileSync(profilePath,JSON.stringify(p),{mode:0o600});}
async function child(args,input){
 const p=spawn('node',args,{cwd:ROOT,env:process.env,stdio:['pipe','pipe','pipe']});let out='';
 p.stdout.on('data',b=>out=(out+b).slice(-32768));p.stderr.on('data',()=>{});p.stdin.on('error',()=>{});
 p.stdin.end(input===undefined?undefined:JSON.stringify(input));const timer=setTimeout(()=>p.kill('SIGKILL'),40000);
 try{const code=await new Promise((resolve,reject)=>{p.once('error',reject);p.once('close',resolve);});return {code,pid:p.pid,out,data:out?JSON.parse(out):null};}finally{clearTimeout(timer);}
}
const run=(cmd,event,rest=[])=>child([cli,cmd,'--profile',profilePath,...rest],event);
const count=async()=>Number((await engine.executeRaw('SELECT count(*)::int AS n FROM ultrabrain.personal_consolidations WHERE source_id=$1',[source]))[0].n);

// A test-only preload signals the exact stdin-read boundary. No sleeps, production
// test switches, credentials or user data are used to synchronize this race.
async function replaceProfileWhileReading(command,request,replacement) {
 const preload=join(dir,'stdin-boundary.cjs');
 writeFileSync(preload,`const iterator=process.stdin[Symbol.asyncIterator];process.stdin[Symbol.asyncIterator]=function(...args){process.send({captureTestReady:true},()=>process.disconnect());return iterator.apply(this,args);};`,{mode:0o600});
 const child=spawn('node',['--require',preload,cli,command,'--profile',profilePath],{cwd:ROOT,env:process.env,stdio:['pipe','pipe','pipe','ipc']});
 let output='';child.stdout.on('data',data=>output=(output+data).slice(-32768));child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});
 const ready=new Promise(done=>child.on('message',message=>{if(message?.captureTestReady===true)done();}));
 const ended=new Promise((done,fail)=>{child.once('error',fail);child.once('close',done);});
 const timer=setTimeout(()=>child.kill('SIGKILL'),30000);
 try {
   await Promise.race([ready,ended.then(()=>{throw Error('Fixture exited before stdin boundary');})]);
   save(replacement);child.stdin.end(JSON.stringify(request));
   const code=await ended;return {code,data:JSON.parse(output)};
 } finally {clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await ended.catch(()=>{});}save();}
}

try{
 await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)',[source]);save();
 const initial=await run('probe');assert.equal(initial.code,0,'Packaged probe failed');const identity=initial.data.identity;
 Object.assign(profile,{expected_instance:identity.instance_id,expected_actor:identity.actor_key,outbox_directory:join(dir,'queue'),automatic_capture:['claude-user','claude-assistant']});save();pass();
 const event={hook_event_name:'UserPromptSubmit',session_id:'synthetic-session',prompt_id:'11111111-1111-4111-8111-111111111111',cwd:workspace,
 prompt:'SYNTHETIC_CAPTURE: 不要使用 Docker Hub。',transcript_path:'/never-read-a-file',tool_output:'NEVER_CAPTURE_TOOL'};
 let r=await run('claude-capture-hook',event);assert.equal(r.code,0);assert.match(r.data.systemMessage,/journaled by the server/);assert.ok(!r.out.includes('SYNTHETIC_CAPTURE'));assert.equal(await count(),1);pass();
 await run('claude-capture-hook',event);assert.equal(await count(),1);pass();
 await run('claude-capture-hook',{...event,prompt_id:'22222222-2222-4222-8222-222222222222'});assert.equal(await count(),2);pass();
 await run('claude-capture-hook',{...event,hook_event_name:'Stop',stop_hook_active:false,last_assistant_message:'SYNTHETIC_ASSISTANT: tests passed.'});assert.equal(await count(),3);pass();
 for(const patch of [{prompt_id:undefined},{cwd:dir},{agent_id:'child'},{hook_event_name:'Stop',stop_hook_active:true,last_assistant_message:'recursive'}])await run('claude-capture-hook',{...event,...patch});
 assert.equal(await count(),3);pass();
 const rows=await engine.executeRaw('SELECT content,status,visibility,confidence,project_id FROM ultrabrain.personal_memories WHERE source_id=$1',[source]);
 assert.ok(rows.every(x=>x.status==='candidate'&&x.visibility==='private'&&x.confidence===null&&x.project_id==='capture-test'&&!x.content.includes('NEVER_CAPTURE_TOOL')));
 assert.ok(rows.map(x=>JSON.parse(x.content).role).includes('assistant'));pass();
 r=await run('context');assert.equal(r.data.memories.length,0);pass();
 save({...profile,allow_capture:false,automatic_capture:[]});await run('claude-capture-hook',{...event,prompt_id:'33333333-3333-4333-8333-333333333333'});assert.equal(await count(),3);save();pass();
 const q=new CaptureOutbox(profile);await q.enqueue({agent_id:'custom',event_id:'offline',transcript:'SYNTHETIC_OFFLINE_INPUT',consent:true});
 const offline=await q.flush(async()=>{throw Error('offline-private-detail');});assert.equal(offline.retained,1);assert.equal((await q.status()).pending,1);pass();
 r=await run('queue-flush');assert.equal(r.code,1,'Backoff-pending queue must not report complete delivery');assert.equal(r.data.result.delivery.remaining_pending,1);pass();
 r=await run('queue-flush',undefined,['--retry-blocked']);assert.equal(r.code,0,'Packaged queue flush failed');assert.equal(r.data.result.delivery.delivered,1);assert.equal(await count(),4);pass();
 r=await run('queue-status');assert.equal(r.data.result.pending,0);assert.ok(!r.out.includes('SYNTHETIC_'));pass();
 // Die after the real server commits but before the local acknowledgement cleanup.
 const script=join(dir,'crash.mjs');
 writeFileSync(script,`import {readFileSync} from 'node:fs';import {CaptureOutbox} from ${JSON.stringify(pathToFileURL(join(ROOT,'src/capture-outbox.mjs')).href)};import {connectClient} from ${JSON.stringify(pathToFileURL(join(ROOT,'packages/ultrabrain-client/src/runtime.mjs')).href)};
 const input=JSON.parse(readFileSync(process.argv[2]));const q=new CaptureOutbox(input);await q.enqueue({agent_id:'crash',event_id:'lost-ack',transcript:'SYNTHETIC_COMMITTED_BEFORE_CRASH',consent:true});await q.flush(async(i,o)=>{const c=await connectClient(i,o);return {...c,capture:async p=>{await c.capture(p);await c.close();process.exit(97);}};});`);
 r=await child([script,profilePath]);assert.equal(r.code,97);assert.equal(await count(),5);assert.equal((await q.status()).pending,1);pass();
 const lock=await run('queue-lock',undefined,['--kind','delivery']);assert.equal(lock.data.result.pid,r.pid);
 const recovered=await run('queue-recover-lock',undefined,['--kind','delivery','--expected-sha',lock.data.result.sha256,'--confirm-writer-stopped']);assert.equal(recovered.code,0);assert.equal(recovered.data.result.payloads_deleted,0);pass();
 r=await run('queue-flush',undefined,['--retry-blocked']);assert.equal(r.code,0);assert.equal(r.data.result.delivery.delivered,1);assert.equal(await count(),5);pass();
 const states=await engine.executeRaw('SELECT state,attempts FROM ultrabrain.personal_consolidations WHERE source_id=$1',[source]);assert.ok(states.every(r=>r.state==='queued'&&r.attempts===0));pass();
 // Recheck local authorization after asynchronous registration/identity calls, before plaintext transmission.
 // For an absent Agent the fifth assertion is immediately after its create-only registration.
 const guarded=await connectClient(profile);let authorized=0;
 try {
   await assert.rejects(guarded.capture({agent_id:'denied-before-register',event_id:'declined-before-register',transcript:'SYNTHETIC_DECLINED_INPUT',consent:true},
     {authorize:()=>false}),{code:'capture_disabled'});
   assert.equal((await engine.executeRaw('SELECT agent_id FROM ultrabrain.agent_registry WHERE source_id=$1 AND agent_id=$2',[source,'denied-before-register'])).length,0);
   assert.equal(await count(),5);pass();
   await assert.rejects(guarded.capture({agent_id:'revoked-before-send',event_id:'must-not-send',transcript:'SYNTHETIC_REVOKED_INPUT',consent:true,project_id:profile.project_id},
     {authorize:()=>{if(++authorized===5)throw new UltraError('capture_disabled','Synthetic revocation');}}),{code:'capture_disabled'});
   assert.equal((await engine.executeRaw('SELECT agent_id FROM ultrabrain.agent_registry WHERE source_id=$1 AND agent_id=$2',[source,'revoked-before-send'])).length,1);
   assert.equal(await count(),5);pass();
   authorized=0;
   await assert.rejects(guarded.capture({agent_id:'boolean-revoked',event_id:'boolean-must-not-send',transcript:'SYNTHETIC_REVOKED_INPUT',consent:true},
     {authorize:()=>++authorized<5}),{code:'capture_disabled'});
   assert.equal((await engine.executeRaw('SELECT agent_id FROM ultrabrain.agent_registry WHERE source_id=$1 AND agent_id=$2',[source,'boolean-revoked'])).length,1);
   assert.equal(await count(),5);pass();
 } finally {await guarded.close();}

 // The configuration that authorized stdin must remain authoritative even if
 // a new valid destination/profile appears before the event body is complete.
 const replacement={...profile,project_id:'replaced-project',outbox_directory:join(dir,'replacement-queue')};
 const swapped=await replaceProfileWhileReading('claude-capture-hook',{...event,prompt_id:'44444444-4444-4444-8444-444444444444'},replacement);
 assert.match(swapped.data.systemMessage,/capture_disabled/,'Profile replacement was not rejected');
 assert.equal(await count(),5);assert.equal(existsSync(replacement.outbox_directory),false);pass();
 const revoked=await replaceProfileWhileReading('queue-capture',{agent_id:'revoked-input',event_id:'revoked-stdin',transcript:'SYNTHETIC_NOT_AUTHORIZED_AFTER_REVOCATION',consent:true},
   {...profile,allow_capture:false,automatic_capture:[]});
 assert.equal(revoked.code,1);assert.equal(revoked.data.error,'capture_disabled');
 assert.equal((await q.status()).pending,0);assert.equal((await q.status()).blocked,0);assert.equal(await count(),5);pass();
 // Existing metadata survives actual packaged capture, replay and outbox delivery.
 const store=new PersonalMemoryStore({engine,sourceId:source,remote:false,transport:'stdio'});
 await store.register({agent_id:'typed-capture',agent_type:'coding_agent',capabilities:['code','files'],workspace:'/synthetic/typed-workspace'});
 const registration=async id=>(await engine.executeRaw('SELECT * FROM ultrabrain.agent_registry WHERE source_id=$1 AND actor_key=$2 AND agent_id=$3',[source,identity.actor_key,id]))[0];
 const typedBefore=await registration('typed-capture');
 const typedInput={agent_id:'typed-capture',event_id:'typed-direct',transcript:'SYNTHETIC_TYPED_CAPTURE',consent:true};
 r=await run('capture',typedInput);assert.equal(r.code,0);assert.equal(r.data.result.storage,'journaled');assert.equal(await count(),6);
 const typedJob=r.data.result.job_id;assert.deepEqual(await registration('typed-capture'),typedBefore);pass();
 r=await run('capture',typedInput);assert.equal(r.code,0);assert.equal(r.data.result.job_id,typedJob);assert.equal(await count(),6);
 assert.deepEqual(await registration('typed-capture'),typedBefore);pass();
 await q.enqueue({...typedInput,event_id:'typed-outbox'});
 r=await run('queue-flush');assert.equal(r.code,0);assert.equal(r.data.result.delivery.delivered,1);assert.equal(await count(),7);
 assert.deepEqual(await registration('typed-capture'),typedBefore);pass();
 // Deterministic race: create a different metadata tuple after the owned lookup
 // and before the client's actual revision-zero registration reaches PostgreSQL.
 const raced=await connectClient(profile);let registrationAttempts=0,raceBefore;
 try {
   const invoke=async(name,args)=>{
     if(name==='ultra_agent_register'){
       registrationAttempts++;
       await store.register({agent_id:args.agent_id,agent_type:'coding_agent',capabilities:['race'],workspace:'/synthetic/race'});
       raceBefore=await registration(args.agent_id);
     }
     const result=await raced.callAllowed(name,args);return JSON.parse(result.content[0].text);
   };
   const checkIdentity=async()=>assert.deepEqual(clientIdentity(await invoke('ultra_identity',{}),raced.profile),raced.identity);
   const result=await deliverCapture({...typedInput,agent_id:'raced-capture',event_id:'raced-capture'},raced.profile,{checkIdentity,invoke});
   assert.equal(result.storage,'journaled');assert.equal(registrationAttempts,1);assert.equal(await count(),8);
   assert.deepEqual(await registration('raced-capture'),raceBefore);pass();
 } finally {await raced.close();}
 console.log(`PASS ${checks} capture/outbox checks: packaged Node/Claude-event fixture/stdio/PostgreSQL, offline reopen and crash-after-commit replay`);
}finally{await engine.disconnect();rmSync(dir,{recursive:true,force:true});}
