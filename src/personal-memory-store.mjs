import { requireThat, sha256, text, integer } from './core.mjs';

/**
 * Personal memory service boundary.
 * Storage adapters are injected so the personal layer does not create a second database.
 */
export class PersonalMemoryStore {
  constructor(adapter) {
    requireThat(adapter && typeof adapter.query === 'function', 'invalid_params', 'Personal memory adapter required');
    this.adapter = adapter;
  }

  async create(input) {
    const memory = normalizeMemory(input);
    const result = await this.adapter.query(
      `INSERT INTO ultrabrain.personal_memories
      (memory_id,memory_type,content,confidence,importance,source,agent_id,project_id,content_hash,status)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING *`,
      [memory.id,memory.type,memory.content,memory.confidence,memory.importance,
       memory.source,memory.agent_id,memory.project_id,memory.hash,memory.status]
    );
    return result[0];
  }

  async search({ type, agent_id, project_id, limit = 20 } = {}) {
    integer(limit, 20, 1, 100);
    return this.adapter.query(
      `SELECT * FROM ultrabrain.personal_memories
       WHERE ($1::text IS NULL OR memory_type=$1)
       AND ($2::text IS NULL OR agent_id=$2)
       AND ($3::text IS NULL OR project_id=$3)
       AND status='active'
       ORDER BY confidence DESC, importance DESC, updated_at DESC
       LIMIT $4`,
      [type ?? null, agent_id ?? null, project_id ?? null, limit]
    );
  }

  async updateConfirmation(id, confidence) {
    integer(Math.round(confidence * 100), 0, 0, 100);
    const rows = await this.adapter.query(
      `UPDATE ultrabrain.personal_memories
       SET confidence=$2,last_confirmed=now(),updated_at=now()
       WHERE memory_id=$1 RETURNING *`,
      [id, confidence]
    );
    return rows[0] ?? null;
  }
}

export function normalizeMemory(input = {}) {
  const allowed = ['identity','preference','environment','project','decision','skill','error','goal','experience'];
  requireThat(allowed.includes(input.type), 'invalid_params', 'Invalid personal memory type');
  text(input.content, 'content', 65536);
  const confidence = Number(input.confidence ?? 0.5);
  requireThat(Number.isFinite(confidence) && confidence >= 0 && confidence <= 1, 'invalid_params', 'Invalid confidence');
  return {
    id: input.id ?? sha256(`${input.type}:${input.content}`).slice(0, 32),
    type: input.type,
    content: input.content,
    confidence,
    importance: Number(input.importance ?? 0.5),
    source: input.source ?? 'agent',
    agent_id: input.agent_id ?? null,
    project_id: input.project_id ?? null,
    hash: sha256(input.content),
    status: 'active'
  };
}
