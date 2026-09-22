/** Direct consolidation references inside ONE already verified snapshot.
 * No filesystem, external lookup, repair or truth authority.
 */
import {setImmediate as yieldToEventLoop} from 'node:timers/promises';
import {queryMemorySnapshot,readMemorySnapshotRecord} from './personal-snapshot-contract.mjs';
import {lineageReference,compareLineage} from './personal-lineage-contract.mjs';
import {requireThat} from './core.mjs';

export const SNAPSHOT_TRACE_DEFAULT_HOPS=32;
export const SNAPSHOT_TRACE_MAX_HOPS=128;
export const validSnapshotTraceHops=value=>Number.isSafeInteger(value)&&value>=1&&value<=SNAPSHOT_TRACE_MAX_HOPS;

export const SNAPSHOT_AUDIT_STATES=Object.freeze(['unlinked','unsupported_origin','invalid_reference','source_missing',
  'matched','changed','archived','quote_mismatch','inconsistent']);
const metadata=row=>Object.freeze(Object.fromEntries(['id','type','origin_kind','status','revision','project_id',
  'content_hash','derivation_current'].map(key=>[key,row[key]])));
const referenceMetadata=ref=>Object.freeze(Object.fromEntries(['job_id','input_id','input_revision','input_hash',
  'profile_hash','start','end','offset_unit'].map(key=>[key,ref[key]])));

function inspectReference(memory,index,allowLookup=true) {
  const entry={memory:metadata(memory),state:'unlinked',reference:null,source:null,same_project:null,comparison:null};
  // Document origins require a different contract and original bytes, which the
  // logical snapshot explicitly excludes. Never misreport them as no origin.
  if(memory.origin_kind!=='agent')return Object.freeze({...entry,state:'unsupported_origin'});
  let ref;
  try { ref=lineageReference(memory); }
  catch(error) {
    if(error?.code!=='lineage_reference_invalid')throw error;
    // Report a structural finding without reflecting any unchecked reference.
    return Object.freeze({...entry,state:'invalid_reference'});
  }
  if(ref===null)return Object.freeze(entry);
  entry.reference=referenceMetadata(ref);
  // At the trace budget boundary, classify the selected record but do not look
  // up or disclose another source. Audit always uses the default allowLookup.
  if(!allowLookup)return Object.freeze({...entry,state:'depth_limit'});
  const source=index.get(ref.input_id);
  if(!source)return Object.freeze({...entry,state:'source_missing'});
  // Both records have passed the existing whole-file content hash/schema check.
  // This does not authenticate the owner or job IDs claimed by the file.
  entry.source=metadata(source);
  entry.same_project=memory.project_id===source.project_id;
  entry.comparison=compareLineage(memory,source);
  entry.state=entry.comparison.state;
  return Object.freeze(entry);
}

/** Internal adapter for canonical inspected handles, not unverified JSON objects.
 * Client APIs validate/copy requests and bytes before invoking this operation.
 * A single-record selection still follows whole-file validation, never a partial
 * checksum. Checkpoints fence all result delivery; no partial report escapes.
 */
export async function auditMemorySnapshot(file,memoryId,checkpoint=()=>{}) {
  checkpoint();
  // Authenticate the canonical WeakSet-backed handle BEFORE touching its data.
  queryMemorySnapshot(file);
  const rows=file.snapshot.memories;
  const selected=memoryId===undefined?rows:[readMemorySnapshotRecord(file,memoryId)];
  const index=new Map(rows.map(row=>[row.id,row]));
  const counts=Object.fromEntries(SNAPSHOT_AUDIT_STATES.map(state=>[state,0])),entries=[];
  for(let i=0;i<selected.length;i++) {
    checkpoint();
    if(i%32===0){await yieldToEventLoop();checkpoint();}
    const entry=inspectReference(selected[i],index);
    counts[entry.state]++;entries.push(entry);
  }
  checkpoint();
  return Object.freeze({format:'ultrabrain-snapshot-lineage-audit-v1',selection:memoryId===undefined?'all':'record',
    snapshot_record_count:rows.length,audited_count:entries.length,counts:Object.freeze(counts),entries:Object.freeze(entries),
    source_lookup:'same-verified-file-only',text_included:false,graph_verified:false,read_only:true,
    identity_verified:false,truth_verified:false});
}

/** Bounded, iterative single-parent trace through matching direct references.
 * Each followed edge reuses the audit's exact comparator. Never splice a current
 * source into a historical chain when its referenced revision or text changed.
 * This is an observation of one unsigned file, not a graph/history certificate.
 */
export async function traceMemorySnapshot(file,memoryId,maxHops=SNAPSHOT_TRACE_DEFAULT_HOPS,checkpoint=()=>{}) {
  checkpoint();
  queryMemorySnapshot(file); // Authenticate the WeakSet-backed handle first.
  requireThat(validSnapshotTraceHops(maxHops),'invalid_params','Invalid snapshot trace hop limit');
  let current=readMemorySnapshotRecord(file,memoryId),followedHops=0,termination,cycle=null;
  const rows=file.snapshot.memories,index=new Map(rows.map(row=>[row.id,row])),seen=new Map(),steps=[];
  for(;;) {
    checkpoint();
    if(steps.length%16===0){await yieldToEventLoop();checkpoint();}
    seen.set(current.id,steps.length);
    const entry=inspectReference(current,index,followedHops<maxHops);
    steps.push(entry);
    if(entry.state!=='matched'){termination=entry.state;break;}
    if(seen.has(entry.source.id)) {
      termination='cycle';
      cycle=Object.freeze({entry_id:entry.source.id,entry_index:seen.get(entry.source.id),closing_index:steps.length-1});
      break; // Retain the closing comparison, never visit a record twice.
    }
    followedHops++;
    current=index.get(entry.source.id);
  }
  checkpoint();
  return Object.freeze({format:'ultrabrain-snapshot-lineage-trace-v1',root_id:memoryId,
    snapshot_record_count:rows.length,max_hops:maxHops,visited_count:steps.length,followed_hops:followedHops,
    termination,reached_unlinked_record:termination==='unlinked',cycle,steps:Object.freeze(steps),
    source_lookup:'same-verified-file-only',text_included:false,graph_verified:false,historical_chain_verified:false,
    read_only:true,identity_verified:false,truth_verified:false});
}
