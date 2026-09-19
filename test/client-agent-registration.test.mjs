import test from 'node:test';
import assert from 'node:assert/strict';
import {deliverCapture} from '../src/capture-delivery.mjs';
import {deliverDocumentImport} from '../src/client-document.mjs';
import {UltraError,sha256} from '../src/core.mjs';
const profile={source:'default',projectId:'project',allowCapture:true,allowDocuments:true};
const payload={agent_id:'existing',event_id:'event',transcript:'Synthetic consented text',consent:true};
const document={agent_id:'existing',event_id:'event',consent:true,label:'note.txt',content_base64:Buffer.from('Synthetic file').toString('base64'),content_sha256:sha256('Synthetic file')};
const receipt={source_id:'default',event_id:'event',agent_id:'existing',project_id:'project',storage:'stored',document_id:'11111111-1111-4111-8111-111111111111',content_sha256:document.content_sha256};
const metadata={agent_id:'existing',agent_type:'coding_agent',capabilities:['code'],workspace:'/owned/workspace',revision:7};
const listing=(agents,next_offset=null)=>({source_id:'default',agents,next_offset});
for(const [kind,deliver,input,write] of [['capture',deliverCapture,payload,'ultra_personal_capture'],['document',deliverDocumentImport,document,'ultra_personal_document_import']]) {
 test(kind+' preserves existing non-default Agent metadata without registration',async()=>{
  const calls=[],before=structuredClone(metadata);
  await deliver(input,profile,{checkIdentity:async()=>{},invoke:async(name)=>{
   calls.push(name);if(name==='ultra_agent_list')return listing([metadata]);
   if(name==='ultra_agent_register')throw new UltraError('revision_conflict','Existing coding Agent');
   assert.equal(name,write);return receipt;
  }});
  assert.deepEqual(metadata,before);assert.deepEqual(calls,['ultra_agent_list',write]);
 });
 test(kind+' tolerates a concurrent registration without overwriting metadata',async()=>{
  const calls=[];let registered=false;
  await deliver(input,profile,{checkIdentity:async()=>{},invoke:async(name,args)=>{
   calls.push(name);if(name==='ultra_agent_list')return listing(registered?[metadata]:[]);
   if(name==='ultra_agent_register'){assert.equal(args.expected_revision,0);registered=true;throw new UltraError('revision_conflict','Another client registered this label');}
   assert.equal(name,write);return receipt;
  }});
  assert.deepEqual(calls,['ultra_agent_list','ultra_agent_register','ultra_agent_list',write]);
 });
 test(kind+' propagates a registration conflict when a fresh lookup is still absent',async()=>{
  const conflict=new UltraError('revision_conflict','Synthetic unresolved conflict');let attempts=0;
  await assert.rejects(deliver(input,profile,{checkIdentity:async()=>{},invoke:async(name)=>{
   if(name==='ultra_agent_list')return listing([]);
   assert.equal(name,'ultra_agent_register');attempts++;throw conflict;
  }}),error=>error===conflict);assert.equal(attempts,1);
 });
 for(const code of ['permission_denied','mcp_rejected','aborted'])test(kind+' does not retry '+code+' registration failures',async()=>{
  let reads=0;
  await assert.rejects(deliver(input,profile,{checkIdentity:async()=>{},invoke:async(name)=>{
   if(name==='ultra_agent_list'){reads++;return listing([]);}
   assert.equal(name,'ultra_agent_register');throw new UltraError(code,'Synthetic failure');
  }}),{code});assert.equal(reads,1);
 });
 for(const when of ['lookup','register','race_lookup'])test(kind+' stops on revocation during '+when,async()=>{
  let permitted=true,reads=0,writes=0;
  await assert.rejects(deliver(input,profile,{authorize:()=>permitted,checkIdentity:async()=>{},invoke:async(name)=>{
   if(name==='ultra_agent_list'){reads++;if(when==='lookup'||when==='race_lookup'&&reads===2)permitted=false;return listing(reads===2?[metadata]:[]);}
   if(name==='ultra_agent_register'){if(when==='register')permitted=false;throw new UltraError('revision_conflict','Synthetic race');}
   writes++;return receipt;
  }}),{code:'capture_disabled'});assert.equal(writes,0);
 });
 test(kind+' rechecks identity before recovering a concurrent registration',async()=>{
  let checks=0,reads=0;
  await assert.rejects(deliver(input,profile,{checkIdentity:async()=>{if(++checks===3)throw new UltraError('identity_mismatch','Changed principal');},invoke:async(name)=>{
   if(name==='ultra_agent_list'){reads++;return listing([]);}
   assert.equal(name,'ultra_agent_register');throw new UltraError('revision_conflict','Synthetic race');
  }}),{code:'identity_mismatch'});assert.equal(reads,1);
 });
}
for(const [label,result] of [
 ['foreign source',{source_id:'foreign',agents:[],next_offset:null}],
 ['missing cursor',listing([],undefined)],
 ['repeated cursor',listing([],0)],
 ['jumped cursor',listing([{agent_id:'other'}],2)],
 ['invalid label',listing([{agent_id:'../other'}])],
 ['oversized page',listing(Array.from({length:101},()=>({agent_id:'other'})))],
])test('capture refuses '+label+' before any write',async()=>{
 if(label==='missing cursor')delete result.next_offset;
 await assert.rejects(deliverCapture(payload,profile,{checkIdentity:async()=>{},invoke:async name=>{
  assert.equal(name,'ultra_agent_list');return result;
 }}),{code:'mcp_contract_changed'});
});
test('capture bounds lookup to sixteen pages without registration or plaintext',async()=>{
 let reads=0;
 await assert.rejects(deliverCapture(payload,profile,{checkIdentity:async()=>{},invoke:async(name,args)=>{
  assert.equal(name,'ultra_agent_list');reads++;return listing([{agent_id:'other'}],args.offset+1);
 }}),{code:'agent_lookup_limit'});assert.equal(reads,16);
});
test('capture finds a registered Agent on a later page without registration',async()=>{
 const calls=[];
 await deliverCapture(payload,profile,{checkIdentity:async()=>{},invoke:async(name,args)=>{
  calls.push(name);if(name==='ultra_agent_list')return args.offset===0?listing([{agent_id:'another'}],1):listing([metadata]);
  assert.equal(name,'ultra_personal_capture');return receipt;
 }});assert.deepEqual(calls,['ultra_agent_list','ultra_agent_list','ultra_personal_capture']);
});
test('cancellation during Agent lookup prevents registration and capture',async()=>{
 const controller=new AbortController();
 await assert.rejects(deliverCapture(payload,profile,{signal:controller.signal,checkIdentity:async()=>{},invoke:async name=>{
  assert.equal(name,'ultra_agent_list');controller.abort();return listing([]);
 }}),{code:'aborted'});
});
