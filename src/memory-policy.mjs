/** Resource-level validity and correction metadata over the ONE native page store.
 * Native facts/prose are not rewritten, and direct native tools remain historical APIs.
 * Annotations describe review state, not proof that a proposition is true.
 */
import {parseUri,uri,sha256,text,integer,requireThat} from './core.mjs';
import {authorizeProjects,identifier} from './projects.mjs';
import {mode,policyAllows} from './memory-selection.mjs';
export {mode,policyAllows} from './memory-selection.mjs';

const states=['active','retracted','superseded','review_required'];
const assertionKinds=['attributed','source_quote','inference'];
export function utcInstant(value,name) {
  if(value===undefined||value===null)return null;
  requireThat(typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value),
    'invalid_params',`${name} must be an explicit UTC ISO instant`);
  const canonical=value.includes('.')?value.replace(/\.(\d{1,3})Z$/,(_,s)=>'.'+s.padEnd(3,'0')+'Z'):value.replace('Z','.000Z');
  requireThat(Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===canonical,'invalid_params',`Invalid ${name}`);
  return canonical;
}
export function normalizeReview(p) {
  requireThat(['active','retracted'].includes(p.status),'invalid_params','Review status must be active or retracted');
  requireThat(assertionKinds.includes(p.assertion_kind),'invalid_params','Specify attributed, source_quote or inference');
  text(p.reason,'reason',2048);text(p.provenance,'provenance',2048);
  const valid_from=utcInstant(p.valid_from,'valid_from'),valid_until=utcInstant(p.valid_until,'valid_until');
  requireThat(!valid_until||!valid_from||valid_until>valid_from,'invalid_params','valid_until must be after valid_from');
  requireThat(p.reactivate===undefined||typeof p.reactivate==='boolean','invalid_params','reactivate must be boolean');
  return {status:p.status,assertion_kind:p.assertion_kind,reason:p.reason,provenance:p.provenance,valid_from,valid_until,
    reactivate:p.reactivate===true,evidence:p.evidence??null};
}
export function effectivePolicy(row,contentHash,now) {
  requireThat(Number.isFinite(new Date(now).getTime()),'upstream_contract_changed','Database time unavailable');
  if(!row)return {revision:0,status:'unreviewed',assertion_kind:'unclassified',eligible:true,
    assurance:'No explicit review recorded; not verified truth'};
  requireThat(states.includes(row.status),'memory_policy_corrupt','Unknown stored memory state');
  let status=row.status;
  if(status==='active') {
    if(row.content_sha256!==contentHash||row.references_current===false)status='review_required';
    else if(row.valid_from&&new Date(row.valid_from).getTime()>new Date(now).getTime())status='not_yet_valid';
    else if(row.valid_until&&new Date(row.valid_until).getTime()<=new Date(now).getTime())status='expired';
  }
  return {revision:row.revision,status,recorded_status:row.status,assertion_kind:row.assertion_kind,
    valid_from:row.valid_from??null,valid_until:row.valid_until??null,
    eligible:status==='active',has_replacement:!!row.replacement_slug,
    assurance:row.assertion_kind==='source_quote'?'Exact quotation located at review time; not truth or entailment proof':
      row.assertion_kind==='inference'?'Explicitly labeled inference, not a confirmed fact':'Attributed assertion, not independently verified truth'};
}
export function authorizeMemory(ctx,write=false) {
  authorizeProjects(ctx);
  requireThat(!ctx.auth?.grantProjectionDegraded,'permission_denied','Grant projection degraded');
  if(ctx.auth)requireThat(ctx.auth.scopes?.includes('admin')||ctx.auth.scopes?.includes(write?'write':'read'),
    'permission_denied','Missing memory governance scope');
}
function expected(p) {
  requireThat(p.expected_revision!==undefined,'invalid_params','expected_revision is required; use 0 for an unreviewed page');
  integer(p.expected_revision,undefined,0,2147483646);
  requireThat(typeof p.content_sha256==='string'&&/^[a-f0-9]{64}$/.test(p.content_sha256),'invalid_params','Canonical SHA-256 required');
}
const pageHash=page=>sha256(page.content);
async function getExact(store,value,hash) {
  const target=parseUri(value);requireThat(target.slug&&target.source===store.source,'scope_denied','Same authorized source required');
  const page=await store.call('get_page',{source_id:target.source,slug:target.slug,include_content:true});
  requireThat(page&&page.source_id===target.source&&page.slug===target.slug&&typeof page.content==='string',
    'invalid_uri','Use an exact canonical page URI, not an alias');
  if(hash)requireThat(pageHash(page)===hash,'stale_source','Page changed; reload the original before reviewing');
  return page;
}
/** Internal metadata query; never returns referenced source text or its URI.
 * Clock-only expiry needs no UPDATE to the source, so evaluate dependency validity at read time.
 */
async function policyRow(sql,source,slug) {
  const [row]=await sql(`WITH RECURSIVE evidence(slug) AS (
      SELECT evidence_slug FROM ultrabrain.review_dependencies WHERE source_id=$1 AND policy_slug=$2
      UNION SELECT d.evidence_slug FROM ultrabrain.review_dependencies d
        JOIN evidence e ON d.policy_slug=e.slug WHERE d.source_id=$1
    ), clock AS (SELECT statement_timestamp() AS now)
    SELECT clock.now AS db_now,p.*,NOT EXISTS (
      SELECT 1 FROM evidence e
      LEFT JOIN public.pages original ON original.source_id=$1 AND original.slug=e.slug
      LEFT JOIN ultrabrain.memory_policies ep ON ep.source_id=$1 AND ep.slug=e.slug
      WHERE original.id IS NULL OR original.deleted_at IS NOT NULL
        OR (ep.revision IS NOT NULL AND (ep.status!='active'
          OR ep.valid_from>clock.now OR ep.valid_until<=clock.now))
    ) AS references_current
    FROM clock LEFT JOIN ultrabrain.memory_policies p ON p.source_id=$1 AND p.slug=$2`,[source,slug]);
  return row;
}
/** Called only after a page has passed native current read authorization. */
export async function inspectPolicy(store,page) {
  const row=await policyRow((q,p)=>store.sql(q,p),page.source_id,page.slug);
  const result=effectivePolicy(row?.revision?row:null,typeof page.content==='string'?pageHash(page):row?.content_sha256,row.db_now);
  return result;
}
export function memoryPolicyTools(store) {
  async function inspect(p) {
    await store.authorize(false);
    const page=await getExact(store,p.uri);
    return {uri:uri(page.source_id,page.slug),content_sha256:pageHash(page),memory:await inspectPolicy(store,page),
      scope:'Native page review metadata; raw fact/prose history and backups are unchanged'};
  }
  async function evidence(p) {
    if(p.assertion_kind!=='source_quote') {
      requireThat(!p.evidence,'invalid_params','Evidence interval is only accepted for source_quote');return null;
    }
    const e=p.evidence;
    requireThat(e&&typeof e==='object'&&!Array.isArray(e)&&Object.keys(e).every(k=>['uri','content_sha256','start','end'].includes(k))&&/^[a-f0-9]{64}$/.test(e.content_sha256??''),
      'invalid_params','source_quote requires URI, source hash and exact interval');
    const page=await getExact(store,e.uri,e.content_sha256);
    integer(e.start,undefined,0,16777216);integer(e.end,undefined,1,16777216);
    requireThat(e.start!==undefined&&e.end!==undefined&&e.end>e.start&&e.end<=page.content.length&&
      ![e.start,e.end].some(n=>n>0&&n<page.content.length&&/[\uDC00-\uDFFF]/.test(page.content[n])),
      'invalid_params','Invalid source quote interval');
    const quote=page.content.slice(e.start,e.end);text(quote,'quote',4096);
    return {uri:uri(page.source_id,page.slug),content_sha256:e.content_sha256,start:e.start,end:e.end,
      quote_sha256:sha256(quote),offset_unit:'UTF-16 code units',page};
  }
  async function write(p,supersede=false) {
    await store.authorize(true);expected(p);identifier(p.event_id,'event_id');
    const annotation=supersede?{status:'superseded',reason:text(p.reason,'reason',2048),provenance:text(p.provenance,'provenance',2048)}:normalizeReview(p);
    const hash=sha256(JSON.stringify({uri:parseUri(p.uri).uri,expected_revision:p.expected_revision,content_sha256:p.content_sha256,
      annotation,replacement_uri:p.replacement_uri??null,replacement_sha256:p.replacement_sha256??null,
      replacement_revision:p.replacement_revision??null}));
    const page=await getExact(store,p.uri,p.content_sha256);
    let replacement=null;
    if(supersede) {
      requireThat(p.replacement_revision!==undefined,'invalid_params','replacement_revision is required');
      integer(p.replacement_revision,undefined,0,2147483646);
      requireThat(/^[a-f0-9]{64}$/.test(p.replacement_sha256??''),'invalid_params','Replacement SHA-256 required');
      replacement=await getExact(store,p.replacement_uri,p.replacement_sha256);
      requireThat(replacement.slug!==page.slug,'invalid_params','Cannot supersede a resource with itself');
    }
    const proof=supersede?null:await evidence(p);
    let evidencePolicy=null;
    if(proof&&proof.page.slug!==page.slug) {
      evidencePolicy=await inspectPolicy(store,proof.page);
      requireThat(evidencePolicy.eligible,'evidence_not_current','Referenced evidence is retired, expired or needs review');
    }
    if(store.dryRun)return {dry_run:true,uri:p.uri,expected_revision:p.expected_revision};
    return store.transaction(async tx=>{
      await tx.executeRaw("SET LOCAL lock_timeout='5s'");
      // One source-scoped governance lock serializes corrections and prevents cycles.
      // Page locks in sorted order also fence concurrent native content updates.
      await tx.executeRaw('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['ultra-memory-policy',store.source])]);
      const pages=[...new Map([page,replacement,proof?.page].filter(Boolean).map(x=>[x.slug,x])).values()].sort((a,b)=>a.slug.localeCompare(b.slug));
      for(const original of pages) {
        const [locked]=await tx.executeRaw('SELECT id,content_hash,deleted_at FROM public.pages WHERE source_id=$1 AND slug=$2 FOR UPDATE',[store.source,original.slug]);
        requireThat(locked&&!locked.deleted_at&&String(locked.id)===String(original.id)&&locked.content_hash===original.content_hash,
          'stale_source','Native page changed before review committed');
      }
      const [replay]=await tx.executeRaw('SELECT revision,request_hash,actor_key FROM ultrabrain.memory_policy_history WHERE source_id=$1 AND slug=$2 AND event_id=$3',
        [store.source,page.slug,p.event_id]);
      if(replay) {
        requireThat(replay.request_hash===hash&&replay.actor_key===store.actorKey,'conflict','Event id reused with different input or actor');
        return {uri:p.uri,revision:replay.revision,replayed:true};
      }
      const [prior]=await tx.executeRaw('SELECT * FROM ultrabrain.memory_policies WHERE source_id=$1 AND slug=$2',[store.source,page.slug]);
      requireThat((prior?.revision??0)===p.expected_revision,'revision_conflict','Policy changed; reload and reconcile');
      if(!supersede&&p.status==='active'&&['retracted','superseded'].includes(prior?.status))
        requireThat(p.reactivate===true,'reactivation_required','Explicit reactivate:true required to restore retired memory');
      if(supersede) {
        const targetPolicy=await policyRow((q,args)=>tx.executeRaw(q,args),store.source,replacement.slug);
        requireThat((targetPolicy?.revision??0)===p.replacement_revision,'revision_conflict','Replacement policy changed');
        requireThat(effectivePolicy(targetPolicy?.revision?targetPolicy:null,p.replacement_sha256,targetPolicy.db_now).status==='active','replacement_not_reviewed',
          'Replacement must be explicitly reviewed and currently valid');
      }
      if(evidencePolicy) {
        const checked=await policyRow((q,args)=>tx.executeRaw(q,args),store.source,proof.page.slug);
        const currentEvidence=effectivePolicy(checked?.revision?checked:null,proof.content_sha256,checked.db_now);
        requireThat(currentEvidence.revision===evidencePolicy.revision&&currentEvidence.eligible,
          'evidence_not_current','Referenced evidence policy changed during review');
      }
      const revision=(prior?.revision??0)+1;
      const state={status:annotation.status,assertion_kind:supersede?(prior?.assertion_kind??'attributed'):annotation.assertion_kind,
        valid_from:supersede?null:annotation.valid_from,valid_until:supersede?null:annotation.valid_until,
        content_sha256:p.content_sha256,replacement_slug:replacement?.slug??null,replacement_sha256:p.replacement_sha256??null};
      await tx.executeRaw(`INSERT INTO ultrabrain.memory_policies(source_id,slug,revision,status,assertion_kind,content_sha256,valid_from,valid_until,replacement_slug,replacement_sha256)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(source_id,slug) DO UPDATE SET
        revision=EXCLUDED.revision,status=EXCLUDED.status,assertion_kind=EXCLUDED.assertion_kind,content_sha256=EXCLUDED.content_sha256,
        valid_from=EXCLUDED.valid_from,valid_until=EXCLUDED.valid_until,replacement_slug=EXCLUDED.replacement_slug,replacement_sha256=EXCLUDED.replacement_sha256,updated_at=now()`,
        [store.source,page.slug,revision,state.status,state.assertion_kind,state.content_sha256,state.valid_from,state.valid_until,state.replacement_slug,state.replacement_sha256]);
      // Keep only the current dependency edge; historical quotations remain in history.
      await tx.executeRaw('DELETE FROM ultrabrain.review_dependencies WHERE source_id=$1 AND policy_slug=$2',[store.source,page.slug]);
      if(proof&&state.status==='active') await tx.executeRaw(`INSERT INTO ultrabrain.review_dependencies
        (source_id,policy_slug,evidence_slug,evidence_sha256) VALUES($1,$2,$3,$4)`,
        [store.source,page.slug,proof.page.slug,proof.content_sha256]);
      const {page:ignored,...reference}=proof??{};
      const snapshot={...state,reason:annotation.reason,provenance:annotation.provenance,...(proof?{evidence:reference}:{}),
        basis:'Caller review; exact source location is not independent truth verification'};
      await tx.executeRaw(`INSERT INTO ultrabrain.memory_policy_history(source_id,slug,revision,event_id,request_hash,actor_key,snapshot)
        VALUES($1,$2,$3,$4,$5,$6,$7::text::jsonb)`,[store.source,page.slug,revision,p.event_id,hash,store.actorKey,JSON.stringify(snapshot)]);
      return {uri:p.uri,revision,replayed:false,status:state.status,scope:'Resource selection policy, not physical deletion or native fact withdrawal'};
    });
  }
  async function history(p) {
    await store.authorize(false);const page=await getExact(store,p.uri);
    const limit=integer(p.limit,20,1,100),before=integer(p.before_revision,2147483647,1,2147483647);
    const rows=await store.sql(`SELECT revision,event_id,actor_key,snapshot,created_at FROM ultrabrain.memory_policy_history
      WHERE source_id=$1 AND slug=$2 AND revision<$3 ORDER BY revision DESC LIMIT $4`,[store.source,page.slug,before,limit]);
    return {uri:p.uri,revisions:rows.map(r=>({revision:r.revision,created_at:r.created_at,status:r.snapshot.status,
      ...(store.local||r.actor_key===store.actorKey?{event_id:r.event_id,review:r.snapshot}:{detail:'Other actor review details withheld'})})),
      next_before_revision:rows.length===limit?rows.at(-1).revision:null};
  }
  return {inspect,review:p=>write(p,false),supersede:p=>write(p,true),history};
}

/** Follow only explicit, hash-bound replacement edges, never arbitrary links in prose.
 * Every hop is re-read through native ACLs and constrained to the requested directory.
 */
export async function replacementPage(store,page,prefix='',maxHops=4) {
  const seen=new Set([page.slug]);let current=page;
  for(let hop=1;hop<=maxHops;hop++) {
    const [edge]=await store.sql('SELECT status,replacement_slug,replacement_sha256 FROM ultrabrain.memory_policies WHERE source_id=$1 AND slug=$2',[page.source_id,current.slug]);
    if(edge?.status!=='superseded'||!edge.replacement_slug||seen.has(edge.replacement_slug))return null;
    if(prefix&&edge.replacement_slug!==prefix&&!edge.replacement_slug.startsWith(prefix+'/'))return null;
    seen.add(edge.replacement_slug);
    try {
      current=await store.call('get_page',{source_id:page.source_id,slug:edge.replacement_slug,include_content:true});
      if(!current||current.source_id!==page.source_id||current.slug!==edge.replacement_slug||pageHash(current)!==edge.replacement_sha256)return null;
      const policy=await inspectPolicy(store,current);
      if(policy.status==='active')return {page:current,hops:hop,from_uri:uri(page.source_id,page.slug)};
      if(policy.status!=='superseded')return null;
    }catch(e){if(!['not_found','page_not_found','permission_denied','scope_denied'].includes(e.code))throw e;return null;}
  }
  return null;
}
