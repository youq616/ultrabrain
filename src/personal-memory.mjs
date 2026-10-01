/** Canonical personal-memory payloads. Labels and caller scores are not identity or truth. */
import {requireThat,sha256,text,integer} from './core.mjs';
export const PERSONAL_MEMORY_TYPES=Object.freeze(['identity','preference','environment','project','decision','skill','error','goal','experience']);
export const AGENT_TYPES=Object.freeze(['coding_agent','general_agent','automation_agent','custom']);
export function objectFields(value,fields) {
  requireThat(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>fields.includes(k)),
    'invalid_params','Unknown or invalid personal-memory field');
}
export function personalId(value,name='identifier') {
  requireThat(typeof value==='string'&&/^[A-Za-z0-9_-]{1,96}$/.test(value),'invalid_params',`${name} must be a stable ASCII identifier`);
  return value;
}
export function memoryId(value) {
  requireThat(typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value),'invalid_params','Full memory UUID required');
  return value;
}
export function validateMemoryType(type) {
  requireThat(PERSONAL_MEMORY_TYPES.includes(type),'invalid_params','Unknown personal-memory type');return type;
}
export function normalizePersonalMemory(input={}) {
  objectFields(input,['type','content','confidence','importance','provenance','visibility','project_id']);
  const type=validateMemoryType(input.type),content=text(input.content,'content',65536);
  const confidence=input.confidence??null;
  requireThat(confidence===null||typeof confidence==='number'&&Number.isFinite(confidence)&&confidence>=0&&confidence<=1,
    'invalid_params','Confidence must be null or a numeric caller estimate in [0,1]');
  const importance=input.importance??'normal',visibility=input.visibility??'private';
  requireThat(['low','normal','high'].includes(importance),'invalid_params','Invalid importance');
  requireThat(['private','source'].includes(visibility),'invalid_params','Invalid personal visibility');
  const project_id=input.project_id==null?null:personalId(input.project_id,'project_id');
  return Object.freeze({type,content,content_hash:sha256(content),confidence,importance,visibility,project_id,
    provenance:input.provenance===undefined?'agent-report':text(input.provenance,'provenance',2048)});
}
export function contextQuery(input={}) {
  objectFields(input,['agent_id','project_id','task','query','types','status','limit','offset','budget_bytes']);
  const types=input.types??PERSONAL_MEMORY_TYPES;
  requireThat(Array.isArray(types)&&types.length>0&&types.length<=PERSONAL_MEMORY_TYPES.length,'invalid_params','Nonempty bounded types array required');
  types.forEach(validateMemoryType);
  const status=input.status??'active';requireThat(['active','candidate','archived'].includes(status),'invalid_params','Invalid personal status');
  if(input.agent_id!==undefined)personalId(input.agent_id,'agent_id');
  if(input.project_id!==undefined&&input.project_id!==null)personalId(input.project_id,'project_id');
  return Object.freeze({types:[...new Set(types)].sort(),status,agent_id:input.agent_id??null,project_id:input.project_id??null,
    task:input.task===undefined||input.task===''?'':text(input.task,'task',4096),
    query:input.query===undefined||input.query===''?'':text(input.query,'query',4096),
    limit:integer(input.limit,20,1,100),offset:integer(input.offset,0,0,1000000),
    budget_bytes:integer(input.budget_bytes,16000,512,131072)});
}
/** UTC timestamps at PostgreSQL microsecond precision, never rounded through Date. */
function updatedTime(value,name) {
  if(value===undefined)return null;
  const match=typeof value==='string'&&/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$/.exec(value);
  requireThat(match&&match[0]===value,'invalid_params',`${name} requires strict UTC YYYY-MM-DDTHH:mm:ss[.ffffff]Z`);
  const [,year,month,day,hour,minute,second,fraction='']=match;
  const y=Number(year),m=Number(month),d=Number(day);
  const leap=y%4===0&&(y%100!==0||y%400===0);
  const days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
  requireThat(y>=1&&m>=1&&m<=12&&d>=1&&d<=days[m-1]&&Number(hour)<=23&&Number(minute)<=59&&Number(second)<=59,
    'invalid_params',`${name} requires a valid Gregorian UTC date and time`);
  return `${year}-${month}-${day}T${hour}:${minute}:${second}.${fraction.padEnd(6,'0')}Z`;
}
/** Search-only current-row modification bounds; context/profile keep their existing contract. */
export function searchQuery(input={}) {
  objectFields(input,['agent_id','project_id','task','query','types','status','limit','offset','budget_bytes','updated_from','updated_before']);
  const {updated_from,updated_before,...query}=input;
  const from=updatedTime(updated_from,'updated_from'),before=updatedTime(updated_before,'updated_before');
  requireThat(from===null||before===null||from<before,'invalid_params','updated_from must precede updated_before');
  return Object.freeze({...contextQuery(query),updated_from:from,updated_before:before});
}
/** A routing hint only: never changes status, deletes content or invents confidence. */
export function classifyMemory(value) {
  const s=text(value,'classification input',65536).toLowerCase();
  if(/prefer|喜欢|习惯|always|通常/.test(s))return 'preference';
  if(/ubuntu|windows|docker|environment|环境/.test(s))return 'environment';
  if(/decision|决定|采用|选择/.test(s))return 'decision';
  if(/error|错误|failed|失败/.test(s))return 'error';
  if(/project|项目|version|版本/.test(s))return 'project';
  return 'experience';
}
