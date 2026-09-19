// Independent synthetic SQL/clock fixture. No real PostgreSQL or model execution.
import assert from 'node:assert/strict';
import {PersonalConsolidator} from '../ultrabrain/src/personal-consolidation.mjs';
import {personalModelProfile} from '../ultrabrain/src/personal-consolidation-core.mjs';
import {sha256} from '../ultrabrain/src/core.mjs';
const source='review-short-lease';
const content='Synthetic explicitly consented input.';
const original={content,content_hash:sha256(content),revision:1,status:'candidate',agent_id:'review',project_id:null};
const job={id:'11111111-1111-1111-1111-111111111111',input_id:'22222222-2222-2222-2222-222222222222',input_revision:1,input_hash:original.content_hash,state:'queued',attempts:0,profile_hash:null};
let leaseUntil=Infinity,transactions=0,reads=0,providerCalls=0,invokedAfterExpiry=false;
const engine={kind:'postgres',executeRaw:async()=>assert.fail('Unexpected nontransactional query'),transaction:async fn=>{
  const t=++transactions;
  return fn({executeRaw:async(sql,args=[])=>{
    if(sql.startsWith('SET LOCAL')||sql.includes('pg_advisory_xact_lock'))return [];
    if(sql.includes('SELECT count(*)'))return [{n:job.state==='processing'?1:0}];
    if(sql.includes('SELECT j.*'))return [{...job}];
    if(sql.includes('SELECT content,content_hash')||sql.includes('SELECT content,revision')||sql.includes('SELECT revision,content_hash,content'))return [{...original}];
    if(sql.includes("SET state='processing'")){Object.assign(job,{state:'processing',attempts:job.attempts+1,profile_hash:args[1],lease_id:args[2]});return [];}
    if(sql.includes('SELECT state,lease_id')){
      // Model a real claim reaching admission with only 20 ms of its lease left.
      if(t===2&&leaseUntil===Infinity)leaseUntil=Date.now()+20;
      return [{state:job.state,lease_id:job.lease_id,live:Date.now()<leaseUntil}];
    }
    if(sql.includes('SET state=$2,result=')){Object.assign(job,{state:args[1],result:args[2],error_code:args[3]});return [];}
    assert.fail('Unexpected SQL: '+sql);
  }});
}};
const profile=personalModelProfile({enabled:true,model:'fixture:only',revision:'review-1',timeout_ms:1000});
const worker=new PersonalConsolidator({engine,sourceId:source,remote:false,transport:'stdio'},async()=>{
  if(++reads===3)await new Promise(r=>setTimeout(r,50));
  return {profile,generate:()=>{providerCalls++;invokedAfterExpiry=Date.now()>=leaseUntil;return {text:'{"memories":[]}'};}};
});
const result=await worker.process({expected_source:source,allow_model_call:true,job_id:job.id});
assert.equal(providerCalls,0);
assert.equal(invokedAfterExpiry,false);
assert.equal(result.results[0].state,'lease_lost');
assert.equal(job.state,'processing');
assert.equal(job.result??null,null);
console.log(JSON.stringify({fixture:'synthetic SQL, shortened already-aging lease, stub provider',providerCalls,invokedAfterExpiry,resultState:result.results[0].state,model_requests_attempted:result.model_requests_attempted}));
