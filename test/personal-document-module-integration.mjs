/** Whole module acceptance on an explicit disposable PostgreSQL instance. No user data/models. */
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {connect,ROOT} from '../src/runtime.mjs';
import {PersonalMemoryStore} from '../src/personal-memory-store.mjs';
import {PersonalDocumentStore} from '../src/personal-documents.mjs';
import {startPersonalConsole} from '../src/personal-console.mjs';
assert.equal(process.env.ULTRABRAIN_TEST_ALLOW_WRITE,'1','Disposable test database must be explicitly authorized');
const engine=await connect(),source='document-module-'+randomBytes(5).toString('hex'),token=randomBytes(32).toString('hex');
let ui;
const ctx={engine,sourceId:source,remote:false,transport:'stdio'};
const counts=async()=>{
  const result={};for(const table of ['personal_memories','personal_events','personal_consolidations','personal_documents'])
    result[table]=(await engine.executeRaw(`SELECT count(*)::integer AS n FROM ultrabrain.${table} WHERE source_id=$1`,[source]))[0].n;
  return result;
};
try{
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)',[source]);
  await new PersonalMemoryStore(ctx).register({agent_id:'module-fixture',agent_type:'general_agent'});
  const documents=new PersonalDocumentStore(ctx);
  const {createHash}=await import('node:crypto');
  for(let i=0;i<23;i++){
    const bytes=Buffer.from('MODULE_FIXTURE_'+i),label=`module-fixture-${String(i).padStart(2,'0')}.txt`;
    const d=await documents.documentImport({agent_id:'module-fixture',event_id:'fixture-'+i,consent:true,label,
      content_base64:bytes.toString('base64'),content_sha256:createHash('sha256').update(bytes).digest('hex')});
    if(i>=21)await documents.documentArchive({document_id:d.document_id,event_id:'archive-fixture-'+i});
  }
  const before=await counts();ui=await startPersonalConsole({engine,source,token,port:0});
  const child=spawn(process.env.ULTRABRAIN_BROWSER_PYTHON??'python3',[ROOT+'/test/personal-document-module-browser.py'],{
    cwd:ROOT,env:{...process.env,ULTRABRAIN_BROWSER_ORIGIN:ui.origin,ULTRABRAIN_BROWSER_TOKEN:token},stdio:['ignore','inherit','inherit']});
  const timer=setTimeout(()=>child.kill('SIGKILL'),120000);
  try{assert.equal(await new Promise((done,fail)=>{child.once('error',fail);child.once('close',done);}),0,'Document module browser failed');}
  finally{clearTimeout(timer);}
  const after=await counts();
  assert.deepEqual(Object.fromEntries(Object.keys(before).map(k=>[k,after[k]-before[k]])),
    {personal_memories:1,personal_events:3,personal_consolidations:1,personal_documents:1});
  const [document]=await engine.executeRaw("SELECT status,revision FROM ultrabrain.personal_documents WHERE source_id=$1 AND label='module-user.md'",[source]);
  assert.deepEqual(document,{status:'archived',revision:2});
  const jobs=await engine.executeRaw('SELECT state,attempts FROM ultrabrain.personal_consolidations WHERE source_id=$1',[source]);
  assert.deepEqual(jobs,[{state:'stale',attempts:0}]);
  const [draft]=await engine.executeRaw("SELECT count(*)::integer AS n FROM ultrabrain.personal_memories WHERE source_id=$1 AND content='MODULE_UNSAVED_DRAFT'",[source]);
  assert.equal(draft.n,0);
  console.log('PASS whole document module: 3 explicit events, 1 retained archived document, 1 archived fragment, 1 stale zero-attempt job; no draft capture');
}finally{await ui?.close();await engine.disconnect();}
