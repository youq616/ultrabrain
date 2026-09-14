/** Explicitly imported personal text documents: original bytes, provenance, bounded queueing.
 * A filename is a caller label, never a path, identity or command. JSON/CSV content is
 * stored as untrusted text only; nothing inside an imported file is ever executed.
 * Import and model processing stay separate: queueing creates candidates through the
 * existing PersonalConsolidator jobs, and archiving retains the original bytes.
 */
import {requireThat,sha256,sourceId,integer,UltraError} from './core.mjs';
import {objectFields,personalId,memoryId} from './personal-memory.mjs';
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
  requireThat(typeof encoded==='string'&&encoded.length>0,'invalid_params','File content must be provided as nonempty standard base64 text');
  requireThat(encoded.length<=200000,'file_too_large',
    `Personal documents are limited to ${PERSONAL_DOCUMENT_MAX_BYTES} bytes; larger files are rejected whole, never truncated`);
  requireThat(BASE64.test(encoded)&&encoded.length%4===0,'invalid_params','File content must be standard base64 in groups of four');
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
  const text=strictUtf8(slice);
  requireThat(!text.includes('\0')&&text.trim().length>0,'fragment_not_processable','A fragment must contain nonempty PostgreSQL-compatible text; the original bytes remain unchanged'); // Rejects ranges that split a multi-byte UTF-8 sequence.
  requireThat(sha256(slice)===sha256(Buffer.from(text,'utf8')),'fragment_boundary','Fragment boundaries must align to UTF-8 code points');
  return {text,fragment_sha256:sha256(slice)};
}
/** Split a validated immutable snapshot at Unicode code-point boundaries, never truncate. */
export function planDocumentFragments(bytes) {
  documentContent(bytes);
  const ranges=[];
  for(let start=0;start<bytes.length;) {
    let end=Math.min(start+PERSONAL_FRAGMENT_MAX_BYTES,bytes.length);
    while(end<bytes.length&&(bytes[end]&0xC0)===0x80)end--;
    requireThat(end>start,'fragment_boundary','Cannot form a complete UTF-8 fragment');
    ranges.push({byte_start:start,byte_length:end-start});start=end;
  }
  return ranges;
}
