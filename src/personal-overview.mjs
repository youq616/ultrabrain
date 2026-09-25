/** Owner-only aggregate overview; one MVCC statement snapshot, no body projection.
 * No locks held across network/model calls. No model/config/data-write API here.
 */
import {requireThat,sourceId,UltraError} from './core.mjs';
import {personalPrincipal,PERSONAL_DERIVATION_CURRENT} from './personal-memory-store.mjs';
import {MAX_PERSONAL_ATTEMPTS} from './personal-consolidation-core.mjs';
import {OVERVIEW_FORMAT,OVERVIEW_SCOPE,overviewRequest,verifyPersonalOverview} from './personal-overview-contract.mjs';
// Do not cap/truncate rows before aggregation; timeout or int32 overflow fails the
// whole read. Both thresholds and the direct-source predicate are canonical imports.
const counts=(pairs)=>pairs.map(([key,filter])=>`'${key}',count(*)${filter?` FILTER (WHERE ${filter})`:''}::integer`).join(',\n      ');
export const PERSONAL_OVERVIEW_SQL=`WITH clock AS (SELECT statement_timestamp() AS observed),
 owned_memories AS (
   SELECT m.status,m.origin_kind,${PERSONAL_DERIVATION_CURRENT} AS current
   FROM ultrabrain.personal_memories m WHERE source_id=$1 AND actor_key=$2
 ), owned_jobs AS (
   SELECT state,attempts,lease_until FROM ultrabrain.personal_consolidations WHERE source_id=$1 AND actor_key=$2
 ), owned_documents AS (
   SELECT status FROM ultrabrain.personal_documents WHERE source_id=$1 AND actor_key=$2
 ), owned_agents AS (
   SELECT 1 FROM ultrabrain.agent_registry WHERE source_id=$1 AND actor_key=$2
 )
 SELECT to_char(clock.observed AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS observed_at,
   (SELECT jsonb_build_object(${counts([
    ['total'],['candidate',"status='candidate'"],['active',"status='active'"],['archived',"status='archived'"],
    ['active_current',"status='active' AND current"],['active_stale',"status='active' AND NOT current"],
    ['candidate_stale',"status='candidate' AND NOT current"],['document_fragments',"origin_kind='document_fragment'"]])}) FROM owned_memories) AS memories,
   (SELECT jsonb_build_object(${counts([
    ['total'],...['queued','processing','completed','failed','stale'].map(s=>[s,`state='${s}'`]),
    ['processing_live',"state='processing' AND lease_until>clock.observed"],
    ['processing_expired',"state='processing' AND lease_until<=clock.observed"],
    ['failed_below_attempt_limit',`state='failed' AND attempts<${MAX_PERSONAL_ATTEMPTS}`]])}) FROM owned_jobs) AS jobs,
   (SELECT jsonb_build_object(${counts([['total'],['active',"status='active'"],['archived',"status='archived'"]])}) FROM owned_documents) AS documents,
   (SELECT jsonb_build_object('total',count(*)::integer) FROM owned_agents) AS agents
 FROM clock`;
export class PersonalOverview {
 constructor(ctx){
  this.ctx=ctx;this.source=sourceId(ctx.sourceId);this.actor=personalPrincipal(ctx);this.engine=ctx.engine;
  requireThat(typeof this.engine.transaction==='function','unsupported_engine','Native transactional adapter required');
 }
 #authorized(){
  requireThat(this.ctx.engine===this.engine&&this.ctx.sourceId===this.source&&personalPrincipal(this.ctx)===this.actor,
   'permission_denied','Overview source or principal changed');
 }
 async read(input){
  this.#authorized();let request;
  try{request=overviewRequest(input);}catch{throw new UltraError('invalid_params','A single full overview request UUID is required');}
  const rows=await this.engine.transaction(async tx=>{
   this.#authorized();await tx.executeRaw('SET LOCAL transaction_read_only=on');
   await tx.executeRaw("SET LOCAL statement_timeout='5s'");await tx.executeRaw("SET LOCAL lock_timeout='1s'");
   this.#authorized();return tx.executeRaw(PERSONAL_OVERVIEW_SQL,[this.source,this.actor]);
  });
  this.#authorized();
  requireThat(Array.isArray(rows)&&rows.length===1,'personal_overview_unconfirmed','Aggregate read was not confirmed');
  const row=rows[0];
  let result;
  try{result=verifyPersonalOverview({format:OVERVIEW_FORMAT,scope:OVERVIEW_SCOPE,source_id:this.source,request_id:request.request_id,
   observed_at:row.observed_at,read_only:true,model_calls:0,trust:'untrusted-memory-metadata',
   memories:row.memories,jobs:row.jobs,documents:row.documents,agents:row.agents},request,this.source);}
  catch{throw new UltraError('personal_overview_unconfirmed','Aggregate counts were not confirmed');}
  // Driver materialization/validation must not reopen a revoked authority window.
  this.#authorized();return result;
 }
}
