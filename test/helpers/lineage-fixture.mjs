import {row,uuid,hash} from './snapshot-audit-fixture.mjs';
export {row,uuid,hash};
export function lineagePair(){
 const content='前言🙂\r\n不要使用 Docker Hub。\n结尾';
 const quote='不要使用 Docker Hub',start=content.indexOf(quote);
 const source=row(2,{content});
 const memory=row(1,{content:'用户要求不要使用 Docker Hub。',derivation:{job_id:uuid(3),input_id:source.id,input_revision:1,
  input_hash:source.content_hash,profile_hash:hash('fixture:profile'),quote,start,end:start+quote.length,offset_unit:'UTF-16 code units'}});
 return {memory,source};
}
