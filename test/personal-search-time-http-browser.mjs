/** Shipped authenticated console/CSP + Chromium, with a synthetic read-only engine.
 * This deliberately is NOT PostgreSQL evidence. No dependency installation or models.
 */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {startPersonalConsole} from '../src/personal-console.mjs';
import {personalPrincipal} from '../src/personal-memory-store.mjs';

export const root=fileURLToPath(new URL('../',import.meta.url));
export const agentLabels=['search-time-fixture','Agent_A','agent_a'];
export const metadataFormat='ultrabrain-search-time-fixture',metadataVersion=1,expectedRowCount=504,metadataMaxBytes=1048576;
export const lower='2024-11-03T06:30:00.123456Z',upper='2024-11-03T06:30:00.123458Z';
/** Expectations originate here, never from search results or the SQL under test. */
export function specifications(){
  const rows=[];
  const add=(key,status,updated_at,{owner='owner',visibility='private',needle=true}={})=>rows.push({
    key,status,updated_at,owner,visibility,content:(needle?'TIME_NEEDLE ':'OTHER ')+key,
    visible:owner==='owner'||owner==='peer'&&visibility==='source'&&status==='active'});
  for(const status of ['candidate','active','archived']){
    for(const fraction of ['123455','123456','123457','123458'])add(status+'-'+fraction,status,'2024-11-03T06:30:00.'+fraction+'Z');
    add(status+'-other',status,lower,{needle:false});
    add(status+'-spring',status,'2024-03-10T02:30:00.000001Z');
  }
  // Equal timestamps force the documented UUID tie-break on both sides of page 20.
  for(let i=0;i<25;i++)add('candidate-tied-'+String(i).padStart(2,'0'),'candidate','2024-11-03T06:30:00.500000Z');
  for(const status of ['candidate','active','archived']){
    add('peer-private-'+status,status,lower,{owner:'peer'});
    add('peer-shared-'+status,status,lower,{owner:'peer',visibility:'source'});
    add('foreign-source-'+status,status,lower,{owner:'foreign-source',visibility:'source'});
  }
  add('peer-shared-upper','active',upper,{owner:'peer',visibility:'source'});
  for(const status of ['candidate','active','archived'])add('owner-shared-'+status,status,lower,{visibility:'source'});
  // Identical content and times across labels/global/case-distinct projects are deliberate distractors.
  // Only event keys receive the label prefix; content cannot substitute for exact label equality.
  return agentLabels.flatMap(agent_id=>[null,'Project_A','project_a'].flatMap(project_id=>rows.map(row=>({...row,
    key:agent_id+'-'+(project_id??'global')+'-'+row.key,agent_id,project_id}))));
}
export function artifactDirectory(){
  const directory=resolve(process.env.ULTRABRAIN_SEARCH_TIME_ARTIFACT_DIR??'/tmp/ultrabrain-search-time-browser');
  mkdirSync(directory,{recursive:true});return directory;
}
export function saveReport(name,value){writeFileSync(join(artifactDirectory(),name),JSON.stringify(value,null,2)+'\n');}
export function expectedMetadata(rows,mode){
  assert.ok(['synthetic-http-not-postgresql','native-postgresql'].includes(mode));
  assert.equal(rows.length,expectedRowCount,'The complete three-label/project fixture is required');
  assert.equal(new Set(rows.map(row=>row.id)).size,expectedRowCount,'Every seed has a unique actual ID');
  const envelope={format:metadataFormat,version:metadataVersion,mode,row_count:rows.length,rows};
  const bytes=Buffer.from(JSON.stringify(envelope)+'\n','utf8');
  assert.ok(bytes.length<=metadataMaxBytes,'Fixture metadata must not exceed 1 MiB');
  return {bytes,evidence:{format:metadataFormat,version:metadataVersion,mode,row_count:rows.length,
    byte_size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}};
}
export async function runBrowser(service,token,rows,mode){
  const directory=artifactDirectory(),{bytes,evidence}=expectedMetadata(rows,mode);
  const path=join(directory,'expected-metadata-'+randomBytes(8).toString('hex')+'.json');
  writeFileSync(path,bytes,{flag:'wx',mode:0o600});
  saveReport('metadata-producer-report.json',{...evidence,file:path});
  const started=Date.now();
  const child=spawn(process.env.ULTRABRAIN_BROWSER_PYTHON??'python3',[join(root,'test/personal-search-time-browser.py')],{
    cwd:root,env:{...process.env,ULTRABRAIN_BROWSER_ORIGIN:service.origin,ULTRABRAIN_BROWSER_TOKEN:token,
      ULTRABRAIN_SEARCH_TIME_ARTIFACT_DIR:directory,ULTRABRAIN_SEARCH_TIME_MODE:mode,
      ULTRABRAIN_SEARCH_TIME_EXPECTED_FILE:path,ULTRABRAIN_SEARCH_TIME_EXPECTED_SHA256:evidence.sha256},
    stdio:['ignore','inherit','inherit']});
  const timer=setTimeout(()=>child.kill('SIGKILL'),240000);
  try{
    assert.equal(await new Promise((done,fail)=>{child.once('error',fail);child.once('close',done);}),0,'Search-time Chromium validation failed');
    const retained=readFileSync(path),browser=JSON.parse(readFileSync(join(directory,'browser-report.json'),'utf8'));
    assert.equal(retained.length,evidence.byte_size,'Retained fixture metadata size changed');
    assert.equal(createHash('sha256').update(retained).digest('hex'),evidence.sha256,'Retained fixture metadata changed');
    assert.deepEqual(browser.fixture_metadata,evidence,'Producer and browser metadata evidence must match');
    assert.equal(browser.passed,true);
    assert.equal(browser.contexts.length,2);
    assert.ok(browser.contexts.every(context=>context.search_count<300),'Each context must stay below 300 search requests');
    return {...evidence,browser_elapsed_ms:Date.now()-started,timeout_ms:240000};
  }finally{clearTimeout(timer);}
}
export function syntheticFixture(){
  const source='synthetic-search-time';
  const actor=personalPrincipal({sourceId:source,remote:false,transport:'stdio',engine:{kind:'postgres'}});
  const rows=specifications().map((row,i)=>({...row,id:String(i+1).padStart(8,'0')+'-1111-4111-8111-111111111111'}));
  const calls=[];
  const engine={kind:'postgres',transaction:()=>assert.fail('Browser search cannot start a synthetic write transaction'),executeRaw:async(sql,args)=>{
    calls.push({sql,args});
    if(sql==='SELECT id FROM public.sources WHERE id=$1'){assert.deepEqual(args,[source]);return [{id:source}];}
    assert.ok(sql.startsWith('SELECT id::text')&&sql.includes('FROM ultrabrain.personal_memories m'),'Only the production search SQL is permitted');
    assert.ok(sql.includes('updated_at >= $10::text::timestamptz')&&sql.includes('updated_at < $11::text::timestamptz'));
    assert.equal(args[0],source);assert.equal(args[1],actor);assert.equal(args.length,11);
    const [, ,status,types,project,agent,query,limit,offset,from,before]=args;
    assert.ok(project===null||typeof project==='string'&&/^[A-Za-z0-9_-]{1,96}$/.test(project));
    assert.ok(agent===null||typeof agent==='string'&&/^[A-Za-z0-9_-]{1,96}$/.test(agent));
    assert.ok(sql.includes('($5::text IS NULL OR project_id=$5)'));
    assert.ok(sql.includes('($6::text IS NULL OR agent_id=$6)'));assert.equal(limit,20);
    return rows.filter(row=>row.visible&&row.status===status&&types.includes('preference')&&(project===null||row.project_id===project)&&
      (agent===null||row.agent_id===agent)&&
      row.content.toLowerCase().includes(query.toLowerCase())&&(!from||row.updated_at>=from)&&(!before||row.updated_at<before))
      .sort((a,b)=>a.updated_at>b.updated_at?-1:a.updated_at<b.updated_at?1:a.id<b.id?-1:1)
      .slice(offset,offset+limit).map(row=>({id:row.id,type:'preference',origin_kind:'agent',content:row.content,
        content_hash:createHash('sha256').update(row.content).digest('hex'),confidence:0.625,importance:'normal',
        provenance:'Synthetic browser fixture only',agent_id:row.agent_id,project_id:row.project_id,status:row.status,
        visibility:row.visibility,revision:row.status==='candidate'?1:2,created_at:'2026-01-01T00:00:00.000Z',
        updated_at:row.updated_at,last_confirmed:null,owned_by_caller:row.owner==='owner',derivation:null,derivation_current:true}));
  }};
  return {source,rows,calls,engine};
}
async function main(){
  const {source,rows,calls,engine}=syntheticFixture(),token=randomBytes(32).toString('hex');
  let service,error,metadata;
  try{
    service=await startPersonalConsole({engine,source,token,port:0,configureModel:()=>assert.fail('No model calls allowed')});
    metadata=await runBrowser(service,token,rows,'synthetic-http-not-postgresql');
    assert.ok(calls.length>30,'Exercise the full browser matrix, not startup only');
    console.log('PASS search-time shipped console HTTP/CSP + Chromium; synthetic engine, NOT PostgreSQL evidence');
  }catch(e){error=e;throw e;}
  finally{
    saveReport('engine-report.json',{mode:'synthetic-http-not-postgresql',passed:!error,fixture_metadata:metadata??null,read_queries:calls.length,
      write_queries:0,model_calls:0,error:error?.message??null});
    await service?.close();
  }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
