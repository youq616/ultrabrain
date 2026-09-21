/** Direct consolidation evidence only. No IO, recursive traversal or truth authority.
 * Record envelopes/content hashes must first pass the existing exact-read verifier.
 */
const refFields=['job_id','input_id','input_revision','input_hash','profile_hash','quote','start','end','offset_unit'];
const scalarFields=['id','type','origin_kind','content','content_hash','confidence','importance','provenance','agent_id','project_id',
  'status','visibility','revision','created_at','updated_at','last_confirmed','owned_by_caller','derivation_current','trust'];
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const fail=code=>{throw Object.assign(new Error(code),{code});};
export function lineageReference(memory){
  if(!memory||!uuid(memory.id))fail('lineage_reference_invalid');
  const d=memory.derivation;
  if(d===null)return null; // Shared reads withhold derivation; absence is not proof of no origin.
  if(memory.owned_by_caller!==true||memory.origin_kind!=='agent'||!d||Array.isArray(d)||
    Object.keys(d).length!==refFields.length||!refFields.every(k=>Object.hasOwn(d,k))||
    !uuid(d.job_id)||!uuid(d.input_id)||d.input_id===memory.id||!hash(d.input_hash)||!hash(d.profile_hash)||
    !Number.isSafeInteger(d.input_revision)||d.input_revision<1||d.input_revision>2147483647||
    typeof d.quote!=='string'||!d.quote.isWellFormed()||!d.quote.trim()||d.quote.includes('\0')||
    new TextEncoder().encode(d.quote).length>2048||d.offset_unit!=='UTF-16 code units'||
    !Number.isSafeInteger(d.start)||!Number.isSafeInteger(d.end)||d.start<0||d.end>32768||
    d.end-d.start!==d.quote.length)fail('lineage_reference_invalid');
  return Object.freeze(Object.fromEntries(refFields.map(k=>[k,d[k]])));
}
/** Two separate current observations, not a transactional or continuously live view.
 * A quote may still match after an edit/archive; do not collapse these dimensions.
 */
export function compareLineage(memory,source){
  const ref=lineageReference(memory);
  if(!ref||!source||source.id!==ref.input_id||source.owned_by_caller!==true||
    typeof source.content!=='string'||!hash(source.content_hash)||!Number.isSafeInteger(source.revision)||source.revision<1||
    !['candidate','active','archived'].includes(source.status))fail('lineage_source_invalid');
  const revision_matches=source.revision===ref.input_revision,content_matches=source.content_hash===ref.input_hash;
  const quote_matches=ref.end<=source.content.length&&source.content.slice(ref.start,ref.end)===ref.quote;
  const state=source.status==='archived'?'archived':!revision_matches||!content_matches?'changed':
    !quote_matches?'quote_mismatch':memory.derivation_current!==true?'inconsistent':'matched';
  return Object.freeze({state,revision_matches,content_matches,quote_matches,source_status:source.status,
    expected_revision:ref.input_revision,observed_revision:source.revision,truth_verified:false});
}
/** Recheck the selected entry after following its reference. Metadata changes matter,
 * including a source invalidation which changes derivation_current without child revision.
 */
export function sameLineageRecord(first,last){
  const a=lineageReference(first),b=lineageReference(last);
  return scalarFields.every(k=>first[k]===last[k])&&
    (a===null||b===null?a===b:refFields.every(k=>a[k]===b[k]));
}
