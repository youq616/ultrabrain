/** Direct consolidation references inside ONE already verified snapshot.
 * No filesystem, external lookup, recursive graph walk, repair or truth authority.
 */
import {setImmediate as yieldToEventLoop} from 'node:timers/promises';
import {queryMemorySnapshot,readMemorySnapshotRecord} from './personal-snapshot-contract.mjs';
import {lineageReference,compareLineage} from './personal-lineage-contract.mjs';

export const SNAPSHOT_AUDIT_STATES=Object.freeze(['unlinked','unsupported_origin','invalid_reference','source_missing',
  'matched','changed','archived','quote_mismatch','inconsistent']);
const metadata=row=>Object.freeze(Object.fromEntries(['id','type','origin_kind','status','revision','project_id',
  'content_hash','derivation_current'].map(key=>[key,row[key]])));
const referenceMetadata=ref=>Object.freeze(Object.fromEntries(['job_id','input_id','input_revision','input_hash',
  'profile_hash','start','end','offset_unit'].map(key=>[key,ref[key]])));

function inspectReference(memory,index) {
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
