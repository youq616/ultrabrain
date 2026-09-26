#!/usr/bin/env node
/** Separate offline executable: never import the live-client CLI or its SDK. */
import {inspectClientSnapshots} from './snapshot.mjs';
import {snapshotFailure} from '../../../src/client-snapshot.mjs';
import {parseSnapshotJSON} from '../../../src/personal-snapshot-contract.mjs';
import {requireThat} from '../../../src/core.mjs';
const HELP = `Ultrabrain offline snapshot tools
Usage: ultrabrain-snapshot < request.json
Read one explicit JSON request (maximum 16 KiB) from stdin. No profile or server.
Operations: inspect, compare, page, record, audit, trace, impact, duplicates, duplicate-compare. Every request requires consent:true.
files: [{path:ABSOLUTE_LOCAL_PATH, expected_sha256:OPTIONAL_HEX}]
compare and duplicate-compare require two files; other operations require one file.
page accepts options; record requires memory_id, and include_text defaults false.
audit accepts optional memory_id; always metadata-only, direct same-file sources.
trace requires memory_id; optional max_hops:1..128 (default 32), metadata-only.
trace stops on mismatches, missing sources, cycles or the hop limit.
impact requires memory_id; metadata-only potential direct/indirect dependents, not a deletion plan.
duplicates scans one complete file for exact equal content; metadata-only, no merge or deletion.
duplicate-compare compares duplicate groups in two complete files; no chronology or deletion inference.
See docs/CLIENT-SNAPSHOTS.md in the matching source commit.
Unsigned files do not prove identity. Comparison is not a restore plan.
`;
async function main() {
  const controller = new AbortController();
  const cancel = () => { controller.abort(); process.stdin.destroy(); };
  const timer = setTimeout(cancel,25000); timer.unref();
  process.once('SIGINT',cancel); process.once('SIGTERM',cancel);
  process.stdout.on('error',() => {process.exitCode=1;});
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--help') { process.stdout.write(HELP); return; }
    requireThat(args.length === 0,'invalid_params','Use stdin for a snapshot request');
    const chunks = []; let size = 0;
    for await (const chunk of process.stdin) {
      const part = Buffer.from(chunk); size += part.length;
      requireThat(size <= 16384,'snapshot_input_too_large','Snapshot request too large'); chunks.push(part);
    }
    requireThat(!controller.signal.aborted,'aborted','Snapshot operation cancelled');
    let text;
    try { text = new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.concat(chunks)); }
    catch { throw Object.assign(new Error(),{code:'snapshot_file_invalid_utf8'}); }
    const request = parseSnapshotJSON(text.startsWith('\ufeff') ? text.slice(1) : text);
    const report = await inspectClientSnapshots(request,{signal:controller.signal});
    requireThat(!controller.signal.aborted,'aborted','Snapshot operation cancelled');
    process.stdout.write(JSON.stringify(report)+'\n');
  } catch (error) {
    const safe = snapshotFailure(error);
    process.stdout.write(JSON.stringify({ok:false,error:safe.code,local_only:true,network_requests:0,memory_writes_requested:false})+'\n');
    process.exitCode=1;
  } finally {
    clearTimeout(timer); process.removeListener('SIGINT',cancel); process.removeListener('SIGTERM',cancel);
    process.stdin.destroy();
  }
}
void main();
