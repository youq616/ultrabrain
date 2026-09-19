import {deliverCapture} from '../ultrabrain/src/capture-delivery.mjs';
import {deliverDocumentImport} from '../ultrabrain/src/client-document.mjs';
import {CaptureOutbox} from '../ultrabrain/src/capture-outbox.mjs';
import {sha256} from '../ultrabrain/src/core.mjs';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
console.log(JSON.stringify({reviewed_commit:'77b4ecf649124fc169e4c838b5202d96211e933e',reviewer:'/root/audit_clients',scope:'synthetic local functions; no network, user services or private data'}));
const payload={agent_id:'audit',event_id:'audit',transcript:'SYNTHETIC_NO_SECRET',consent:true};
const writes=[];
await deliverCapture(payload,{allowCapture:true,projectId:null},{checkIdentity:async()=>{},authorize:()=>false,invoke:async(name)=>writes.push(name)});
console.log(JSON.stringify({case:'direct_false_authorization',writes}));
const documentWrites=[],file={agent_id:'audit',event_id:'audit-doc',consent:true,label:'synthetic.txt',content_base64:Buffer.from('SYNTHETIC').toString('base64'),content_sha256:sha256('SYNTHETIC')};
await deliverDocumentImport(file,{source:'default',allowDocuments:true,projectId:null},{checkIdentity:async()=>{},authorize:()=>false,invoke:async name=>{
  documentWrites.push(name);
  return name==='ultra_agent_list'?{source_id:'default',agents:[],next_offset:null}:{source_id:'default',event_id:'audit-doc',storage:'stored',document_id:'33333333-3333-4333-8333-333333333333',content_sha256:file.content_sha256,agent_id:'audit',project_id:null};
}});
console.log(JSON.stringify({case:'document_false_authorization',writes:documentWrites}));
const dir=mkdtempSync(join(tmpdir(),'ub-audit-auth-'));
try {
 const workspace=join(dir,'work');mkdirSync(workspace,{mode:0o700});
 const input={format:1,source:'default',allow_capture:true,workspace,outbox_directory:join(dir,'queue'),expected_instance:'11111111-1111-4111-8111-111111111111',expected_actor:'a'.repeat(64),server:{transport:'stdio',command:'node',args:[]}};
 const q=new CaptureOutbox(input);
 const stored=await q.enqueue(payload,{authorize:()=>false});
 console.log(JSON.stringify({case:'queue_false_authorization',stored,pending:(await q.status()).pending}));
 let transmitted=0;
 const delivered=await q.flush(async()=>({identity:{format:1,source_id:'default',instance_id:input.expected_instance,actor_key:input.expected_actor},capture:async()=>{transmitted++;return {source_id:'default',event_id:'audit',storage:'journaled',job_id:'22222222-2222-4222-8222-222222222222'};},close:async()=>{}}),{authorize:async()=>false});
 console.log(JSON.stringify({case:'flush_async_false_authorization',transmitted,delivered}));
} finally {rmSync(dir,{recursive:true,force:true});}
