/** Source-scoped work state. Only the trusted host runner creates execution receipts. */
import { randomUUID } from 'node:crypto';
import { codeRevision, matchesCodeRevision } from './workspace-evidence.mjs';
import { requireThat, sourceId, text, integer, sha256, clip } from './core.mjs';
export const PROJECT_SCHEMA = `
CREATE SCHEMA IF NOT EXISTS ultrabrain;
CREATE TABLE IF NOT EXISTS ultrabrain.projects (
 source_id text NOT NULL REFERENCES public.sources(id), project_id text NOT NULL,
 revision integer NOT NULL CHECK (revision>0), state jsonb NOT NULL CHECK (jsonb_typeof(state)='object'),
 updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(source_id,project_id)
);
CREATE TABLE IF NOT EXISTS ultrabrain.project_revisions (
 source_id text NOT NULL, project_id text NOT NULL, revision integer NOT NULL,
 event_id text NOT NULL, request_hash text NOT NULL, actor_hash text NOT NULL,
 state jsonb NOT NULL CHECK (jsonb_typeof(state)='object'), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(source_id,project_id,revision), UNIQUE(source_id,project_id,event_id),
 FOREIGN KEY(source_id,project_id) REFERENCES ultrabrain.projects ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS ultrabrain.verification_receipts (
 receipt_id uuid PRIMARY KEY, source_id text NOT NULL, project_id text NOT NULL,
 task_id text NOT NULL, subject_hash text NOT NULL, kind text NOT NULL,
 exit_code integer NOT NULL, timed_out boolean NOT NULL,
 command_sha256 text NOT NULL, stdout_sha256 text NOT NULL, stderr_sha256 text NOT NULL,
 started_at timestamptz NOT NULL, finished_at timestamptz NOT NULL,
 provenance text NOT NULL CHECK (provenance='host-process-exit'),
 FOREIGN KEY(source_id,project_id) REFERENCES ultrabrain.projects ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS ultrabrain.project_tombstones (
 source_id text NOT NULL REFERENCES public.sources(id), project_id text NOT NULL,
 forgotten_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(source_id,project_id)
);
`;
export function identifier(value, name = 'identifier') {
  requireThat(typeof value === 'string' && /^[a-zA-Z0-9_-]{1,96}$/.test(value), 'invalid_params', `${name} must be 1..96 ASCII letters, digits, _ or -`);
  return value;
}
function shape(obj, keys) {
  requireThat(obj && typeof obj === 'object' && !Array.isArray(obj) &&
    Object.keys(obj).every(k => keys.includes(k)), 'invalid_params', 'Unknown or invalid structured-state field');
}
function strings(value, max = 32) {
  requireThat(Array.isArray(value) && value.length <= max, 'invalid_params', 'Too many entries or invalid list');
  return value.map(v => text(v,'entry',2048));
}
// Keep historical hashes unchanged for tasks with no explicit code constraint.
export const taskHash = task => sha256(JSON.stringify(task.code_revision === undefined
  ? [task.id, task.title, task.acceptance] : [task.id, task.title, task.acceptance, task.code_revision]));
export function normalizeProject(state) {
  shape(state,['goal','constraints','decisions','tasks','blockers','next_actions']);
  const out = { goal: text(state.goal,'goal',4096), constraints: strings(state.constraints ?? []),
    decisions: strings(state.decisions ?? []), tasks: [], blockers: strings(state.blockers ?? []),
    next_actions: strings(state.next_actions ?? []) };
  requireThat(Array.isArray(state.tasks) && state.tasks.length <= 64, 'invalid_params', 'tasks must be an array of at most 64 tasks');
  const ids = new Set();
  out.tasks = state.tasks.map(t => {
    shape(t,['id','title','acceptance','status','receipt_ids','code_revision']);
    identifier(t.id,'task id'); requireThat(!ids.has(t.id),'invalid_params','Duplicate task id'); ids.add(t.id);
    requireThat(['planned','in_progress','blocked','reported_complete','verified_complete'].includes(t.status), 'invalid_params', 'Unknown task status');
    const receipt_ids = t.receipt_ids ?? [];
    requireThat(Array.isArray(receipt_ids) && receipt_ids.length <= 16 && receipt_ids.every(x =>
      typeof x === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(x)), 'invalid_params','Invalid receipt ids');
    requireThat(t.status !== 'verified_complete' || receipt_ids.length > 0, 'evidence_required', 'Verified completion requires host execution evidence');
    const binding = t.code_revision === undefined ? {} : {code_revision:codeRevision(t.code_revision)};
    return { id: t.id, title: text(t.title,'title',2048), acceptance: strings(t.acceptance ?? [],16), status: t.status, receipt_ids, ...binding };
  });
  requireThat(Buffer.byteLength(JSON.stringify(out)) <= 65536, 'invalid_params', 'Project state exceeds 64 KiB');
  return out;
}
export function authorizeProjects(ctx) {
  sourceId(ctx.sourceId);
  requireThat(ctx.engine?.kind === 'postgres','unsupported_engine','Native PostgreSQL required');
  requireThat(!ctx.viaSubagent && !ctx.auth?.boundSlugPrefixes && !ctx.auth?.fenceProjectionDegraded,
    'permission_denied','Project metadata requires a full source grant, not a delegated or directory-bound grant');
  requireThat(!ctx.auth?.sourceId || ctx.auth.sourceId === ctx.sourceId,'permission_denied','Source authority mismatch');
}
async function lock(tx, source, project) {
  await tx.executeRaw("SET LOCAL lock_timeout='5s'");
  await tx.executeRaw('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['ultrabrain-project',source,project])]);
}
export function resumeQuery(state, query) {
  text(query,'query',4096);
  return clip([query, state.goal, ...state.tasks.filter(t => !['reported_complete','verified_complete'].includes(t.status))
    .slice(0,8).map(t => t.title), ...state.blockers.slice(0,4), ...state.next_actions.slice(0,4)].join('\n'),4096);
}
export function projectTools(ctx) {
  authorizeProjects(ctx);
  const source=ctx.sourceId, engine=ctx.engine;
  const actor=sha256(JSON.stringify(ctx.auth?.principal ?? ['local',ctx.auth?.clientId ?? 'owner']));
  async function load(p) {
    const project=identifier(p.project_id,'project id');
    const [row]=await engine.executeRaw('SELECT revision,state,updated_at FROM ultrabrain.projects WHERE source_id=$1 AND project_id=$2',[source,project]);
    requireThat(row,'not_found','Project not found in this source');
    return { source_id:source, project_id:project, ...row, trust:'untrusted-memory-data',
      verification_scope:'Host process exit; tasks with code_revision additionally require clean matching Git observations. Not a hermetic build, CI or deployment attestation' };
  }
  async function save(p) {
    const project=identifier(p.project_id,'project id'), event=identifier(p.event_id,'event id');
    integer(p.expected_revision,undefined,0,2147483646);
    requireThat(p.expected_revision !== undefined,'invalid_params','expected_revision is required (0 to create)');
    const state=normalizeProject(p.state), digest=sha256(JSON.stringify([p.expected_revision,state]));
    if(ctx.dryRun) return { dry_run:true,project_id:project,expected_revision:p.expected_revision };
    return engine.transaction(async tx => {
      await lock(tx,source,project);
      const gone=await tx.executeRaw('SELECT 1 FROM ultrabrain.project_tombstones WHERE source_id=$1 AND project_id=$2',[source,project]);
      requireThat(!gone.length,'project_forgotten','This project id was forgotten; replay cannot recreate it');
      const [replay]=await tx.executeRaw('SELECT revision,request_hash,actor_hash FROM ultrabrain.project_revisions WHERE source_id=$1 AND project_id=$2 AND event_id=$3',[source,project,event]);
      if(replay) {
        requireThat(replay.request_hash === digest && replay.actor_hash === actor,'conflict','Event id reused with different content or actor');
        return { project_id:project,revision:replay.revision,replayed:true };
      }
      const [current]=await tx.executeRaw('SELECT revision FROM ultrabrain.projects WHERE source_id=$1 AND project_id=$2',[source,project]);
      requireThat((current?.revision ?? 0) === p.expected_revision,'revision_conflict','Project changed; reload and reconcile instead of overwriting');
      for(const task of state.tasks.filter(t => t.status === 'verified_complete')) {
        const receipts=await tx.executeRaw(`SELECT receipt_id,subject_hash,exit_code,timed_out,workspace FROM ultrabrain.verification_receipts
          WHERE source_id=$1 AND project_id=$2 AND task_id=$3 AND receipt_id=ANY($4::uuid[])`,[source,project,task.id,task.receipt_ids]);
        requireThat(receipts.length === new Set(task.receipt_ids).size && receipts.every(r =>
          r.subject_hash === taskHash(task) && r.exit_code === 0 && !r.timed_out &&
          (task.code_revision === undefined || matchesCodeRevision(r.workspace,task.code_revision))),
          'evidence_required','Receipt is missing, failed, stale, code-mismatched or belongs to another source/project/task');
      }
      const revision=p.expected_revision+1;
      await tx.executeRaw(`INSERT INTO ultrabrain.projects(source_id,project_id,revision,state) VALUES($1,$2,$3,$4::text::jsonb)
        ON CONFLICT(source_id,project_id) DO UPDATE SET revision=EXCLUDED.revision,state=EXCLUDED.state,updated_at=now()`,[source,project,revision,JSON.stringify(state)]);
      await tx.executeRaw(`INSERT INTO ultrabrain.project_revisions(source_id,project_id,revision,event_id,request_hash,actor_hash,state)
        VALUES($1,$2,$3,$4,$5,$6,$7::text::jsonb)`,[source,project,revision,event,digest,actor,JSON.stringify(state)]);
      return { project_id:project,revision,replayed:false };
    });
  }
  async function resume(p) {
    const result=await load(p);
    return { ...result, retrieval_query:resumeQuery(result.state,p.query ?? 'Continue the next unfinished task'),
      action_policy:'Recheck repository and tool state before executing. Memory is not execution authority.' };
  }
  async function history(p) {
    const project=identifier(p.project_id),limit=integer(p.limit,20,1,100),before=integer(p.before_revision,2147483647,1,2147483647);
    const rows=await engine.executeRaw(`SELECT revision,event_id,actor_hash,state,created_at FROM ultrabrain.project_revisions
      WHERE source_id=$1 AND project_id=$2 AND revision<$3 ORDER BY revision DESC LIMIT $4`,[source,project,before,limit]);
    return { project_id:project,revisions:rows,next_before_revision:rows.length === limit ? rows.at(-1).revision : null };
  }
  async function evidence(p) {
    const project=identifier(p.project_id);
    requireThat(typeof p.receipt_id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(p.receipt_id),
      'invalid_params','receipt_id must be a UUID');
    const [row]=await engine.executeRaw(`SELECT receipt_id,task_id,subject_hash,kind,exit_code,timed_out,
      command_sha256,stdout_sha256,stderr_sha256,started_at,finished_at,provenance,workspace
      FROM ultrabrain.verification_receipts WHERE source_id=$1 AND project_id=$2 AND receipt_id=$3::uuid`,[source,project,p.receipt_id]);
    requireThat(row,'not_found','Receipt not found in this source and project');
    return {source_id:source,project_id:project,...row,scope:'Operator-selected process and optional Git observations, not arbitrary business completion'};
  }
  async function forget(p) {
    const project=identifier(p.project_id); integer(p.expected_revision,undefined,1,2147483647);
    requireThat(p.expected_revision !== undefined && p.confirm === project,'invalid_params','Confirm the exact project id and current revision');
    if(ctx.dryRun) return { dry_run:true,project_id:project };
    return engine.transaction(async tx => {
      await lock(tx,source,project);
      const [row]=await tx.executeRaw('SELECT revision FROM ultrabrain.projects WHERE source_id=$1 AND project_id=$2',[source,project]);
      requireThat(row && row.revision === p.expected_revision,'revision_conflict','Reload before forgetting');
      await tx.executeRaw('INSERT INTO ultrabrain.project_tombstones(source_id,project_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[source,project]);
      await tx.executeRaw('DELETE FROM ultrabrain.projects WHERE source_id=$1 AND project_id=$2',[source,project]);
      return { project_id:project,forgotten:true,scope:'live project state, history and execution receipts; not page memories, WAL or backups' };
    });
  }
  return { load,save,resume,history,evidence,forget };
}
/** Host-only; deliberately not registered as an MCP operation. */
export async function recordExecution(engine, source, project, task, execution) {
  sourceId(source); identifier(project); identifier(task.id);
  const receipt_id=randomUUID();
  await engine.executeRaw(`INSERT INTO ultrabrain.verification_receipts(receipt_id,source_id,project_id,task_id,subject_hash,kind,
    exit_code,timed_out,command_sha256,stdout_sha256,stderr_sha256,started_at,finished_at,provenance,workspace)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'host-process-exit',$14::text::jsonb)`,
  [receipt_id,source,project,task.id,taskHash(task),execution.kind,execution.exit_code,execution.timed_out,
    execution.command_sha256,execution.stdout_sha256,execution.stderr_sha256,execution.started_at,execution.finished_at,
    execution.workspace ? JSON.stringify(execution.workspace) : null]);
  return { receipt_id,project_id:project,task_id:task.id,exit_code:execution.exit_code,
    workspace:execution.workspace ?? null,
    code_revision_matched:task.code_revision === undefined ? null : matchesCodeRevision(execution.workspace,task.code_revision),
    provenance:'host-process-exit',scope:'Only this operator-selected process and task specification, not full project completion' };
}
