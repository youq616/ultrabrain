/** Real stored/exported fixtures, then local browser-only inspection. No external model calls. */
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {connect,ROOT} from '../src/runtime.mjs';
import {PersonalMemoryStore} from '../src/personal-memory-store.mjs';
import {startPersonalConsole} from '../src/personal-console.mjs';
assert.equal(process.env.ULTRABRAIN_TEST_ALLOW_WRITE,'1','Disposable test database only');
const engine=await connect(),source='inspect-'+randomBytes(5).toString('hex'),token=randomBytes(32).toString('hex');
const directory=await mkdtemp(join(tmpdir(),'ultra-snapshot-inspect-'));
const tables=['personal_memories','personal_events','personal_consolidations','agent_registry','personal_documents','personal_document_fragments'];
const fingerprints=async()=>{
 const result={};for(const table of tables)result[table]=(await engine.executeRaw(`SELECT md5(coalesce(string_agg(row_to_json(t)::text,',' ORDER BY row_to_json(t)::text),'')) AS digest FROM ultrabrain.${table} t WHERE source_id=$1`,[source]))[0].digest;
 return result;
};
let ui;
try{
 await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)',[source]);
 const store=new PersonalMemoryStore({engine,sourceId:source,remote:false,transport:'stdio'});
 await store.register({agent_id:'inspect-fixture',agent_type:'general_agent'});
 const snapshot=()=>store.snapshot({request_id:randomUUID(),consent:true});
 const empty=await snapshot();let changedId;
 for(let i=0;i<23;i++){
  const result=await store.commit({agent_id:'inspect-fixture',event_id:'fixture-'+i,consent:true,
   memories:[{type:'preference',content:'BEFORE_LOCAL_ONLY_'+i+' <img src=x onerror="window.inspectorInjected=1">\r\n🙂',
    project_id:i%2?'project-a':null,provenance:'Explicit synthetic local inspection fixture'}]});
  if(i===0)changedId=result.entries[0].id;
 }
 const left=await snapshot();
 await store.update({memory_id:changedId,expected_revision:1,event_id:'change-one',memory:{type:'preference',
  content:'AFTER_LOCAL_ONLY <script>window.inspectorInjected=1</script>\r\n🙂',provenance:'Explicit synthetic local inspection fixture',importance:'high'}});
 await store.commit({agent_id:'inspect-fixture',event_id:'extra',consent:true,memories:[{type:'goal',content:'ONLY_RIGHT_FILE',provenance:'Synthetic'}]});
 const right=await snapshot();
 assert.equal(left.record_count,23);assert.equal(right.record_count,24);
 for(const [name,data]of Object.entries({left,right,empty}))await writeFile(join(directory,name+'.json'),JSON.stringify(data,null,2)+'\n',{mode:0o600});
 ui=await startPersonalConsole({engine,source,token,port:0});const before=await fingerprints();
 const child=spawn(process.env.ULTRABRAIN_BROWSER_PYTHON??'python3',[ROOT+'/test/personal-snapshot-inspector-browser.py'],{
  cwd:ROOT,env:{...process.env,ULTRABRAIN_BROWSER_ORIGIN:ui.origin,ULTRABRAIN_BROWSER_TOKEN:token,
   ULTRABRAIN_INSPECT_LEFT:join(directory,'left.json'),ULTRABRAIN_INSPECT_RIGHT:join(directory,'right.json'),ULTRABRAIN_INSPECT_EMPTY:join(directory,'empty.json')},
  stdio:['ignore','inherit','inherit']});
 const deadline=setTimeout(()=>child.kill('SIGKILL'),120000);
 try{assert.equal(await new Promise((done,fail)=>{child.once('error',fail);child.once('close',done);}),0,'Snapshot inspector browser failed');}
 finally{clearTimeout(deadline);}
 assert.deepEqual(await fingerprints(),before);
 console.log('PASS snapshot inspection: actual 0/23/24-record exports, no data HTTP during local inspection, six database tables unchanged; no model calls');
}finally{await ui?.close();await engine.disconnect();await rm(directory,{recursive:true,force:true});}
