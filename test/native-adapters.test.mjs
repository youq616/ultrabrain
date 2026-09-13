import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createOpenCodePlugin,registerOpenClaw,contextReader} from '../packages/ultrabrain-client/src/native-adapters.mjs';
import {readClientProfile,matchingWorkspace} from '../src/client-profile-file.mjs';
const identity={format:1,source_id:'default',instance_id:'00000000-0000-4000-8000-000000000001',actor_key:'a'.repeat(64)};
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'ub-native-')),file=join(dir,'profile.json');t.after(()=>rmSync(dir,{force:true,recursive:true}));
 const profile={format:1,source:'default',workspace:dir,expected_instance:identity.instance_id,expected_actor:identity.actor_key,allow_capture:true,server:{transport:'stdio',command:'not-executed',args:[]}};
 const save=p=>writeFileSync(file,JSON.stringify(p),{mode:0o600});save(profile);let calls=0,closes=0,reads=0;
 const connect=async()=>{calls++;return {identity,context:async()=>{reads++;return {memories:[{content:'SYNTHETIC personal note'}]};},close:async()=>closes++};};
 return {dir,file,profile,save,connect,get calls(){return calls;},get closes(){return closes;},get reads(){return reads;}};
}
test('OpenCode hooks append only and do not inspect prompt, chat logs or tool results',async t=>{
 const f=fixture(t),hooks=await createOpenCodePlugin({profilePath:f.file},f.connect)({directory:f.dir});
 assert.deepEqual(Object.keys(hooks).sort(),['dispose','experimental.chat.system.transform','experimental.session.compacting']);
 const input={sessionID:'s',get prompt(){assert.fail('must not read');}},output={system:['original system']};
 await hooks['experimental.chat.system.transform'](input,output);assert.equal(output.system[0],'original system');assert.match(output.system[1],/SYNTHETIC/);
 const compact={context:['existing'],prompt:'original'};await hooks['experimental.session.compacting'](input,compact);
 assert.equal(compact.prompt,'original');assert.equal(compact.context.length,2);assert.equal(f.calls,2);assert.equal(f.reads,2);assert.equal(f.closes,2);await hooks.dispose();
});
test('OpenCode small-model calls without a session do not read private memory',async t=>{
 const f=fixture(t),h=await createOpenCodePlugin({profilePath:f.file},f.connect)({directory:f.dir});const out={system:[]};await h['experimental.chat.system.transform']({},out);assert.equal(f.calls,0);assert.deepEqual(out.system,[]);
});
test('OpenCode exact workspace is required before network connection',async t=>{
 const f=fixture(t);await assert.rejects(createOpenCodePlugin({profilePath:f.file},f.connect)({directory:tmpdir()}),{code:'workspace_mismatch'});assert.equal(f.calls,0);
});
test('native automatic hooks require observed identity pins',t=>{
 const f=fixture(t);const p={...f.profile};delete p.expected_actor;f.save(p);assert.throws(()=>contextReader({profilePath:f.file},f.connect),{code:'invalid_profile'});
});
test('hook failures are visible but contain neither provider diagnostics nor old cached content',async t=>{
 const f=fixture(t);let fail=false;const h=await createOpenCodePlugin({profilePath:f.file},async(...args)=>{if(fail)throw Error('SECRET provider');return f.connect(...args);})({directory:f.dir});
 const first={system:[]};await h['experimental.chat.system.transform']({sessionID:'s'},first);assert.match(first.system[0],/SYNTHETIC/);fail=true;
 const next={system:[]};await h['experimental.chat.system.transform']({sessionID:'s'},next);assert.match(next.system[0],/memory_unavailable/);assert.ok(!/SYNTHETIC|SECRET/.test(next.system[0]));
});
test('native reader pins the first actual identity across turns',async t=>{
 const f=fixture(t);let changed=false;const r=contextReader({profilePath:f.file},async()=>({...await f.connect(),identity:changed?{...identity,actor_key:'b'.repeat(64)}:identity}));
 await r.read(f.dir);changed=true;await assert.rejects(r.read(f.dir),{code:'identity_mismatch'});assert.equal(f.reads,1);assert.equal(f.closes,2);
});
test('profile bytes are fixed for the plugin lifetime rather than reloaded from a model-controlled workspace',async t=>{
 const f=fixture(t),seen=[];const r=contextReader({profilePath:f.file},async input=>{seen.push(input.source);return f.connect();});
 f.save({...f.profile,source:'changed'});await r.read(f.dir);assert.deepEqual(seen,['default']);
});
test('OpenClaw has an additive narrow hook surface and exact session/agent bounds',async t=>{
 const f=fixture(t),registered=new Map();registerOpenClaw({pluginConfig:{profilePath:f.file,agentIds:['mine'],sessionKeys:['private-session']},on:(name,fn)=>registered.set(name,fn)},f.connect);
 assert.deepEqual([...registered.keys()],['before_prompt_build','gateway_stop']);const hook=registered.get('before_prompt_build');
 const ctx={agentId:'mine',sessionKey:'private-session',workspaceDir:f.dir,trigger:'user'};
 for(const change of [{agentId:'other'},{sessionKey:'group'},{workspaceDir:tmpdir()},{trigger:'cron'},{sessionKey:undefined}])assert.equal(await hook({get prompt(){assert.fail();}},{...ctx,...change}),undefined);
 assert.equal(f.calls,0);const result=await hook({},ctx);assert.deepEqual(Object.keys(result),['prependContext']);assert.match(result.prependContext,/SYNTHETIC/);assert.equal(f.calls,1);
 await registered.get('gateway_stop')();
});
test('OpenClaw refuses empty/wildcard allowlists and unknown configuration authority',t=>{
 const f=fixture(t),base={profilePath:f.file,agentIds:['mine'],sessionKeys:['private']};
 for(const change of [{agentIds:[]},{sessionKeys:['*']},{sessionKeys:[]},{endpoint:'https://other'}])assert.throws(()=>registerOpenClaw({pluginConfig:{...base,...change},on:()=>{}},f.connect));
});
test('OpenClaw rechecks the host invocation lifetime after reading',async t=>{
 const f=fixture(t),hooks={};registerOpenClaw({pluginConfig:{profilePath:f.file,agentIds:['mine'],sessionKeys:['private']},on:(n,f)=>hooks[n]=f},f.connect);
 let n=0;const result=await hooks.before_prompt_build({}, {agentId:'mine',sessionKey:'private',workspaceDir:f.dir,hookInvocation:{assertActive(){if(++n>1)throw Error('expired PRIVATE');}}});
 assert.ok(!result.prependContext.includes('SYNTHETIC'));assert.ok(!result.prependContext.includes('PRIVATE'));assert.equal(n,2);
});
test('in-flight bounds do not create an unlimited hook queue, and shutdown rejects late data',async t=>{
 const f=fixture(t);let release;const barrier=new Promise(r=>release=r);
 const reader=contextReader({profilePath:f.file},async()=>({identity,context:async()=>{await barrier;return {memories:[]};},close:async()=>{}}));
 const a=reader.read(f.dir),b=reader.read(f.dir);await assert.rejects(reader.read(f.dir),{code:'busy'});reader.close();release();
 await assert.rejects(a,{code:'closed'});await assert.rejects(b,{code:'closed'});await assert.rejects(reader.read(f.dir),{code:'closed'});
});
test('profile reader rejects malformed bytes, oversized files and relative paths',t=>{
 const f=fixture(t);assert.equal(readClientProfile(f.file).profile.source,'default');assert.throws(()=>readClientProfile('relative.json'));
 for(const data of [Buffer.from([255,254]),'x'.repeat(16385),'{}']){writeFileSync(f.file,data);assert.throws(()=>readClientProfile(f.file));}
});
test('workspace binding does not treat a sibling directory as a descendant grant',t=>{
 const f=fixture(t);matchingWorkspace({workspace:f.dir},f.dir);assert.throws(()=>matchingWorkspace({workspace:f.dir},tmpdir()));
});
