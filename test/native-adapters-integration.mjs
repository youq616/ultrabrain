/** Synthetic native-hook integration. --opencode-engine additionally runs the actual pinned CLI. */
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {connect,ROOT} from '../src/runtime.mjs';
import {PersonalMemoryStore} from '../src/personal-memory-store.mjs';
assert.equal(process.env.ULTRABRAIN_TEST_ALLOW_WRITE,'1');
const engine=await connect(),dir=mkdtempSync(join(tmpdir(),'ub-native-')),source='native-'+randomBytes(5).toString('hex');
const workspace=join(dir,'workspace'),home=join(dir,'hermes');mkdirSync(workspace,{mode:0o700});mkdirSync(home,{mode:0o700});
const packageRoot=process.env.ULTRABRAIN_NATIVE_INSTALLED??join(ROOT,'packages/ultrabrain-client');
const cli=join(packageRoot,'dist/cli.cjs'),library=join(packageRoot,'dist/native-adapters.cjs'),profilePath=join(dir,'profile.json');
let provider,automaticInputs=0,checks=0;const pass=()=>checks++;
async function run(command,args,{env=process.env,input,timeout=60000,cwd=ROOT}={}){
 const p=spawn(command,args,{cwd,env,stdio:['pipe','pipe','pipe']});let stdout='',stderr='';p.stdout.on('data',x=>{stdout=(stdout+x).slice(-262144);});p.stderr.on('data',x=>{stderr=(stderr+x).slice(-8192);});
 p.stdin.end(input);const t=setTimeout(()=>p.kill('SIGKILL'),timeout);try{const [code]=await once(p,'close');return {code,stdout,stderr};}finally{clearTimeout(t);}
}
try{
 await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)',[source]);
 const store=new PersonalMemoryStore({sourceId:source,engine,remote:false,transport:'stdio'});await store.register({agent_id:'seed'});
 const item=(await store.commit({agent_id:'seed',event_id:'seed',consent:true,memories:[{type:'preference',content:'NATIVE_ADAPTER_CANARY: do not remove negative conditions.',provenance:'Synthetic integration'}]})).entries[0];
 await store.review({memory_id:item.id,expected_revision:1,event_id:'activate',status:'active'});
 const profile={format:1,source,workspace,server:{transport:'stdio',command:process.execPath,args:[join(ROOT,'src/cli.mjs'),'mcp'],env:{ULTRABRAIN_HOME:process.env.ULTRABRAIN_HOME,GBRAIN_SOURCE:source,GBRAIN_SWEEP:'0'}}};
 writeFileSync(profilePath,JSON.stringify(profile),{mode:0o600});const probe=await run('node',[cli,'probe','--profile',profilePath]);assert.equal(probe.code,0,'Actual Node probe failed');const identity=JSON.parse(probe.stdout).identity;
 Object.assign(profile,{expected_instance:identity.instance_id,expected_actor:identity.actor_key});writeFileSync(profilePath,JSON.stringify(profile));pass();
 const env={...process.env,ULTRABRAIN_NATIVE_LIBRARY:library,ULTRABRAIN_NATIVE_PROFILE:profilePath,ULTRABRAIN_NATIVE_WORKSPACE:workspace,ULTRABRAIN_NATIVE_HERMES_HOME:home};
 const callbacks=await run('node',[join(ROOT,'test/native-adapter-node-fixture.mjs')],{env});assert.equal(callbacks.code,0,'Native Node callback fixture failed');assert.equal(JSON.parse(callbacks.stdout).passed,true);pass();
 const bound=await run('node',[cli,'bound-context','--profile',profilePath],{input:JSON.stringify({workspace})});assert.equal(bound.code,0);assert.equal(JSON.parse(bound.stdout).memories[0].id,item.id);pass();
 const mismatch=await run('node',[cli,'bound-context','--profile',profilePath],{input:JSON.stringify({workspace:dir,prompt:'NO_SECRET_CAPTURE'})});assert.equal(mismatch.code,1);assert.ok(!mismatch.stdout.includes('NATIVE_ADAPTER_CANARY'));pass();
 const node=(await run('node',['-p','process.execPath'])).stdout.trim();
 writeFileSync(join(home,'ultrabrain.json'),JSON.stringify({format:1,node,cli,profile:profilePath}),{mode:0o600});
 const hermes=await run('python3',[join(ROOT,'test/hermes-native-integration.py')],{env});
 assert.equal(hermes.code,0,'Hermes provider/Node integration failed');assert.equal(JSON.parse(hermes.stdout).checks,6);pass();
 if(process.argv.includes('--opencode-engine')){
  Object.assign(profile,{allow_capture:true,outbox_directory:join(dir,'capture-outbox'),automatic_capture:['opencode-user','opencode-assistant']});writeFileSync(profilePath,JSON.stringify(profile));
  const binary=process.env.ULTRABRAIN_OPENCODE_BIN;assert.ok(binary,'Pinned OpenCode executable required');
  const version=await run(binary,['--version']);assert.equal(version.stdout.trim(),'1.18.30','Unreviewed OpenCode version');
  let observed=false,requests=0;
  provider=createServer(async(req,res)=>{
   try{let body='';for await(const c of req){body+=c;if(body.length>524288)throw Error();}const p=JSON.parse(body);requests++;
    const text=JSON.stringify(p.messages??[]);if(text.includes('SYNTHETIC_MAIN_REQUEST')&&text.includes('NATIVE_ADAPTER_CANARY'))observed=true;
    if(p.stream){res.setHeader('Content-Type','text/event-stream');for(const [delta,finish] of [[{role:'assistant',content:'Synthetic response.'},null],[{},'stop']])res.write('data: '+JSON.stringify({id:'synthetic',object:'chat.completion.chunk',model:'test',choices:[{index:0,delta,finish_reason:finish}]})+'\n\n');res.end('data: [DONE]\n\n');}
    else {res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:'synthetic',object:'chat.completion',model:'test',choices:[{index:0,message:{role:'assistant',content:'Synthetic response.'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));}
   }catch{res.statusCode=400;res.end('{}');}
  });provider.listen(0,'127.0.0.1');await once(provider,'listening');
  const pluginDir=join(workspace,'.opencode/plugins');mkdirSync(pluginDir,{recursive:true,mode:0o700});
  writeFileSync(join(pluginDir,'ultrabrain.js'),`import {createRequire} from 'node:module';const {createOpenCodePlugin}=createRequire(import.meta.url)(${JSON.stringify(library)});export default createOpenCodePlugin({profilePath:${JSON.stringify(profilePath)}});`);
  const config={model:'ubfixture/test',small_model:'ubfixture/test',permission:{'*':'deny'},provider:{ubfixture:{npm:'@ai-sdk/openai-compatible',name:'Synthetic localhost only',options:{baseURL:`http://127.0.0.1:${provider.address().port}/v1`,apiKey:'synthetic-not-a-secret'},models:{test:{name:'Synthetic',limit:{context:16000,output:1000}}}}}};
  const clean={PATH:process.env.PATH,HOME:join(dir,'opencode-home'),XDG_CONFIG_HOME:join(dir,'xdg-config'),XDG_DATA_HOME:join(dir,'xdg-data'),XDG_CACHE_HOME:join(dir,'xdg-cache'),OPENCODE_DISABLE_AUTOUPDATE:'true',OPENCODE_DISABLE_DEFAULT_PLUGINS:'true',OPENCODE_DISABLE_MODELS_FETCH:'true',OPENCODE_CONFIG_CONTENT:JSON.stringify(config)};
  const actual=await run(binary,['run','--format','json','--model','ubfixture/test','SYNTHETIC_MAIN_REQUEST'],{env:clean,cwd:workspace,timeout:120000});
  if(actual.code!==0||!observed){console.error(JSON.stringify({opencode_exit:actual.code,provider_requests:requests,observed_personal_context:observed,missing_module:/Cannot find|ResolveError/.test(actual.stderr),config_error:/config|Config/.test(actual.stderr),no_raw_logs:true}));}
  assert.equal(actual.code,0,'Actual OpenCode CLI failed');assert.ok(observed,'Actual OpenCode model request did not include recalled memory');pass();
  const captured=await engine.executeRaw("SELECT m.content,m.status,m.visibility,j.state FROM ultrabrain.personal_memories m JOIN ultrabrain.personal_consolidations j ON j.input_id=m.id WHERE m.source_id=$1",[source]);
  assert.ok(captured.length>=2,'Actual OpenCode hooks did not capture user/assistant observations');
  const observations=captured.map(r=>JSON.parse(r.content));
  assert.ok(observations.some(r=>r.origin==='opencode'&&r.role==='user'&&r.texts.includes('SYNTHETIC_MAIN_REQUEST')),'Actual user input missing');
  assert.ok(observations.some(r=>r.origin==='opencode'&&r.role==='assistant'&&r.texts.includes('Synthetic response.')),'Actual assistant output missing');
  assert.ok(captured.every(r=>r.status==='candidate'&&r.visibility==='private'&&r.state==='queued'));
  assert.ok(observations.every(r=>r.origin==='opencode'&&r.texts.every(t=>['SYNTHETIC_MAIN_REQUEST','Synthetic response.'].includes(t))),'Unexpected transcript/tool/context captured');
  automaticInputs=captured.length;pass();
  const journal=await run('node',[cli,'queue-status','--profile',profilePath]);assert.equal(journal.code,0);
  assert.equal(JSON.parse(journal.stdout).result.pending,0);pass();
 }
 await store.review({memory_id:item.id,expected_revision:2,event_id:'archive',status:'archived'});
 const empty=await run('node',[cli,'bound-context','--profile',profilePath],{input:JSON.stringify({workspace})});assert.equal(JSON.parse(empty.stdout).memories.length,0);pass();
 const [count]=await engine.executeRaw('SELECT count(*)::integer AS n FROM ultrabrain.personal_memories WHERE source_id=$1',[source]);assert.equal(count.n,1+automaticInputs);pass();
 console.log(`PASS ${checks} native-adapter integrations; OpenCode actual CLI: ${process.argv.includes('--opencode-engine')}; Hermes/OpenClaw callback scope explicitly limited`);
}finally{if(provider)await new Promise(r=>provider.close(r));await engine.disconnect();rmSync(dir,{recursive:true,force:true});}
