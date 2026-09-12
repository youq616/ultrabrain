/** Durable raw capture is committed before any model call. Processing always uses
 * the current authenticated actor's request context; no queued token/host impersonation.
 * This is at-least-once consolidation, not a distributed exactly-once executor.
 */
import { randomUUID } from 'node:crypto';
import { text, sourceId, sha256, requireThat, uri, integer } from './core.mjs';
export const MAX_ATTEMPTS = 5;
export const MAX_PENDING_PER_SOURCE = 1000;
function identity(p) {
  for (const k of ['session_id','event_id']) requireThat(typeof p[k]==='string' &&
    /^[A-Za-z0-9_-]{1,96}$/.test(p[k]),'invalid_params','Invalid session/event identifier');
}
export function deferredSlug(actor,session,event) {
  return `sessions/deferred/${actor}/${sha256(JSON.stringify([session,event]))}`;
}
function summary(source,actor,row) {
  return {session_id:row.session_id,event_id:row.event_id,state:row.state,
    storage:'journaled',deferred:true,extraction_state:row.state,attempts:row.attempts,
    canonical_state:row.result?.canonical_state ?? 'pending',
    uri:uri(source,deferredSlug(actor,row.session_id,row.event_id)),
    last_error:row.result?.error ?? null,
    ...(row.result?.evidence_binding?{evidence_binding:row.result.evidence_binding}:{}),
    retryable:['needs_model','failed'].includes(row.state)&&row.attempts<MAX_ATTEMPTS,
    delivery:'at-least-once',
    note:'The raw event is durable in PostgreSQL; canonical search availability and extraction are separate states.'};
}
async function access(store,mutating=true) {
  sourceId(store.source);
  await store.assertSessionAccess(mutating);
  return sha256(store.actor);
}
export async function enqueueSession(store,p) {
  identity(p);text(p.transcript,'transcript',65536);
  const visibility=p.visibility??'private';
  requireThat(['private','world'].includes(visibility),'invalid_params','Invalid visibility');
  const actor=await access(store), source=store.source;
  const keys=[source,actor,p.session_id,p.event_id];
  const hash=sha256(JSON.stringify([p.transcript,visibility]));
  const slug=deferredSlug(actor,p.session_id,p.event_id);
  if(store.dryRun) return {dry_run:true,uri:uri(source,slug),storage:'not_stored'};
  return store.transaction(async tx=>{
    // Bound pending payloads under a source-wide lock; never evict unprocessed data.
    await tx.executeRaw("SET LOCAL lock_timeout='5s'");
    await tx.executeRaw('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['deferred-capture',source])]);
    const [old]=await tx.executeRaw(`SELECT session_id,event_id,content_hash,state,result,attempts,deferred
      FROM ultrabrain.session_receipts WHERE source_id=$1 AND actor=$2 AND session_id=$3 AND event_id=$4`,keys);
    if(old) {
      requireThat(old.deferred&&old.content_hash===hash,'conflict','Event already used with different content, visibility or processing mode');
      return {...summary(source,actor,old),replayed:true};
    }
    const [capacity]=await tx.executeRaw(`SELECT count(*)::integer AS count FROM ultrabrain.session_receipts
      WHERE source_id=$1 AND deferred AND pending_payload IS NOT NULL`,[source]);
    requireThat(capacity.count<MAX_PENDING_PER_SOURCE,'queue_full','Process pending events before accepting more; no existing events were removed');
    const [row]=await tx.executeRaw(`INSERT INTO ultrabrain.session_receipts
      (source_id,actor,session_id,event_id,content_hash,state,deferred,pending_payload,result)
      VALUES($1,$2,$3,$4,$5,'queued',true,$6::text::jsonb,'{"canonical_state":"pending"}'::jsonb)
      RETURNING session_id,event_id,state,result,attempts`,[...keys,hash,JSON.stringify({transcript:p.transcript,visibility})]);
    return {...summary(source,actor,row),replayed:false};
  });
}
export async function sessionStatus(store,p) {
  identity(p);const actor=await access(store,false);
  const [row]=await store.sql(`SELECT session_id,event_id,state,result,attempts FROM ultrabrain.session_receipts
    WHERE source_id=$1 AND actor=$2 AND session_id=$3 AND event_id=$4 AND deferred`,[store.source,actor,p.session_id,p.event_id]);
  requireThat(row,'not_found','Deferred event not found for this source and actor');
  return summary(store.source,actor,row);
}
export async function processSessions(store,p={}) {
  const limit=integer(p.limit,1,1,8);
  requireThat(p.retry===undefined||typeof p.retry==='boolean','invalid_params','retry must be boolean');
  const actor=await access(store), source=store.source;
  requireThat(p.expected_source === source,'scope_denied','Configured source does not match the authenticated grant');
  if(store.dryRun) return {dry_run:true,results:[]};
  await store.sql(`UPDATE ultrabrain.session_receipts SET state='failed',lease_until=NULL,
    result=coalesce(result,'{}'::jsonb)||'{"error":"attempts_exhausted"}'::jsonb
    WHERE source_id=$1 AND actor=$2 AND deferred AND state='processing' AND lease_until<now() AND attempts>=$3`,[source,actor,MAX_ATTEMPTS]);
  const results=[];const attempted=[];
  for(let n=0;n<limit;n++) {
    const lease=randomUUID();
    // Atomic claim; do not hold a transaction or row lock during a model call.
    const [row]=await store.sql(`WITH candidate AS (
      SELECT source_id,actor,session_id,event_id FROM ultrabrain.session_receipts
      WHERE source_id=$1 AND actor=$2 AND deferred AND pending_payload IS NOT NULL
        AND attempts<$4 AND next_attempt_at<=now()
        AND NOT ((session_id||':'||event_id)=ANY($5::text[]))
        AND (state='queued' OR (state='processing' AND lease_until<now())
          OR ($3 AND state IN ('failed','needs_model')))
      ORDER BY created_at,session_id,event_id FOR UPDATE SKIP LOCKED LIMIT 1)
      UPDATE ultrabrain.session_receipts r SET state='processing',attempts=r.attempts+1,
        lease_id=$6::uuid,lease_until=now()+interval '15 minutes',updated_at=now()
      FROM candidate c WHERE r.source_id=c.source_id AND r.actor=c.actor
        AND r.session_id=c.session_id AND r.event_id=c.event_id
      RETURNING r.session_id,r.event_id,r.pending_payload,r.content_hash,r.attempts,r.result`,
      [source,actor,p.retry===true,MAX_ATTEMPTS,attempted,lease]);
    if(!row) break;
    attempted.push(`${row.session_id}:${row.event_id}`);
    const keys=[source,actor,row.session_id,row.event_id,lease];
    let state='failed',reason=null,binding=row.result?.evidence_binding??null,canonical=row.result?.canonical_state??'pending';
    try {
      const payload=row.pending_payload;
      text(payload?.transcript,'transcript',65536);
      requireThat(['private','world'].includes(payload.visibility) &&
        sha256(JSON.stringify([payload.transcript,payload.visibility]))===row.content_hash,
        'payload_integrity','Stored event failed integrity checks');
      const slug=deferredSlug(actor,row.session_id,row.event_id);
      await store.assertWrite(slug);
      if(canonical!=='stored') {
        await store.call('put_page',{slug,content:`---\ntitle: Session ${row.session_id}\ntype: note\nvisibility: ${payload.visibility}\n---\n\n${payload.transcript}`});
        canonical='stored';
      }
      const extracted=await store.call('extract_facts',{turn_text:payload.transcript,
        session_id:row.session_id,source_slug:slug,visibility:payload.visibility});
      requireThat(extracted&&typeof extracted==='object','upstream_contract_changed','Invalid extraction response');
      binding=extracted.evidence_binding??null;
      state=!extracted.skipped?'completed':['extraction_disabled','extraction_unavailable'].includes(extracted.skipped)?'needs_model':'failed';
      if(state!=='completed') reason=state==='needs_model'?'model_unavailable':'extraction_failed';
    } catch(error) {
      reason=['permission_denied','scope_denied','payload_integrity'].includes(error.code)?error.code:'processing_failed';
    }
    const [saved]=await store.sql(`UPDATE ultrabrain.session_receipts SET state=$6,result=$7::text::jsonb,
      pending_payload=CASE WHEN $6='completed' THEN NULL ELSE pending_payload END,
      lease_until=NULL,next_attempt_at=now()+interval '5 seconds',updated_at=now()
      WHERE source_id=$1 AND actor=$2 AND session_id=$3 AND event_id=$4 AND lease_id=$5::uuid
      RETURNING session_id,event_id,state,result,attempts`,[...keys,state,JSON.stringify({canonical_state:canonical,error:reason,...(binding?{evidence_binding:binding}:{})})]);
    requireThat(saved,'lease_lost','Processing lease changed; use status before retrying');
    results.push(summary(source,actor,saved));
  }
  return {source_id:source,results,processed:results.length,actor_scope:'current authenticated actor within source',
    retry_policy:'Failures and missing-model events require retry=true; at most five attempts. No queued credentials.',
    delivery:'at-least-once; a worker crash can repeat already submitted native operations'};
}
