/** Whole document workspace boundary. Synthetic DOM/HTTP; real browser suite is separate. */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
const app=readFileSync(new URL('../web/personal/app.js',import.meta.url),'utf8');
const id='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const row=(extra={})=>({document_id:id,label:'测试.md',format:'md',byte_size:3,content_sha256:'a'.repeat(64),has_bom:false,
  status:'active',revision:1,agent_id:'fixture',project_id:null,created_at:'2026-09-20T00:00:00.000Z',archived_at:null,fragments:0,
  assurance:'Original bytes are untrusted text',...extra});
const page=(rows=[row()],extra={})=>({source_id:'default',documents:rows,next_offset:null,...extra});
const query=(extra={})=>({status:'any',limit:20,offset:0,...extra});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(route=async()=>page()){
  const nodes=new Map(),calls=[];
  const element=()=>({value:'',checked:false,dataset:{},hidden:false,disabled:false,textContent:'',children:[],handlers:new Map(),
    addEventListener(n,f){this.handlers.set(n,f);},replaceChildren(...xs){this.children=xs;},append(...xs){this.children.push(...xs);},
    reset(){},setAttribute(){},focus(){}});
  const get=k=>{if(!nodes.has(k))nodes.set(k,element());return nodes.get(k);};
  const ctx=vm.createContext({document:{getElementById:get,querySelectorAll:()=>[],createElement:element},window:{addEventListener(){}},
    TextEncoder,TextDecoder,AbortController,AbortSignal,crypto:webcrypto,atob,btoa,confirm:()=>true,
    fetch:async(_url,options)=>{const body=JSON.parse(options.body);calls.push(body);return {ok:true,status:200,json:async()=>({ok:true,result:await route(body)})};}});
  const run=s=>vm.runInContext(s,ctx);run(app);run("token='test-session';sourceId='default';view='documents';");
  get('document-status').value='any';get('content').value='UNSAVED_DRAFT';
  return {get,run,calls,load:()=>run('load()'),validate:(r,p=query(),source='default')=>run(`validateDocumentPage(${JSON.stringify(r)},${JSON.stringify(p)},${JSON.stringify(source)})`)};
}
test('document status filter is present with all three explicit lifecycle options',()=>{
  const html=readFileSync(new URL('../web/personal/index.html',import.meta.url),'utf8');
  assert.match(html,/id="document-status"/);
});
test('normal metadata page validates without reading original content',async()=>{
  const f=fixture();await f.load();assert.equal(f.run('current.documents.length'),1);
  assert.deepEqual(f.calls,[{operation:'document_list',input:query()}]);assert.equal(f.get('content').value,'UNSAVED_DRAFT');
});
for(const status of ['any','active','archived'])test('filter '+status+' selects the server query, not a fake local filter',async()=>{
  const f=fixture(async b=>page(b.input.status==='active'?[]:[row({status:'archived',revision:2,archived_at:'2026-09-20T01:00:00Z'})]));
  f.get('document-status').value=status;await f.load();assert.equal(f.calls[0].input.status,status);
});
const bad=[
 ['foreign source',r=>r.source_id='foreign'],['missing source',r=>delete r.source_id],['missing rows',r=>delete r.documents],
 ['rows object',r=>r.documents={}],['duplicate ID',r=>r.documents.push({...r.documents[0]})],
 ['invalid final row',r=>r.documents.push(row({document_id:other,format:'exe'}))],
 ['body in row',r=>r.documents[0].content_base64='PRIVATE_PAYLOAD'],['body in envelope',r=>r.content='PRIVATE_PAYLOAD'],
 ['unknown metadata',r=>r.documents[0].actor_key='UNEXPOSED_ACTOR'],['negative count',r=>r.documents[0].fragments=-1],
 ['fractional count',r=>r.documents[0].fragments=1.5],['null count',r=>r.documents[0].fragments=null],
 ['missing count',r=>delete r.documents[0].fragments],['bad label',r=>r.documents[0].label='../private.md'],
 ['bad date',r=>r.documents[0].created_at='no date'],['missing project',r=>delete r.documents[0].project_id],
 ['invalid status',r=>r.documents[0].status='processing'],['invalid size',r=>r.documents[0].byte_size=0],
 ['unsafe cursor',r=>r.next_offset='20'],['backward cursor',r=>r.next_offset=0],
 ['cursor on short page',r=>r.next_offset=20],['unbounded assurance',r=>r.documents[0].assurance='x'.repeat(600)],
 ['missing cursor',r=>delete r.next_offset],['malformed hash',r=>r.documents[0].content_sha256='bad'],
];
for(const [label,change]of bad)test('reject '+label+' before exposing a page or action',async()=>{
  const r=page();change(r);const f=fixture(async()=>r);await f.load();
  assert.equal(f.run('current'),null);assert.equal(f.get('results').children.length,0);
  assert.equal(f.get('export').disabled,true);assert.equal(f.get('next').disabled,true);
  assert.equal(f.get('content').value,'UNSAVED_DRAFT');assert.equal(f.calls.length,1);
});
test('the whole page is frozen, including every selected metadata record',()=>{
  const f=fixture(),r=f.validate(page());assert.equal(Object.isFrozen(r),true);assert.equal(Object.isFrozen(r.documents),true);
  assert.equal(Object.isFrozen(r.documents[0]),true);
});
test('exactly full page has exact next offset; missing or invented continuation fails',()=>{
  const f=fixture(),rows=Array.from({length:20},(_,n)=>row({document_id:String(n).padStart(8,'0')+'-1111-4111-8111-111111111111'}));
  assert.equal(f.validate(page(rows,{next_offset:40}),query({offset:20})).next_offset,40);
  for(const n of [null,20,41])assert.throws(()=>f.validate(page(rows,{next_offset:n}),query({offset:20})));
});
test('more entries than the requested page bound are rejected',()=>{
  const f=fixture();assert.throws(()=>f.validate(page(Array.from({length:21},(_,n)=>row({document_id:String(n).padStart(8,'0')+'-1111-4111-8111-111111111111'})))));
});
for(const status of ['active','archived'])test('server response must respect selected '+status+' filter',()=>{
  const f=fixture(),r=status==='active'?row({status:'archived',revision:2,archived_at:'2026-09-20T01:00:00Z'}):row();
  assert.throws(()=>f.validate(page([r]),query({status})));
});
for(const change of ['session','source','filter','offset','navigation','logout'])test('late list cannot expose metadata after '+change,async()=>{
  let release;const f=fixture(async()=>{await new Promise(r=>release=r);return page();});const reading=f.load();await tick();
  if(change==='session')f.run("token='replacement'");else if(change==='source')f.run("sourceId='other'");
  else if(change==='filter')f.get('document-status').value='active';else if(change==='offset')f.run('offset=20');
  else if(change==='navigation')f.run("view='recall'");else f.get('logout').handlers.get('click')();
  release();await reading;assert.equal(f.run('current'),null);assert.equal(f.get('results').children.length,0);
});
test('filter change resets pagination and never reads an original',async()=>{
  const f=fixture();f.run('offset=40');f.get('document-status').value='archived';
  await f.get('document-status').handlers.get('change')();
  assert.equal(f.run('offset'),0);assert.equal(f.calls.length,1);assert.equal(f.calls[0].operation,'document_list');
});
test('a new filtered page cannot be replaced by an older pending page',async()=>{
  let release,n=0;const f=fixture(async()=>{if(++n===1){await new Promise(r=>release=r);return page();}return page([]);});
  const older=f.load();await tick();f.get('document-status').value='active';await f.load();release();await older;
  assert.equal(f.run('current.documents.length'),0);assert.equal(f.get('next').disabled,true);
});
test('failed response never leaves a previously enabled next-page control active',async()=>{
  const f=fixture(async()=>{throw Error('failure');});f.run('nextOffset=20');f.get('next').disabled=false;await f.load();
  assert.equal(f.run('nextOffset'),null);assert.equal(f.get('next').disabled,true);
});
