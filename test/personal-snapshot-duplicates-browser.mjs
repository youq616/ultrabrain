/** Real production HTTP server/CSP/scripts, synthetic initial owner list only.
 * The review consumes local files; no application database should be consulted.
 */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {startPersonalConsole} from '../src/personal-console.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),calls=[];
const engine={kind:'postgres',transaction:()=>assert.fail('Local review must not query a database'),
 executeRaw:async(sql,args)=>{
  calls.push(sql);
  if(sql==='SELECT id FROM public.sources WHERE id=$1'){assert.deepEqual(args,['selected']);return [{id:'selected'}];}
  if(sql.startsWith('SELECT id::text')&&sql.includes('FROM ultrabrain.personal_memories'))return [];
  assert.fail('Unexpected database request');
 }};
const token=randomBytes(32).toString('hex');
const service=await startPersonalConsole({engine,source:'selected',token,port:0,configureModel:()=>assert.fail('No model access')});
try{
 const child=spawn(process.env.ULTRABRAIN_BROWSER_PYTHON??'python3',[root+'test/personal-snapshot-duplicates-browser.py'],
  {cwd:root,env:{...process.env,ULTRABRAIN_BROWSER_ORIGIN:service.origin,ULTRABRAIN_BROWSER_TOKEN:token},stdio:['ignore','inherit','inherit']});
 const timer=setTimeout(()=>child.kill('SIGKILL'),120000);
 try{assert.equal(await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);}),0);}
 finally{clearTimeout(timer);}
 assert.equal(calls.length,2,'Only console startup and login list may query the fixture');
 console.log('PASS authenticated console duplicate-review browser; synthetic startup DB only, no review queries/writes');
}finally{await service.close();}
