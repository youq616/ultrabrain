/** Client-side explicitly selected personal text documents.
 * Reads only one user-chosen regular file: no directory scans, no chat-history
 * paths, no symlink or Windows junction following. Mirrors the server bounds so
 * obviously ineligible files are rejected before any bytes leave the machine.
 */
import {lstatSync,readFileSync} from 'node:fs';
import {basename} from 'node:path';
import {requireThat,UltraError,sha256} from './core.mjs';
import {objectFields,personalId} from './personal-memory.mjs';
import {documentLabel,documentFormat,documentContent,PERSONAL_DOCUMENT_MAX_BYTES} from './personal-documents.mjs';
export function readLocalDocument(path) {
  requireThat(typeof path==='string'&&path.length>0&&!path.includes('\0'),'invalid_params','One explicit file path is required');
  const stats=lstatSync(path); // lstat, never stat: a symlink or junction is rejected, not followed.
  requireThat(!stats.isSymbolicLink(),'invalid_path','Symlinks and Windows junctions are not followed; import the real file');
  requireThat(stats.isFile(),'invalid_path','Only one explicitly selected regular file can be imported');
  requireThat(stats.size>=1&&stats.size<=PERSONAL_DOCUMENT_MAX_BYTES,'file_too_large',
    `Personal documents are limited to ${PERSONAL_DOCUMENT_MAX_BYTES} bytes; this file is rejected whole`);
  const label=documentLabel(basename(path));documentFormat(label);
  const bytes=readFileSync(path);
  const content=documentContent(bytes); // Strict UTF-8; BOM and line endings preserved.
  requireThat(stats.size===bytes.length&&sha256(bytes)===content.content_sha256,'invalid_params','File changed while being read');
  return {label,content_base64:bytes.toString('base64'),content_sha256:content.content_sha256,
    byte_size:bytes.length,has_bom:content.has_bom};
}
export function documentImportRequest(input,profile) {
  objectFields(input,['agent_id','event_id','consent','label','content_base64','content_sha256','project_id']);
  // Document import is per-file consent; it is independent of the automatic
  // conversation-capture switch and never enabled by it alone.
  requireThat(input.consent===true,'capture_disabled',
    'Explicit per-file consent is required to import a personal document');
  personalId(input.agent_id,'agent_id');personalId(input.event_id,'event_id');
  documentLabel(input.label);documentFormat(input.label);
  requireThat(typeof input.content_base64==='string'&&/^[A-Za-z0-9+/]+={0,2}$/.test(input.content_base64),'invalid_params','Invalid base64 content');
  requireThat(typeof input.content_sha256==='string'&&/^[a-f0-9]{64}$/.test(input.content_sha256),'invalid_params','Invalid content fingerprint');
  requireThat(!Object.hasOwn(input,'project_id')||input.project_id===profile.projectId,
    'scope_denied','Project differs from the trusted client profile');
  const {...fields}=input;delete fields.project_id;
  return {...fields,...(profile.projectId?{project_id:profile.projectId}:{})};
}
/** Last-mile consent boundary for document import, mirroring deliverCapture:
 * freeze the selection before asynchronous work and re-assert the synchronous
 * authorization snapshot after every awaited step, immediately before sending.
 */
export async function deliverDocumentImport(file,profile,{checkIdentity,invoke,signal,authorize=()=>{}}) {
  requireThat(file&&typeof file==='object'&&!Array.isArray(file),'invalid_params','A selected document is required');
  requireThat(typeof authorize==='function','invalid_params','Synchronous authorization assertion required');
  const selection=structuredClone(file); // Bytes and consent frozen at selection time.
  const request=documentImportRequest({...selection,consent:true},profile);
  const allowed=()=>{
    requireThat(!signal?.aborted,'aborted','Document import cancelled before transmission');
    const result=authorize();
    if(result&&typeof result.then==='function'){
      Promise.resolve(result).catch(()=>{});
      requireThat(false,'invalid_params','Authorization assertion must be synchronous');
    }
    requireThat(!signal?.aborted,'aborted','Document import cancelled during authorization');
  };
  await checkIdentity();
  allowed();
  await invoke('ultra_agent_register',{agent_id:request.agent_id,agent_type:'custom'});
  await checkIdentity();
  allowed();
  return invoke('ultra_personal_document_import',request);
}
