/** Shipped authenticated console/CSP + Chromium, with a synthetic read-only engine.
 * This deliberately is NOT PostgreSQL evidence. No dependency installation or models.
 */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {startPersonalConsole} from '../src/personal-console.mjs';
import {personalPrincipal} from '../src/personal-memory-store.mjs';

export const root=fileURLToPath(new URL('../',import.meta.url));
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
  return rows;
}
export function artifactDirectory(){
  const directory=resolve(process.env.ULTRABRAIN_SEARCH_TIME_ARTIFACT_DIR??'/tmp/ultrabrain-search-time-browser');
  mkdirSync(directory,{recursive:true});return directory;
}
export function saveReport(name,value){writeFileSync(join(artifactDirectory(),name),JSON.stringify(value,null,2)+'\n');}
export async function runBrowser(service,token,rows,mode){
  const child=spawn(process.env.ULTRABRAIN_BROWSER_PYTHON??'python3',[join(root,'test/personal-search-time-browser.py')],{
    cwd:root,env:{...process.env,ULTRABRAIN_BROWSER_ORIGIN:service.origin,ULTRABRAIN_BROWSER_TOKEN:token,
      ULTRABRAIN_SEARCH_TIME_ARTIFACT_DIR:artifactDirectory(),ULTRABRAIN_SEARCH_TIME_MODE:mode,
      ULTRABRAIN_SEARCH_TIME_EXPECTED:JSON.stringify(rows)},stdio:['ignore','inherit','inherit']});
  const timer=setTimeout(()=>child.kill('SIGKILL'),240000);
  try{assert.equal(await new Promise((done,fail)=>{child.once('error',fail);child.once('close',done);}),0,'Search-time Chromium validation failed');}
  finally{clearTimeout(timer);}
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
    assert.equal(project,null);assert.equal(agent,null);assert.equal(limit,20);
    return rows.filter(row=>row.visible&&row.status===status&&types.includes('preference')&&
      row.content.toLowerCase().includes(query.toLowerCase())&&(!from||row.updated_at>=from)&&(!before||row.updated_at<before))
      .sort((a,b)=>a.updated_at>b.updated_at?-1:a.updated_at<b.updated_at?1:a.id<b.id?-1:1)
      .slice(offset,offset+limit).map(row=>({id:row.id,type:'preference',origin_kind:'agent',content:row.content,
        content_hash:createHash('sha256').update(row.content).digest('hex'),confidence:0.625,importance:'normal',
        provenance:'Synthetic browser fixture only',agent_id:'search-time-fixture',project_id:null,status:row.status,
        visibility:row.visibility,revision:row.status==='candidate'?1:2,created_at:'2026-01-01T00:00:00.000Z',
        updated_at:row.updated_at,last_confirmed:null,owned_by_caller:row.owner==='owner',derivation:null,derivation_current:true}));
  }};
  return {source,rows,calls,engine};
}
async function main(){
  const {source,rows,calls,engine}=syntheticFixture(),token=randomBytes(32).toString('hex');
  let service,error;
  try{
    service=await startPersonalConsole({engine,source,token,port:0,configureModel:()=>assert.fail('No model calls allowed')});
    await runBrowser(service,token,rows,'synthetic-http-not-postgresql');
    assert.ok(calls.length>30,'Exercise the full browser matrix, not startup only');
    console.log('PASS search-time shipped console HTTP/CSP + Chromium; synthetic engine, NOT PostgreSQL evidence');
  }catch(e){error=e;throw e;}
  finally{
    saveReport('engine-report.json',{mode:'synthetic-http-not-postgresql',passed:!error,read_queries:calls.length,
      write_queries:0,model_calls:0,error:error?.message??null});
    await service?.close();
  }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
