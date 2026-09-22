/** Local real-browser harness with an explicitly synthetic database adapter, not PostgreSQL evidence. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {startPersonalConsole} from '../src/personal-console.mjs';
import {row,envelope} from './helpers/snapshot-audit-fixture.mjs';
const dir=await mkdtemp(join(tmpdir(),'ultra-explorer-local-')),token=randomBytes(32).toString('hex');let ui;
try{
 const rows=Array.from({length:43},(_,i)=>row(i,{agent_id:i%2?'explorer-b':'explorer-a',type:i%2?'goal':'preference',
  status:['candidate','active','archived'][i%3],project_id:i%3===0?null:i%3===1?'project-a':'project-b',importance:['low','normal','high'][i%3],
  content:'EXPLORER_PRIVATE_'+i+' Alpha %_*[] 🙂 <img src=x onerror="window.explorerInjected=1">',provenance:'UNIQUE_PROVENANCE_ONLY'}));
 rows.push(row(43,{origin_kind:'document_fragment',content:'EXPLORER_DOCUMENT_FRAGMENT 🙂\r\n'}));
 for(const [name,records]of Object.entries({left:rows,right:[...rows,row(44,{content:'RIGHT_EXTRA'})],empty:[]}))
  await writeFile(join(dir,name+'.json'),JSON.stringify(envelope(records),null,2)+'\n',{mode:0o600});
 const engine={kind:'postgres',executeRaw:async sql=>sql.startsWith('SELECT id FROM public.sources')?[{id:'selected'}]:[],
  transaction:async()=>assert.fail('No synthetic writes allowed')};
 ui=await startPersonalConsole({engine,source:'selected',token,port:0});
 const child=spawn(process.env.ULTRABRAIN_BROWSER_PYTHON??'python3',[new URL('./personal-snapshot-explorer-browser.py',import.meta.url).pathname],{
  env:{...process.env,ULTRABRAIN_BROWSER_ORIGIN:ui.origin,ULTRABRAIN_BROWSER_TOKEN:token,
   ULTRABRAIN_EXPLORE_LEFT:join(dir,'left.json'),ULTRABRAIN_EXPLORE_RIGHT:join(dir,'right.json'),ULTRABRAIN_EXPLORE_EMPTY:join(dir,'empty.json'),
   ULTRABRAIN_EXPLORER_SCOPE:'Real Chromium and production console with synthetic files/adapter; NOT real PostgreSQL or user deployment'},
  stdio:['ignore','inherit','inherit']});
 const deadline=setTimeout(()=>child.kill('SIGKILL'),120000);
 try{assert.equal(await new Promise((done,fail)=>{child.once('error',fail);child.once('close',done);}),0);}
 finally{clearTimeout(deadline);}
}finally{await ui?.close();await rm(dir,{recursive:true,force:true});}
