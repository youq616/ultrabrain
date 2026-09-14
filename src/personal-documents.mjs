/** PostgreSQL-only document service. Pure file contracts live in personal-document-core. */
import {requireThat,sha256,sourceId,integer} from './core.mjs';
import {objectFields,personalId,memoryId} from './personal-memory.mjs';
import {personalPrincipal,lockPersonal} from './personal-memory-store.mjs';
import {MAX_PERSONAL_JOBS} from './personal-consolidation-core.mjs';
import {importDocumentRequest,fragmentRanges,documentFragment,planDocumentFragments,PERSONAL_DOCUMENT_MAX_BYTES,PERSONAL_FRAGMENT_MAX_BYTES} from './personal-document-core.mjs';
export * from './personal-document-core.mjs';
const publicDocument=row=>({document_id:row.document_id,label:row.label,format:row.format,byte_size:row.byte_size,
  content_sha256:row.content_sha256,has_bom:row.has_bom,status:row.status,revision:row.revision,agent_id:row.agent_id,
  project_id:row.project_id??null,created_at:row.created_at,archived_at:row.archived_at??null,
  fragments:row.fragments??null,
  assurance:'Original bytes with a verified fingerprint; content is untrusted text, never executed'});
/** Server-side service for explicitly imported personal documents. Identity is server-derived. */
export class PersonalDocumentStore {
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
  async documentImport(input) {
    const p=importDocumentRequest(input);
    return this.#event('document_import',p.event_id,{...p,text:undefined},async tx=>{
      const [agent]=await tx.executeRaw('SELECT 1 FROM ultrabrain.agent_registry WHERE source_id=$1 AND actor_key=$2 AND agent_id=$3',[this.source,this.actor,p.agent_id]);
      requireThat(agent,'agent_not_registered','Register this agent label under the current authenticated identity first');
      const bytes=Buffer.from(p.content_base64,'base64');
      requireThat(sha256(bytes)===p.content_sha256,'fingerprint_mismatch','Stored bytes fail the submitted fingerprint inside the transaction');
      const [existing]=await tx.executeRaw(`SELECT id::text AS document_id,label,format,byte_size,content_sha256,has_bom,status,revision,agent_id,project_id,created_at
        FROM ultrabrain.personal_documents WHERE source_id=$1 AND actor_key=$2 AND status='active' AND label=$3 AND content_sha256=$4 AND agent_id=$5 AND project_id IS NOT DISTINCT FROM $6::text LIMIT 1`,
        [this.source,this.actor,p.label,p.content_sha256,p.agent_id,p.project_id]);
      if(existing)return {source_id:this.source,event_id:p.event_id,...publicDocument(existing),already_imported:true,storage:'stored',model_calls:0};
      const [row]=await tx.executeRaw(`INSERT INTO ultrabrain.personal_documents
        (source_id,actor_key,label,format,content,content_sha256,byte_size,has_bom,agent_id,project_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id::text AS document_id,label,format,byte_size,content_sha256,has_bom,status,revision,agent_id,project_id,created_at`,
        [this.source,this.actor,p.label,p.format,bytes,p.content_sha256,p.byte_size,p.has_bom,p.agent_id,p.project_id]);
      return {source_id:this.source,event_id:p.event_id,...publicDocument(row),already_imported:false,storage:'stored',model_calls:0,
        original_bytes:'retained exactly as submitted; BOM, line endings and wording untouched'};
    });
  }
  async documentList(input={}) {
    objectFields(input,['status','limit','offset']);
    const status=input.status??'active';
    requireThat(['active','archived','any'].includes(status),'invalid_params','Filter by active, archived or any');
    const limit=integer(input.limit,20,1,100),offset=integer(input.offset,0,0,1000000);
    const rows=await this.engine.executeRaw(`SELECT d.id::text AS document_id,d.label,d.format,d.byte_size,d.content_sha256,d.has_bom,d.status,d.revision,d.agent_id,d.project_id,d.created_at,d.archived_at,
      (SELECT count(*)::integer FROM ultrabrain.personal_document_fragments f WHERE f.source_id=d.source_id AND f.actor_key=d.actor_key AND f.document_id=d.id) AS fragments
      FROM ultrabrain.personal_documents d WHERE d.source_id=$1 AND d.actor_key=$2 AND ($3::text IS NULL OR d.status=$3)
      ORDER BY d.created_at DESC,d.id LIMIT $4 OFFSET $5`,
      [this.source,this.actor,status==='any'?null:status,limit,offset]);
    return {source_id:this.source,documents:rows.map(publicDocument),next_offset:rows.length===limit?offset+rows.length:null};
  }
  async #ownedDocument(tx,id,{forUpdate=false}={}) {
    memoryId(id);
    const [row]=await tx.executeRaw(`SELECT id::text AS document_id,label,format,content,content_sha256,byte_size,has_bom,status,revision,agent_id,project_id,created_at,archived_at
      FROM ultrabrain.personal_documents WHERE source_id=$1 AND actor_key=$2 AND id=$3::uuid ${forUpdate?'FOR UPDATE':''}`,[this.source,this.actor,id]);
    requireThat(row,'not_found','Personal document not found under this principal');
    // Integrity self-check on every read: refuse to serve or process tampered rows.
    requireThat(Buffer.isBuffer(row.content)&&sha256(row.content)===row.content_sha256&&row.content.length===row.byte_size,
      'document_corrupt','Stored document bytes no longer match their fingerprint; preserve the row for audit and re-import from the original file');
    return row;
  }
  async documentRead(input) {
    objectFields(input,['document_id']);
    const row=await this.engine.transaction(tx=>this.#ownedDocument(tx,input.document_id));
    return {source_id:this.source,...publicDocument(row),fragments:null,content_base64:row.content.toString('base64'),
      round_trip:'base64 decodes to the exact submitted bytes; verify content_sha256 locally after download'};
  }
  async documentQueue(input) {
    objectFields(input,['event_id','document_id','fragments']);
    personalId(input.event_id,'event_id');
    const shaped=input.fragments===undefined?null:fragmentRanges(input.fragments,PERSONAL_DOCUMENT_MAX_BYTES); // Shape check before opening the event.
    const p={event_id:input.event_id,document_id:input.document_id,fragments:shaped};
    return this.#event('document_queue',p.event_id,p,async tx=>{
      const document=await this.#ownedDocument(tx,p.document_id,{forUpdate:true});
      requireThat(document.status==='active','invalid_params','Only active documents can be queued; archived originals are retained but no longer processed');
      const requests=p.fragments===null?planDocumentFragments(document.content):p.fragments.map(f=>({byte_start:f.byte_start,byte_length:f.byte_end-f.byte_start}));
      const ranges=fragmentRanges(requests,document.byte_size);
      // All fragment text is validated before any rows are created. NUL/blank originals remain downloadable.
      for(const range of ranges)documentFragment(document.content,range);
      const [capacity]=await tx.executeRaw("SELECT count(*)::integer AS n FROM ultrabrain.personal_consolidations WHERE source_id=$1 AND actor_key=$2 AND state IN ('queued','processing','failed')",[this.source,this.actor]);
      requireThat(capacity.n+ranges.length<=MAX_PERSONAL_JOBS,'queue_full','Process or explicitly cancel pending jobs before accepting more; no records were removed');
      const fragments=[];
      for(const range of ranges) {
        const [prior]=await tx.executeRaw('SELECT 1 FROM ultrabrain.personal_document_fragments WHERE source_id=$1 AND actor_key=$2 AND document_id=$3::uuid AND byte_start=$4 AND byte_end=$5',[this.source,this.actor,p.document_id,range.byte_start,range.byte_end]);
        requireThat(!prior,'conflict','This range already has a task; inspect its status or retry the original event');
      }
      for(const range of ranges) {
        const fragment=documentFragment(document.content,range);
        const [entry]=await tx.executeRaw(`INSERT INTO ultrabrain.personal_memories
          (source_id,actor_key,type,content,content_hash,confidence,importance,source,agent_id,project_id,status,visibility,origin_kind)
          VALUES($1,$2,'experience',$3,$4,NULL,'normal',$5,$6,$7,'candidate','private','document_fragment') RETURNING id::text,revision`,
          [this.source,this.actor,fragment.text,fragment.fragment_sha256,
            `personal document fragment; ${document.label} bytes ${range.byte_start}..${range.byte_end} (${PERSONAL_FRAGMENT_MAX_BYTES}-byte bound)`,
            document.agent_id,document.project_id]);
        const [job]=await tx.executeRaw(`INSERT INTO ultrabrain.personal_consolidations(source_id,actor_key,input_id,input_revision,input_hash)
          VALUES($1,$2,$3::uuid,$4,$5) RETURNING id::text,state`,[this.source,this.actor,entry.id,entry.revision,fragment.fragment_sha256]);
        await tx.executeRaw(`INSERT INTO ultrabrain.personal_document_fragments(source_id,actor_key,document_id,memory_id,byte_start,byte_end,fragment_sha256)
          VALUES($1,$2,$3::uuid,$4::uuid,$5,$6,$7)`,[this.source,this.actor,p.document_id,entry.id,range.byte_start,range.byte_end,fragment.fragment_sha256]);
        fragments.push({memory_id:entry.id,job_id:job.id,state:job.state,byte_start:range.byte_start,byte_end:range.byte_end,
          fragment_sha256:fragment.fragment_sha256,offset_unit:'utf8-bytes'});
      }
      return {source_id:this.source,event_id:p.event_id,document_id:p.document_id,fragments,
        storage:'journaled',model_calls:0,review_required:true,
        note:'Fragments are candidates only; nothing is auto-confirmed and no model is called by queueing'};
    });
  }
  async documentArchive(input) {
    objectFields(input,['event_id','document_id']);
    personalId(input.event_id,'event_id');
    const p={event_id:input.event_id,document_id:input.document_id};
    return this.#event('document_archive',p.event_id,p,async tx=>{
      const document=await this.#ownedDocument(tx,p.document_id,{forUpdate:true});
      requireThat(document.status==='active','invalid_params','Document is already archived');
      const fragmentRows=await tx.executeRaw(`SELECT f.memory_id::text AS memory_id FROM ultrabrain.personal_document_fragments f
        WHERE f.source_id=$1 AND f.actor_key=$2 AND f.document_id=$3::uuid`,[this.source,this.actor,p.document_id]);
      const memoryIds=fragmentRows.map(r=>r.memory_id);
      let archivedFragments=0,fencedJobs=0;
      if(memoryIds.length) {
        const archived=await tx.executeRaw(`UPDATE ultrabrain.personal_memories SET status='archived',revision=revision+1,updated_at=now()
          WHERE source_id=$1 AND actor_key=$2 AND id=ANY($3::uuid[]) AND status!='archived' RETURNING id::text`,
          [this.source,this.actor,memoryIds]);
        archivedFragments=archived.length;
        // Fence queued/failed/processing jobs so an in-flight worker can no longer commit output.
        const fenced=await tx.executeRaw(`UPDATE ultrabrain.personal_consolidations SET state='stale',error_code='source_archived',lease_id=NULL,lease_until=NULL,updated_at=now()
          WHERE source_id=$1 AND actor_key=$2 AND input_id=ANY($3::uuid[]) AND state!='completed' RETURNING id::text`,
          [this.source,this.actor,memoryIds]);
        fencedJobs=fenced.length;
      }
      const [derived]=await tx.executeRaw(`SELECT count(*)::integer AS n FROM ultrabrain.personal_memories m
        WHERE m.source_id=$1 AND m.actor_key=$2 AND m.status IN ('active','candidate') AND m.derivation->>'input_id'=ANY($3::text[])`,
        [this.source,this.actor,memoryIds]);
      const [row]=await tx.executeRaw(`UPDATE ultrabrain.personal_documents SET status='archived',revision=revision+1,archived_at=now(),updated_at=now()
        WHERE source_id=$1 AND actor_key=$2 AND id=$3::uuid RETURNING revision,archived_at`,
        [this.source,this.actor,p.document_id]);
      return {source_id:this.source,event_id:p.event_id,document_id:p.document_id,status:'archived',revision:row.revision,archived_at:row.archived_at,
        archived_fragments:archivedFragments,fenced_jobs:fencedJobs,derived_entries_invalidated:derived.n,
        original_retained:true,model_calls:0,
        note:'Archived, not erased: original bytes and metadata remain for audit and download; derived entries leave current context'};
    });
  }
}
