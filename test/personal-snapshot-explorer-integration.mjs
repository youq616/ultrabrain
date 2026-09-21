/** Actual export/store integration; synthetic preparation writes, then zero-mutation browser phase. */
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {connect,ROOT} from '../src/runtime.mjs';
import {PersonalMemoryStore} from '../src/personal-memory-store.mjs';
import {PersonalDocumentStore} from '../src/personal-documents.mjs';
import {startPersonalConsole} from '../src/personal-console.mjs';
assert.equal(process.env.ULTRABRAIN_TEST_ALLOW_WRITE,'1','Disposable database only');
const engine=await connect(),source='explore-'+randomBytes(5).toString('hex'),token=randomBytes(32).toString('hex');
const directory=await mkdtemp(join(tmpdir(),'ultra-snapshot-explore-'));let ui;
const tables=['personal_memories','personal_events','personal_consolidations','agent_registry','personal_documents','personal_document_fragments'];
const fingerprints=async()=>{
 const result={};for(const table of tables)result[table]=(await engine.executeRaw(`SELECT md5(coalesce(string_agg(row_to_json(t)::text,',' ORDER BY row_to_json(t)::text),'')) AS digest FROM ultrabrain.${table} t WHERE source_id=$1`,[source]))[0].digest;
 return result;
};
try{
 await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)',[source]);
 const ctx={engine,sourceId:source,remote:false,transport:'stdio'},store=new PersonalMemoryStore(ctx),documents=new PersonalDocumentStore(ctx);
 for(const agent_id of ['explorer-a','explorer-b'])await store.register({agent_id,agent_type:'general_agent'});
 const snapshot=()=>store.snapshot({request_id:randomUUID(),consent:true});
 const empty=await snapshot();
 for(let i=0;i<43;i++){
  const result=await store.commit({agent_id:i%2?'explorer-b':'explorer-a',event_id:'record-'+i,consent:true,
   memories:[{type:i%2?'goal':'preference',content:'EXPLORER_PRIVATE_'+i+' Alpha %_*[] 🙂 <img src=x onerror="window.explorerInjected=1">',
    project_id:i%3===0?null:i%3===1?'project-a':'project-b',importance:['low','normal','high'][i%3],provenance:'UNIQUE_PROVENANCE_ONLY'}]});
  if(i%3)await store.review({memory_id:result.entries[0].id,expected_revision:1,event_id:'review-'+i,status:i%3===1?'active':'archived'});
 }
 const content=Buffer.from('EXPLORER_DOCUMENT_FRAGMENT 🙂\r\n');
 const imported=await documents.documentImport({agent_id:'explorer-a',event_id:'doc-import',consent:true,label:'synthetic.txt',
  content_base64:content.toString('base64'),content_sha256:createHash('sha256').update(content).digest('hex')});
 const queued=await documents.documentQueue({document_id:imported.document_id,event_id:'doc-queue'});
 assert.equal(queued.fragments.length,1);assert.equal(queued.model_calls,0);
 const left=await snapshot();assert.equal(left.record_count,44);
 await store.commit({agent_id:'explorer-a',event_id:'extra',consent:true,memories:[{type:'goal',content:'RIGHT_EXTRA',provenance:'Synthetic'}]});
 const right=await snapshot();assert.equal(right.record_count,45);
 for(const [name,value]of Object.entries({left,right,empty}))await writeFile(join(directory,name+'.json'),JSON.stringify(value,null,2)+'\n',{mode:0o600});
 ui=await startPersonalConsole({engine,source,token,port:0});const before=await fingerprints();
 const child=spawn(process.env.ULTRABRAIN_BROWSER_PYTHON??'python3',[ROOT+'/test/personal-snapshot-explorer-browser.py'],{
  cwd:ROOT,env:{...process.env,ULTRABRAIN_BROWSER_ORIGIN:ui.origin,ULTRABRAIN_BROWSER_TOKEN:token,
   ULTRABRAIN_EXPLORE_LEFT:join(directory,'left.json'),ULTRABRAIN_EXPLORE_RIGHT:join(directory,'right.json'),ULTRABRAIN_EXPLORE_EMPTY:join(directory,'empty.json')},stdio:['ignore','inherit','inherit']});
 const deadline=setTimeout(()=>child.kill('SIGKILL'),120000);
 try{assert.equal(await new Promise((done,fail)=>{child.once('error',fail);child.once('close',done);}),0,'Snapshot explorer browser failed');}
 finally{clearTimeout(deadline);}
 assert.deepEqual(await fingerprints(),before);
 console.log('PASS snapshot explorer: actual 0/44/45-record exports with three states, two projects and a real document fragment; six tables unchanged, no model calls');
}finally{await ui?.close();await engine.disconnect();await rm(directory,{recursive:true,force:true});}
