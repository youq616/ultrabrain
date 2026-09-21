/** Explicit synthetic export files; no user data or storage IO. */
import {createHash} from 'node:crypto';
import {SNAPSHOT_FORMAT,SNAPSHOT_SCOPE,SNAPSHOT_EXCLUDES} from '../../src/personal-snapshot-contract.mjs';
export const hash=s=>createHash('sha256').update(s).digest('hex');
export const uuid=n=>String(n).padStart(8,'0')+'-1111-4111-8111-111111111111';
export const row=(n=1,changes={})=>{
 const r={id:uuid(n),type:'preference',origin_kind:'agent',content:'合成内容 '+n+'\r\n🙂',confidence:null,importance:'normal',
  provenance:'Synthetic audit fixture',agent_id:'fixture',project_id:null,status:'candidate',visibility:'private',revision:1,
  created_at:'2026-09-21T00:00:00.000Z',updated_at:'2026-09-21T00:00:00.000Z',last_confirmed:null,owned_by_caller:true,
  derivation:null,derivation_current:true,trust:'untrusted-memory-data',...changes};
 return {...r,content_hash:hash(r.content)};
};
export const envelope=(memories=[row()],changes={})=>({format:SNAPSHOT_FORMAT,scope:SNAPSHOT_SCOPE,source_id:'selected',request_id:uuid(99),
 snapshot_at:'2026-09-21T00:00:00.000Z',read_only:true,complete:true,record_count:memories.length,excluded:[...SNAPSHOT_EXCLUDES],
 memories,memories_sha256:hash(JSON.stringify(memories)),...changes});
export const encoded=(snapshot=envelope())=>new TextEncoder().encode(JSON.stringify(snapshot,null,2)+'\n');
