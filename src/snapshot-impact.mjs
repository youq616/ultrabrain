/** Potential dependent records within ONE verified logical snapshot.
 *
 * Edges are structurally valid consolidation declarations, not authenticated
 * provenance. Stale declarations remain edges: filtering to matched references
 * would hide precisely the dependents an operator needs to investigate.
 * No filesystem, external lookup, model, repair, invalidation or write access.
 */
import {setImmediate as yieldToEventLoop} from 'node:timers/promises';
import {readMemorySnapshotRecord} from './personal-snapshot-contract.mjs';
import {auditMemorySnapshot,SNAPSHOT_AUDIT_STATES} from './snapshot-lineage-audit.mjs';

const BATCH_SIZE=32;

/** Internal canonical-handle adapter. The public byte/path APIs validate and
 * freeze the complete request and file before reaching this function.
 *
 * Each supported record has at most one declared parent. Reverse breadth-first
 * traversal visits each ID once, without recursion or an artificial depth cut.
 * Every asynchronous boundary rechecks authority; a failure returns no partial
 * traversal. Root cycle detection concerns this selected root, not other graphs.
 */
export async function inspectMemorySnapshotImpact(file,memoryId,checkpoint=()=>{}) {
  checkpoint();
  // Authenticate the WeakSet-backed handle before looking at any of its fields.
  const rootId=readMemorySnapshotRecord(file,memoryId).id;
  const audit=await auditMemorySnapshot(file,undefined,checkpoint);
  checkpoint();
  const children=new Map();
  const coverage={scanned_records:audit.audited_count,valid_references:0,
    invalid_references:audit.counts.invalid_reference,
    unsupported_origins:audit.counts.unsupported_origin,
    missing_sources:audit.counts.source_missing,
    unknown_dependencies_present:audit.counts.invalid_reference>0 ||
      audit.counts.unsupported_origin>0 || audit.counts.source_missing>0};
  let rootEntry;
  for(let i=0;i<audit.entries.length;i++) {
    checkpoint();
    if(i%BATCH_SIZE===0){await yieldToEventLoop();checkpoint();}
    const entry=audit.entries[i];
    if(entry.memory.id===rootId)rootEntry=entry;
    if(entry.reference===null)continue;
    coverage.valid_references++;
    // An absent source has no in-file parent to traverse. It is still counted as
    // a coverage gap, never converted into a guessed edge or deletion claim.
    if(entry.source===null)continue;
    const parent=entry.reference.input_id;
    if(!children.has(parent))children.set(parent,[]);
    children.get(parent).push(entry);
  }

  const queue=[{id:rootId,distance:0,path_crosses_projects:false,path_has_reference_findings:false}];
  const seen=new Set([rootId]),entries=[];
  const counts={direct:0,indirect:0,total:0};
  const statusCounts={candidate:0,active:0,archived:0};
  const referenceCounts=Object.fromEntries(SNAPSHOT_AUDIT_STATES.map(state=>[state,0]));
  let rootInCycle=false,maxDistance=0,crossProjectPaths=0,pathsWithFindings=0,edgeCount=0;
  for(let cursor=0;cursor<queue.length;cursor++) {
    checkpoint();
    if(cursor%BATCH_SIZE===0){await yieldToEventLoop();checkpoint();}
    const parent=queue[cursor];
    for(const entry of children.get(parent.id)??[]) {
      checkpoint();
      // A 999-child fan-out must yield too, not only a 999-deep chain.
      if(edgeCount++%BATCH_SIZE===0){await yieldToEventLoop();checkpoint();}
      const id=entry.memory.id;
      if(id===rootId)rootInCycle=true;
      if(seen.has(id))continue;
      seen.add(id);
      const distance=parent.distance+1;
      const crossesProjects=parent.path_crosses_projects || entry.same_project===false;
      const hasFindings=parent.path_has_reference_findings || entry.state!=='matched';
      const record=Object.freeze({memory:entry.memory,parent_id:parent.id,distance,
        direct_source_state:entry.state,comparison:entry.comparison,same_project:entry.same_project,
        path_crosses_projects:crossesProjects,path_has_reference_findings:hasFindings});
      entries.push(record);
      queue.push({id,distance,path_crosses_projects:crossesProjects,path_has_reference_findings:hasFindings});
      counts.total++;counts[distance===1?'direct':'indirect']++;
      statusCounts[entry.memory.status]++;referenceCounts[entry.state]++;
      maxDistance=Math.max(maxDistance,distance);
      if(crossesProjects)crossProjectPaths++;
      if(hasFindings)pathsWithFindings++;
    }
  }
  // File order is canonical ID order, but different BFS parents can interleave
  // their children. Explicit distance/ID sorting is deterministic on all hosts.
  entries.sort((a,b)=>a.distance-b.distance || (a.memory.id<b.memory.id?-1:a.memory.id>b.memory.id?1:0));
  checkpoint();
  return Object.freeze({format:'ultrabrain-snapshot-impact-v1',root:rootEntry.memory,
    root_audit_state:rootEntry.state,snapshot_record_count:audit.snapshot_record_count,
    counts:Object.freeze(counts),status_counts:Object.freeze(statusCounts),reference_state_counts:Object.freeze(referenceCounts),
    entries:Object.freeze(entries),max_distance:maxDistance,root_in_cycle:rootInCycle,
    cross_project_paths:crossProjectPaths,paths_with_reference_findings:pathsWithFindings,
    coverage:Object.freeze(coverage),traversal_complete:true,all_impacts_known:false,
    source_lookup:'same-verified-file-only',semantics:'potential-dependencies-not-automatic-invalidation',
    cycle_scope:'selected-root-known-edges-only',text_included:false,graph_verified:false,read_only:true,
    identity_verified:false,truth_verified:false});
}
