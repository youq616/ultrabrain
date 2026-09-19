/** Synthetic admission barriers and provider modules; no PostgreSQL or real model calls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {PersonalConsolidator} from '../src/personal-consolidation.mjs';
import {personalModelProfile} from '../src/personal-consolidation-core.mjs';
import {configuredPersonalModel} from '../src/adapters/personal-model.mjs';
import {sha256} from '../src/core.mjs';

const source='admission-fixture';
const configProfile={enabled:true,model:'fixture:only',revision:'admission-1',timeout_ms:1000};
const profile=personalModelProfile(configProfile);
const output={text:'{"memories":[]}'};
const processInput={expected_source:source,allow_model_call:true,job_id:'11111111-1111-1111-1111-111111111111'};

/** Small SQL fixture for an owned queued job. Unexpected queries fail the test. */
function admissionContext(beforeAdmission=()=>{}) {
  const content='Synthetic consent regression input.';
  const original={content,content_hash:sha256(content),revision:1,status:'candidate',agent_id:'fixture',project_id:null};
  const job={id:processInput.job_id,input_id:'22222222-2222-2222-2222-222222222222',input_revision:1,
    input_hash:original.content_hash,state:'queued',attempts:0,profile_hash:null};
  let transactions=0;
  const engine={kind:'postgres',executeRaw:async()=>{assert.fail('Unexpected nontransactional query');},
    transaction:async fn=>{
      const transaction=++transactions;
      return fn({executeRaw:async(sql,args=[])=>{
        if(sql.startsWith('SET LOCAL'))return [];
        if(sql.includes('pg_advisory_xact_lock')) {
          if(transaction===2)await beforeAdmission();
          return [];
        }
        if(sql.includes('SELECT count(*)'))return [{n:job.state==='processing'?1:0}];
        if(sql.includes('SELECT j.*'))return [{...job}];
        if(sql.includes('SELECT content,content_hash')||sql.includes('SELECT content,revision')||
          sql.includes('SELECT revision,content_hash,content'))return [{...original}];
        if(sql.includes("SET state='processing'")) {
          Object.assign(job,{state:'processing',attempts:job.attempts+1,profile_hash:args[1],lease_id:args[2]});
          return [];
        }
        if(sql.includes('SELECT state,lease_id'))return [{state:job.state,lease_id:job.lease_id,live:true}];
        if(sql.includes('SET state=$2,result=')) {
          Object.assign(job,{state:args[1],result:args[2],error_code:args[3]});
          return [];
        }
        assert.fail('Unexpected SQL in admission fixture: '+sql);
      }});
    }};
  return {ctx:{engine,sourceId:source,remote:false,transport:'stdio'},job};
}

for(const [change,changed] of [
  ['disabled',null],
  ['model changed',personalModelProfile({...configProfile,model:'fixture:changed'})],
  ['revision changed',personalModelProfile({...configProfile,revision:'admission-2'})],
])test('profile '+change+' while admission waits sends no provider request',async()=>{
  let current=profile,calls=0;
  const {ctx,job}=admissionContext(()=>{current=changed;});
  const worker=new PersonalConsolidator(ctx,()=>({profile:current,generate:()=>{calls++;return output;}}));
  const result=await worker.process(processInput);
  assert.equal(calls,0,'A revoked or changed profile must be checked after admission awaits');
  assert.equal(result.model_requests_attempted,0);
  assert.equal(result.results[0].state,'failed');
  assert.equal(result.results[0].error,'model_profile_changed');
  assert.equal(job.result,null);
});

test('admission invokes the freshly configured provider after the wait',async()=>{
  let admitted=false;
  const called=[];
  const {ctx}=admissionContext(()=>{admitted=true;});
  const worker=new PersonalConsolidator(ctx,()=>{
    const version=admitted?'fresh':'earlier';
    return {profile,generate:()=>{called.push(version);return output;}};
  });
  const result=await worker.process(processInput);
  assert.deepEqual(called,['fresh']);
  assert.equal(result.results[0].state,'completed');
  assert.equal(result.model_requests_attempted,1);
});

test('abort during the final model configuration check sends no provider request',async()=>{
  const controller=new AbortController();
  let reads=0,calls=0;
  const {ctx}=admissionContext();
  const worker=new PersonalConsolidator(ctx,async()=>{
    if(++reads===3)controller.abort();
    return {profile,generate:()=>{calls++;return output;}};
  });
  const result=await worker.process(processInput,{signal:controller.signal});
  assert.equal(calls,0);
  assert.equal(result.model_requests_attempted,0);
  assert.equal(result.results[0].error,'personal_model_timeout');
});

function nativeModules({duringGatewayLoad=()=>{}}={}) {
  const data={ultrabrain_personal_consolidation:{...configProfile}};
  let calls=0;
  const gateway={configureGatewayIfUninitialized(){},isAvailable:()=>true,chat:()=>{calls++;return output;}};
  const load=async path=>{
    if(path==='src/core/config.ts')return {loadConfig:()=>data};
    assert.equal(path,'src/core/ai/gateway.ts');
    await duringGatewayLoad(data);
    return gateway;
  };
  return {data,load,calls:()=>calls};
}

for(const [change,changed] of [
  ['disabled',{enabled:false}],
  ['model changed',{...configProfile,model:'fixture:changed'}],
  ['revision changed',{...configProfile,revision:'admission-2'}],
])test('native provider closure rejects a profile '+change+' after configuration',async()=>{
  const fixture=nativeModules();
  const model=await configuredPersonalModel(fixture.load);
  fixture.data.ultrabrain_personal_consolidation=changed;
  assert.throws(()=>model.generate({model:profile.model,prompt:'synthetic',system:'synthetic',maxTokens:10}),{code:'model_profile_changed'});
  assert.equal(fixture.calls(),0);
});

test('native provider closure rejects revocation during gateway loading',async()=>{
  const fixture=nativeModules({duringGatewayLoad:async data=>{data.ultrabrain_personal_consolidation={enabled:false};}});
  const model=await configuredPersonalModel(fixture.load);
  assert.throws(()=>model.generate({model:profile.model,prompt:'synthetic',system:'synthetic',maxTokens:10}),{code:'model_profile_changed'});
  assert.equal(fixture.calls(),0);
});

test('native provider closure checks cancellation and still admits an unchanged live profile',async()=>{
  const fixture=nativeModules(),model=await configuredPersonalModel(fixture.load);
  const controller=new AbortController();controller.abort();
  const request={model:profile.model,prompt:'synthetic',system:'synthetic',maxTokens:10};
  assert.throws(()=>model.generate({...request,signal:controller.signal}),{code:'personal_model_timeout'});
  assert.equal(fixture.calls(),0);
  assert.equal(model.generate(request),output);
  assert.equal(fixture.calls(),1);
});
