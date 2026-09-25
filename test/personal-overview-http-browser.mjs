/** Real authenticated console HTTP + production CSP/scripts + Chromium.
 * Aggregate rows are synthetic. This fixture must never claim PostgreSQL evidence.
 */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {startPersonalConsole} from '../src/personal-console.mjs';
import {overviewReceipt} from './helpers/overview-fixture.mjs';
import {PERSONAL_OVERVIEW_SQL} from '../src/personal-overview.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const expected=overviewReceipt(),token=randomBytes(32).toString('hex');
let reads=0;const calls=[];
const executeRaw=async(sql,args)=>{
 calls.push(sql);
 if(sql==='SELECT id FROM public.sources WHERE id=$1')return [{id:'selected'}];
 // Initial owner candidate-list load only; all overview work uses the transaction below.
 if(sql.startsWith('SELECT id::text')&&sql.includes('FROM ultrabrain.personal_memories'))return [];
 assert.fail('Unexpected database operation in synthetic browser fixture');
};
const engine={kind:'postgres',executeRaw,transaction:async fn=>{
 const sequence=[];
 return fn({executeRaw:async(sql,args)=>{
  calls.push(sql);sequence.push(sql);
  if(sql===PERSONAL_OVERVIEW_SQL){
   assert.deepEqual(sequence.slice(0,-1),['SET LOCAL transaction_read_only=on',"SET LOCAL statement_timeout='5s'","SET LOCAL lock_timeout='1s'"]);
   assert.equal(args[0],'selected');assert.match(args[1],/^[a-f0-9]{64}$/);reads++;
   const {observed_at,memories,jobs,documents,agents}=expected;
   return [{observed_at,memories,jobs,documents,agents}];
  }
  assert.ok(['SET LOCAL transaction_read_only=on',"SET LOCAL statement_timeout='5s'","SET LOCAL lock_timeout='1s'"].includes(sql));
  return [];
 }});
}};
const service=await startPersonalConsole({engine,source:'selected',token,port:0,
 configureModel:()=>assert.fail('No model configuration or calls allowed')});
try{
 const child=spawn(process.env.ULTRABRAIN_BROWSER_PYTHON??'python3',[root+'test/personal-overview-browser.py','--synthetic-http'],{
  cwd:root,env:{...process.env,ULTRABRAIN_BROWSER_ORIGIN:service.origin,ULTRABRAIN_BROWSER_TOKEN:token,
   ULTRABRAIN_OVERVIEW_EXPECTED:JSON.stringify(expected)},stdio:['ignore','inherit','inherit']});
 const timeout=setTimeout(()=>child.kill('SIGKILL'),120000);
 try{assert.equal(await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);}),0);}
 finally{clearTimeout(timeout);}
 assert.ok(reads>=8,'Browser exercised refresh, rejection, cancellation and recovery');
 assert.ok(calls.every(sql=>!/^\s*(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE|COPY)\b/i.test(sql)));
 console.log('PASS authenticated console HTTP/CSP + Chromium; synthetic aggregates, no database writes or external models');
}finally{await service.close();}
