/** Real PostgreSQL service. Identity is server-derived; an agent_id is only an owned label. */
import {sha256,requireThat,sourceId,integer} from './core.mjs';
import {authorizeMemory} from './memory-policy.mjs';
import {objectFields,personalId,memoryId,normalizePersonalMemory,contextQuery} from './personal-memory.mjs';
import {agentIdentity,memoryCommit} from './agent-memory-protocol.mjs';
import {captureRequest,MAX_PERSONAL_JOBS} from './personal-consolidation-core.mjs';
import {buildPersonalContext,taskTerms} from './personal-context-engine.mjs';
export {normalizePersonalMemory as normalizeMemory} from './personal-memory.mjs';
export function personalPrincipal(ctx,write=false) {
  authorizeMemory(ctx,write);
  sourceId(ctx.sourceId);
  requireThat(!ctx.localFederatedSourceIds?.length,'permission_denied','Personal operations require a single source');
  // Native stdio intentionally uses remote:true; HTTP must always carry authentication.
  if(!ctx.auth&&(ctx.transport==='stdio'||ctx.remote===false&&(ctx.transport===undefined||ctx.transport==='cli')))return sha256(JSON.stringify(['host','owner']));
  requireThat(ctx.auth&&ctx.auth.sourceId===ctx.sourceId&&ctx.auth.hasSourceGrant!==false&&
    (!ctx.auth.allowedSources||(Array.isArray(ctx.auth.allowedSources)&&ctx.auth.allowedSources.length===1&&ctx.auth.allowedSources[0]===ctx.sourceId)),
    'permission_denied','An explicit complete single-source grant is required');
  const p=ctx.auth.principal;
  const identity=p?[p.kind,p.id]:['client',ctx.auth.clientId];
  requireThat(identity.every(x=>typeof x==='string'&&x.length>0&&x.length<=256),'permission_denied','Stable authenticated principal required');
  return sha256(JSON.stringify(['authenticated',...identity]));
}
/** Fixed alias used only in reviewed internal SQL, never from request data. */
export const PERSONAL_DERIVATION_CURRENT=`(m.derivation IS NULL OR EXISTS (
  SELECT 1 FROM ultrabrain.personal_memories origin WHERE origin.source_id=m.source_id AND origin.actor_key=m.actor_key
  AND origin.id::text=m.derivation->>'input_id' AND origin.revision::text=m.derivation->>'input_revision'
  AND origin.content_hash=m.derivation->>'input_hash' AND origin.status!='archived'))`;
export async function lockPersonal(tx,source,actor) {
  await tx.executeRaw("SET LOCAL lock_timeout='5s'");
  await tx.executeRaw("SET LOCAL statement_timeout='15s'");
  await tx.executeRaw('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['ultra-personal',source,actor])]);
}
const projection=`id::text,type,origin_kind,content,content_hash,confidence,importance,source AS provenance,agent_id,project_id,
  status,visibility,revision,created_at,updated_at,last_confirmed,(actor_key=$2) AS owned_by_caller,
  CASE WHEN actor_key=$2 THEN derivation ELSE NULL END AS derivation,${PERSONAL_DERIVATION_CURRENT} AS derivation_current`;
function rowView(row) {
  return {...row,confidence:row.confidence===null?null:Number(row.confidence),trust:'untrusted-memory-data'};
}
function boundedRows(rows,budget,extra={}) {
  const result={...extra,memories:[],dropped:0,trust:'untrusted-memory-data',budget_bytes:budget,
    budget_scope:'this JSON result; whole entries only; UTF-8 bytes, not model tokens'};
  for(const row of rows){result.memories.push(rowView(row));if(Buffer.byteLength(JSON.stringify(result))>budget){result.memories.pop();result.dropped++;}}
  while(Buffer.byteLength(JSON.stringify(result))>budget&&result.memories.length){result.memories.pop();result.dropped++;}
  return result;
}
export class PersonalMemoryStore {
  constructor(ctx) {
    this.ctx=ctx;this.source=sourceId(ctx.sourceId);this.actor=personalPrincipal(ctx);
    requireThat(typeof ctx.engine.executeRaw==='function'&&typeof ctx.engine.transaction==='function','unsupported_engine','Native PostgreSQL adapter required');
    this.engine=ctx.engine;
  }
  async #lock(tx) {return lockPersonal(tx,this.source,this.actor);}
  async #event(operation,event,input,action) {
    personalPrincipal(this.ctx,true);personalId(event,'event_id');
    const digest=sha256(JSON.stringify([operation,input]));
    if(this.ctx.dryRun)return {dry_run:true,operation,storage:'not_stored'};
    return this.engine.transaction(async tx=>{
      await this.#lock(tx);
      const [prior]=await tx.executeRaw('SELECT operation,request_hash,result FROM ultrabrain.personal_events WHERE source_id=$1 AND actor_key=$2 AND event_id=$3',[this.source,this.actor,event]);
      if(prior){
        requireThat(prior.operation===operation&&prior.request_hash===digest,'conflict','Event was used for a different request');
        return {...prior.result,replayed:true};
      }
      const result=await action(tx);
      await tx.executeRaw('INSERT INTO ultrabrain.personal_events(source_id,actor_key,event_id,operation,request_hash,result) VALUES($1,$2,$3,$4,$5,$6::text::jsonb)',
        [this.source,this.actor,event,operation,digest,JSON.stringify(result)]);
      return {...result,replayed:false};
    });
  }
  async register(input) {
    personalPrincipal(this.ctx,true);const p=agentIdentity(input);
    // Metadata is untrusted caller description; it never grants permissions.
    const digest=sha256(JSON.stringify([this.source,this.actor,p.agent_id,p.agent_type,p.capabilities,p.workspace]));
    if(this.ctx.dryRun)return {dry_run:true,storage:'not_stored'};
    return this.engine.transaction(async tx=>{
      await this.#lock(tx);
      const [old]=await tx.executeRaw('SELECT identity_hash,revision FROM ultrabrain.agent_registry WHERE source_id=$1 AND actor_key=$2 AND agent_id=$3',[this.source,this.actor,p.agent_id]);
      const same=old?.identity_hash===digest;
      requireThat(same||(old?.revision??0)===p.expected_revision,'revision_conflict','Agent metadata changed; reload its current revision');
      const revision=old?(same?old.revision:old.revision+1):1;
      await tx.executeRaw(`INSERT INTO ultrabrain.agent_registry(source_id,actor_key,agent_id,type,capabilities,workspace,identity_hash,revision)
        VALUES($1,$2,$3,$4,$5::text::jsonb,$6,$7,$8) ON CONFLICT(source_id,actor_key,agent_id) DO UPDATE SET
        type=EXCLUDED.type,capabilities=EXCLUDED.capabilities,workspace=EXCLUDED.workspace,identity_hash=EXCLUDED.identity_hash,
        revision=EXCLUDED.revision,last_seen=now()`,[this.source,this.actor,p.agent_id,p.agent_type,JSON.stringify(p.capabilities),p.workspace,digest,revision]);
      return {source_id:this.source,actor_key:this.actor,agent_id:p.agent_id,revision,replayed:same??false,
        identity_basis:'authenticated principal; agent label/capabilities are self-described, not verified software identity'};
    });
  }
  async agents(input={}) {
    objectFields(input,['limit','offset']);const limit=integer(input.limit,20,1,100),offset=integer(input.offset,0,0,1000000);
    const rows=await this.engine.executeRaw(`SELECT agent_id,type AS agent_type,capabilities,workspace,revision,last_seen FROM ultrabrain.agent_registry
      WHERE source_id=$1 AND actor_key=$2 ORDER BY agent_id LIMIT $3 OFFSET $4`,[this.source,this.actor,limit,offset]);
    return {source_id:this.source,agents:rows,next_offset:rows.length===limit?offset+rows.length:null};
  }
  async commit(input) {
    const p=memoryCommit(input);
    return this.#event('commit',p.event_id,p,async tx=>{
      const [agent]=await tx.executeRaw('SELECT 1 FROM ultrabrain.agent_registry WHERE source_id=$1 AND actor_key=$2 AND agent_id=$3',[this.source,this.actor,p.agent_id]);
      requireThat(agent,'agent_not_registered','Register this agent label under the current authenticated identity first');
      const entries=[];
      for(const m of p.memories){
        const [row]=await tx.executeRaw(`INSERT INTO ultrabrain.personal_memories
          (source_id,actor_key,type,content,content_hash,confidence,importance,source,agent_id,project_id,status,visibility)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'candidate',$11)
          RETURNING id::text,revision,status`,[this.source,this.actor,m.type,m.content,m.content_hash,m.confidence,m.importance,m.provenance,p.agent_id,m.project_id,m.visibility]);
        entries.push(row);
      }
      return {source_id:this.source,event_id:p.event_id,entries,storage:'stored',model_calls:0,
        state:'candidate',review_required:true,assurance:'Structured caller statements, not automatically confirmed facts'};
    });
  }
  async capture(input) {
    const p=captureRequest(input);
    return this.#event('capture',p.event_id,p,async tx=>{
      const [agent]=await tx.executeRaw('SELECT 1 FROM ultrabrain.agent_registry WHERE source_id=$1 AND actor_key=$2 AND agent_id=$3',[this.source,this.actor,p.agent_id]);
      requireThat(agent,'agent_not_registered','Register this agent label first');
      const [capacity]=await tx.executeRaw("SELECT count(*)::integer AS n FROM ultrabrain.personal_consolidations WHERE source_id=$1 AND actor_key=$2 AND state IN ('queued','processing','failed')",[this.source,this.actor]);
      requireThat(capacity.n<MAX_PERSONAL_JOBS,'queue_full','Process or explicitly cancel pending jobs before accepting more; no records were removed');
      const digest=sha256(p.transcript);
      const [entry]=await tx.executeRaw(`INSERT INTO ultrabrain.personal_memories
        (source_id,actor_key,type,content,content_hash,confidence,importance,source,agent_id,project_id,status,visibility)
        VALUES($1,$2,'experience',$3,$4,NULL,'normal','Explicit personal consolidation input',$5,$6,'candidate','private') RETURNING id::text,revision`,
        [this.source,this.actor,p.transcript,digest,p.agent_id,p.project_id]);
      const [job]=await tx.executeRaw(`INSERT INTO ultrabrain.personal_consolidations(source_id,actor_key,input_id,input_revision,input_hash)
        VALUES($1,$2,$3::uuid,$4,$5) RETURNING id::text,state`,[this.source,this.actor,entry.id,entry.revision,digest]);
      return {source_id:this.source,event_id:p.event_id,input_id:entry.id,input_revision:entry.revision,job_id:job.id,
        state:job.state,storage:'journaled',model_calls:0,review_required:true};
    });
  }
  async #owned(tx,id) {
    const [row]=await tx.executeRaw('SELECT revision,derivation,origin_kind FROM ultrabrain.personal_memories WHERE source_id=$1 AND actor_key=$2 AND id=$3::uuid FOR UPDATE',[this.source,this.actor,id]);
    requireThat(row,'not_found','Memory not found under this principal');
    // Imported document fragments are immutable snapshots: edits and lifecycle changes go
    // through the document interfaces so fragments never diverge from their original bytes.
    requireThat(row.origin_kind!=='document_fragment','document_bound','This entry is an immutable imported-document fragment; queue or archive it through the document interfaces instead');
    return row;
  }
  async review(input) {
    objectFields(input,['memory_id','expected_revision','event_id','status']);
    memoryId(input.memory_id);personalId(input.event_id,'event_id');
    requireThat(input.expected_revision!==undefined,'invalid_params','Current revision required');
    integer(input.expected_revision,undefined,1,2147483646);
    requireThat(['active','archived'].includes(input.status),'invalid_params','Review selects active or archived');
    const p={memory_id:input.memory_id,expected_revision:input.expected_revision,event_id:input.event_id,status:input.status};
    return this.#event('review',p.event_id,p,async tx=>{
      const old=await this.#owned(tx,p.memory_id);requireThat(old.revision===p.expected_revision,'revision_conflict','Memory changed; reload instead of overwriting');
      if(p.status==='active'&&old.derivation) {
        const [origin]=await tx.executeRaw(`SELECT revision,content_hash,status FROM ultrabrain.personal_memories
          WHERE source_id=$1 AND actor_key=$2 AND id=$3::uuid FOR SHARE`,[this.source,this.actor,old.derivation.input_id]);
        requireThat(origin&&origin.status!=='archived'&&origin.revision===old.derivation.input_revision&&origin.content_hash===old.derivation.input_hash,
          'stale_source','Consolidation input changed or was archived; reconcile this candidate before activation');
      }
      const [row]=await tx.executeRaw(`UPDATE ultrabrain.personal_memories SET status=$4,revision=revision+1,
        last_confirmed=CASE WHEN $4='active' THEN now() ELSE last_confirmed END,updated_at=now()
        WHERE source_id=$1 AND actor_key=$2 AND id=$3::uuid RETURNING id::text,revision,status`,[this.source,this.actor,p.memory_id,p.status]);
      return {...row,assurance:'Explicit caller review, not independent truth verification'};
    });
  }
  async update(input) {
    objectFields(input,['memory_id','expected_revision','event_id','memory']);
    memoryId(input.memory_id);personalId(input.event_id,'event_id');
    requireThat(input.expected_revision!==undefined,'invalid_params','Current revision required');integer(input.expected_revision,undefined,1,2147483646);
    const m=normalizePersonalMemory(input.memory),p={memory_id:input.memory_id,expected_revision:input.expected_revision,event_id:input.event_id,memory:m};
    return this.#event('update',p.event_id,p,async tx=>{
      const old=await this.#owned(tx,p.memory_id);requireThat(old.revision===p.expected_revision,'revision_conflict','Memory changed; reload instead of overwriting');
      const [row]=await tx.executeRaw(`UPDATE ultrabrain.personal_memories SET type=$4,content=$5,content_hash=$6,confidence=$7,
        importance=$8,source=$9,project_id=$10,visibility=$11,status='candidate',derivation=NULL,last_confirmed=NULL,revision=revision+1,updated_at=now()
        WHERE source_id=$1 AND actor_key=$2 AND id=$3::uuid RETURNING id::text,revision,status`,
        [this.source,this.actor,p.memory_id,m.type,m.content,m.content_hash,m.confidence,m.importance,m.provenance,m.project_id,m.visibility]);
      return {...row,review_required:true};
    });
  }
  async #rows(p) {
    // All optional search filters are data, never identifiers or SQL fragments.
    // Search keeps time-ordered pagination; ranking belongs to the context path only.
    return this.engine.executeRaw(`SELECT ${projection} FROM ultrabrain.personal_memories m
      WHERE source_id=$1 AND (actor_key=$2 OR (visibility='source' AND status='active')) AND status=$3 AND type=ANY($4::text[])
      AND (status!='active' OR actor_key=$2 OR ${PERSONAL_DERIVATION_CURRENT})
      AND ($5::text IS NULL OR project_id=$5)
      AND ($6::text IS NULL OR agent_id=$6) AND ($7='' OR strpos(lower(content),lower($7))>0)
      ORDER BY updated_at DESC,id LIMIT $8 OFFSET $9`,
      [this.source,this.actor,p.status,p.types,p.project_id,p.agent_id,p.query,p.limit,p.offset]);
  }
  /** Context/profile candidates: rank first, then bound. Same authorization filters as
   * search's non-context branch plus context semantics (active, derivation-current, project
   * scope). Task terms arrive as a bound text[] parameter; translate() folds ASCII A–Z only,
   * matching the JavaScript rule. Read-only transaction with a local statement timeout:
   * failures propagate as errors, never as empty success, and SET LOCAL cannot outlive the
   * transaction or alter connection-level settings.
   */
  async #contextRows(p) {
    const terms=taskTerms(p.task);
    return this.engine.transaction(async tx=>{
      await tx.executeRaw('SET LOCAL transaction_read_only=on');
      await tx.executeRaw("SET LOCAL statement_timeout='5s'");
      return tx.executeRaw(`SELECT ${projection},
        (CASE m.importance WHEN 'high' THEN 3 WHEN 'normal' THEN 2 WHEN 'low' THEN 1 ELSE 0 END
          +(SELECT count(*) FROM unnest($7::text[]) AS term(word)
            WHERE strpos(translate(m.content,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),term.word)>0)) AS rank_score
        FROM ultrabrain.personal_memories m
        WHERE m.source_id=$1 AND (m.actor_key=$2 OR (m.visibility='source' AND m.status='active'))
          AND m.status='active' AND m.type=ANY($3::text[])
          AND ${PERSONAL_DERIVATION_CURRENT}
          AND (m.project_id IS NULL OR m.project_id=$4)
          AND ($5::text IS NULL OR m.agent_id=$5) AND ($6='' OR strpos(lower(m.content),lower($6))>0)
        ORDER BY rank_score DESC,date_trunc('milliseconds',m.updated_at) DESC,m.id
        LIMIT 100`,
        [this.source,this.actor,p.types,p.project_id,p.agent_id,p.query,terms]);
    });
  }
  async search(input={}) {
    const p=contextQuery(input),rows=await this.#rows(p);
    return boundedRows(rows,p.budget_bytes,{source_id:this.source,status:p.status,
      next_offset:rows.length===p.limit?p.offset+rows.length:null,coverage:'bounded live page, not a snapshot'});
  }
  async context(input={}) {
    const p=contextQuery(input);
    requireThat(p.status==='active','invalid_params','Personal context contains only explicitly active entries');
    const rows=await this.#contextRows(p);
    // Re-rank in JavaScript with the same canonical rule; drop the SQL-only score column.
    const result=buildPersonalContext(rows.map(({rank_score,...row})=>rowView(row)),
      Object.fromEntries(Object.entries(p).filter(([,v])=>v!==null)));
    result.source_id=this.source;
    result.recall='bounded top-100 ranked candidates, not semantic search; important entries outside the window or filters are absent';
    while(Buffer.byteLength(JSON.stringify(result))>p.budget_bytes&&result.memories.length){result.memories.pop();result.dropped++;}
    return result;
  }
  async profile(input={}) {
    objectFields(input,['limit','budget_bytes']);
    return this.context({...input,types:['identity','preference','environment','goal']});
  }
}
