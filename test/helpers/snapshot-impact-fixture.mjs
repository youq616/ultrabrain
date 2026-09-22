/** Synthetic single-parent consolidation graphs; no external model or user data. */
import {row,uuid,hash,envelope,encoded} from './snapshot-audit-fixture.mjs';
export {row,uuid,hash,envelope,encoded};
export function reference(source, changes={}) {
  const quote=source.content.slice(0,20);
  return {job_id:uuid(90),input_id:source.id,input_revision:source.revision,input_hash:source.content_hash,
    profile_hash:hash('synthetic impact profile'),quote,start:0,end:quote.length,offset_unit:'UTF-16 code units',...changes};
}
export function graph(parents, changes={}) {
  const rows=parents.map((_,i)=>row(i+1,{content:`PRIVATE_IMPACT_BODY_${i+1} 中文🙂\r\n`,
    provenance:'PRIVATE_IMPACT_PROVENANCE',status:'active',...changes[i+1]}));
  for(let i=0;i<parents.length;i++) if(parents[i]!==null) rows[i].derivation=reference(rows[parents[i]-1]);
  return rows;
}
