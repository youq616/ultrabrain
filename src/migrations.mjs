/** Append-only application metadata migrations; no PostgreSQL-major or native-engine upgrade magic. */
import {readFileSync} from 'node:fs';
import {requireThat,sha256} from './core.mjs';
export const migrations=['0001-baseline','0002-revision-evidence','0003-deferred-sessions','0004-summary-cache'].map(id =>
  JSON.parse(readFileSync(new URL(`../migrations/${id}.json`,import.meta.url),'utf8')));
export const checksum=m=>sha256(JSON.stringify(m.statements));
export function validateHistory(rows, plan=migrations) {
  requireThat(Array.isArray(rows)&&Array.isArray(plan),'migration_invalid','Invalid migration history');
  const ids=plan.map(m=>m.id);
  requireThat(new Set(ids).size===ids.length && ids.every((id,i)=>/^\d{4}-[a-z0-9-]+$/.test(id)&&
    (i===0||id>ids[i-1])) && plan.every(m=>Array.isArray(m.statements)&&m.statements.length>0&&
    m.statements.every(s=>typeof s==='string'&&s.trim())), 'migration_invalid','Invalid migration plan');
  requireThat(rows.length<=plan.length,'migration_unknown','Database contains migrations unknown to this release');
  for(let i=0;i<rows.length;i++) {
    requireThat(rows[i].id===plan[i].id,'migration_unknown','Migration history is not an ordered prefix of this release');
    requireThat(rows[i].checksum===checksum(plan[i]),'migration_checksum_mismatch','Previously applied migration was changed');
  }
  return plan.slice(rows.length);
}
export async function migrationStatus(engine) {
  const [table]=await engine.executeRaw("SELECT to_regclass('ultrabrain.schema_migrations') IS NOT NULL AS present");
  const rows=table.present?await engine.executeRaw('SELECT id,checksum FROM ultrabrain.schema_migrations ORDER BY id'):[];
  return {applied:rows.map(r=>r.id),pending:validateHistory(rows).map(m=>m.id)};
}
export async function applyMigrations(engine,{plan=migrations}={}) {
  validateHistory([],plan);
  return engine.transaction(async tx=>{
    await tx.executeRaw('SELECT pg_advisory_xact_lock(1431061074,1)');
    await tx.executeRaw('CREATE SCHEMA IF NOT EXISTS ultrabrain');
    await tx.executeRaw(`CREATE TABLE IF NOT EXISTS ultrabrain.schema_migrations (
      id text PRIMARY KEY,checksum text NOT NULL CHECK(length(checksum)=64),
      applied_at timestamptz NOT NULL DEFAULT now())`);
    const rows=await tx.executeRaw('SELECT id,checksum FROM ultrabrain.schema_migrations ORDER BY id');
    const pending=validateHistory(rows,plan);
    for(const migration of pending) {
      for(const statement of migration.statements) await tx.executeRaw(statement);
      await tx.executeRaw('INSERT INTO ultrabrain.schema_migrations(id,checksum) VALUES ($1,$2)',
        [migration.id,checksum(migration)]);
    }
    return {applied:pending.map(m=>m.id),atomic:true};
  });
}
