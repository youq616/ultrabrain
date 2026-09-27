/** One owner-scoped MVCC statement, fixed metadata projection and keyset paging. */
import {requireThat,sourceId,UltraError} from './core.mjs';
import {personalPrincipal,PERSONAL_DERIVATION_CURRENT} from './personal-memory-store.mjs';
import {CANDIDATES_FORMAT,CANDIDATES_SCOPE,candidateData,candidatePageRequest,candidateMetadataRows,verifyCandidatePage} from './personal-candidates-contract.mjs';
export const PERSONAL_CANDIDATES_SQL=`WITH page AS (
 SELECT m.id::text,m.type,m.agent_id,m.project_id,m.importance,m.confidence,m.visibility,m.revision,m.content_hash,
  m.status,m.origin_kind,
  to_char(m.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
  to_char(m.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at,
  ${PERSONAL_DERIVATION_CURRENT} AS derivation_current
 FROM ultrabrain.personal_memories m
 WHERE m.source_id=$1 AND m.actor_key=$2 AND m.status='candidate' AND m.origin_kind='agent'
  AND (m.project_id IS NULL OR m.project_id=$3)
  AND ($4::uuid IS NULL OR m.id>$4::uuid)
 ORDER BY m.id LIMIT $5
 ) SELECT to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS observed_at,
 coalesce(jsonb_agg(to_jsonb(page) ORDER BY page.id),'[]'::jsonb) AS memories FROM page`;
export class PersonalCandidates {
 constructor(ctx){
  this.ctx=ctx;this.source=sourceId(ctx.sourceId);this.actor=personalPrincipal(ctx);this.engine=ctx.engine;
  requireThat(typeof this.engine?.transaction==='function','unsupported_engine','Native transactional adapter required');
 }
 #authorized(){
  requireThat(this.ctx.engine===this.engine&&this.ctx.sourceId===this.source&&personalPrincipal(this.ctx)===this.actor,
   'permission_denied','Candidate page authority changed');
 }
 async list(input){
  this.#authorized();let request;
  try{request=candidatePageRequest(input);}catch{throw new UltraError('invalid_params','Invalid candidate page selection');}
  const rows=await this.engine.transaction(async tx=>{
   this.#authorized();await tx.executeRaw('SET LOCAL transaction_read_only=on');
   await tx.executeRaw("SET LOCAL statement_timeout='5s'");await tx.executeRaw("SET LOCAL lock_timeout='1s'");
   this.#authorized();return tx.executeRaw(PERSONAL_CANDIDATES_SQL,[this.source,this.actor,request.project_id??null,request.after_id??null,request.limit+1]);
  });
  this.#authorized();let result;
  try{
   requireThat(Array.isArray(rows)&&rows.length===1,'personal_candidates_unconfirmed','Expected one complete page');
   const descriptor=Object.getOwnPropertyDescriptor(rows,'0');
   requireThat(descriptor?.enumerable&&Object.hasOwn(descriptor,'value'),'personal_candidates_unconfirmed','Data aggregate required');
   const aggregate=candidateData(descriptor.value,['observed_at','memories'],[],'personal_candidates_unconfirmed');
   const selected=candidateMetadataRows(aggregate.memories,request,request.limit+1),more=selected.length>request.limit;
   const memories=selected.slice(0,request.limit);
   result=verifyCandidatePage({format:CANDIDATES_FORMAT,scope:CANDIDATES_SCOPE,source_id:this.source,request_id:request.request_id,
    project_id:request.project_id??null,after_id:request.after_id??null,limit:request.limit,observed_at:aggregate.observed_at,memories,
    returned:memories.length,has_more:more,next_after:more?memories.at(-1).id:null,read_only:true,model_calls:0,
    trust:'untrusted-memory-metadata',snapshot:false},request,this.source);
  }catch{throw new UltraError('personal_candidates_unconfirmed','Candidate page was not confirmed');}
  this.#authorized();return result;
 }
}
