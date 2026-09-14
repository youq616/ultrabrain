/** Synthetic original document and queued fragment, never user files or model calls. */
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {connect} from '../src/runtime.mjs';
import {PersonalMemoryStore} from '../src/personal-memory-store.mjs';
import {PersonalDocumentStore} from '../src/personal-documents.mjs';
assert.equal(process.env.ULTRABRAIN_TEST_ALLOW_WRITE,'1');
const engine=await connect(),source='recover-'+randomBytes(5).toString('hex');
try {
 await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)',[source]);
 const ctx={sourceId:source,engine,remote:false,transport:'stdio'};
 await new PersonalMemoryStore(ctx).register({agent_id:'recovery-fixture',agent_type:'custom'});
 const original=Buffer.from('\uFEFF合成恢复样本\r\n不要自动删除，不要修改原文字节。\r\n');
 const store=new PersonalDocumentStore(ctx);
 const result=await store.documentImport({agent_id:'recovery-fixture',event_id:'import',consent:true,
   label:'recovery.md',project_id:'recovery-fixture',content_base64:original.toString('base64'),
   content_sha256:createHash('sha256').update(original).digest('hex')});
 await store.documentQueue({event_id:'queue',document_id:result.document_id});
 console.log(JSON.stringify({source_id:source,document_id:result.document_id,sha256:result.content_sha256}));
} finally {await engine.disconnect();}
