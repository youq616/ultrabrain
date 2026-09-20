/** Mutation checks for the oracle used by real PostgreSQL acceptance, not a database substitute. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DOCUMENT_MODULE_TABLES,readDocumentModuleLinks,assertDocumentModuleLinks} from './fixtures/document-module-state.mjs';
const documentId='11111111-1111-4111-8111-111111111111',memory='22222222-2222-4222-8222-222222222222';
const job='33333333-3333-4333-8333-333333333333',original=Buffer.from('\ufeffMODULE_ORIGINAL\r\n保留否定词🙂\r\n');
const hash=createHash('sha256').update(original).digest('hex');
const valid=()=>({document_id:documentId,fragment_memory_id:memory,byte_start:0,byte_end:original.length,
  fragment_sha256:hash,offset_unit:'utf8-bytes',linked_document_id:documentId,label:'module-user.md',
  document_status:'archived',document_revision:2,byte_size:original.length,document_hash:hash,
  linked_memory_id:memory,memory_status:'archived',memory_revision:2,origin_kind:'document_fragment',
  content:original.toString('utf8'),memory_hash:hash,job_id:job,job_input_id:memory,input_revision:1,
  input_hash:hash,job_state:'stale',attempts:0});
const verify=rows=>assertDocumentModuleLinks(rows,{documentId,original});
test('acceptance counts the actual fragment table, not only memories and jobs',()=>{
  assert.ok(DOCUMENT_MODULE_TABLES.includes('personal_document_fragments'));assert.equal(Object.isFrozen(DOCUMENT_MODULE_TABLES),true);
});
test('complete archived document/fragment/job state satisfies the oracle',()=>assert.doesNotThrow(()=>verify([valid()])));
for(const rows of [[],[valid(),valid()]])test('missing or duplicated final fragment fails acceptance: '+rows.length,()=>{
  assert.throws(()=>verify(rows));
});
for(const [field,value]of Object.entries({document_id:job,linked_document_id:null,linked_memory_id:null,
  fragment_memory_id:null,job_id:null,job_input_id:job,document_status:'active',document_revision:1,
  memory_status:'candidate',memory_revision:1,origin_kind:'agent',job_state:'completed',attempts:1,
  byte_start:1,byte_end:original.length-1,offset_unit:'characters',fragment_sha256:'0'.repeat(64),
  document_hash:'0'.repeat(64),memory_hash:'0'.repeat(64),input_hash:'0'.repeat(64),
  content:'lost original BOM or negation',input_revision:2}))
 test('broken retained linkage/state is refused: '+field,()=>assert.throws(()=>verify([{...valid(),[field]:value}])));
test('linkage query uses source/actor parameters and keeps missing join targets visible',async()=>{
  const calls=[],engine={executeRaw:async(sql,params)=>{calls.push({sql,params});return [valid()];}};
  verify(await readDocumentModuleLinks(engine,'synthetic-source','a'.repeat(64)));
  assert.deepEqual(calls[0].params,['synthetic-source','a'.repeat(64)]);
  assert.equal((calls[0].sql.match(/LEFT JOIN/g)||[]).length,3);
  for(const alias of ['d','m','j']){
    assert.ok(calls[0].sql.includes(alias+'.source_id=f.source_id'));
    assert.ok(calls[0].sql.includes(alias+'.actor_key=f.actor_key'));
  }
});
