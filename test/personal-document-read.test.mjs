/** Shipped DOM handlers and synthetic responses. Real console/PostgreSQL coverage is separate. */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {webcrypto,createHash} from 'node:crypto';
const app=readFileSync(new URL('../web/personal/app.js',import.meta.url),'utf8');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function doc(n,text='DOCUMENT_'+n,label='文档'+n+'.MD'){
 const bytes=Buffer.isBuffer(text)?text:Buffer.from(text);
 const row={document_id:`${String(n).padStart(8,'0')}-1111-4111-8111-111111111111`,label,format:label.split('.').at(-1).toLowerCase(),
  byte_size:bytes.length,content_sha256:hash(bytes),has_bom:bytes.subarray(0,3).equals(Buffer.from([239,187,191])),
  status:'active',revision:1,agent_id:'synthetic',project_id:null,created_at:'2026-09-20T00:00:00.000Z',archived_at:null,fragments:0};
 return {bytes,row,response:{...row,source_id:'default',fragments:null,content_base64:bytes.toString('base64')}};
}
function fixture({documents=[doc(1),doc(2)],reply,crypto=webcrypto}={}){
 const nodes=new Map(),calls=[],downloads=[],urls=new Map();let urlId=0;
 const element=tag=>({tag,value:'',checked:false,dataset:{},hidden:false,disabled:false,textContent:'',children:[],handlers:new Map(),
  addEventListener(k,f){this.handlers.set(k,f);},replaceChildren(){this.children=[];},append(...xs){this.children.push(...xs);},
  setAttribute(){},focus(){},reset(){throw Error('Read must not reset a draft');},
  click(){if(this.tag==='a')downloads.push({label:this.download,blob:urls.get(this.href)});}});
 const get=k=>{if(!nodes.has(k))nodes.set(k,element());return nodes.get(k);};
 const context=vm.createContext({document:{getElementById:get,createElement:element,querySelectorAll:()=>[]},window:{addEventListener(){}},
  TextEncoder,TextDecoder,AbortController,AbortSignal,crypto,atob,btoa,Blob,confirm:()=>true,setTimeout:()=>0,
  URL:{createObjectURL(blob){const id='blob:synthetic-'+(++urlId);urls.set(id,blob);return id;},revokeObjectURL(id){urls.delete(id);}},
  fetch:async(_url,o)=>{const body=JSON.parse(o.body);calls.push(body);
   const result=body.operation==='document_read'
    ?await (reply?.(body,calls.length)??structuredClone(documents.find(d=>d.row.document_id===body.input.document_id).response))
    :{documents:documents.map(d=>d.row),memories:[],agents:[]};
   return {ok:true,status:200,json:async()=>({ok:true,result})};}});
 const run=s=>vm.runInContext(s,context);run(app);run("sourceId='default';token='PRIVATE_TOKEN';view='documents'");
 get('content').value='UNRELATED_UNSAVED_DRAFT';get('document-original').hidden=true;
 run(`renderDocuments(${JSON.stringify({source_id:'default',documents:documents.map(d=>d.row),next_offset:null})})`);
 const action=(i,name)=>{const actions=get('results').children[i].children.find(n=>n.children.some(b=>b.handlers.has('click')));
  return actions.children.find(n=>n.textContent===name).handlers.get('click')();};
 return {get,run,calls,downloads,read:(i=0)=>action(i,'查看原文'),download:(i=0)=>action(i,'下载原文')};
}
function noExposure(f,draft='UNRELATED_UNSAVED_DRAFT'){
 assert.equal(f.get('document-original').hidden,true);assert.equal(f.get('document-original-text').textContent,'');
 assert.equal(f.downloads.length,0);assert.equal(f.get('content').value,draft);assert.equal(f.run('pending'),null);
 assert.ok(f.calls.every(c=>['document_read','document_list'].includes(c.operation)));
}
for(const text of ['普通中文🙂\r\n','\ufeff保留BOM\r\n','\ufeff','\0',' \r\n','\ufffd',Buffer.alloc(131072,120)])
 test('valid original survives preview and exact byte download: '+(typeof text==='string'?JSON.stringify(text):'128KiB'),async()=>{
 const original=doc(1,text);const f=fixture({documents:[original]});await f.read();assert.equal(f.get('document-original').hidden,false);
 assert.equal(f.get('document-original-text').textContent,new TextDecoder().decode(original.bytes));
 await f.download();assert.equal(f.downloads.length,1);assert.equal(f.downloads[0].label,original.row.label);
 assert.deepEqual(Buffer.from(await f.downloads[0].blob.arrayBuffer()),original.bytes);
 assert.equal(f.get('content').value,'UNRELATED_UNSAVED_DRAFT');
});
const corruptions=[
 ['foreign source',r=>r.source_id='other'],['wrong document',r=>r.document_id=doc(2).row.document_id],
 ['different label',r=>r.label='other.MD'],['path label',r=>r.label='../bad.MD'],['wrong format',r=>r.format='txt'],
 ['wrong size',r=>r.byte_size++],['missing size',r=>delete r.byte_size],['oversized',r=>r.byte_size=131073],
 ['wrong hash',r=>r.content_sha256='0'.repeat(64)],['wrong BOM',r=>r.has_bom=true],['wrong agent',r=>r.agent_id='other'],
 ['wrong project',r=>r.project_id='other'],['changed creation',r=>r.created_at='2026-09-19T00:00:00.000Z'],
 ['invalid status',r=>r.status='candidate'],['zero revision',r=>r.revision=0],['fractional revision',r=>r.revision=1.5],
 ['unversioned archive',r=>{r.status='archived';r.archived_at='2026-09-20T01:00:00.000Z';}],
 ['archive without timestamp',r=>{r.status='archived';r.revision=2;}],['active with archive date',r=>r.archived_at='2026-09-20T01:00:00.000Z'],
 ['dry run',r=>r.dry_run=true],['missing base64',r=>delete r.content_base64],['base64 wrong type',r=>r.content_base64={}],
 ['base64 whitespace',r=>r.content_base64+='\n'],['oversized base64',r=>r.content_base64='A'.repeat(174768)],
 ['self-consistent foreign body',r=>Object.assign(r,doc(2).response)],
 ['self-consistent changed content',r=>Object.assign(r,{content_base64:Buffer.from('CHANGED').toString('base64'),byte_size:7,content_sha256:hash(Buffer.from('CHANGED'))})]
];
for(const [name,change]of corruptions)for(const action of ['read','download'])test(action+' fails closed on '+name,async()=>{
 const original=doc(1);const f=fixture({reply:()=>{const r=structuredClone(original.response);change(r);return r;}});
 await f[action]();noExposure(f);assert.equal(f.get('message').dataset.error,'true');
});
for(const bytes of [Buffer.from([255]),Buffer.from([0xc0,0x80]),Buffer.from([0xed,0xa0,0x80]),Buffer.from([0xf0,0x9f])])
 test('self-consistent invalid UTF8 is not exposed: '+bytes.toString('hex'),async()=>{
 const f=fixture({documents:[doc(1,bytes)]});await f.read();noExposure(f);
});
test('noncanonical pad bits are refused despite matching decoded bytes',async()=>{
 const original=doc(1,'x');original.response.content_base64='eB==';
 const f=fixture({documents:[original]});await f.download();noExposure(f);
});
test('legitimate archival since card render is shown as latest read status',async()=>{
 const original=doc(1);original.response.status='archived';original.response.revision=2;original.response.archived_at='2026-09-20T01:00:00.000Z';
 const f=fixture({documents:[original]});await f.read();assert.equal(f.get('document-original').hidden,false);
 assert.match(f.get('document-original-title').textContent,/已归档/);await f.download();assert.equal(f.downloads.length,1);
});
test('archived originals remain readable',async()=>{
 const original=doc(1);for(const r of [original.row,original.response])Object.assign(r,{status:'archived',revision:2,archived_at:'2026-09-20T01:00:00.000Z'});
 const f=fixture({documents:[original]});await f.read();assert.equal(f.get('document-original').hidden,false);await f.download();assert.equal(f.downloads.length,1);
});
test('archived selected record cannot regress to active',async()=>{
 const original=doc(1);Object.assign(original.row,{status:'archived',revision:2,archived_at:'2026-09-20T01:00:00.000Z'});
 const f=fixture({documents:[original]});await f.read();noExposure(f);
});
test('each download rechecks server visibility instead of reusing the preview cache',async()=>{
 let reads=0;const original=doc(1);const f=fixture({reply:()=>{if(++reads>1)throw Error('synthetic refusal');return original.response;}});
 await f.read();await f.download();noExposure(f);assert.equal(reads,2);
});
test('starting another read immediately clears old displayed bytes',async()=>{
 const gate=deferred();let n=0;const f=fixture({reply:b=>++n===1?doc(1).response:gate.promise});
 await f.read();const later=f.read(1);assert.equal(f.get('document-original-text').textContent,'');
 assert.equal(f.get('document-original').hidden,true);gate.resolve(doc(2).response);await later;
});
for(const first of ['read','download'])for(const second of ['read','download'])test('latest selection wins '+first+' A then '+second+' B',async()=>{
 const gate=deferred();const f=fixture({reply:b=>b.input.document_id===doc(1).row.document_id?gate.promise:doc(2).response});
 const old=f[first]();await tick();await f[second](1);const status=f.get('message').textContent;
 gate.resolve(doc(1).response);await old;assert.equal(f.get('message').textContent,status);
 if(second==='read'){assert.equal(f.get('document-original-text').textContent,'DOCUMENT_2');assert.equal(f.downloads.length,0);}
 else {assert.equal(f.downloads.length,1);assert.equal(f.downloads[0].label,doc(2).row.label);}
});
for(const change of ["token='NEW_TOKEN'","sourceId='other'","view='agents';load()"])
 test('late delivery cannot expose bytes after '+change,async()=>{
 const gate=deferred();const f=fixture({reply:()=>gate.promise});const old=f.download();await tick();
 await f.run(change);f.get('message').textContent='CURRENT_SCREEN';gate.resolve(doc(1).response);await old;
 assert.equal(f.downloads.length,0);assert.equal(f.get('document-original-text').textContent,'');assert.equal(f.get('message').textContent,'CURRENT_SCREEN');
});
test('logout keeps locked message and discards the outstanding read',async()=>{
 const gate=deferred();const f=fixture({reply:()=>gate.promise});const old=f.read();await tick();
 f.get('logout').handlers.get('click')();gate.resolve(doc(1).response);await old;
 noExposure(f,'');assert.equal(f.get('message').textContent,'管理台已锁定。');
});
test('explicit cancel discards an in-flight download without producing a file',async()=>{
 const gate=deferred();const f=fixture({reply:()=>gate.promise});const old=f.download();await tick();
 assert.ok(f.get('document-read-cancel').handlers.has('click'));
 f.get('document-read-cancel').handlers.get('click')();gate.resolve(doc(1).response);await old;noExposure(f);
});
test('selection fencing also applies while SHA256 computation is pending',async()=>{
 const gate=deferred();let n=0;const crypto={...webcrypto,subtle:{digest:async(...args)=>{if(++n===1)await gate.promise;return webcrypto.subtle.digest(...args);}}};
 const f=fixture({crypto});const old=f.read();for(let i=0;i<100&&!n;i++)await tick();assert.equal(n,1);
 await f.read(1);gate.resolve();await old;assert.equal(f.get('document-original-text').textContent,'DOCUMENT_2');
});
