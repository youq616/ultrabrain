/** Explicit local files only. No globbing, directory scan, profile or URL loader. */
import {constants} from 'node:fs';
import {lstat,open} from 'node:fs/promises';
import {dirname,isAbsolute,parse} from 'node:path';
import {requireThat,sha256,UltraError} from './core.mjs';
import {assertClientAuthorized} from './client-authorization.mjs';
import {SNAPSHOT_FILE_MAX_BYTES} from './personal-snapshot-contract.mjs';
import {snapshotRequest,snapshotDigest,snapshotFailure,freezeSnapshotResult,inspectClientSnapshotBytes} from './client-snapshot.mjs';

const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const sameFile = (a,b) => ['dev','ino','size','mtimeNs','ctimeNs'].every(key => a[key] === b[key]);
function fileSelection(selection) {
  requireThat(object(selection) && Object.keys(selection).every(key => ['path','expected_sha256'].includes(key)),
    'invalid_params','Invalid snapshot file selection');
  const path = selection.path;
  requireThat(typeof path === 'string' && path.isWellFormed() && Buffer.byteLength(path) <= 8192 &&
    !/[\x00-\x1f\x7f]/.test(path) && isAbsolute(path) && !path.startsWith('//') && !path.startsWith('\\\\') &&
    !path.split(process.platform === 'win32' ? /[\\/]/ : /\//).some(part => part === '.' || part === '..') &&
    (process.platform !== 'win32' || /^[A-Za-z]:[\\/]/.test(path) && !path.slice(2).includes(':')),
    'snapshot_path_invalid','Select an absolute local file path');
  requireThat(selection.expected_sha256 === undefined || snapshotDigest(selection.expected_sha256),
    'invalid_params','Invalid expected snapshot digest');
  return {path,...(selection.expected_sha256 === undefined ? {} : {expected_sha256:selection.expected_sha256})};
}
export function snapshotFileRequest(input) {
  let copy;
  try { copy = structuredClone(input); } catch { throw new UltraError('invalid_params','Cloneable request required'); }
  requireThat(object(copy),'invalid_params','Invalid snapshot request');
  const {files,...operation} = copy, request = snapshotRequest(operation);
  requireThat(Array.isArray(files) && files.length === (['compare','duplicate-compare'].includes(request.operation) ? 2 : 1),
    'invalid_params','Invalid snapshot file count');
  return freezeSnapshotResult({request,files:Array.from(files,fileSelection)});
}
async function parents(path,allowed) {
  const result = [];
  for (let parent=dirname(path);;parent=dirname(parent)) {
    requireThat(result.length < 128,'snapshot_path_invalid','Too many parent directories');
    allowed(); const stat = await lstat(parent,{bigint:true}); allowed();
    requireThat(stat.isDirectory() && !stat.isSymbolicLink(),'snapshot_path_invalid','Linked parent rejected');
    result.push([parent,stat.dev,stat.ino]);
    if (parent === parse(parent).root) break;
  }
  return result;
}
const sameParents = (a,b) => a.length === b.length && a.every((row,i) => row.every((v,j) => v === b[i][j]));
/** Read through a bounded descriptor; detect observed replacement, resize or
 * modification. This is not a filesystem transaction or hostile-kernel defense.
 */
export async function readSnapshotFile(selection,allowed) {
  const {path} = selection;
  allowed(); const originalParents = await parents(path,allowed); allowed();
  const before = await lstat(path,{bigint:true}); allowed();
  requireThat(before.isFile() && !before.isSymbolicLink(),'snapshot_path_invalid','Regular files only');
  requireThat(before.size > 0n && before.size <= BigInt(SNAPSHOT_FILE_MAX_BYTES),'snapshot_file_size','Invalid snapshot file size');
  let handle, bytes;
  try {
    allowed();
    // Assign the descriptor before checking post-open authority, so revocation
    // during open cannot leak the successfully opened descriptor.
    handle = await open(path,constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    allowed(); const opened = await handle.stat({bigint:true}); allowed();
    requireThat(opened.isFile() && sameFile(before,opened),'snapshot_file_changed','File replaced before reading');
    const current = await lstat(path,{bigint:true}); allowed();
    requireThat(!current.isSymbolicLink() && sameFile(opened,current) &&
      sameParents(originalParents,await parents(path,allowed)),'snapshot_file_changed','Selected path changed');
    const buffer = Buffer.alloc(Number(opened.size)+1); let length = 0;
    while (length < buffer.length) {
      allowed(); const {bytesRead} = await handle.read(buffer,length,Math.min(65536,buffer.length-length),length); allowed();
      if (!bytesRead) break;
      length += bytesRead;
    }
    const last = await handle.stat({bigint:true}); allowed();
    const linked = await lstat(path,{bigint:true}); allowed();
    requireThat(length === Number(opened.size) && sameFile(opened,last) && linked.isFile() && !linked.isSymbolicLink() &&
      sameFile(opened,linked) && sameParents(originalParents,await parents(path,allowed)),
      'snapshot_file_changed','File changed during reading');
    bytes = buffer.subarray(0,length);
  } finally {
    // Cleanup runs even after cancellation. A close failure must not deliver bytes.
    if (handle) await handle.close();
  }
  allowed(); return bytes;
}
/** Public path API. Selection validated and copied before any filesystem access.
 * No file handles survive into the digest/report phase, and no cache is retained.
 */
export async function inspectClientSnapshots(input,{authorize=()=>{},signal}={}) {
  const allowed = () => assertClientAuthorized(authorize,signal);
  try {
    allowed(); const chosen = snapshotFileRequest(input), data = [];
    for (const selection of chosen.files) {
      allowed(); let bytes;
      try { bytes = await readSnapshotFile(selection,allowed); }
      catch (error) {
        allowed();
        if (typeof error?.code === 'string' && /^E[A-Z]+$/.test(error.code))
          throw new UltraError('snapshot_file_unavailable','Selected file unavailable');
        throw error;
      }
      allowed();
      requireThat(selection.expected_sha256 === undefined || sha256(bytes) === selection.expected_sha256,
        'snapshot_hash_mismatch','Snapshot differs from the selected fingerprint');
      data.push({data:bytes,expected_sha256:selection.expected_sha256});
    }
    const result = await inspectClientSnapshotBytes(chosen.request,data,{authorize,signal});
    allowed(); return result;
  } catch (error) { throw snapshotFailure(error); }
}
