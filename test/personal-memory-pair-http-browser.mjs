/** Real loopback console HTTP/CSP and Chromium; synthetic Store rows, NOT PostgreSQL evidence. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {startPersonalConsole} from '../src/personal-console.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),token=randomBytes(32).toString('hex');
const left='11111111-1111-4111-8111-111111111111',right='22222222-2222-4222-8222-222222222222',sourceId='33333333-3333-4333-8333-333333333333';
const counts=new Map(),calls=[];
const envelopeRow=id=>{
 const count=(counts.get(id)??0)+1;counts.set(id,count);
 const content=id===left?'Prefer concise answers. <b>plain text</b>':'Prefer detailed answers for technical reviews.';
 return {id,type:'preference',origin_kind:'agent',content,content_hash:createHash('sha256').update(content).digest('hex'),status:id===left?'active':'candidate',revision:count,
 confidence:null,importance:'normal',visibility:'private',owned_by_caller:true,provenance:id===left?'User statement in everyday conversation':'User statement about technical reviews',project_id:id===left?null:'technical',
 derivation:id===left?null:{job_id:sourceId,input_id:sourceId,input_revision:2,input_hash:'a'.repeat(64),profile_hash:'b'.repeat(64),quote:'Detailed technical reviews',start:0,end:'Detailed technical reviews'.length,offset_unit:'UTF-16 code units'},derivation_current:true};
};
const engine={kind:'postgres',executeRaw:async(sql,args)=>{
 calls.push(sql);if(sql==='SELECT id FROM public.sources WHERE id=$1')return [{id:'selected'}];
 if(sql.startsWith('SELECT id::text')&&sql.includes('FROM ultrabrain.personal_memories'))return [];
 assert.fail('Unexpected SQL outside read transaction');
},transaction:async fn=>{
 const sequence=[];return fn({executeRaw:async(sql,args)=>{
  calls.push(sql);sequence.push(sql);
  if(sql.startsWith('SELECT id::text')&&sql.includes('m.id=$3::uuid')){
   assert.deepEqual(sequence.slice(0,-1),['SET LOCAL transaction_read_only=on',"SET LOCAL statement_timeout='5s'"]);
   assert.equal(args[0],'selected');assert.match(args[1],/^[a-f0-9]{64}$/);return [left,right].includes(args[2])?[envelopeRow(args[2])]:[];
  }
  assert.ok(['SET LOCAL transaction_read_only=on',"SET LOCAL statement_timeout='5s'"].includes(sql));return [];
 }});
}};
const service=await startPersonalConsole({engine,source:'selected',token,port:0,configureModel:()=>assert.fail('No model allowed')});
try{
 const child=spawn(process.env.ULTRABRAIN_BROWSER_PYTHON??'python3',[root+'test/personal-memory-pair-browser.py'],{cwd:root,
 env:{...process.env,ULTRABRAIN_BROWSER_ORIGIN:service.origin,ULTRABRAIN_BROWSER_TOKEN:token},stdio:['ignore','inherit','inherit']});
 const timer=setTimeout(()=>child.kill('SIGKILL'),120000);
 try{assert.equal(await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);}),0,'Chromium pair validation failed');}
 finally{clearTimeout(timer);}
 assert.ok(counts.get(left)>=5&&counts.get(right)>=4);
 assert.ok(calls.every(sql=>!/^\s*(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE|COPY)\b/i.test(sql)));
 console.log('PASS manual pair: authenticated HTTP/CSP + Chromium, synthetic SQL rows, zero writes/models; not real PostgreSQL');
}finally{await service.close();}
