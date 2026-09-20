/** Acceptance-only oracle shared by real PostgreSQL and mutation tests; not application code. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
export const DOCUMENT_MODULE_TABLES=Object.freeze([
  'personal_memories','personal_events','personal_consolidations','personal_documents','personal_document_fragments',
]);
export async function readDocumentModuleLinks(engine,source,actor){
  // LEFT JOIN is deliberate: a missing document, memory or job remains visible
  // as null and fails the oracle, rather than disappearing from an inner join.
  return engine.executeRaw(`SELECT f.document_id::text, f.memory_id::text AS fragment_memory_id,
    f.byte_start,f.byte_end,f.fragment_sha256,f.offset_unit,
    d.id::text AS linked_document_id,d.label,d.status AS document_status,d.revision AS document_revision,
    d.byte_size,d.content_sha256 AS document_hash,
    m.id::text AS linked_memory_id,m.status AS memory_status,m.revision AS memory_revision,
    m.origin_kind,m.content,m.content_hash AS memory_hash,
    j.id::text AS job_id,j.input_id::text AS job_input_id,j.input_revision,j.input_hash,
    j.state AS job_state,j.attempts
    FROM ultrabrain.personal_document_fragments f
    LEFT JOIN ultrabrain.personal_documents d ON d.id=f.document_id AND d.source_id=f.source_id AND d.actor_key=f.actor_key
    LEFT JOIN ultrabrain.personal_memories m ON m.id=f.memory_id AND m.source_id=f.source_id AND m.actor_key=f.actor_key
    LEFT JOIN ultrabrain.personal_consolidations j ON j.input_id=f.memory_id AND j.source_id=f.source_id AND j.actor_key=f.actor_key
    WHERE f.source_id=$1 AND f.actor_key=$2 ORDER BY f.byte_start,j.id`,[source,actor]);
}
export function assertDocumentModuleLinks(rows,{documentId,original}){
  assert.equal(rows.length,1,'Exactly one retained fragment and linked job must remain after archival');
  const row=rows[0],hash=createHash('sha256').update(original).digest('hex');
  const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
  assert.ok(uuid(row.fragment_memory_id)&&uuid(row.job_id),'Fragment memory and job IDs must exist');
  assert.deepEqual(row,{
    document_id:documentId,fragment_memory_id:row.fragment_memory_id,
    byte_start:0,byte_end:original.length,fragment_sha256:hash,offset_unit:'utf8-bytes',
    linked_document_id:documentId,label:'module-user.md',document_status:'archived',document_revision:2,
    byte_size:original.length,document_hash:hash,
    linked_memory_id:row.fragment_memory_id,memory_status:'archived',memory_revision:2,
    origin_kind:'document_fragment',content:original.toString('utf8'),memory_hash:hash,
    job_id:row.job_id,job_input_id:row.fragment_memory_id,input_revision:1,input_hash:hash,
    job_state:'stale',attempts:0,
  },'Document, retained fragment memory, immutable source bytes and zero-attempt job must remain linked');
}
