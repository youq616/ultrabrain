/** Personal MCP tools are registered in compatibility mode; governed enterprise allowlist stays frozen. */
import {PersonalConsolidator} from './personal-consolidation.mjs';
import {configuredPersonalModel} from './adapters/personal-model.mjs';
import {PersonalMemoryStore} from './personal-memory-store.mjs';
import {PersonalDocumentStore,PERSONAL_DOCUMENT_FORMATS,PERSONAL_DOCUMENT_MAX_BYTES,PERSONAL_FRAGMENT_MAX_BYTES,PERSONAL_DOCUMENT_FRAGMENT_LIMIT} from './personal-documents.mjs';
import {UltraError,requireThat} from './core.mjs';
import {PERSONAL_MEMORY_TYPES,AGENT_TYPES} from './personal-memory.mjs';
const str=(description,required=false)=>({type:'string',description,required});
const num=(description,required=false)=>({type:'number',description,required});
const query={agent_id:str('Optional label filter, never authentication'),project_id:str('Project label'),
  query:str('Literal substring search'),task:str('Context query hint, not a model prompt'),
  types:{type:'array',items:{type:'string',enum:PERSONAL_MEMORY_TYPES}},status:{...str('Search lifecycle state; context requires active'),enum:['active','candidate','archived']},
  limit:num('1..100'),offset:num('Search live page offset; personal context accepts only 0'),budget_bytes:num('512..131072 serialized UTF-8 bytes')};
const revision={memory_id:str('Full memory UUID',true),expected_revision:num('Latest observed revision',true),event_id:str('Stable immutable request id',true)};
const definitions=[
 ['ultra_personal_capture','capture',true,{agent_id:str('Registered label',true),event_id:str('Stable capture event id',true),transcript:str('Explicitly consented raw text, at most 32 KiB',true),consent:{type:'boolean',required:true},project_id:str('Optional project label')},'Atomically retain a private source entry and queue it for personal consolidation. Does not call a model or activate memory.'],
 ['ultra_personal_consolidate','job_process',true,{expected_source:str('Must match authenticated source',true),allow_model_call:{type:'boolean',required:true},limit:num('1..4 jobs, default 1'),retry:{type:'boolean'},job_id:str('Optional owned job UUID')},'Process explicitly queued owned personal jobs using a separately enabled host model. Produces quoted private candidates only. Model costs may repeat after explicit recovery.'],
 ['ultra_personal_jobs','job_status',false,{job_id:str('Optional owned job UUID'),limit:num('1..100'),offset:num('Live list offset')},'Inspect owned personal consolidation state without transcript content, credentials or model calls.'],
 ['ultra_personal_cancel','job_cancel',true,{job_id:str('Owned incomplete job UUID',true)},'Fence an incomplete consolidation job. Retain its original input; cannot undo a submitted provider call or charge.'],
 ['ultra_agent_register','register',true,{agent_id:str('Caller-owned client label',true),agent_type:{...str('Self-described type'),enum:AGENT_TYPES},
   capabilities:{type:'array',items:{type:'string'}},workspace:str('Optional descriptive path, never executed'),expected_revision:num('0 to create; current revision for metadata changes')},'Register a client label under the authenticated source/principal, not a self-asserted identity.'],
 ['ultra_agent_list','agents',false,{limit:num('1..100'),offset:num('Live page offset')},'List only this principal registered client labels.'],
 ['ultra_memory_commit','commit',true,{agent_id:str('Registered label owned by this principal',true),event_id:str('Immutable request id',true),consent:{type:'boolean',required:true},
   summary:str('Optional experience candidate instead of a memories array'),memories:{type:'array',items:{type:'object'},description:'1..16 typed items: type, content, confidence(optional caller estimate), importance, provenance, visibility(private/source), project_id'}},'Atomically store explicitly consented candidate memories. No automatic confirmation or model call.'],
 ['ultra_memory_read','read',false,{memory_id:str('Full UUID of one currently authorized entry; not an ownership grant',true)},'Read one complete current entry by ID. Owned candidates/archives remain inspectable; others require current active source sharing. Not a historical snapshot or permission to update.'],
 ['ultra_memory_search','search',false,query,'Search authorized personal entries. Private by default; source-shared active entries require explicit sharing.'],
 ['ultra_personal_context','context',false,query,'Return bounded active personal context for current source/principal and optional project. Not semantic ranking or truth certification.'],
 ['ultra_memory_profile','profile',false,{limit:num('1..100'),budget_bytes:num('512..131072 UTF-8 bytes')},'Read explicitly active identity, preference, environment and goal entries.'],
 ['ultra_personal_review','review',true,{...revision,status:{type:'string',required:true,enum:['active','archived']}},'Explicitly activate or archive an owned entry with revision checking. Does not change its confidence or certify truth.'],
 ['ultra_personal_update','update',true,{...revision,memory:{type:'object',required:true}},'Replace an owned typed entry with revision checking; edits return it to candidate. Not physical erasure.'],
 ['ultra_personal_document_import','documentImport',true,{event_id:str('Stable import event id',true),agent_id:str('Registered label',true),consent:{type:'boolean',required:true},
   label:str(`Plain file name label (${PERSONAL_DOCUMENT_FORMATS.join('/')}); never a path`,true),content_base64:str(`Explicitly submitted file bytes, standard base64, at most ${PERSONAL_DOCUMENT_MAX_BYTES} bytes`,true),
   content_sha256:str('SHA-256 hex of the exact submitted bytes',true),project_id:str('Optional project label')},
  `Store one explicitly chosen UTF-8 text file (${PERSONAL_DOCUMENT_FORMATS.join(', ')}) with its original bytes, BOM and line endings. Oversized or non-UTF-8 files are rejected whole; JSON/CSV are stored as untrusted text, never executed. No model call.`],
 ['ultra_personal_document_list','documentList',false,{status:{...str('active (default), archived or any'),enum:['active','archived','any']},limit:num('1..100'),offset:num('Live page offset')},
  'List owned imported documents with metadata and fingerprint only; no file content is returned.'],
 ['ultra_personal_document_read','documentRead',false,{document_id:str('Owned document UUID',true)},
  'Return the exact original bytes (base64) with metadata and integrity self-check. Display as plain text; verify content_sha256 after download.'],
 ['ultra_personal_document_queue','documentQueue',true,{event_id:str('Stable queue event id',true),document_id:str('Owned active document UUID',true),
   fragments:{type:'array',items:{type:'object'},description:`1..${PERSONAL_DOCUMENT_FRAGMENT_LIMIT} explicit ranges {byte_start,byte_length}; omit to split the whole immutable file on UTF-8 boundaries; each ${PERSONAL_FRAGMENT_MAX_BYTES} bytes max, UTF-8 aligned, non-overlapping`}},
  'Atomically create bounded fragment entries and consolidation jobs for an owned active document. Queueing never calls a model and never auto-confirms memories.'],
 ['ultra_personal_document_archive','documentArchive',true,{event_id:str('Stable archive event id',true),document_id:str('Owned active document UUID',true)},
  'Archive a document: fragments leave current use, derived entries are invalidated, pending jobs are fenced, original bytes are retained. Not physical erasure.'],
];
export const PERSONAL_TOOL_NAMES=Object.freeze(definitions.map(d=>d[0]));
const DOCUMENT_METHODS=new Set(['documentImport','documentList','documentRead','documentQueue','documentArchive']);
export function registerPersonalPlugin(operations,{OperationError},configureModel=configuredPersonalModel) {
  requireThat(definitions.every(([name])=>!operations.some(o=>o.name===name)),'upstream_contract_changed','Personal tool collision');
  for(const [name,method,mutating,params,description] of definitions)operations.push({name,params,description,mutating,scope:mutating?'write':'read',area:'ultrabrain',
    async handler(ctx,p){
      try {
        const {dry_run,_meta,...input}=p;
        requireThat(dry_run===undefined||typeof dry_run==='boolean','invalid_params','dry_run must be boolean');
        if(method.startsWith('job_'))return await new PersonalConsolidator(ctx,configureModel)[method.slice(4)](input);
        if(DOCUMENT_METHODS.has(method))return await new PersonalDocumentStore(ctx)[method](input);
        return await new PersonalMemoryStore(ctx)[method](input);
      }
      catch(e){
        if(e.code==='personal_commit_unconfirmed')throw new OperationError(e.code,'Personal job commit unconfirmed; inspect durable status before retry');
        if(e instanceof UltraError)throw new OperationError(e.code,e.message);
        throw new OperationError('personal_storage_error','Personal operation failed; no raw SQL, credentials or memory content disclosed');
      }
    }});
  return PERSONAL_TOOL_NAMES;
}
