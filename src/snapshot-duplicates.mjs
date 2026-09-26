/** Exact-content review groups in ONE fully verified immutable snapshot.
 * Equal text is not equal provenance, scope, lifecycle or permission to merge.
 * No filesystem, network, model, mutation or record-retention decision here.
 */
import {setImmediate as yieldToEventLoop} from 'node:timers/promises';
import {queryMemorySnapshot} from './personal-snapshot-contract.mjs';

const DIFFERENCE_FIELDS=Object.freeze(['agent_id','confidence','created_at','derivation','derivation_current',
  'importance','last_confirmed','origin_kind','project_id','provenance','revision','status','type','updated_at','visibility']);
const MEMBER_FIELDS=Object.freeze(['id','type','origin_kind','status','visibility','project_id','agent_id','revision','derivation_current']);
// Canonical snapshots contain bounded, frozen JSON only. Compare metadata with
// object key order ignored, but never normalize text, array order or value types.
const valueKey=value=>{
  if(value===null||typeof value!=='object')return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(valueKey).join(',')+']';
  return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+valueKey(value[k])).join(',')+'}';
};
const member=row=>Object.freeze(Object.fromEntries(MEMBER_FIELDS.map(k=>[k,row[k]])));

/** Internal canonical-handle adapter; public path/byte APIs first verify the
 * complete file using the existing snapshot contract and cryptographic hashes.
 * Group by the actual well-formed content string, NOT by its claimed digest.
 * At most1000 records /8MiB compact JSON under the shared contract; no row cap
 * is applied before grouping. Checkpoints protect all asynchronous delivery.
 */
export async function inspectMemorySnapshotDuplicates(file,checkpoint=()=>{}) {
  checkpoint();
  queryMemorySnapshot(file); // WeakSet-backed handle check before field access.
  const rows=file.snapshot.memories,byContent=new Map();
  for(let i=0;i<rows.length;i++) {
    checkpoint();
    if(i%32===0){await yieldToEventLoop();checkpoint();}
    const row=rows[i];
    if(!byContent.has(row.content))byContent.set(row.content,[]);
    byContent.get(row.content).push(row);
  }
  const groups=[];
  let groupedRecords=0,processed=0;
  for(const matches of byContent.values()) {
    checkpoint();
    if(matches.length<2)continue;
    const first=matches[0],different=new Set(),projects=new Set(),members=[];
    const baseline=Object.fromEntries(DIFFERENCE_FIELDS.map(k=>[k,valueKey(first[k])]));
    const statusCounts={candidate:0,active:0,archived:0};
    for(const row of matches) {
      checkpoint();
      // Yield inside a large group too, not only between groups.
      if(processed++%32===0){await yieldToEventLoop();checkpoint();}
      for(const field of DIFFERENCE_FIELDS)if(!different.has(field)&&valueKey(row[field])!==baseline[field])different.add(field);
      statusCounts[row.status]++;projects.add(row.project_id);members.push(member(row));
    }
    groupedRecords+=matches.length;
    groups.push(Object.freeze({group_id:first.id,content_hash:first.content_hash,member_count:matches.length,
      status_counts:Object.freeze(statusCounts),cross_project:projects.size>1,
      different_fields:Object.freeze(DIFFERENCE_FIELDS.filter(k=>different.has(k))),members:Object.freeze(members)}));
  }
  // Input rows are already strictly ID-ordered by the shared file contract.
  // Map insertion order therefore orders groups by their smallest member ID;
  // this ID is a label only, not a recommended record to keep.
  checkpoint();
  return Object.freeze({format:'ultrabrain-snapshot-duplicates-v1',scope:'same-verified-file-all-records',
    equality:'exact-content-no-normalization',record_count:rows.length,
    counts:Object.freeze({distinct_contents:byContent.size,singleton_records:rows.length-groupedRecords,
      duplicate_groups:groups.length,records_in_duplicate_groups:groupedRecords,repeated_occurrences:groupedRecords-groups.length}),
    groups:Object.freeze(groups),complete:true,text_included:false,read_only:true,
    automatic_merge_safe:false,identity_verified:false,truth_verified:false,
    limitations:Object.freeze(['same-text-is-not-record-equivalence','not-a-delete-or-merge-plan','metadata-is-private',
      'no-live-database-check','no-fuzzy-or-semantic-matching','no-document-original-byte-comparison'])});
}
