/** Opt-in server-side admission over the SAME PostgreSQL database.
 * Admission and its audit event are atomic; native business writes and the final
 * audit event are separate transactions. A crash can leave an admitted request
 * without a terminal event. That is unknown execution, never proof of success.
 */
import {randomUUID} from 'node:crypto';
import {requireThat,sourceId,integer,sha256} from './core.mjs';
import {GOVERNED_TOOLS,normalizeEnterprisePolicy,enterprisePrincipal,policyDenial,InflightGate} from './enterprise-policy.mjs';
const publicCodes=new Set(['permission_denied','scope_denied','invalid_params','not_found','page_not_found','conflict','revision_conflict',
  'memory_not_current','stale_source','summary_unavailable','model_unavailable','busy','capture_disabled','evidence_required',
  'reactivation_required','replacement_not_reviewed','evidence_not_current','fact_not_current','mcp_timeout','cancelled']);
const failureCode=e=>publicCodes.has(e?.code)?e.code:'operation_failed';
async function append(sql,event) {
  await sql(`INSERT INTO ultrabrain.enterprise_audit(request_id,source_id,actor_sha256,operation,phase,outcome,code,policy_revision,duration_ms)
    VALUES($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [event.id,event.source,event.actor,event.operation,event.phase,event.outcome,event.code,event.revision??null,event.ms??null]);
}
export function enterpriseGuard(native) {
  const gate=new InflightGate();
  async function execute(op,ctx,params) {
    let actor;
    try {actor=enterprisePrincipal(ctx);}catch(e){throw new native.OperationError(e.code,'Governed request identity or source scope rejected');}
    const id=randomUUID(),started=performance.now(),base={id,source:ctx.sourceId,actor,operation:op.name};
    let release,admission;
    try {
      admission=await ctx.engine.transaction(async tx=>{
        const sql=(q,p)=>tx.executeRaw(q,p);
        await sql("SET LOCAL lock_timeout='2s'");
        await sql("SET LOCAL statement_timeout='5s'");
        const [row]=await sql('SELECT revision,policy FROM ultrabrain.enterprise_sources WHERE source_id=$1 FOR UPDATE',[ctx.sourceId]);
        if(!row)return {code:'enterprise_source_not_enrolled'};
        const policy=normalizeEnterprisePolicy(row.policy);
        let code=policyDenial(policy,op,params);
        if(!code) {
          const [clock]=await sql("SELECT date_trunc('minute',clock_timestamp()) AS window");
          // All requests for a source share this short row lock. Never hold it
          // while running the native handler or an external model.
          const subjects=['source',actor];
          const current=await sql(`SELECT subject,used,window_start FROM ultrabrain.enterprise_rate_windows
            WHERE source_id=$1 AND subject=ANY($2::text[])`,[ctx.sourceId,subjects]);
          const used=subject=>{const x=current.find(r=>r.subject===subject);
            return x&&new Date(x.window_start)>=new Date(clock.window)?x.used:0;};
          if(used('source')>=policy.requests_per_minute||used(actor)>=policy.actor_requests_per_minute)code='enterprise_rate_limited';
          if(!code){release=gate.acquire(ctx.sourceId,actor,policy);if(!release)code='enterprise_concurrency_limited';}
          if(!code)for(const subject of subjects)await sql(`INSERT INTO ultrabrain.enterprise_rate_windows(source_id,subject,window_start,used)
            VALUES($1,$2,$3,1) ON CONFLICT(source_id,subject) DO UPDATE SET
              used=CASE WHEN ultrabrain.enterprise_rate_windows.window_start<EXCLUDED.window_start THEN 1 ELSE ultrabrain.enterprise_rate_windows.used+1 END,
              window_start=GREATEST(ultrabrain.enterprise_rate_windows.window_start,EXCLUDED.window_start)`,[ctx.sourceId,subject,clock.window]);
          // Retain current/prior-window counters only; active subjects are never removed.
          await sql("DELETE FROM ultrabrain.enterprise_rate_windows WHERE source_id=$1 AND window_start<$2::timestamptz-interval '2 minutes'",[ctx.sourceId,clock.window]);
        }
        await append(sql,{...base,revision:row.revision,phase:'admission',outcome:code?'denied':'admitted',code:code??'ok'});
        return {code,revision:row.revision};
      });
    }catch {
      release?.();throw new native.OperationError('enterprise_admission_unavailable','Admission or audit persistence unavailable; operation was not submitted');
    }
    if(admission.code){release?.();throw new native.OperationError(admission.code,'Governed source admission rejected');}
    try {
      let result,error;
      try {result=await op.handler(ctx,params);}catch(e){error=e;}
      try {
        await ctx.engine.transaction(async tx=>{
          await tx.executeRaw("SET LOCAL statement_timeout='5s'");
          await append((q,p)=>tx.executeRaw(q,p),{...base,revision:admission.revision,phase:'result',outcome:error?'failed':'succeeded',
            code:error?failureCode(error):'ok',ms:Math.min(2147483647,Math.max(0,Math.floor(performance.now()-started)))});
        });
      }catch {
        throw new native.OperationError('enterprise_audit_unconfirmed','Operation may have completed; terminal audit could not be persisted. Reconcile before retrying non-idempotent writes');
      }
      if(error)throw new native.OperationError(failureCode(error),'Governed operation failed; sensitive provider and input details omitted');
      return result;
    }finally{release?.();}
  }
  return {execute,gate};
}
/** Capture originals BEFORE replacing the public array. Internal governed
 * delegates retain original native handlers with their original request ctx.
 */
export function publishGovernedSurface(operations,native) {
  const byName=new Map(operations.map(op=>[op.name,op]));
  requireThat(GOVERNED_TOOLS.every(name=>byName.has(name)),'upstream_contract_changed','Governed tool contract is incomplete');
  const guard=enterpriseGuard(native);
  const published=GOVERNED_TOOLS.map(name=>{const original=byName.get(name);
    return {...original,handler:(ctx,p)=>guard.execute(original,ctx,p)};});
  operations.splice(0,operations.length,...published);
  return {operations:GOVERNED_TOOLS,concurrency_scope:'this server process',rate_scope:'shared database source and principal',guard};
}
export async function configureEnterpriseSource(engine,source,expectedRevision,policy) {
  sourceId(source);integer(expectedRevision,undefined,0,2147483646);
  requireThat(expectedRevision!==undefined,'invalid_params','expected_revision is required');
  const normalized=normalizeEnterprisePolicy(policy);
  return engine.transaction(async tx=>{
    await tx.executeRaw("SET LOCAL lock_timeout='2s'");
    await tx.executeRaw("SET LOCAL statement_timeout='5s'");
    await tx.executeRaw('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['ultrabrain-enterprise-config',source])]);
    const [existingSource]=await tx.executeRaw('SELECT id FROM public.sources WHERE id=$1',[source]);
    requireThat(existingSource,'not_found','Create the native source before enrolling it');
    const [prior]=await tx.executeRaw('SELECT revision FROM ultrabrain.enterprise_sources WHERE source_id=$1 FOR UPDATE',[source]);
    requireThat((prior?.revision??0)===expectedRevision,'revision_conflict','Enterprise policy changed; read status before retrying');
    const revision=expectedRevision+1;
    await tx.executeRaw(`INSERT INTO ultrabrain.enterprise_sources(source_id,revision,policy) VALUES($1,$2,$3::text::jsonb)
      ON CONFLICT(source_id) DO UPDATE SET revision=EXCLUDED.revision,policy=EXCLUDED.policy,updated_at=now()`,[source,revision,JSON.stringify(normalized)]);
    await append((q,p)=>tx.executeRaw(q,p),{id:randomUUID(),source,actor:sha256('trusted-host-administrator'),operation:'enterprise_configure',
      phase:'configuration',outcome:'configured',code:'ok',revision});
    return {source_id:source,revision,policy:normalized,effect:'next admission; already running operations are not revoked',host_only:true};
  });
}
export async function enterpriseStatus(engine,source) {
  sourceId(source);
  const [row]=await engine.executeRaw('SELECT revision,policy,updated_at FROM ultrabrain.enterprise_sources WHERE source_id=$1',[source]);
  const counters=await engine.executeRaw(`SELECT phase,outcome,code,count(*)::integer AS count FROM ultrabrain.enterprise_audit
    WHERE source_id=$1 AND created_at>now()-interval '24 hours' GROUP BY phase,outcome,code ORDER BY phase,outcome,code`,[source]);
  const [pending]=await engine.executeRaw(`SELECT count(*)::integer AS count FROM ultrabrain.enterprise_audit a
    WHERE a.source_id=$1 AND a.phase='admission' AND a.outcome='admitted' AND a.created_at>now()-interval '24 hours'
    AND NOT EXISTS(SELECT 1 FROM ultrabrain.enterprise_audit r WHERE r.request_id=a.request_id AND r.phase='result')`,[source]);
  return {source_id:source,enrolled:!!row,...(row??{}),last_24h:counters,admissions_without_result_last_24h:pending.count,
    unresolved_meaning:'May be running, crashed, or terminal audit failed; not a success or failure count',
    audit_scope:'governed admitted-handler boundary and host policy edits; not all HTTP/OAuth rejection paths',
    concurrency_scope:'per server process, not a distributed concurrency limit'};
}
export async function enterpriseAudit(engine,source,{after=0,limit=100}={}) {
  sourceId(source);integer(after,0,0,Number.MAX_SAFE_INTEGER);integer(limit,100,1,1000);
  const rows=await engine.executeRaw(`SELECT id::text,request_id,source_id,actor_sha256,operation,phase,outcome,code,policy_revision,duration_ms,created_at
    FROM ultrabrain.enterprise_audit WHERE source_id=$1 AND id>$2::bigint ORDER BY id LIMIT $3`,[source,after,limit]);
  return {source_id:source,events:rows,next_after:rows.at(-1)?.id??String(after),consistency:'live ID page, not a frozen export snapshot',
    assurance:'append-only trigger; not tamper-proof against the database owner or host administrator'};
}
