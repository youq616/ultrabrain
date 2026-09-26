/** Production console HTTP/CSP + Chromium; startup/list DB is synthetic. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {startPersonalConsole} from '../src/personal-console.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),token=randomBytes(32).toString('hex'),calls=[];
const engine={kind:'postgres',executeRaw:async sql=>{
 calls.push(sql);if(sql==='SELECT id FROM public.sources WHERE id=$1')return [{id:'selected'}];
 if(sql.startsWith('SELECT id::text')&&sql.includes('FROM ultrabrain.personal_memories'))return [];
 assert.fail('Unexpected DB request during local comparison');
},transaction:()=>assert.fail('No comparison transaction')};
const service=await startPersonalConsole({engine,source:'selected',token,port:0,configureModel:()=>assert.fail('No model')});
try{
 const child=spawn(process.env.ULTRABRAIN_BROWSER_PYTHON??'python3',[root+'test/personal-snapshot-duplicate-compare-browser.py'],{
  cwd:root,env:{...process.env,ULTRABRAIN_BROWSER_ORIGIN:service.origin,ULTRABRAIN_BROWSER_TOKEN:token},stdio:['ignore','inherit','inherit']});
 const timer=setTimeout(()=>child.kill('SIGKILL'),120000);
 try{assert.equal(await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);}),0);}
 finally{clearTimeout(timer);}
 assert.equal(calls.length,2,'Only source startup and initial candidate list; no comparison DB read');
 console.log('PASS real HTTP/CSP duplicate-comparison UI; synthetic DB, no data requests during comparison');
}finally{await service.close();}
