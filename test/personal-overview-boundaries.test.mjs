/** Adversarial in-process contract/adapter probes. No real database claim. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {overviewRequest,verifyPersonalOverview} from '../src/personal-overview-contract.mjs';
import {PersonalOverview} from '../src/personal-overview.mjs';
import {overviewReceipt,overviewId} from './helpers/overview-fixture.mjs';
const request=()=>({request_id:overviewId});
const verify=value=>verifyPersonalOverview(value,request(),'selected');
for(const field of ['source_id','request_id','observed_at','read_only','model_calls','trust']) {
 test('overview boundary: rejects root accessor without invoking '+field,()=>{
  const value=overviewReceipt();let reads=0;const original=value[field];
  Object.defineProperty(value,field,{enumerable:true,get(){reads++;return reads===1?original:'PRIVATE_UNCHECKED_VALUE';}});
  assert.throws(()=>verify(value),{code:'personal_overview_unconfirmed'});assert.equal(reads,0);
 });
}
for(const group of ['memories','jobs','documents','agents']) {
 test('overview boundary: rejects count accessor without invoking '+group,()=>{
  const value=overviewReceipt();let reads=0;const original=value[group].total;
  Object.defineProperty(value[group],'total',{enumerable:true,get(){reads++;return reads<3?original:-99;}});
  assert.throws(()=>verify(value),{code:'personal_overview_unconfirmed'});assert.equal(reads,0);
 });
 test('overview boundary: rejects non-enumerable count '+group,()=>{
  const value=overviewReceipt();Object.defineProperty(value[group],'total',{enumerable:false});
  assert.throws(()=>verify(value),{code:'personal_overview_unconfirmed'});
 });
}
test('overview boundary: request getter is rejected without reading it',()=>{
 let reads=0;const value={get request_id(){reads++;return overviewId;}};
 assert.throws(()=>overviewRequest(value),{code:'invalid_params'});assert.equal(reads,0);
});
for(const target of ['request','response','group'])for(const kind of ['symbol','hidden']) {
 test(`overview boundary: ${kind} excess field is rejected in ${target}`,()=>{
  const value=target==='request'?request():overviewReceipt();const object=target==='group'?value.jobs:value;
  Object.defineProperty(object,kind==='symbol'?Symbol('private'):'private',{value:'PRIVATE_EXTRA',enumerable:kind==='symbol'});
  assert.throws(()=>target==='request'?overviewRequest(value):verify(value),{code:target==='request'?'invalid_params':'personal_overview_unconfirmed'});
 });
}
test('overview boundary: reflection exceptions are sanitized',()=>{
 const value=new Proxy(overviewReceipt(),{ownKeys(){throw Error('PRIVATE_HOST_ERROR');}});
 assert.throws(()=>verify(value),error=>error.code==='personal_overview_unconfirmed'&&!error.message.includes('PRIVATE'));
});
test('overview boundary: data-only null-prototype objects stay supported',()=>{
 const value=overviewReceipt();Object.setPrototypeOf(value,null);
 for(const key of ['memories','jobs','documents','agents'])Object.setPrototypeOf(value[key],null);
 const checked=verify(value);assert.equal(checked.jobs.total,15);assert.ok(Object.isFrozen(checked.jobs));
});
for(const field of ['source','principal','scope'])test('overview boundary: authority is checked after driver row materialization '+field,async()=>{
 const ctx={sourceId:'selected',remote:true,transport:'http',auth:{sourceId:'selected',scopes:['read'],principal:{kind:'oauth_client',id:'owner'}}};
 const receipt=overviewReceipt();const row={observed_at:receipt.observed_at,jobs:receipt.jobs,documents:receipt.documents,agents:receipt.agents};
 Object.defineProperty(row,'memories',{get(){
  if(field==='source')ctx.sourceId='other';else if(field==='principal')ctx.auth.principal.id='other';else ctx.auth.scopes=[];
  return receipt.memories;
 }});
 const executeRaw=async sql=>sql.startsWith('WITH ')?[row]:[];
 ctx.engine={kind:'postgres',transaction:fn=>fn({executeRaw})};
 await assert.rejects(new PersonalOverview(ctx).read(request()),{code:'permission_denied'});
});
