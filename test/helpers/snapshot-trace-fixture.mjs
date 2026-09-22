/** Synthetic single-parent paths; no user transcripts or model output. */
import {row,uuid,hash,envelope,encoded} from './snapshot-audit-fixture.mjs';
export {row,uuid,hash,envelope,encoded};
export function reference(source) {
  const quote='TRACE_PRIVATE',start=source.content.indexOf(quote);
  return {job_id:uuid(9001),input_id:source.id,input_revision:source.revision,input_hash:source.content_hash,
    profile_hash:hash('synthetic trace profile'),quote,start,end:start+quote.length,offset_unit:'UTF-16 code units'};
}
export function chain(length=4) {
  const rows=Array.from({length},(_,i)=>row(i+1,{content:`前🙂\r\nTRACE_PRIVATE_${i+1}`,provenance:'TRACE_PRIVATE_PROVENANCE',status:'active'}));
  for(let i=1;i<rows.length;i++)rows[i].derivation=reference(rows[i-1]);
  return rows;
}
