/** Synchronous, retryable session finalization, with explicit deferred capture opt-in. */
import { enqueueSession } from './deferred-sessions.mjs';
import { randomUUID } from 'node:crypto';
import { text, sourceId, sha256, requireThat, uri } from './core.mjs';
export const SESSION_SCHEMA = `
CREATE SCHEMA IF NOT EXISTS ultrabrain;
CREATE TABLE IF NOT EXISTS ultrabrain.session_receipts (
  source_id text NOT NULL REFERENCES public.sources(id), actor text NOT NULL,
  session_id text NOT NULL, event_id text NOT NULL, content_hash text NOT NULL,
  state text NOT NULL CHECK (state IN ('processing','completed','needs_model','failed')),
  lease_id uuid, lease_until timestamptz, result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, actor, session_id, event_id)
);
UPDATE ultrabrain.session_receipts SET result =
 CASE WHEN jsonb_typeof(result)='string' AND (result #>> '{}') IS JSON OBJECT
 THEN (result #>> '{}')::jsonb ELSE result END
 WHERE jsonb_typeof(result)='string';
`;
export async function commitSession(store, p) {
  requireThat(p.defer_extraction === undefined || typeof p.defer_extraction === 'boolean', 'invalid_params', 'defer_extraction must be boolean');
  if (p.defer_extraction === true) return enqueueSession(store,p);
  const source = sourceId(store.source);
  for (const key of ['session_id', 'event_id']) {
    requireThat(typeof p[key] === 'string' && /^[a-zA-Z0-9_-]{1,96}$/.test(p[key]),
      'invalid_params', `${key} must be 1..96 ASCII letters, digits, _ or -`);
  }
  text(p.transcript, 'transcript', 65536);
  const visibility = p.visibility ?? 'private';
  requireThat(['private', 'world'].includes(visibility), 'invalid_params', 'Invalid visibility');
  const actor = sha256(store.actor);
  const digest = sha256(JSON.stringify([p.transcript, visibility]));
  const slug = `sessions/${actor.slice(0, 24)}/${p.session_id}/${p.event_id}`;
  if (store.dryRun) return { dry_run: true, uri: uri(source, slug) };
  await store.assertWrite(slug);
  const lease = randomUUID();
  const keys = [source, actor, p.session_id, p.event_id];
  const claimed = await store.sql(`
    INSERT INTO ultrabrain.session_receipts
      (source_id,actor,session_id,event_id,content_hash,state,lease_id,lease_until)
    VALUES ($1,$2,$3,$4,$5,'processing',$6,now()+interval '15 minutes')
    ON CONFLICT (source_id,actor,session_id,event_id) DO UPDATE
      SET state='processing',lease_id=EXCLUDED.lease_id,
          lease_until=EXCLUDED.lease_until,updated_at=now()
      WHERE NOT ultrabrain.session_receipts.deferred
        AND ultrabrain.session_receipts.content_hash=EXCLUDED.content_hash
        AND ((ultrabrain.session_receipts.state='processing'
              AND ultrabrain.session_receipts.lease_until < now())
          OR (ultrabrain.session_receipts.state IN ('needs_model','failed') AND $7))
    RETURNING state`, [...keys, digest, lease, p.retry === true]);
  if (!claimed.length) {
    const [row] = await store.sql(`SELECT content_hash,state,result,deferred FROM ultrabrain.session_receipts
      WHERE source_id=$1 AND actor=$2 AND session_id=$3 AND event_id=$4`, keys);
    requireThat(row && !row.deferred && row.content_hash === digest, 'conflict', 'event_id was already used for different content, visibility or processing mode');
    requireThat(row.state !== 'processing', 'busy', 'This event is being finalized; retry after its lease expires');
    return { ...row.result, state: row.state, replayed: true };
  }
  try {
    const content = `---\ntitle: Session ${p.session_id}\ntype: note\nvisibility: ${visibility}\n---\n\n${p.transcript}`;
    await store.call('put_page', { slug, content });
    const extracted = await store.call('extract_facts', {
      turn_text: p.transcript, session_id: p.session_id, source_slug: slug, visibility,
    });
    const state = !extracted.skipped ? 'completed' :
      ['extraction_unavailable', 'extraction_disabled'].includes(extracted.skipped) ? 'needs_model' : 'failed';
    const result = { uri: uri(source, slug), state, storage: 'stored',
      extraction_state: state, extraction: extracted,
      delivery: 'at-least-once; native fact deduplication; not transactional exactly-once',
      visibility_note: 'private is host-private under native policy; remote recall sees world within its source grant' };
    const updated = await store.sql(`UPDATE ultrabrain.session_receipts SET
      state=$5,result=$6::text::jsonb,lease_until=NULL,updated_at=now()
      WHERE source_id=$1 AND actor=$2 AND session_id=$3 AND event_id=$4 AND lease_id=$7 RETURNING state`,
    [...keys, state, JSON.stringify(result), lease]);
    requireThat(updated.length === 1, 'lease_lost', 'Lease changed; inspect the receipt before retrying');
    return result;
  } catch (error) {
    await store.sql(`UPDATE ultrabrain.session_receipts SET state='failed',
      result='{"error":"session_finalize_failed","retryable":true}'::jsonb,
      lease_until=NULL,updated_at=now()
      WHERE source_id=$1 AND actor=$2 AND session_id=$3 AND event_id=$4 AND lease_id=$5`, [...keys, lease]);
    throw error;
  }
}
