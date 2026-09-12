import test from 'node:test';
import assert from 'node:assert/strict';
import {GOVERNED_TOOLS,deploymentProfile,normalizeEnterprisePolicy,enterprisePrincipal,policyDenial,InflightGate} from '../src/enterprise-policy.mjs';
import {enterpriseArguments} from '../src/enterprise-cli.mjs';
import {publishGovernedSurface} from '../src/enterprise.mjs';
import {guardMetadataSource,META_HOOK_SHA256} from '../src/adapters/response-metadata.mjs';
const ctx={sourceId:'team',remote:true,transport:'http',engine:{kind:'postgres'},auth:{sourceId:'team',principal:{kind:'oauth_client',id:'agent-one'}}};
test('deployment profile is explicit and rejects typos',()=>{assert.equal(deploymentProfile(),'compatibility');assert.equal(deploymentProfile('governed'),'governed');assert.throws(()=>deploymentProfile('enterprise'));});
test('default source policy is read-only, historical recall requires opt-in',()=>{
 const p=normalizeEnterprisePolicy();assert.equal(p.mode,'read-only');assert.equal(p.allow_history,false);
 assert.equal(policyDenial(p,{name:'ultra_read',mutating:false},{}),null);
 assert.equal(policyDenial(p,{name:'ultra_write',mutating:true},{}),'enterprise_read_only');
 assert.equal(policyDenial(p,{name:'ultra_read'}, {memory_policy:'history'}),'enterprise_history_disabled');
 for(const name of ['ultra_memory_history','ultra_project_history'])assert.equal(policyDenial(p,{name},{}),'enterprise_history_disabled');
});
for(const bad of [{mode:'admin'},{allow_history:'true'},{actor_requests_per_minute:301},{actor_max_inflight:9},{max_inflight:0},
 {requests_per_minute:1.1},{new_field:true},{mode:null}])test('invalid source policy rejected '+JSON.stringify(bad),()=>{
 if(bad.mode===null)assert.equal(normalizeEnterprisePolicy(bad).mode,'read-only');else assert.throws(()=>normalizeEnterprisePolicy(bad));
});
test('authenticated principal is stable and excludes credential content',()=>{
 const actor=enterprisePrincipal(ctx);assert.match(actor,/^[a-f0-9]{64}$/);
 assert.equal(enterprisePrincipal({...ctx,auth:{...ctx.auth,token:'changed'}}),actor);
 assert.notEqual(enterprisePrincipal({...ctx,auth:{...ctx.auth,principal:{kind:'oauth_client',id:'agent-two'}}}),actor);
});
for(const overrides of [{remote:false},{transport:'stdio'},{auth:null},{auth:{...ctx.auth,hasSourceGrant:false}},{auth:{...ctx.auth,allowedSources:['team','foreign']}},{auth:{...ctx.auth,sourceId:'foreign'}},{viaSubagent:true},
 {auth:{...ctx.auth,boundSlugPrefixes:['a/']}},{auth:{...ctx.auth,grantProjectionDegraded:true}},{localFederatedSourceIds:['team','other']},
 {auth:{sourceId:'team'}}])test('nonenterprise grant rejected '+JSON.stringify(overrides),()=>assert.throws(()=>enterprisePrincipal({...ctx,...overrides})));
test('strict in-process concurrency cannot be bypassed by another actor and slots are freed exactly once',()=>{
 const gate=new InflightGate(),p=normalizeEnterprisePolicy({max_inflight:2,actor_max_inflight:1});
 const a=gate.acquire('s','a',p);assert.ok(a);assert.equal(gate.acquire('s','a',p),null);
 const b=gate.acquire('s','b',p);assert.ok(b);assert.equal(gate.acquire('s','c',p),null);
 a();a();const c=gate.acquire('s','c',p);assert.ok(c);b();c();assert.equal(gate.tracked,0);
});
test('source concurrency and map lifecycle stay isolated over repeated principals',()=>{
 const gate=new InflightGate(),p=normalizeEnterprisePolicy({max_inflight:1,actor_max_inflight:1});
 const one=gate.acquire('s1','a',p),two=gate.acquire('s2','a',p);assert.ok(one&&two);one();two();
 for(let i=0;i<10000;i++)gate.acquire('s'+i,'actor'+i,p)();assert.equal(gate.tracked,0);
});
test('governed catalog cannot be expanded by request_tools or a newly added ultra tool',()=>{
 const original={name:'get_page',handler:()=> 'native-delegate'};
 const operations=[original,...GOVERNED_TOOLS.map(name=>({name,handler:()=> 'governed'})),{name:'ultra_unreviewed',handler(){}}];
 publishGovernedSurface(operations,{OperationError:Error});assert.deepEqual(operations.map(x=>x.name),GOVERNED_TOOLS);
 assert.equal(original.handler(),'native-delegate');assert.ok(!operations.some(o=>o.name==='request_tools'));
});
test('a missing reviewed tool prevents partial publication',()=>assert.throws(()=>publishGovernedSurface([],{OperationError:Error}),{code:'upstream_contract_changed'}));
test('host CLI requires explicit configuration revision and rejects unknown/duplicate options',()=>{
 assert.equal(enterpriseArguments(['status','--source','team']).source,'team');
 for(const args of [['configure','--source','a','--source','b'],['status','--source'],['disable'],['status','--source','a','--mode','disabled']])assert.throws(()=>enterpriseArguments(args));
});
test('native metadata adapter refuses unreviewed source code rather than best-effort replacement',()=>{
 assert.match(META_HOOK_SHA256,/^[a-f0-9]{64}$/);
 assert.throws(()=>guardMetadataSource("if (name === 'recall') return undefined;"),{code:'upstream_contract_changed'});
});
