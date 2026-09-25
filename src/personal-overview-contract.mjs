/** Shared browser/server aggregate contract. No IO, model calls or mutation authority. */
export const OVERVIEW_FORMAT='ultrabrain-personal-overview-v1';
export const OVERVIEW_SCOPE='owned-all-projects';
export const OVERVIEW_COUNT_MAX=2147483647;
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
/** Snapshot data descriptors once: validation must cover the returned values.
 * Reject accessors, hidden fields and symbol extras without running user getters.
 * Data records from another realm or with a null prototype remain supported.
 */
function record(value,keys,code){
 try{
  if(!object(value))fail(code);
  const descriptors=Object.getOwnPropertyDescriptors(value),names=Reflect.ownKeys(descriptors);
  if(names.length!==keys.length||!keys.every(key=>Object.hasOwn(descriptors,key)))fail(code);
  const entries=keys.map(key=>{
   const descriptor=descriptors[key];
   if(!descriptor.enumerable||!Object.hasOwn(descriptor,'value'))fail(code);
   return [key,descriptor.value];
  });
  return Object.fromEntries(entries);
 }catch{fail(code);}
}
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const date=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)&&
 Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const count=v=>Number.isSafeInteger(v)&&v>=0&&v<=OVERVIEW_COUNT_MAX;
function fail(code){throw Object.assign(new Error(code),{code});}
export function overviewRequest(input){
 const request=record(input,['request_id'],'invalid_params');
 if(!uuid(request.request_id))fail('invalid_params');
 return Object.freeze(request);
}
const fields=Object.freeze({
 memories:['total','candidate','active','archived','active_current','active_stale','candidate_stale','document_fragments'],
 jobs:['total','queued','processing','completed','failed','stale','processing_live','processing_expired','failed_below_attempt_limit'],
 documents:['total','active','archived'],agents:['total'],
});
/** Entire response or nothing. Validate partitions, not merely HTTP success.
 * Current/stale follows the existing direct-source predicate, not model quality,
 * content-hash revalidation or transitive truth. Lease observations grant no retry.
 */
export function verifyPersonalOverview(value,request,source){
 const valid=v=>{if(!v)fail('personal_overview_unconfirmed');};
 value=record(value,['format','scope','source_id','request_id','observed_at','read_only','model_calls','trust',...Object.keys(fields)],'personal_overview_unconfirmed');
 request=record(request,['request_id'],'personal_overview_unconfirmed');
 for(const [group,names]of Object.entries(fields))value[group]=record(value[group],names,'personal_overview_unconfirmed');
 valid(typeof source==='string'&&/^[a-z0-9-]{1,32}$/.test(source)&&value.source_id===source&&
  uuid(request?.request_id)&&value.request_id===request.request_id&&value.format===OVERVIEW_FORMAT&&value.scope===OVERVIEW_SCOPE&&
  date(value.observed_at)&&value.read_only===true&&value.model_calls===0&&value.trust==='untrusted-memory-metadata');
 for(const [group,names]of Object.entries(fields))valid(names.every(k=>count(value[group][k])));
 const m=value.memories,j=value.jobs,d=value.documents;
 valid(m.total===m.candidate+m.active+m.archived&&m.active===m.active_current+m.active_stale&&
  m.candidate_stale<=m.candidate&&m.document_fragments<=m.total&&
  j.total===j.queued+j.processing+j.completed+j.failed+j.stale&&j.processing===j.processing_live+j.processing_expired&&
  j.failed_below_attempt_limit<=j.failed&&d.total===d.active+d.archived);
 // Only fixed primitive fields are retained; caller-owned nested objects remain untouched.
 const copy={...value};
 for(const [group,names]of Object.entries(fields))copy[group]=Object.freeze(Object.fromEntries(names.map(k=>[k,value[group][k]])));
 return Object.freeze(copy);
}
