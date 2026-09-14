/** Explicitly imported personal text documents: original bytes, provenance, bounded queueing.
 * A filename is a caller label, never a path, identity or command. JSON/CSV content is
 * stored as untrusted text only; nothing inside an imported file is ever executed.
 * Import and model processing stay separate: queueing creates candidates through the
 * existing PersonalConsolidator jobs, and archiving retains the original bytes.
 */
import {requireThat,sha256,sourceId,integer,UltraError} from './core.mjs';
import {objectFields,personalId,memoryId} from './personal-memory.mjs';
import {personalPrincipal,lockPersonal} from './personal-memory-store.mjs';
import {MAX_PERSONAL_JOBS} from './personal-consolidation-core.mjs';
export const PERSONAL_DOCUMENT_MAX_BYTES=131072; // First batch hard cap: whole-file reject, never truncate.
export const PERSONAL_DOCUMENT_FORMATS=Object.freeze(['txt','md','json','csv','log']);
export const PERSONAL_FRAGMENT_MAX_BYTES=32768; // Same bound as capture transcripts feeding the consolidator.
export const PERSONAL_DOCUMENT_FRAGMENT_LIMIT=16;
const BASE64=/^[A-Za-z0-9+/]+={0,2}$/;
const strictUtf8=bytes=>{try{
  // ignoreBOM keeps a leading U+FEFF in the decoded text so re-encoding reproduces the exact bytes.
  return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
}catch{throw new UltraError('invalid_utf8','Imported files must be strictly valid UTF-8; re-encoding is not accepted as the original');}};
export function documentLabel(value) {
  requireThat(typeof value==='string'&&value.isWellFormed(),'invalid_label','File label must be well-formed text');
  const bytes=Buffer.byteLength(value);
  requireThat(bytes>=1&&bytes<=256,'invalid_label','File label must be 1..256 UTF-8 bytes');
  requireThat(value!=='.'&&value!=='..','invalid_label','File label cannot be a directory reference');
  // A label is not a path: separators, drive syntax and control characters are rejected whole.
  requireThat(!/[\\/\x00-\x1f\x7f]/.test(value)&&!/^[A-Za-z]:/.test(value)&&!/[<>:"|?*]/.test(value),
    'invalid_label','File label must be a plain name without path separators, drives or control characters');
  return value;
}
export function documentFormat(label) {
  const match=/\.([A-Za-z0-9]{1,16})$/.exec(label);
  const format=match?match[1].toLowerCase():null;
  requireThat(format&&PERSONAL_DOCUMENT_FORMATS.includes(format),'unsupported_format',
    'First-batch personal documents are UTF-8 .txt .md .json .csv .log files only');
  return format;
}
export function decodeDocumentContent(encoded) {
  requireThat(typeof encoded==='string'&&encoded.length>0&&encoded.length<=200000&&BASE64.test(encoded)&&encoded.length%4===0,
    'invalid_params','File content must be standard unpadded-every-4 base64 of at most 128 KiB');
  const bytes=Buffer.from(encoded,'base64');
  requireThat(bytes.toString('base64')===encoded,'invalid_params','File content is not canonical base64');
  requireThat(bytes.length>=1&&bytes.length<=PERSONAL_DOCUMENT_MAX_BYTES,'file_too_large',
    `Personal documents are limited to ${PERSONAL_DOCUMENT_MAX_BYTES} bytes; larger files are rejected whole, never truncated`);
  return bytes;
}
export function documentContent(bytes) {
  requireThat(Buffer.isBuffer(bytes)&&bytes.length>=1&&bytes.length<=PERSONAL_DOCUMENT_MAX_BYTES,'file_too_large',
    `Personal documents are limited to ${PERSONAL_DOCUMENT_MAX_BYTES} bytes; larger files are rejected whole, never truncated`);
  const decoded=strictUtf8(bytes); // Strict decode: BOM, CRLF/LF, U+FFFD and negations survive only as original bytes.
  return {text:decoded,has_bom:bytes.length>=3&&bytes[0]===0xEF&&bytes[1]===0xBB&&bytes[2]===0xBF,
    content_sha256:sha256(bytes)};
}
export function importDocumentRequest(input) {
  objectFields(input,['event_id','agent_id','label','content_base64','content_sha256','consent','project_id']);
  requireThat(input.consent===true,'capture_disabled','Explicit consent is required to import this file into personal memory');
  personalId(input.agent_id,'agent_id');personalId(input.event_id,'event_id');
  const label=documentLabel(input.label),format=documentFormat(label);
  requireThat(typeof input.content_sha256==='string'&&/^[a-f0-9]{64}$/.test(input.content_sha256),'invalid_params','Content fingerprint must be a lowercase SHA-256 hex digest');
  const bytes=decodeDocumentContent(input.content_base64),content=documentContent(bytes);
  requireThat(input.content_sha256===content.content_sha256,'fingerprint_mismatch',
    'Submitted fingerprint does not match the submitted bytes; the file changed during import');
  return {event_id:input.event_id,agent_id:input.agent_id,label,format,content_base64:input.content_base64,
    content_sha256:content.content_sha256,byte_size:bytes.length,has_bom:content.has_bom,text:content.text,
    project_id:input.project_id==null?null:personalId(input.project_id,'project_id')};
}
export function fragmentRanges(input,byteSize) {
  requireThat(Array.isArray(input)&&input.length>=1&&input.length<=PERSONAL_DOCUMENT_FRAGMENT_LIMIT,
    'invalid_params',`Queue 1..${PERSONAL_DOCUMENT_FRAGMENT_LIMIT} explicit fragments per request`);
  const ranges=[];
  for(const f of input) {
    objectFields(f,['byte_start','byte_length']);
    const start=integer(f.byte_start,undefined,0,PERSONAL_DOCUMENT_MAX_BYTES-1);
    const length=integer(f.byte_length,undefined,1,PERSONAL_FRAGMENT_MAX_BYTES);
    requireThat(start+length<=byteSize,'invalid_params','Fragment range exceeds the imported file');
    ranges.push({byte_start:start,byte_end:start+length});
  }
  const sorted=[...ranges].sort((a,b)=>a.byte_start-b.byte_start);
  for(let i=1;i<sorted.length;i++)requireThat(sorted[i-1].byte_end<=sorted[i].byte_start,'invalid_params','Fragments must not overlap');
  return sorted;
}
export function documentFragment(bytes,range) {
  const slice=bytes.subarray(range.byte_start,range.byte_end);
  const text=strictUtf8(slice); // Rejects ranges that split a multi-byte UTF-8 sequence.
  requireThat(sha256(slice)===sha256(Buffer.from(text,'utf8')),'fragment_boundary','Fragment boundaries must align to UTF-8 code points');
  return {text,fragment_sha256:sha256(slice)};
}
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
        FROM ultrabrain.personal_documents WHERE source_id=$1 AND actor_key=$2 AND status='active' AND label=$3 AND content_sha256=$4 LIMIT 1`,
        [this.source,this.actor,p.label,p.content_sha256]);
      if(existing)return {...publicDocument(existing),already_imported:true,storage:'stored',model_calls:0};
      const [row]=await tx.executeRaw(`INSERT INTO ultrabrain.personal_documents
        (source_id,actor_key,label,format,content,content_sha256,byte_size,has_bom,agent_id,project_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id::text AS document_id,label,format,byte_size,content_sha256,has_bom,status,revision,agent_id,project_id,created_at`,
        [this.source,this.actor,p.label,p.format,bytes,p.content_sha256,p.byte_size,p.has_bom,p.agent_id,p.project_id]);
      return {...publicDocument(row),already_imported:false,storage:'stored',model_calls:0,
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
    const [row]=await tx.executeRaw(`SELECT id::text AS document_id,label,format,content,content_sha256,byte_size,has_bom,status,revision
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
    return {...publicDocument(row),fragments:null,content_base64:row.content.toString('base64'),
      round_trip:'base64 decodes to the exact submitted bytes; verify content_sha256 locally after download'};
  }
  async documentQueue(input) {
    objectFields(input,['event_id','document_id','fragments']);
    personalId(input.event_id,'event_id');
    const shaped=fragmentRanges(input.fragments,PERSONAL_DOCUMENT_MAX_BYTES); // Shape check before opening the event.
    const p={event_id:input.event_id,document_id:input.document_id,fragments:shaped};
    return this.#event('document_queue',p.event_id,p,async tx=>{
      const document=await this.#ownedDocument(tx,p.document_id,{forUpdate:true});
      requireThat(document.status==='active','invalid_params','Only active documents can be queued; archived originals are retained but no longer processed');
      const ranges=fragmentRanges(input.fragments,document.byte_size);
      const [capacity]=await tx.executeRaw("SELECT count(*)::integer AS n FROM ultrabrain.personal_consolidations WHERE source_id=$1 AND actor_key=$2 AND state IN ('queued','processing','failed')",[this.source,this.actor]);
      requireThat(capacity.n+ranges.length<=MAX_PERSONAL_JOBS,'queue_full','Process or explicitly cancel pending jobs before accepting more; no records were removed');
      const fragments=[];
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
        WHERE m.source_id=$1 AND m.actor_key=$2 AND m.status='active' AND m.derivation->>'input_id'=ANY($3::text[])`,
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
