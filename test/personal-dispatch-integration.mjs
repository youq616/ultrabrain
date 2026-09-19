/** Real PostgreSQL barriers around provider admission, not a real-model quality test. */
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {connect} from '../src/runtime.mjs';
import {sha256} from '../src/core.mjs';
import {PersonalMemoryStore,lockPersonal} from '../src/personal-memory-store.mjs';
import {PersonalDocumentStore} from '../src/personal-documents.mjs';
import {PersonalConsolidator} from '../src/personal-consolidation.mjs';
import {personalModelProfile} from '../src/personal-consolidation-core.mjs';
assert.equal(process.env.ULTRABRAIN_TEST_ALLOW_WRITE,'1','Use an isolated test installation');
const engine=await connect(),source='dispatch-'+randomBytes(5).toString('hex'),ctx={engine,sourceId:source,remote:false,transport:'stdio'};
const memories=new PersonalMemoryStore(ctx),documents=new PersonalDocumentStore(ctx);
const profile=personalModelProfile({enabled:true,model:'fixture:only',revision:'dispatch-1',timeout_ms:10000});
const bytes=Buffer.from('\uFEFF合成原文：不要删除。\r\n'),output={text:JSON.stringify({memories:[{type:'preference',content:'合成偏好：不要删除。',quote:'不要删除'}]})};
const jobInput=job=>({expected_source:source,allow_model_call:true,job_id:job});
const count=async id=>(await engine.executeRaw("SELECT count(*)::int AS n FROM ultrabrain.personal_memories WHERE source_id=$1 AND derivation->>'job_id'=$2",[source,id]))[0].n;
const create=async label=>{const doc=await documents.documentImport({agent_id:'fixture',event_id:'import-'+label,label:label+'.md',consent:true,content_base64:bytes.toString('base64'),content_sha256:sha256(bytes)});const q=await documents.documentQueue({document_id:doc.document_id,event_id:'queue-'+label});return {document:doc.document_id,job:q.fragments[0].job_id,input:q.fragments[0].memory_id};};
const deadline=async promise=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('Synthetic barrier timed out')),8000))]);}finally{clearTimeout(timer);}};
let checks=0;const pass=()=>checks++;
try {
 await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)',[source]);await memories.register({agent_id:'fixture'});
 for(const action of ['archive','cancel','modify','expire','abort']) {
   const doc=await create(action);let entered,release,reads=0,calls=0;const ready=new Promise(r=>entered=r),hold=new Promise(r=>release=r),abort=new AbortController();
   const worker=new PersonalConsolidator(ctx,async()=>{if(++reads===2){entered();await hold;}return {profile,generate:async()=>{calls++;return output;}};});
   const running=worker.process(jobInput(doc.job),{signal:abort.signal});
   try {
     await deadline(ready);
     if(action==='archive')await documents.documentArchive({document_id:doc.document,event_id:'archive-before-send'});
     else if(action==='cancel')await worker.cancel({job_id:doc.job});
     else if(action==='modify')await engine.executeRaw("UPDATE ultrabrain.personal_memories SET revision=revision+1 WHERE id=$1::uuid",[doc.input]); // synthetic DB integrity mutation
     else if(action==='expire')await engine.executeRaw("UPDATE ultrabrain.personal_consolidations SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1::uuid",[doc.job]);
     else abort.abort();
   }finally{release();}
   const result=await deadline(running);
   assert.equal(calls,0,'No provider invocation after '+action+' won before admission');
   assert.equal(result.model_requests_attempted,0);assert.equal(await count(doc.job),0);pass();
   await worker.cancel({job_id:doc.job}); // clear synthetic expired/aborted records before next test
 }
 // Revoke/change host opt-in while admission is waiting for a real PostgreSQL owner lock.
 // The earlier profile read is valid; the later check must prevent any provider invocation.
 for(const [action,nextProfile] of [
   ['disable-profile',null],
   ['change-model',personalModelProfile({enabled:true,model:'fixture:changed',revision:'dispatch-1',timeout_ms:10000})],
   ['change-revision',personalModelProfile({enabled:true,model:'fixture:only',revision:'dispatch-2',timeout_ms:10000})],
 ]) {
   const doc=await create(action);
   let current=profile,reads=0,calls=0,locks=0,holder,release,locked,admission;
   const hold=new Promise(r=>release=r),hasLock=new Promise(r=>locked=r),atAdmission=new Promise(r=>admission=r);
   const waitingCtx={...ctx,engine:{kind:'postgres',executeRaw:(...args)=>engine.executeRaw(...args),
     transaction:fn=>engine.transaction(tx=>fn({executeRaw:async(sql,args)=>{
       if(sql.includes('pg_advisory_xact_lock')&&++locks===2)admission();
       return tx.executeRaw(sql,args);
     }}))}};
   const waitingWorker=new PersonalConsolidator(waitingCtx,async()=>{
     if(++reads===2) {
       holder=engine.transaction(async tx=>{await lockPersonal(tx,source,memories.actor);locked();await hold;});
       await deadline(hasLock);
     }
     return {profile:current,generate:async()=>{calls++;return output;}};
   });
   const running=waitingWorker.process(jobInput(doc.job));
   try {await deadline(atAdmission);current=nextProfile;}
   finally {release();if(holder)await holder;}
   const result=await deadline(running);
   assert.equal(calls,0,'No provider invocation after '+action+' during DB admission');
   assert.equal(result.model_requests_attempted,0);
   assert.equal(result.results[0].error,'model_profile_changed');
   assert.equal((await waitingWorker.status({job_id:doc.job})).jobs[0].state,'failed');
   assert.equal(await count(doc.job),0);pass();
 }
 // Let actual database time expire a shortened fixture lease during the final config await.
 // The mutation is test-only and uses the transaction already holding the job/source locks.
 const late=await create('expiry-during-final-profile');
 let admissionTx,transactions=0,configReads=0,lateCalls=0;
 const lateCtx={...ctx,engine:{kind:'postgres',executeRaw:(...args)=>engine.executeRaw(...args),
   transaction:fn=>engine.transaction(tx=>{if(++transactions===2)admissionTx=tx;return fn(tx);})}};
 const lateWorker=new PersonalConsolidator(lateCtx,async()=>{
   if(++configReads===3) {
     assert.ok(admissionTx);
     await admissionTx.executeRaw("UPDATE ultrabrain.personal_consolidations SET lease_until=clock_timestamp()+interval '100 milliseconds' WHERE id=$1::uuid",[late.job]);
     await admissionTx.executeRaw('SELECT true AS waited FROM pg_sleep(0.2)');
   }
   return {profile,generate:async()=>{lateCalls++;return output;}};
 });
 const lateResult=await deadline(lateWorker.process(jobInput(late.job)));
 assert.equal(lateCalls,0);assert.equal(lateResult.model_requests_attempted,0);
 assert.equal(lateResult.results[0].state,'lease_lost');assert.equal(await count(late.job),0);
 assert.equal((await lateWorker.status({job_id:late.job})).jobs[0].state,'processing');
 await lateWorker.cancel({job_id:late.job});pass();
 // An already-started provider does not hold the DB lock for the model response.
 const live=await create('live');let entered,release;const ready=new Promise(r=>entered=r),hold=new Promise(r=>release=r);
 const worker=new PersonalConsolidator(ctx,()=>({profile,generate:async()=>{entered();await hold;return output;}}));
 const running=worker.process(jobInput(live.job));
 try{await deadline(ready);await deadline(documents.documentArchive({document_id:live.document,event_id:'archive-after-start'}));}finally{release();}
 assert.equal((await deadline(running)).results[0].state,'lease_lost');assert.equal(await count(live.job),0);pass();
 // Loss of admission transaction confirmation AFTER invocation is not a safe automatic retry.
 const uncertain=await create('uncertain');let started=false;
 const faulty={...ctx,engine:{kind:'postgres',executeRaw:(...args)=>engine.executeRaw(...args),transaction:fn=>engine.transaction(async tx=>{const result=await fn(tx);if(started)throw Error('synthetic admission commit failure');return result;})}};
 await assert.rejects(new PersonalConsolidator(faulty,()=>({profile,generate:async()=>{started=true;return output;}})).process(jobInput(uncertain.job)),{code:'personal_commit_unconfirmed'});
 assert.equal((await worker.status({job_id:uncertain.job})).jobs[0].state,'processing');assert.equal(await count(uncertain.job),0);pass();
 await worker.cancel({job_id:uncertain.job});
 console.log(`PASS ${checks} provider-admission checks: real PostgreSQL archive/cancel/source/expiry/abort/profile barriers, unlocked provider wait and uncertain admission`);
}finally{await engine.disconnect();}
