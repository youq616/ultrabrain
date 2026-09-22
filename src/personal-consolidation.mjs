/** Durable personal jobs refer to existing owned memory rows; no second transcript store.
 * Short DB claims, bounded provider calls, fenced atomic output+receipt commits.
 * Expired leases require explicit retry; external model calls are not exactly-once.
 */
import {randomUUID} from 'node:crypto';
import {requireThat,integer,sha256} from './core.mjs';
import {objectFields,memoryId} from './personal-memory.mjs';
import {personalPrincipal,lockPersonal,PERSONAL_DERIVATION_CURRENT} from './personal-memory-store.mjs';
import {personalProfileHash,generatePersonalCandidates,MAX_PERSONAL_ATTEMPTS,jobStatusQuery} from './personal-consolidation-core.mjs';
import {configuredPersonalModel} from './adapters/personal-model.mjs';
const safeErrors=new Set(['invalid_personal_output','personal_model_timeout','model_unavailable','model_profile_changed','stale_source']);
const publicJob=row=>({job_id:row.id,input_id:row.input_id,input_revision:row.input_revision,state:row.state,
  attempts:row.attempts,retryable:row.attempts<MAX_PERSONAL_ATTEMPTS&&['failed','processing'].includes(row.state),error:row.error_code??null,lease_until:row.lease_until??null,
  result:row.result??null,created_at:row.created_at,updated_at:row.updated_at,
  assurance:'Processing result, not truth verification; external model execution may repeat after explicit recovery'});
export class PersonalConsolidator {
  constructor(ctx,configure=configuredPersonalModel) {
    this.ctx=ctx;this.source=ctx.sourceId;this.actor=personalPrincipal(ctx);this.engine=ctx.engine;this.configure=configure;
  }
  async status(input={}) {
    const p=jobStatusQuery(input);
    const rows=await this.engine.transaction(async tx=>{
      await tx.executeRaw('SET LOCAL transaction_read_only=on');
      await tx.executeRaw("SET LOCAL statement_timeout='5s'");
      return tx.executeRaw(`SELECT id::text,input_id::text,input_revision,state,attempts,lease_until,result,error_code,created_at,updated_at
        FROM ultrabrain.personal_consolidations WHERE source_id=$1 AND actor_key=$2 AND ($3::uuid IS NULL OR id=$3::uuid)
        AND ($6::text IS NULL OR state=$6)
        ORDER BY created_at DESC,id LIMIT $4 OFFSET $5`,[this.source,this.actor,p.job_id,p.limit,p.offset,p.state]);
    });
    if(p.job_id)requireThat(rows.length===1,'not_found','Personal job not found under this identity');
    return {source_id:this.source,jobs:rows.map(publicJob),next_offset:!p.job_id&&rows.length===p.limit&&p.offset+rows.length<=1000000?p.offset+rows.length:null};
  }

  async cancel(input) {
    objectFields(input,['job_id']);memoryId(input.job_id);personalPrincipal(this.ctx,true);
    if(this.ctx.dryRun)return {dry_run:true,storage:'not_stored'};
    return this.engine.transaction(async tx=>{
      await lockPersonal(tx,this.source,this.actor);
      const [row]=await tx.executeRaw(`UPDATE ultrabrain.personal_consolidations SET state='stale',error_code='cancelled',lease_id=NULL,lease_until=NULL,updated_at=now()
        WHERE source_id=$1 AND actor_key=$2 AND id=$3::uuid AND state!='completed' RETURNING id::text,state`,[this.source,this.actor,input.job_id]);
      requireThat(row,'not_found','No cancellable job under this identity');
      return {...row,note:'Input retained. An already submitted provider call may still incur cost, but its output cannot commit.'};
    });
  }
  /** Linearize invocation admission with archive/cancel using the same short owner lock.
   * Never hold a DB transaction while waiting for the external response. The nested settled
   * promise prevents rejection leaks if admission commit fails after invocation has started.
   */
  async #dispatch(row,lease,request,profileHash,onInvoke) {
    let invoked=false,admitted;
    try {
      admitted=await this.engine.transaction(async tx=>{
        await lockPersonal(tx,this.source,this.actor);
        const [job]=await tx.executeRaw(`SELECT state,lease_id,lease_until>clock_timestamp() AS live
          FROM ultrabrain.personal_consolidations WHERE source_id=$1 AND actor_key=$2 AND id=$3::uuid FOR UPDATE`,
          [this.source,this.actor,row.id]);
        requireThat(job?.state==='processing'&&job.lease_id===lease&&job.live,'lease_lost','Job no longer owns provider admission');
        const [original]=await tx.executeRaw(`SELECT content,revision,content_hash,status FROM ultrabrain.personal_memories
          WHERE source_id=$1 AND actor_key=$2 AND id=$3::uuid FOR SHARE`,[this.source,this.actor,row.input_id]);
        requireThat(original&&original.status!=='archived'&&original.revision===row.input_revision&&
          original.content_hash===row.input_hash&&sha256(original.content)===row.input_hash,'stale_source','Source changed before provider admission');
        // A config read before waiting for DB admission can become stale while the lock or
        // source query is pending. Recheck the host opt-in here and use this fresh binding.
        const current=await this.configure();
        requireThat(current.profile&&personalProfileHash(current.profile)===profileHash,
          'model_profile_changed','Personal model profile changed before provider admission');
        // The configuration await can outlive an already aging lease. Recheck DB time
        // after it; the held owner/job/source locks still fence cancellation and edits.
        const [admission]=await tx.executeRaw(`SELECT state,lease_id,lease_until>clock_timestamp() AS live
          FROM ultrabrain.personal_consolidations WHERE source_id=$1 AND actor_key=$2 AND id=$3::uuid`,
          [this.source,this.actor,row.id]);
        requireThat(admission?.state==='processing'&&admission.lease_id===lease&&admission.live,
          'lease_lost','Job lease expired before provider admission');
        requireThat(!request.signal?.aborted,'personal_model_timeout','Cancelled before provider admission');
        personalPrincipal(this.ctx,true);
        // The native generator synchronously rechecks host opt-in at gateway invocation;
        // trusted host-injected generators must preserve that final boundary as well.
        // Invoke synchronously under the lock. Do not await the provider's returned promise here.
        // After this boundary an external request may still be pending; archive fences its output,
        // but cannot promise to undo SDK scheduling, remote processing or a charge already begun.
        invoked=true;onInvoke();
        let outcome;
        try{outcome=Promise.resolve(current.generate(request)).then(value=>({value}),error=>({error}));}
        catch(error){outcome=Promise.resolve({error});}
        return {outcome};
      });
    }catch(error){
      if(invoked)throw Object.assign(new Error('Provider admission confirmation unknown; inspect the durable job'),{code:'personal_commit_unconfirmed'});
      throw error;
    }
    const settled=await admitted.outcome;
    if(settled.error)throw settled.error;
    return settled.value;
  }
  async process(input={}, {signal}={}) {
    objectFields(input,['expected_source','allow_model_call','limit','retry','job_id']);
    personalPrincipal(this.ctx,true);
    requireThat(input.expected_source===this.source,'scope_denied','Configured source does not match authentication');
    requireThat(input.allow_model_call===true,'model_consent_required','Explicit allow_model_call:true required');
    requireThat(input.retry===undefined||typeof input.retry==='boolean','invalid_params','retry must be boolean');
    if(input.job_id!==undefined)memoryId(input.job_id);
    const limit=integer(input.limit,1,1,4);
    if(this.ctx.dryRun)return {dry_run:true,results:[],model_calls:0};
    const model=await this.configure();
    if(!model.profile)return {source_id:this.source,state:'needs_model',results:[],model_calls:0};
    const profileHash=personalProfileHash(model.profile),results=[],attempted=[];
    let modelCalls=0;
    for(let i=0;i<limit;i++) {
      requireThat(!signal?.aborted,'cancelled','Worker cancelled before claiming another job');
      const lease=randomUUID();
      const row=await this.engine.transaction(async tx=>{
        await lockPersonal(tx,this.source,this.actor);
        const [active]=await tx.executeRaw("SELECT count(*)::integer AS n FROM ultrabrain.personal_consolidations WHERE source_id=$1 AND actor_key=$2 AND state='processing' AND lease_until>clock_timestamp()",[this.source,this.actor]);
        if(active.n>0)return null; // One live provider job per owner, shared across worker processes.
        const [job]=await tx.executeRaw(`SELECT j.*,j.id::text AS id,j.input_id::text AS input_id FROM ultrabrain.personal_consolidations j
          WHERE source_id=$1 AND actor_key=$2 AND attempts<$3 AND NOT(id=ANY($4::uuid[]))
          AND ($5::uuid IS NULL OR id=$5::uuid) AND (state='queued' OR ($6 AND (state='failed' OR (state='processing' AND lease_until<clock_timestamp()))))
          ORDER BY j.created_at,j.id LIMIT 1 FOR UPDATE SKIP LOCKED`,
          [this.source,this.actor,MAX_PERSONAL_ATTEMPTS,attempted,input.job_id??null,input.retry===true]);
        if(!job)return null;
        if(job.profile_hash&&job.profile_hash!==profileHash) {
          await tx.executeRaw("UPDATE ultrabrain.personal_consolidations SET state='failed',error_code='model_profile_changed',lease_id=NULL,lease_until=NULL,updated_at=now() WHERE id=$1::uuid",[job.id]);
          return {...job,state:'failed',error_code:'model_profile_changed',skip:true};
        }
        const [original]=await tx.executeRaw(`SELECT content,content_hash,revision,status,agent_id,project_id FROM ultrabrain.personal_memories
          WHERE source_id=$1 AND actor_key=$2 AND id=$3::uuid FOR SHARE`,[this.source,this.actor,job.input_id]);
        if(!original||original.status==='archived'||original.revision!==job.input_revision||original.content_hash!==job.input_hash||sha256(original.content)!==job.input_hash) {
          await tx.executeRaw("UPDATE ultrabrain.personal_consolidations SET state='stale',error_code='stale_source',lease_id=NULL,lease_until=NULL,updated_at=now() WHERE id=$1::uuid",[job.id]);
          return {...job,state:'stale',error_code:'stale_source',skip:true};
        }
        await tx.executeRaw(`UPDATE ultrabrain.personal_consolidations SET state='processing',attempts=attempts+1,profile_hash=$2,
          lease_id=$3::uuid,lease_until=clock_timestamp()+interval '3 minutes',error_code=NULL,updated_at=now() WHERE id=$1::uuid`,[job.id,profileHash,lease]);
        return {...job,original,attempts:job.attempts+1};
      });
      if(!row)break;attempted.push(row.id);
      if(row.skip){results.push(publicJob(row));continue;}
      let generated,error;
      try {
        // Re-read host opt-in between jobs, before data leaves the process and before applying output.
        const current=await this.configure();
        requireThat(current.profile&&personalProfileHash(current.profile)===profileHash,'model_profile_changed','Personal model profile changed');
        generated=await generatePersonalCandidates(row.original.content,current.profile,
          request=>this.#dispatch(row,lease,request,profileHash,()=>modelCalls++),{signal});
        const final=await this.configure();
        requireThat(final.profile&&personalProfileHash(final.profile)===profileHash,'model_profile_changed','Personal model profile changed during generation');
      }catch(e){
        if(e.code==='personal_commit_unconfirmed')throw e; // Never automatically redo ambiguous admission.
        if(e.code==='lease_lost'){results.push({job_id:row.id,state:'lease_lost',result:null});continue;}
        error=safeErrors.has(e.code)?e.code:'personal_processing_failed';
      }
      try {
        const result=await this.engine.transaction(async tx=>{
          await lockPersonal(tx,this.source,this.actor);
          const [job]=await tx.executeRaw(`SELECT state,lease_id FROM ultrabrain.personal_consolidations WHERE source_id=$1 AND actor_key=$2 AND id=$3::uuid FOR UPDATE`,[this.source,this.actor,row.id]);
          requireThat(job?.state==='processing'&&job.lease_id===lease,'lease_lost','Job changed; old worker cannot commit');
          const [original]=await tx.executeRaw(`SELECT revision,content_hash,content,status FROM ultrabrain.personal_memories
            WHERE source_id=$1 AND actor_key=$2 AND id=$3::uuid FOR SHARE`,[this.source,this.actor,row.input_id]);
          if(!original||original.status==='archived'||original.revision!==row.input_revision||original.content_hash!==row.input_hash||sha256(original.content)!==row.input_hash)error='stale_source';
          const entries=[];
          if(!error)for(const m of generated.memories) {
            // Hints only. Never overwrite, merge, activate or delete older memories on model authority.
            const duplicates=await tx.executeRaw(`SELECT id::text FROM ultrabrain.personal_memories m WHERE source_id=$1 AND actor_key=$2
              AND type=$3 AND content_hash=$4 AND project_id IS NOT DISTINCT FROM $5::text
              AND status IN ('active','candidate') AND ${PERSONAL_DERIVATION_CURRENT} ORDER BY id LIMIT 3`,
              [this.source,this.actor,m.type,m.content_hash,row.original.project_id]);
            const derivation={job_id:row.id,input_id:row.input_id,input_revision:row.input_revision,input_hash:row.input_hash,
              profile_hash:profileHash,...m.evidence};
            const [entry]=await tx.executeRaw(`INSERT INTO ultrabrain.personal_memories
              (source_id,actor_key,type,content,content_hash,confidence,importance,source,agent_id,project_id,status,visibility,derivation)
              VALUES($1,$2,$3,$4,$5,NULL,'normal',$6,$7,$8,'candidate','private',$9::text::jsonb) RETURNING id::text,revision,status`,
              [this.source,this.actor,m.type,m.content,m.content_hash,m.provenance,row.original.agent_id,row.original.project_id,JSON.stringify(derivation)]);
            entries.push({...entry,exact_duplicate_hints:duplicates.map(d=>d.id)});
          }
          const state=error?(error==='stale_source'?'stale':'failed'):'completed';
          const receipt=error?null:{entries,gateway_invocations:1,usage:generated.usage,profile_hash:profileHash,
            input_hash:row.input_hash,review_required:true,source_retained:true,truth_verified:false};
          await tx.executeRaw(`UPDATE ultrabrain.personal_consolidations SET state=$2,result=$3::text::jsonb,error_code=$4,
            lease_id=NULL,lease_until=NULL,updated_at=now() WHERE id=$1::uuid`,[row.id,state,receipt===null?null:JSON.stringify(receipt),error??null]);
          return {job_id:row.id,state,attempts:row.attempts,error:error??null,result:receipt};
        });
        results.push(result);
      }catch(e) {
        // No automatic redo after an ambiguous commit. Durable status remains the authority.
        if(e.code==='lease_lost'){results.push({job_id:row.id,state:'lease_lost',result:null});continue;}
        throw Object.assign(new Error('Check durable personal job status before retrying'),{code:'personal_commit_unconfirmed'});
      }
    }
    return {source_id:this.source,results,processed:results.length,model_requests_attempted:modelCalls,
      retry_policy:'Only queued jobs by default; failed or expired processing requires explicit retry, at most three attempts. Provider calls are not exactly-once.'};
  }
}
