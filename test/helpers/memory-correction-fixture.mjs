import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {row,uuid,hash} from './snapshot-audit-fixture.mjs';
export {uuid,hash};
export function fixture(t){
 const workspace=mkdtempSync(join(tmpdir(),'ub-correction-'));t.after(()=>rmSync(workspace,{recursive:true,force:true}));
 const profile={source:'selected',workspace,expectedInstance:uuid(99),expectedActor:'a'.repeat(64),projectId:null,allowCapture:true};
 const replacement={type:'preference',content:'PRIVATE_CORRECTED 🙂\r\n',provenance:'PRIVATE_NEW_SOURCE',importance:'high',confidence:0,visibility:'private',project_id:null};
 const request={operation:'correct',memory_id:uuid(1),workspace,consent:true,event_id:'correct-one',expected_revision:1,
  expected_content_hash:hash('PRIVATE_OLD'),expected_status:'active',expected_visibility:'private',expected_project_id:null,acknowledge_reset:true,memory:replacement};
 const state={row:row(1,{content:'PRIVATE_OLD',status:'active'}),calls:[],reply:{id:uuid(1),revision:2,status:'candidate',replayed:false,review_required:true}};
 const io={checkIdentity:async()=>{state.calls.push({name:'identity'});},invoke:async(name,args)=>{
  state.calls.push({name,args});return name==='ultra_memory_read'?{source_id:'selected',memory:structuredClone(state.row),read_only:true,trust:'untrusted-memory-data',coverage:'one'}:structuredClone(state.reply);
 }};
 return {profile,request,state,io,replacement};
}
