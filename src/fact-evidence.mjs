/** Govern native facts without copying their text, vectors or authority into another store.
 * A binding records a source-version association, not entailment or independent truth.
 */
import {requireThat,sha256,text,integer,parseUri,uri,within} from './core.mjs';
import {authorizeMemory,inspectPolicy,mode,policyAllows} from './memory-policy.mjs';
import {identifier} from './projects.mjs';

export function factId(value) {
  requireThat(typeof value==='string'&&/^[1-9][0-9]{0,18}$/.test(value)&&BigInt(value)<=9223372036854775807n,
    'invalid_params','fact_id must be a canonical positive PostgreSQL bigint string');
  return value;
}
const instant=value=>value==null?null:new Date(value).toISOString();
export function factHash(row) {
  return sha256(JSON.stringify([factId(row.fact_id),row.source_id,row.fact,row.kind,row.visibility,
    row.entity_slug??null,row.source,row.source_session??null,row.context??null,
    instant(row.valid_from),instant(row.valid_until),instant(row.expired_at),row.superseded_by==null?null:String(row.superseded_by),instant(row.created_at)]));
}
export function activeFact(row,now) {
  requireThat(Number.isFinite(new Date(now).getTime()),'upstream_contract_changed','Fact clock unavailable');
  return row.expired_at==null&&row.superseded_by==null&&
    (row.valid_until==null||new Date(row.valid_until).getTime()>new Date(now).getTime());
}
export function authorizeFacts(ctx,write=false) {
  authorizeMemory(ctx,write);
  // Native recall omits source_id from projected facts. Do not infer the origin of
  // a federated result. Single-source access only, without rewriting the request grant.
  const allowed=ctx.auth?.allowedSources;
  requireThat(allowed===undefined||(Array.isArray(allowed)&&allowed.every(s=>s===ctx.sourceId)),
    'permission_denied','Governed facts require one explicit source, not a federated grant');
}
const columns=`f.id::text AS fact_id,f.source_id,f.fact,f.kind,f.visibility,f.entity_slug,f.source,
 f.source_session,f.context,f.valid_from,f.valid_until,f.expired_at,f.superseded_by::text,f.created_at`;
async function readFact(store,id,tx=null,lock=false) {
  const sql=tx?(q,p)=>tx.executeRaw(q,p):(q,p)=>store.sql(q,p);
  const [row]=await sql(`SELECT ${columns},statement_timestamp() AS db_now FROM public.facts f
    WHERE f.source_id=$1 AND f.id=$2::bigint AND ($3::boolean OR f.visibility='world')
      AND NOT(f.source=ANY($4::text[])) ${lock?'FOR UPDATE OF f':''}`,
    [store.source,factId(id),store.local===true,store.auditSources]);
  requireThat(row,'not_found','Fact is not readable in this source');
  return row;
}
async function linkRow(store,id,tx=null) {
  const sql=tx?(q,p)=>tx.executeRaw(q,p):(q,p)=>store.sql(q,p);
  return (await sql('SELECT * FROM ultrabrain.fact_evidence WHERE source_id=$1 AND fact_id=$2::bigint',[store.source,id]))[0]??null;
}
const denied=new Set(['not_found','page_not_found','permission_denied','scope_denied']);
async function evidenceState(store,fact,link,prefix='') {
  if(!link)return {status:'unlinked',current:false,reviewed:false};
  if(!within(link.evidence_slug,prefix))return {status:'outside_scope',current:false,reviewed:false};
  let page;
  try {page=await store.call('get_page',{source_id:store.source,slug:link.evidence_slug,include_content:true});}
  catch(e){if(denied.has(e.code))return {status:'source_unavailable',current:false,reviewed:false};throw e;}
  if(!page||page.source_id!==store.source||page.slug!==link.evidence_slug||typeof page.content!=='string')
    return {status:'source_unavailable',current:false,reviewed:false};
  const policy=await inspectPolicy(store,page);
  const hash=sha256(page.content);
  const matches=link.state==='bound'&&link.fact_sha256===factHash(fact)&&
    String(page.id)===String(link.page_id)&&hash===link.evidence_sha256;
  return {status:!matches?'review_required':!policy.eligible?'source_not_current':'linked',
    current:matches&&policy.eligible,reviewed:matches&&policy.status==='active',
    revision:link.revision,source_uri:uri(store.source,page.slug),source_sha256:hash,
    bound_source_sha256:link.evidence_sha256,source_policy:policy,method:link.method};
}
function projection(fact,state) {
  return {fact_id:fact.fact_id,source_id:fact.source_id,fact:fact.fact,kind:fact.kind,
    entity_slug:fact.entity_slug??null,visibility:fact.visibility,fact_sha256:factHash(fact),
    valid_from:instant(fact.valid_from),valid_until:instant(fact.valid_until),expired_at:instant(fact.expired_at),
    superseded_by:fact.superseded_by,created_at:instant(fact.created_at),evidence:state,
    trust:'untrusted-memory-data',assurance:'Native assertion associated with a source version; not verified truth or entailment'};
}
export function factEvidenceTools(store) {
  async function inspect(p) {
    await store.authorize(false);
    const fact=await readFact(store,p.fact_id),link=await linkRow(store,p.fact_id);
    const evidence=await evidenceState(store,fact,link);
    requireThat(evidence.status!=='source_unavailable','not_found','Fact evidence is not readable');
    return {...projection(fact,evidence),binding_revision:link?.revision??0,native_active:activeFact(fact,fact.db_now)};
  }
  async function bind(p,{automatic=false}={}) {
    await store.authorize(true);factId(p.fact_id);identifier(p.event_id,'event_id');
    requireThat(p.expected_revision!==undefined,'invalid_params','expected_revision required; 0 creates a binding');
    integer(p.expected_revision,undefined,0,2147483646);
    for(const key of ['fact_sha256','content_sha256'])requireThat(/^[a-f0-9]{64}$/.test(p[key]??''),'invalid_params',`Full ${key} required`);
    const target=parseUri(p.evidence_uri);
    requireThat(target.source===store.source&&target.slug,'scope_denied','Evidence must be in the authenticated source');
    const before=await readFact(store,p.fact_id);
    requireThat(factHash(before)===p.fact_sha256&&activeFact(before,before.db_now),'stale_fact','Reload the active native fact before binding');
    const prior=await linkRow(store,p.fact_id);
    if(prior)requireThat((await evidenceState(store,before,prior)).status!=='source_unavailable','not_found','Existing evidence is not readable');
    const page=await store.call('get_page',{slug:target.slug,source_id:target.source,include_content:true});
    requireThat(page&&page.source_id===target.source&&page.slug===target.slug&&typeof page.content==='string',
      'invalid_uri','Exact canonical evidence URI required, not an alias');
    requireThat(sha256(page.content)===p.content_sha256,'stale_source','Source changed; reload before binding');
    requireThat((await inspectPolicy(store,page)).eligible,'memory_not_current','Evidence source is not current');
    const requestHash=sha256(JSON.stringify([p.fact_id,p.fact_sha256,target.uri,p.content_sha256,p.expected_revision,automatic]));
    if(store.dryRun)return {dry_run:true,fact_id:p.fact_id,binding_revision:p.expected_revision};
    return store.transaction(async tx=>{
      await tx.executeRaw("SET LOCAL lock_timeout='5s'");
      // Native writers typically touch a page before facts. Use the same order.
      const [locked]=await tx.executeRaw('SELECT id,content_hash,deleted_at FROM public.pages WHERE source_id=$1 AND slug=$2 FOR UPDATE',[store.source,target.slug]);
      requireThat(locked&&!locked.deleted_at&&String(locked.id)===String(page.id)&&locked.content_hash===page.content_hash,
        'stale_source','Source changed before binding committed');
      const fact=await readFact(store,p.fact_id,tx,true);
      requireThat(factHash(fact)===p.fact_sha256&&activeFact(fact,fact.db_now),'stale_fact','Native fact changed before binding committed');
      const policy=await inspectPolicy({...store,sql:(q,args)=>tx.executeRaw(q,args)},page);
      requireThat(policy.eligible,'memory_not_current','Source policy changed before binding committed');
      const [replay]=await tx.executeRaw('SELECT revision,request_hash,actor_key FROM ultrabrain.fact_evidence_events WHERE source_id=$1 AND fact_id=$2::bigint AND event_id=$3',[store.source,p.fact_id,p.event_id]);
      if(replay){requireThat(replay.request_hash===requestHash&&replay.actor_key===store.actorKey,'conflict','Event reused for different binding or actor');return {fact_id:p.fact_id,revision:replay.revision,replayed:true};}
      const old=await linkRow(store,p.fact_id,tx);
      requireThat((old?.revision??0)===p.expected_revision,'revision_conflict','Binding changed; reload and reconcile');
      const revision=p.expected_revision+1,method=automatic?'extraction':'explicit';
      await tx.executeRaw(`INSERT INTO ultrabrain.fact_evidence(source_id,fact_id,revision,state,fact_sha256,evidence_slug,evidence_sha256,page_id,method)
        VALUES($1,$2::bigint,$3,'bound',$4,$5,$6,$7,$8)
        ON CONFLICT(source_id,fact_id) DO UPDATE SET revision=EXCLUDED.revision,state='bound',fact_sha256=EXCLUDED.fact_sha256,
          evidence_slug=EXCLUDED.evidence_slug,evidence_sha256=EXCLUDED.evidence_sha256,page_id=EXCLUDED.page_id,method=EXCLUDED.method,updated_at=now()`,
        [store.source,p.fact_id,revision,p.fact_sha256,target.slug,p.content_sha256,page.id,method]);
      await tx.executeRaw(`INSERT INTO ultrabrain.fact_evidence_events(source_id,fact_id,event_id,revision,request_hash,actor_key,evidence_slug,evidence_sha256,method)
        VALUES($1,$2::bigint,$3,$4,$5,$6,$7,$8,$9)`,[store.source,p.fact_id,p.event_id,revision,requestHash,store.actorKey,target.slug,p.content_sha256,method]);
      return {fact_id:p.fact_id,revision,replayed:false,method,assurance:'Source association only; original native fact was not rewritten'};
    });
  }
  async function recall(p) {
    await store.authorize(false);
    const target=parseUri(p.uri);requireThat(target.source===store.source,'scope_denied','Recall source must match current authorization');
    const selection=mode(p.memory_policy??'current'),limit=integer(p.limit,20,1,100),cap=integer(p.candidate_limit,100,1,100);
    const budget=integer(p.budget_bytes,16000,512,131072),filters={};
    for(const key of ['entity','session_id','grep','since'])if(p[key]!==undefined)filters[key]=text(p[key],key,2048);
    const native=await store.call('recall',{...filters,limit:cap,include_expired:selection==='history'});
    requireThat(native&&Array.isArray(native.facts)&&native.facts.length<=cap,'upstream_contract_changed','Invalid native fact recall result');
    const facts=[];let excluded=0,budgetDropped=0;const seen=new Set();
    for(const candidate of native.facts) {
      // Current native projection uses JS numeric IDs: fail closed beyond safe range.
      requireThat(Number.isSafeInteger(candidate.id)&&candidate.id>0&&candidate.fact_id===String(candidate.id),
        'upstream_contract_changed','Native fact ID projection is not exact');
      const id=factId(candidate.fact_id);if(seen.has(id))continue;seen.add(id);
      let fact;try{fact=await readFact(store,id);}catch(e){if(e.code==='not_found'){excluded++;continue;}throw e;}
      // Do not emit a different fact after a concurrent mutation of a retrieved row.
      let candidateSignature;
      try{candidateSignature=factHash({...candidate,source_id:store.source});}
      catch{requireThat(false,'upstream_contract_changed','Native fact projection lost required lifecycle fields');}
      if(factHash(fact)!==candidateSignature){excluded++;continue;}
      if(filters.session_id&&fact.source_session!==filters.session_id){excluded++;continue;}
      if(selection!=='history'&&!activeFact(fact,fact.db_now)){excluded++;continue;}
      const state=await evidenceState(store,fact,await linkRow(store,id),target.slug);
      // Unknown origin is never silently current. History can show unlinked native
      // facts only at the source root, where no unsupported directory claim is made.
      if(['outside_scope','source_unavailable'].includes(state.status)||
        (state.status==='unlinked'&&(selection!=='history'||target.slug))||
        (selection==='current'&&!state.current)||(selection==='reviewed'&&!state.reviewed)){excluded++;continue;}
      const item={...projection(fact,state),native_active:activeFact(fact,fact.db_now),memory_policy:selection};
      if(Buffer.byteLength(JSON.stringify([...facts,item]))>budget){budgetDropped++;continue;}
      facts.push(item);if(facts.length===limit)break;
    }
    return {source_id:store.source,facts,evidence_bytes:Buffer.byteLength(JSON.stringify(facts)),evidence_budget_bytes:budget,
      budget_unit:'UTF-8 serialized facts array; response envelope excluded; no partial-claim truncation',
      memory_policy:selection,candidates:native.facts.length,candidate_limit:cap,excluded_in_checked_window:excluded,budget_dropped:budgetDropped,
      exhaustive:false,model_calls:0,scope:'Bounded native candidates rechecked for source, visibility, native lifecycle and linked resource policy. Raw native recall is unchanged.'};
  }
  return {inspect,bind,recall};
}

/** Associate only returned IDs that still name this exact extraction event/source.
 * Dedup IDs with different provenance are never silently reattributed. No old binding
 * is overwritten. Unavailable/invalid origins leave the native result explicit but unlinked.
 */
export async function extractWithEvidence(store,params,invoke) {
  let page=null;
  try {
    await store.authorize(true);
    if(typeof params.source_slug==='string') {
      page=await store.call('get_page',{source_id:store.source,slug:params.source_slug,include_content:true});
      if(page?.source_id!==store.source||page.slug!==params.source_slug||typeof page.content!=='string'||
        typeof params.turn_text!=='string'||!params.turn_text.trim()||!page.content.includes(params.turn_text))page=null;
    }
  }catch{page=null;}
  const result=await invoke();
  if(!result||result.skipped||store.dryRun)return result;
  const ids=Array.isArray(result.fact_ids)?[...new Set(result.fact_ids)]:[];
  if(!page)return {...result,evidence_binding:{linked:0,skipped:ids.length,status:'source_unavailable'}};
  let linked=0,skipped=0;
  for(const id of ids.slice(0,100)) {
    try {
      requireThat(Number.isSafeInteger(id)&&id>0,'upstream_contract_changed','Invalid extraction fact ID');
      const fact=await readFact(store,String(id));
      if(fact.context!==page.slug||fact.source_session!==(params.session_id??null)||await linkRow(store,String(id))){skipped++;continue;}
      await factEvidenceTools(store).bind({fact_id:String(id),fact_sha256:factHash(fact),evidence_uri:uri(store.source,page.slug),
        content_sha256:sha256(page.content),expected_revision:0,event_id:'extract-'+sha256(JSON.stringify([id,params.session_id,page.slug])).slice(0,48)}, {automatic:true});
      linked++;
    }catch{skipped++;}
  }
  return {...result,evidence_binding:{linked,skipped:skipped+Math.max(0,ids.length-100),status:(skipped||ids.length>100)?'partial':'processed',
    assurance:'No new truth claim; missing or changed origins require explicit binding review'}};
}
