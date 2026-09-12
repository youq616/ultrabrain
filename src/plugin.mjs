import { contextTools } from './context.mjs';
import { processSessions, sessionStatus } from './deferred-sessions.mjs';
import { authorizeProjects } from './projects.mjs';
import { commitSession } from './sessions.mjs';
import { UltraError, requireThat } from './core.mjs';
const string = (description, required = false) => ({ type: 'string', description, required });
const number = description => ({ type: 'number', description });
const URI = string('Canonical ultra://source/path. Root: ultra://default/', true);
export function registerPlugin(operations, native) {
  const names = new Set(operations.map(op => op.name));
  const base = new Map(operations.map(op => [op.name, op]));
  for (const name of ['get_page', 'put_page', 'delete_page', 'list_pages', 'search', 'extract_facts']) {
    requireThat(base.has(name), 'upstream_contract_changed', `Missing native operation ${name}`);
  }
  const makeStore = ctx => ({
    source: ctx.sourceId, dryRun: ctx.dryRun,
    transaction: fn => ctx.engine.transaction(fn),
    async assertSessionAccess(mutating) {
      authorizeProjects(ctx);
      requireThat(!ctx.auth?.grantProjectionDegraded, 'permission_denied', 'Grant projection is degraded');
      if (ctx.auth) requireThat(Array.isArray(ctx.auth.scopes) && (ctx.auth.scopes.includes('admin') || ctx.auth.scopes.includes(mutating ? 'write' : 'read')), 'permission_denied', 'Missing session scope');
    },
    actor: `${ctx.auth?.principal?.kind ?? ctx.transport ?? 'local'}:${ctx.auth?.principal?.id ?? ctx.auth?.clientId ?? 'owner'}:${ctx.subagentId ?? ''}`,
    async assertWrite(slug) {
      requireThat(!ctx.viaSubagent, 'scope_denied', 'Session receipts are not exposed to delegated subagents');
      requireThat(!ctx.auth?.boundSlugPrefixes && !ctx.auth?.fenceProjectionDegraded,
        'scope_denied', 'Session extraction is unavailable to prefix-bound clients');
      requireThat(ctx.engine.kind === 'postgres', 'unsupported_engine', 'ultrabrain requires native PostgreSQL');
      requireThat(!ctx.auth?.sourceId || ctx.auth.sourceId === ctx.sourceId, 'scope_denied', 'Source authority mismatch');
      native.enforceClientSlugFence(ctx, slug, 'put_page');
    },
    sql: (query, params) => ctx.engine.executeRaw(query, params),
    async call(name, params) {
      const op = base.get(name);
      const error = native.validateParams(op, params);
      requireThat(!error, 'upstream_contract_changed', error ?? 'Native parameter mismatch');
      return op.handler(ctx, params);
    },
  });
  const definitions = [
    ['ultra_read', 'read', 'Read L0 abstract, L1 overview or L2 canonical context. L0/L1 are explicitly extractive, not AI summaries.',
      { uri: URI, level: { ...string('L0, L1 or L2'), enum: ['L0','L1','L2'] }, max_bytes: number('128..262144; default 65536') }],
    ['ultra_ls', 'list', 'Explore a virtual context directory through native ACL-filtered page listings. Bounded, live pagination; inspect coverage.',
      { uri: URI, limit: number('1..100'), offset: number('Native source-page offset'), scan_limit: number('1..2000') }],
    ['ultra_retrieve', 'retrieve', 'Native hybrid candidates plus directory-assisted reranking, progressive loading, byte-budgeted evidence and retrieval trace.',
      { uri: URI, query: string('Search query', true), level: { ...string('L0, L1 or L2'), enum: ['L0','L1','L2'] },
        limit: number('1..30'), candidate_limit: number('1..100'), budget_bytes: number('512..131072 UTF-8 evidence bytes') }],
    ['ultra_write', 'write', 'Replace a canonical resource. Read L2 first; preserves native versions and write-through. Not a partial or compare-and-swap edit.',
      { uri: URI, content: string('Complete markdown with frontmatter', true) }, true],
    ['ultra_delete', 'remove', 'Native soft delete, not immediate physical erasure. Restoration follows the native recovery window.', { uri: URI }, true],
    ['ultra_commit_session', 'session', 'Finalize one caller-owned session event. Synchronous by default; opt in to deferred durable raw capture without a model call.',
      { session_id: string('Stable session identifier', true), event_id: string('Unique immutable event identifier', true),
        transcript: string('Consented transcript, maximum 64 KiB', true),
        visibility: { ...string('private (default) or world within your source grant'), enum: ['private','world'] },
        retry: { type: 'boolean', description: 'Explicitly retry a failed or needs_model receipt' },
        defer_extraction: {type:'boolean',description:'Durable raw capture now; process later using the same authenticated actor. No model call during capture.'} }, true],
    ['ultra_process_sessions','process', "Process this actor's deferred sessions with current permissions. At most five attempts; missing model remains needs_model.",
      {expected_source:string('Must equal authenticated source; cannot select a different grant',true),limit:number('1..8, default 1'),retry:{type:'boolean',description:'Explicitly retry failed or missing-model events'}},true],
    ['ultra_session_status','status','Read deferred delivery/extraction state for this actor. Never returns transcript text.',
      {session_id:string('Session id',true),event_id:string('Event id',true)}],
  ];
  for (const [name, method, description, params, mutating] of definitions) {
    requireThat(!names.has(name), 'upstream_contract_changed', `Operation collision: ${name}`);
    operations.push({ name, description, params, scope: mutating ? 'write' : 'read', mutating: !!mutating,
      area: 'ultrabrain', async handler(ctx, p) {
        try {
          const store = makeStore(ctx);
          if (method === 'session') return await commitSession(store,p);
          if (method === 'process') return await processSessions(store,p);
          if (method === 'status') return await sessionStatus(store,p);
          return await contextTools(store)[method](p);
        } catch (error) {
          if (error instanceof UltraError) throw new native.OperationError(error.code, error.message);
          throw error;
        }
      } });
  }
  return definitions.map(d => d[0]);
}
