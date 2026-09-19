import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sha256} from '../src/core.mjs';
import {clientProfile} from '../src/client-kit.mjs';
import {readLocalDocument,deliverDocumentImport,documentImportRequest} from '../src/client-document.mjs';
import {planDocumentFragments,documentFragment} from '../src/personal-document-core.mjs';
const profile={source:'default',projectId:'test',allowDocuments:true};
const file=()=>({agent_id:'doc-agent',event_id:'doc-event',consent:true,label:'note.txt',content_base64:Buffer.from('不要删除。\r\n').toString('base64'),content_sha256:sha256('不要删除。\r\n')});
const receipt=()=>({source_id:'default',event_id:'doc-event',storage:'stored',document_id:'11111111-1111-4111-8111-111111111111',content_sha256:file().content_sha256,agent_id:'doc-agent',project_id:'test'});
function temp(t){const dir=fs.mkdtempSync(join(tmpdir(),'ub-doc-boundary-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
test('documents require their own opt-in, independent of conversation capture',()=>{
 const base={format:1,source:'default',server:{transport:'stdio',command:'node',args:[]}};
 assert.equal(clientProfile(base).allowDocuments,false);assert.equal(clientProfile({...base,allow_capture:true}).allowDocuments,false);
 assert.equal(clientProfile({...base,allow_documents:true}).allowCapture,false);
 assert.throws(()=>clientProfile({...base,allow_documents:'true'}));
 assert.throws(()=>documentImportRequest(file(),{...profile,allowDocuments:false}),{code:'capture_disabled'});
});
for(const consent of [undefined,false])test('delivery cannot manufacture missing consent '+consent,async()=>{
 await assert.rejects(deliverDocumentImport({...file(),consent},profile,{checkIdentity:()=>assert.fail('No network'),invoke:()=>assert.fail('No send')}),{code:'capture_disabled'});
});
test('fingerprint, canonical encoding and declared metadata are checked before network',async()=>{
 for(const change of [{content_sha256:'0'.repeat(64)},{content_base64:'YW=='},{byte_size:5},{has_bom:true}])
  await assert.rejects(deliverDocumentImport({...file(),...change},profile,{checkIdentity:()=>assert.fail('No network'),invoke:()=>assert.fail('No network')}));
});
test('the selected original and consent are frozen before asynchronous work',async()=>{
 const input=file();let sent;const r=await deliverDocumentImport(input,profile,{checkIdentity:async()=>{input.consent=false;input.content_base64='Yg==';},invoke:async(n,p)=>{if(n.endsWith('_import'))sent=p;return n==='ultra_agent_list'?{source_id:'default',agents:[],next_offset:null}:receipt();}});
 assert.equal(sent.content_base64,file().content_base64);assert.equal(r.document_id,receipt().document_id);
});
test('revocation while registering prevents the later document write',async()=>{
 let allowed=true,sent=false;await assert.rejects(deliverDocumentImport(file(),profile,{checkIdentity:async()=>{},authorize:()=>{if(!allowed)throw Error('revoked');},invoke:async n=>{if(n==='ultra_agent_list')return {source_id:'default',agents:[],next_offset:null};if(n==='ultra_agent_register')allowed=false;else sent=true;}}));assert.equal(sent,false);
});
test('cancellation or asynchronous authorization is not permission',async()=>{
 const c=new AbortController();c.abort();await assert.rejects(deliverDocumentImport(file(),profile,{signal:c.signal,checkIdentity:()=>assert.fail('No network'),invoke:()=>assert.fail('No network')}),{code:'aborted'});
 await assert.rejects(deliverDocumentImport(file(),profile,{authorize:async()=>true,checkIdentity:()=>assert.fail('No network'),invoke:()=>assert.fail('No network')}),{code:'invalid_params'});
});
for(const change of [{event_id:'wrong'},{source_id:'foreign'},{project_id:'other'},{content_sha256:'0'.repeat(64)}])test('receipt mismatch is unconfirmed '+JSON.stringify(change),async()=>{
 await assert.rejects(deliverDocumentImport(file(),profile,{checkIdentity:async()=>{},invoke:async n=>n==='ultra_agent_list'?{source_id:'default',agents:[],next_offset:null}:({...receipt(),...change})}),{code:'mcp_contract_changed'});
});
test('planner preserves exact large Chinese, BOM, CRLF and emoji bytes',()=>{
 const bytes=Buffer.from('\uFEFF不要删除。🙂\r\n'.repeat(4000));const ranges=planDocumentFragments(bytes),parts=[];
 for(const f of ranges){assert.ok(f.byte_length<=32768);const fragment=documentFragment(bytes,{byte_start:f.byte_start,byte_end:f.byte_start+f.byte_length});parts.push(Buffer.from(fragment.text));}
 assert.ok(ranges.length>1);assert.deepEqual(Buffer.concat(parts),bytes);
});
test('non-processable originals are never silently re-encoded for queueing',()=>{
 for(const s of ['a\0b',' \r\n'])assert.throws(()=>documentFragment(Buffer.from(s),{byte_start:0,byte_end:Buffer.byteLength(s)}),{code:'fragment_not_processable'});
});
test('selected path replacement is detected before descriptor reads',t=>{
 const dir=temp(t),p=join(dir,'selected.txt');fs.writeFileSync(p,'original');
 const realOpen=fs.openSync,realRead=fs.readSync;let bytesRead=false;
 fs.openSync=(name,...args)=>{if(name===p){fs.renameSync(p,join(dir,'old.txt'));fs.writeFileSync(p,'sameSize');}return realOpen(name,...args);};
 fs.readSync=(...args)=>{bytesRead=true;return realRead(...args);};syncBuiltinESMExports();
 try{assert.throws(()=>readLocalDocument(p),{code:'file_changed'});assert.equal(bytesRead,false);}
 finally{fs.openSync=realOpen;fs.readSync=realRead;syncBuiltinESMExports();}
});
test('parent directory symlinks and Windows junctions are refused',t=>{
 const dir=temp(t),real=join(dir,'real'),alias=join(dir,'alias');fs.mkdirSync(real);fs.writeFileSync(join(real,'a.txt'),'text');
 fs.symlinkSync(real,alias,process.platform==='win32'?'junction':'dir');assert.throws(()=>readLocalDocument(join(alias,'a.txt')),{code:'invalid_path'});
});

test('existing Agent metadata is left untouched even across a paged listing',async()=>{
 const calls=[];
 const response=await deliverDocumentImport(file(),profile,{checkIdentity:async()=>{},invoke:async(name,args)=>{
   calls.push(name);
   if(name==='ultra_agent_list')return args.offset===0?{source_id:'default',agents:[{agent_id:'another'}],next_offset:1}:
     {source_id:'default',agents:[{agent_id:'doc-agent',agent_type:'coding_agent',revision:4,capabilities:['code'],workspace:'/other'}],next_offset:null};
   assert.equal(name,'ultra_personal_document_import');return receipt();
 }});
 assert.equal(response.document_id,receipt().document_id);assert.deepEqual(calls,['ultra_agent_list','ultra_agent_list','ultra_personal_document_import']);
});
for(const result of [{source_id:'foreign',agents:[],next_offset:null},{source_id:'default',agents:[],next_offset:0}])test('malformed Agent listing never authorizes default registration '+JSON.stringify(result),async()=>{
 await assert.rejects(deliverDocumentImport(file(),profile,{checkIdentity:async()=>{},invoke:async n=>{assert.equal(n,'ultra_agent_list');return result;}}),{code:'mcp_contract_changed'});
});
test('truncated Agent lookup fails closed rather than overwriting an unknown existing label',async()=>{
 let calls=0;await assert.rejects(deliverDocumentImport(file(),profile,{checkIdentity:async()=>{},invoke:async(n,args)=>{
   assert.equal(n,'ultra_agent_list');calls++;return {source_id:'default',agents:[{agent_id:'other'}],next_offset:args.offset+1};
 }}),{code:'agent_lookup_limit'});assert.equal(calls,16);
});
test('permission revoked during Agent lookup prevents all writes',async()=>{
 let allowed=true;await assert.rejects(deliverDocumentImport(file(),profile,{checkIdentity:async()=>{},authorize:()=>{if(!allowed)throw Error('revoked');},invoke:async name=>{
   assert.equal(name,'ultra_agent_list');allowed=false;return {source_id:'default',agents:[],next_offset:null};
 }}));
});
for(const when of ['before','identity','lookup','registration','final_identity'])test('boolean document revocation '+when+' prevents subsequent writes',async()=>{
 let permitted=when!=='before',checks=0;const calls=[];
 await assert.rejects(deliverDocumentImport(file(),profile,{authorize:()=>permitted,
  checkIdentity:async()=>{checks++;if(when==='identity'||when==='final_identity'&&checks===3)permitted=false;},
  invoke:async name=>{
   calls.push(name);
   if(name==='ultra_agent_list'){if(when==='lookup')permitted=false;return {source_id:'default',agents:[],next_offset:null};}
   if(name==='ultra_agent_register'&&when==='registration')permitted=false;
   return receipt();
  }}),{code:'capture_disabled'});
 assert.ok(!calls.includes('ultra_personal_document_import'));
 if(['before','identity','lookup'].includes(when))assert.ok(!calls.includes('ultra_agent_register'));
 if(when==='before')assert.equal(checks,0);
});
test('rejected asynchronous document authorization never leaks a rejection or sends a request',async()=>{
 await assert.rejects(deliverDocumentImport(file(),profile,{authorize:async()=>{throw Error('synthetic denial');},
  checkIdentity:()=>assert.fail('No network'),invoke:()=>assert.fail('No network')}),{code:'invalid_params'});
 await new Promise(resolve=>setImmediate(resolve));
});
