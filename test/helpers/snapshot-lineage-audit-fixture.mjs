/** Synthetic direct-source relationships, never private memory or model outputs. */
import {row,uuid,hash,envelope,encoded} from './snapshot-audit-fixture.mjs';
export {row,uuid,hash,envelope,encoded};
export function linkedRows(sourceChanges={}, memoryChanges={}, referenceChanges={}) {
  const source=row(1,{content:'PRIVATE_SOURCE 前🙂\r\nPRIVATE_QUOTE 尾',status:'active',...sourceChanges});
  const quote='PRIVATE_QUOTE',start=source.content.indexOf(quote);
  const memory=row(2,{content:'PRIVATE_DERIVED_BODY',provenance:'PRIVATE_PROVENANCE',status:'active',
    derivation:{job_id:uuid(90),input_id:source.id,input_revision:source.revision,input_hash:source.content_hash,
      profile_hash:hash('synthetic profile'),quote,start,end:start+quote.length,offset_unit:'UTF-16 code units',...referenceChanges},
    ...memoryChanges});
  return [source,memory];
}
