import { contextTools } from './context.mjs';
import { commitSession } from './sessions.mjs';
import { UltraError, requireThat } from './core.mjs';
const string = (description, required = false) => ({ type: 'string', description, required });
const number = description => ({ type: 'number', description });
const URI = string('Canonical ultra://source/path. Root: ultra://default/', true);
/** Native operations own validation, authentication, source/slug fences and privacy filtering. */
export function registerPlugin(operations, native) {
  const names = new Set(operations.map(op => op.name));
  const base = new Map(operations.map(op => [op.name, op]));
  for (const name of ['get_page', 'put_page', 'delete_page', 'list_pages', 'search', 'extract_facts']) {
    requireThat(base.has(name), 'upstream_contract_changed', `Missing native operation ${name}`);
  }
  const makeStore = ctx => ({
    source: ctx.sourceId, dryRun: ctx.dryRun,
    actor: `${ctx.auth?.principal?.kind ?? ctx.transport ?? 'local'}:${ctx.auth?.principal?.id ?? ctx.auth?.clientId ?? 'owner'}:${ctx.subagentId ?? ''}`,
    async assertWrite(slug) {
      requireThat(!ctx.viaSubagent, 'scope_denied', 'Session receipts are not exposed to delegated subagents');
      requireThat(ctx.engine.kind === 'postgres', 'unsupported_engine', 'ultrabrain requires native PostgreSQL');
      requireThat(!ctx.auth?.sourceId || ctx.auth.sourceId === ctx.sourceId, 'scope_denied', 'Source authority mismatch');
      native.enforceClientSlugFence(ctx, slug, 'put_page');
      // put_page applies the remaining native subagent and grant guards before storing content.
    },
    sql: (query, params) => ctx.engine.executeRaw(query, params),
    async call(name, params) {
      const op = base.get(name);
      const error = native.validateParams(op, params);
      requireThat(!error, 'upstream_contract_changed', error ?? 'Native parameter mismatch');
      // Preserve ctx in full, including delegated grants, visibility, remote=true and dryRun.
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
    ['ultra_commit_session', 'session', 'Finalize one caller-owned session event synchronously. Records replay receipts; no model means needs_model, never fabricated extraction.',
      { session_id: string('Stable session identifier', true), event_id: string('Unique immutable event identifier', true),
        transcript: string('Consented transcript, maximum 64 KiB', true),
        visibility: { ...string('private (default) or world within your source grant'), enum: ['private','world'] },
        retry: { type: 'boolean', description: 'Explicitly retry a failed or needs_model receipt' } }, true],
  ];
  for (const [name, method, description, params, mutating] of definitions) {
    requireThat(!names.has(name), 'upstream_contract_changed', `Operation collision: ${name}`);
    operations.push({ name, description, params, scope: mutating ? 'write' : 'read', mutating: !!mutating,
      area: 'ultrabrain', async handler(ctx, p) {
        try {
          const store = makeStore(ctx);
          return method === 'session' ? await commitSession(store, p) : await contextTools(store)[method](p);
        } catch (error) {
          if (error instanceof UltraError) throw new native.OperationError(error.code, error.message);
          throw error;
        }
      } });
  }
  return definitions.map(d => d[0]);
}
