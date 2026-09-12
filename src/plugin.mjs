import {memoryPolicyTools,inspectPolicy,authorizeMemory,policyAllows,replacementPage} from './memory-policy.mjs';
import { semanticCache } from './semantic-cache.mjs';
import { configuredSummaryModel } from './adapters/summary-model.mjs';
import { sha256 } from './core.mjs';
import { contextTools } from './context.mjs';
import { processSessions, sessionStatus } from './deferred-sessions.mjs';
import { authorizeProjects } from './projects.mjs';
import { commitSession } from './sessions.mjs';
import { UltraError, requireThat } from './core.mjs';
const string = (description, required = false) => ({ type: 'string', description, required });
const number = description => ({ type: 'number', description });
const MEMORY_POLICY={type:'string',enum:['current','reviewed','history'],description:'current (default) excludes retired, expired and changed reviewed resources; reviewed requires active review; history explicitly includes old evidence'};
const URI = string('Canonical ultra://source/path. Root: ultra://default/', true);
export function registerPlugin(operations, native, configureSummaries=configuredSummaryModel) {
  const names = new Set(operations.map(op => op.name));
  const base = new Map(operations.map(op => [op.name, op]));
  for (const name of ['get_page', 'put_page', 'delete_page', 'list_pages', 'search', 'extract_facts']) {
    requireThat(base.has(name), 'upstream_contract_changed', `Missing native operation ${name}`);
  }
  const makeStore = ctx => ({
    local:ctx.remote===false,
    actorKey:sha256(JSON.stringify([ctx.remote===false?'host':'remote',ctx.auth?.principal??ctx.auth?.clientId??'owner'])),
    authorize:write=>authorizeMemory(ctx,write),
    source: ctx.sourceId, dryRun: ctx.dryRun,
    transaction: fn => ctx.engine.transaction(fn),
    async assertSummaryAccess(mutating) {
      authorizeProjects(ctx);
      requireThat(!ctx.auth?.grantProjectionDegraded,'permission_denied','Grant projection is degraded');
      if(ctx.auth) requireThat(ctx.auth.scopes?.includes('admin')||ctx.auth.scopes?.includes(mutating?'write':'read'),'permission_denied','Missing summary scope');
    },
    readerKey:sha256(JSON.stringify([ctx.remote===false?'local':'remote',ctx.auth?.principal??ctx.auth?.clientId??'owner'])),
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
      if(name==='extract_facts'&&native.extractWithEvidence)return native.extractWithEvidence(ctx,params,()=>op.handler(ctx,params));
      return op.handler(ctx, params);
    },
  });
  const definitions = [
    ['ultra_read', 'read', 'Read L0/L1 from a current source-grounded summary cache when available, otherwise explicit extractive fallback. L2 is canonical. Reading never generates summaries.',
      { uri: URI, memory_policy:MEMORY_POLICY, level: { ...string('L0, L1 or L2'), enum: ['L0','L1','L2'] }, max_bytes: number('128..262144; default 65536'), summary:{...string('Cache policy; never generates a summary'),enum:['prefer','require','off']} }],
    ['ultra_ls', 'list', 'Explore a virtual context directory through native ACL-filtered page listings. Bounded, live pagination; inspect coverage.',
      { uri: URI, memory_policy:MEMORY_POLICY, limit: number('1..100'), offset: number('Native source-page offset'), scan_limit: number('1..2000') }],
    ['ultra_retrieve', 'retrieve', 'Native hybrid candidates plus directory-assisted reranking, progressive loading, byte-budgeted evidence and retrieval trace.',
      { uri: URI, memory_policy:MEMORY_POLICY, query: string('Search query', true), level: { ...string('L0, L1 or L2'), enum: ['L0','L1','L2'] },
        scope_scan_limit:number('0..500; opt-in source enumeration, filter directory before content reads'),scan_read_limit:number('1..100 supplemental content reads, default 50'),types:{type:'array',items:{type:'string'}},summary:{...string('Summary cache preference'),enum:['prefer','require','off']},
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
    ['ultra_excerpt','excerpt','Read an exact source interval after current ACL and SHA-256 checks; reject stale citations. At most 16 KiB.',{uri:URI,memory_policy:MEMORY_POLICY,content_sha256:string('Canonical content SHA-256',true),start:{type:'number',required:true},end:{type:'number',required:true}}],
    ['ultra_summarize','summarize','Generate a cited L0/L1 summary of the entire bounded authorized page. Requires host model configuration and allow_model_call:true; may use paid model calls.',{uri:URI,allow_model_call:{type:'boolean'}},true],
    ['ultra_summary_status','summary_status','Check whether this reader has a current summary. No model call and no raw transcript response.',{uri:URI}],
    ['ultra_summary_forget','summary_forget','Remove only this reader derived cache; originals and backups are unchanged.',{uri:URI},true],
    ['ultra_identity','identity','Read authenticated actor/source and logical installation identity for durable client binding. No token or filesystem path.',{}],
    ['ultra_memory_inspect','policy_inspect','Inspect the current resource review/validity state without returning content.',{uri:URI}],
    ['ultra_memory_review','policy_review','Review or retract a resource with a canonical source hash and optimistic revision. Reviews are attributed metadata, not proof of truth.',
      {uri:URI,event_id:string('Immutable event id',true),expected_revision:{type:'number',required:true},content_sha256:string('Current canonical source hash',true),
       status:{type:'string',enum:['active','retracted'],required:true},assertion_kind:{type:'string',enum:['attributed','source_quote','inference'],required:true},
       reason:string('Reason for this review',true),provenance:string('Attribution, not an independently verified identity',true),
       valid_from:string('UTC ISO inclusive start'),valid_until:string('UTC ISO exclusive end'),reactivate:{type:'boolean'},
       evidence:{type:'object',description:'For source_quote only: uri, content_sha256, start and end; exact source interval is verified, not entailment.'}},true],
    ['ultra_memory_supersede','policy_supersede','Retire an old resource in favor of a reviewed currently valid same-source replacement. Both content hashes and policy revisions are checked atomically.',
      {uri:URI,event_id:string('Immutable event id',true),expected_revision:{type:'number',required:true},content_sha256:string('Old canonical source hash',true),
       replacement_uri:string('Exact same-source replacement URI',true),replacement_sha256:string('Replacement canonical source hash',true),replacement_revision:{type:'number',required:true},
       reason:string('Correction reason',true),provenance:string('Attribution',true)},true],
    ['ultra_memory_history','policy_history','Read resource review history; other actors free-text review details are withheld from remote readers.',
      {uri:URI,limit:{type:'number'},before_revision:{type:'number'}}],
  ];
  for (const [name, method, description, params, mutating] of definitions) {
    requireThat(!names.has(name), 'upstream_contract_changed', `Operation collision: ${name}`);
    operations.push({ name, description, params, scope: mutating ? 'write' : 'read', mutating: !!mutating,
      area: 'ultrabrain', async handler(ctx, p) {
        try {
          const store = makeStore(ctx);
          store.policy=page=>inspectPolicy(store,page);
          store.replacement=(page,prefix)=>replacementPage(store,page,prefix);
          store.assertCurrent=async page=>requireThat(policyAllows(await store.policy(page),'current'),'memory_not_current','Resource is retired, expired or needs review');
          if(method==='identity') {
            await store.authorize(false);
            const [row]=await store.sql('SELECT instance_id FROM ultrabrain.instance_identity WHERE singleton');
            requireThat(row,'pending_migrations','Instance identity is not initialized');
            return {format:1,instance_id:row.instance_id,actor_key:sha256(store.actor),source_id:store.source,identity_scope:'Current authenticated principal; logical instance identity is retained in backups'};
          }
          if(method.startsWith('policy_'))return await memoryPolicyTools(store)[method.slice(7)](p);
          if(['read','retrieve','summarize','summary_status','summary_forget'].includes(method)) {
            const configured=await configureSummaries();
            Object.assign(store,configured);
            if(ctx.viaSubagent||ctx.auth?.boundSlugPrefixes||ctx.auth?.fenceProjectionDegraded||ctx.auth?.grantProjectionDegraded)store.readerKey=null;
            const summaries=semanticCache(store);
            store.render=summaries.render;
            if(method==='summarize')return await summaries.refresh(p);
            if(method==='summary_status')return await summaries.status(p);
            if(method==='summary_forget')return await summaries.forget(p);
          }
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
