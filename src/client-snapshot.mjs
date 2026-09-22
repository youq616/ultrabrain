/** Offline snapshot operations. No filesystem, profile, transport or model access. */
import {setImmediate as yieldToEventLoop} from 'node:timers/promises';
import {sha256,requireThat,UltraError} from './core.mjs';
import {assertClientAuthorized} from './client-authorization.mjs';
import {
  inspectMemorySnapshotFile,compareMemorySnapshots,queryMemorySnapshot,readMemorySnapshotRecord,
  memorySnapshotQueryOptions,SNAPSHOT_FILE_MAX_BYTES,
} from './personal-snapshot-contract.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const ownFields = (value, fields) => object(value) && Object.keys(value).every(key => fields.includes(key));
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
export const snapshotDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function freezeSnapshotResult(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeSnapshotResult(child);
    Object.freeze(value);
  }
  return value;
}
export function snapshotRequest(input) {
  let request;
  try { request = structuredClone(input); }
  catch { throw new UltraError('invalid_params','Cloneable snapshot request required'); }
  const choices = {inspect:['operation','consent'],compare:['operation','consent'],
    page:['operation','consent','options'],record:['operation','consent','memory_id','include_text']};
  requireThat(object(request) && typeof request.operation === 'string' && Object.hasOwn(choices,request.operation) &&
    ownFields(request,choices[request.operation]),'invalid_params','Invalid offline snapshot operation');
  requireThat(request.consent === true,'snapshot_consent_required','Explicit local inspection consent required');
  if (request.operation === 'page') request.options = memorySnapshotQueryOptions(request.options === undefined ? {} : request.options);
  if (request.operation === 'record') {
    requireThat(uuid(request.memory_id) && (request.include_text === undefined || typeof request.include_text === 'boolean'),
      'invalid_params','Invalid snapshot record selection');
    request.include_text = request.include_text === true;
  }
  return freezeSnapshotResult(request);
}
const safeCodes = new Set(['invalid_params','snapshot_consent_required','client_authorization_revoked','aborted',
  'snapshot_file_size','snapshot_file_invalid_utf8','snapshot_file_invalid_json','snapshot_file_duplicate_key',
  'snapshot_file_too_deep','memory_snapshot_unconfirmed','snapshot_source_mismatch','snapshot_query_invalid',
  'snapshot_record_missing','snapshot_page_out_of_range','snapshot_hash_mismatch','snapshot_path_invalid',
  'snapshot_file_changed','snapshot_file_unavailable','snapshot_input_too_large']);
/** Never expose parser snippets, paths, query text, filesystem details or callback errors. */
export function snapshotFailure(error) {
  return new UltraError(safeCodes.has(error?.code) ? error.code : 'snapshot_operation_unconfirmed',
    'Offline snapshot operation was not confirmed');
}
const summary = file => ({file_sha256:file.file_sha256,file_bytes:file.file_bytes,
  expected_hash_verified:file.expected_hash_verified,source_id:file.snapshot.source_id,
  request_id:file.snapshot.request_id,snapshot_at:file.snapshot.snapshot_at,
  record_count:file.snapshot.record_count,memories_sha256:file.snapshot.memories_sha256});
const metadata = row => Object.fromEntries(['id','type','origin_kind','status','visibility','importance','confidence',
  'agent_id','project_id','revision','created_at','updated_at','last_confirmed','content_hash','derivation_current']
  .map(key => [key,row[key]]));

/** Inputs are one or two {data: Uint8Array, expected_sha256?: hex} objects.
 * Both byte selections and disclosure/filter choices are copied before the first
 * await. A digest pins bytes, not identity. Every run verifies the complete files.
 */
export async function inspectClientSnapshotBytes(input, inputs, {authorize=()=>{},signal}={}) {
  const allowed = () => assertClientAuthorized(authorize,signal);
  try {
    allowed();
    const request = snapshotRequest(input), count = request.operation === 'compare' ? 2 : 1;
    requireThat(Array.isArray(inputs) && inputs.length === count,'invalid_params','Invalid snapshot file count');
    const copies = Array.from(inputs,selection => {
      requireThat(ownFields(selection,['data','expected_sha256']) && selection.data instanceof Uint8Array &&
        !(typeof SharedArrayBuffer !== 'undefined' && selection.data.buffer instanceof SharedArrayBuffer),
        'invalid_params','A private byte buffer is required');
      requireThat(selection.data.byteLength > 0 && selection.data.byteLength <= SNAPSHOT_FILE_MAX_BYTES,
        'snapshot_file_size','Invalid snapshot file size');
      requireThat(selection.expected_sha256 === undefined || snapshotDigest(selection.expected_sha256),
        'invalid_params','Invalid expected snapshot digest');
      return {data:Uint8Array.from(selection.data),expected_sha256:selection.expected_sha256};
    });
    allowed();
    const digest = async text => {
      allowed();
      // Give cancellation/host revocation a turn even when SHA-256 is synchronous.
      await yieldToEventLoop(); allowed(); return sha256(text);
    };
    const files = [];
    for (const selection of copies) {
      allowed();
      requireThat(selection.expected_sha256 === undefined || sha256(selection.data) === selection.expected_sha256,
        'snapshot_hash_mismatch','Snapshot differs from the selected fingerprint');
      const file = await inspectMemorySnapshotFile(selection.data,digest,allowed); allowed();
      // Keep the canonical inspected handle intact; do not fabricate a new handle.
      files.push(file);
    }
    let result;
    if (request.operation === 'inspect') {
      const states = {candidate:0,active:0,archived:0};
      for (const row of files[0].snapshot.memories) states[row.status]++;
      result = {record_count:files[0].snapshot.record_count,states,excluded:files[0].snapshot.excluded};
    } else if (request.operation === 'compare') result = compareMemorySnapshots(files[0],files[1]);
    else if (request.operation === 'page') result = queryMemorySnapshot(files[0],request.options);
    else {
      const row = readMemorySnapshotRecord(files[0],request.memory_id);
      result = {memory:metadata(row),has_derivation:row.derivation !== null,text_included:request.include_text};
      if (request.include_text) result.text = {content:row.content,provenance:row.provenance,derivation:row.derivation};
    }
    const report = {format:'ultrabrain-client-snapshot-v1',operation:request.operation,local_only:true,read_only:true,
      identity_verified:false,truth_verified:false,network_requests:0,memory_writes_requested:false,
      trust:'untrusted-memory-data',files:files.map((file,index) => summary({...file,
        expected_hash_verified:copies[index].expected_sha256 !== undefined})),result,
      limitations:['unsigned-self-declared-owner','no-live-database-check','absence-is-not-deletion',
        'no-chronology-inference','not-a-restore-plan','metadata-is-private','no-source-following']};
    allowed(); return freezeSnapshotResult(report);
  } catch (error) { throw snapshotFailure(error); }
}
