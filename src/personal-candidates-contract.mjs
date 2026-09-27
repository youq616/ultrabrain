/** Canonical owner-candidate metadata page contract. No content or write authority. */
import {PERSONAL_MEMORY_TYPES} from './personal-memory.mjs';
export const CANDIDATES_FORMAT='ultrabrain-personal-candidates-v1';
export const CANDIDATES_SCOPE='owned-agent-candidates-global-and-project';
export const CANDIDATES_LIMIT=50;
export const CANDIDATES_MAX_BYTES=65536;
const fields=['id','type','agent_id','project_id','importance','confidence','visibility','revision','content_hash',
 'status','origin_kind','created_at','updated_at','derivation_current'];
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const label=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,96}$/.test(v);
const date=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)&&
 Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const fail=code=>{throw Object.assign(new Error(code),{code});};
export function candidateData(value,required,optional=[],code='invalid_params'){
 try{
  if(!value||typeof value!=='object'||Array.isArray(value))fail(code);
  const d=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(d);
  if(!required.every(k=>Object.hasOwn(d,k))||!keys.every(k=>[...required,...optional].includes(k)&&d[k].enumerable&&Object.hasOwn(d[k],'value')))fail(code);
  return Object.fromEntries(keys.map(k=>[k,d[k].value]));
 }catch{fail(code);}
}
export function candidatePageRequest(value){
 const r=candidateData(value,['request_id'],['project_id','after_id','limit']);
 if(!uuid(r.request_id)||Object.hasOwn(r,'project_id')&&!label(r.project_id)||
  Object.hasOwn(r,'after_id')&&!uuid(r.after_id)||Object.hasOwn(r,'limit')&&(!Number.isSafeInteger(r.limit)||r.limit<1||r.limit>CANDIDATES_LIMIT))fail('invalid_params');
 return Object.freeze({...r,limit:r.limit??20});
}
/** Validate every selected row, including the bounded look-ahead row on the server.
 * Descriptor copying keeps tests/callers with accessors from running during checks. */
export function candidateMetadataRows(value,request,max=request.limit){
 const code='personal_candidates_unconfirmed';let rows;
 try{
  if(!Array.isArray(value))fail(code);const d=Object.getOwnPropertyDescriptors(value),length=d.length?.value;
  if(!Number.isSafeInteger(length)||length<0||length>max||Reflect.ownKeys(d).length!==length+1)fail(code);
  rows=Array.from({length},(_,i)=>{const p=d[i];if(!p?.enumerable||!Object.hasOwn(p,'value'))fail(code);return candidateData(p.value,fields,[],code);});
 }catch{fail(code);}
 let previous=request.after_id??'';
 for(const r of rows){
  if(!uuid(r.id)||r.id<=previous||!PERSONAL_MEMORY_TYPES.includes(r.type)||!label(r.agent_id)||
   r.project_id!==null&&(!label(r.project_id)||r.project_id!==request.project_id)||
   !['low','normal','high'].includes(r.importance)||!['private','source'].includes(r.visibility)||
   !(r.confidence===null||typeof r.confidence==='number'&&Number.isFinite(r.confidence)&&r.confidence>=0&&r.confidence<=1)||
   !Number.isSafeInteger(r.revision)||r.revision<1||r.revision>2147483647||
   typeof r.content_hash!=='string'||!/^[a-f0-9]{64}$/.test(r.content_hash)||r.status!=='candidate'||r.origin_kind!=='agent'||
   !date(r.created_at)||!date(r.updated_at)||typeof r.derivation_current!=='boolean')fail(code);
  previous=r.id;Object.freeze(r);
 }
 if(Buffer.byteLength(JSON.stringify(rows))>CANDIDATES_MAX_BYTES)fail(code);
 return Object.freeze(rows);
}
export function verifyCandidatePage(value,input,source){
 const code='personal_candidates_unconfirmed';let request,r;
 try{
  request=candidatePageRequest(input);
  r=candidateData(value,['format','scope','source_id','request_id','project_id','after_id','limit','observed_at','memories',
   'returned','has_more','next_after','read_only','model_calls','trust','snapshot'],[],code);
 }catch{fail(code);}
 if(typeof source!=='string'||!/^[a-z0-9-]{1,32}$/.test(source)||r.source_id!==source||r.format!==CANDIDATES_FORMAT||
  r.scope!==CANDIDATES_SCOPE||r.request_id!==request.request_id||r.project_id!==(request.project_id??null)||
  r.after_id!==(request.after_id??null)||r.limit!==request.limit||!date(r.observed_at)||r.read_only!==true||r.model_calls!==0||
  r.trust!=='untrusted-memory-metadata'||r.snapshot!==false||typeof r.has_more!=='boolean')fail(code);
 r.memories=candidateMetadataRows(r.memories,request);
 if(r.returned!==r.memories.length||r.has_more&&(r.returned!==request.limit||r.next_after!==r.memories.at(-1).id)||
  !r.has_more&&r.next_after!==null||Buffer.byteLength(JSON.stringify(r))>CANDIDATES_MAX_BYTES)fail(code);
 return Object.freeze(r);
}
