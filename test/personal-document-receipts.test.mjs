/** Execute shipped UI handlers. Replies are synthetic; PostgreSQL/Chromium coverage is separate. */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {webcrypto,createHash} from 'node:crypto';
import {importDocumentRequest,planDocumentFragments,documentFragment} from '../src/personal-document-core.mjs';
const app=readFileSync(new URL('../web/personal/app.js',import.meta.url),'utf8');
const id='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const uuid=n=>`${String(n).padStart(8,'0')}-1111-4111-8111-111111111111`;
const bytes=Buffer.from('\ufeff'+('不要删除🙂\r\n'.repeat(2400)));
const hash=b=>createHash('sha256').update(b).digest('hex');
const documentRow={document_id:id,label:'合成文档.MD',format:'md',byte_size:bytes.length,content_sha256:hash(bytes),
  has_bom:true,status:'active',revision:1,agent_id:'personal-console',project_id:'draft-project',created_at:'2026-09-20T00:00:00.000Z',archived_at:null,fragments:0};
function receipt(body){
 const p=body.input;
 if(body.operation==='register')return {source_id:'default',agent_id:p.agent_id,actor_key:'a'.repeat(64),revision:1,replayed:true};
 if(body.operation==='document_import'){
  const shaped=importDocumentRequest(p);
  return {...documentRow,label:shaped.label,format:shaped.format,content_sha256:shaped.content_sha256,
   byte_size:shaped.byte_size,has_bom:shaped.has_bom,project_id:shaped.project_id,fragments:null,
   source_id:'default',event_id:p.event_id,storage:'stored',already_imported:false,model_calls:0,replayed:false};
 }
 if(body.operation==='document_queue')return {source_id:'default',event_id:p.event_id,document_id:p.document_id,
  fragments:planDocumentFragments(bytes).map((r,i)=>({memory_id:uuid(i+10),job_id:uuid(i+20),state:'queued',
   byte_start:r.byte_start,byte_end:r.byte_start+r.byte_length,
   fragment_sha256:documentFragment(bytes,{byte_start:r.byte_start,byte_end:r.byte_start+r.byte_length}).fragment_sha256,offset_unit:'utf8-bytes'})),
  storage:'journaled',model_calls:0,review_required:true,replayed:false};
 if(body.operation==='document_archive')return {source_id:'default',event_id:p.event_id,document_id:p.document_id,status:'archived',
  revision:2,archived_at:'2026-09-20T01:00:00.000Z',archived_fragments:2,fenced_jobs:2,derived_entries_invalidated:0,
  original_retained:true,model_calls:0,replayed:false};
 return {documents:[documentRow],next_offset:null};
}
const tick=()=>new Promise(r=>setImmediate(r));
function fixture(route=async b=>receipt(b)){
 const nodes=new Map(),calls=[];
 const element=()=>({value:'',checked:false,dataset:{},hidden:false,disabled:false,textContent:'',children:[],handlers:new Map(),
  addEventListener(k,f){this.handlers.set(k,f);},reset(){throw Error('Unrelated editor must not be reset');},
  replaceChildren(){this.children=[];},append(...xs){this.children.push(...xs);},setAttribute(){},focus(){}});
 const get=k=>{if(!nodes.has(k))nodes.set(k,element());return nodes.get(k);};
 const ctx=vm.createContext({document:{getElementById:get,createElement:element,querySelectorAll:()=>[]},window:{addEventListener(){}},
  TextEncoder,TextDecoder,AbortController,AbortSignal,crypto:webcrypto,atob,btoa,confirm:()=>true,
  fetch:async(_url,o)=>{const body=JSON.parse(o.body);calls.push(body);const r=await route(body);
   return {ok:true,status:200,json:async()=>({ok:true,result:r})};}});
 const run=s=>vm.runInContext(s,ctx);run(app);run("sourceId='default';token='PRIVATE_TOKEN';view='documents';");
 for(const [k,v]of Object.entries({content:'UNRELATED_DRAFT',project:'draft-project',type:'preference',visibility:'private',importance:'normal',provenance:'Synthetic'}))get(k).value=v;
 get('consent').checked=true;get('document-consent').checked=true;
 get('document-file').files=[{name:documentRow.label,size:bytes.length,arrayBuffer:async()=>bytes}];
 const render=row=>run(`renderDocuments({documents:[${JSON.stringify(row)}],next_offset:null})`);
 return {get,calls,run,
  async start(op){
   if(op==='document_import')await run('importSelectedDocument()');
   else {render(documentRow);const actions=get('results').children[0].children.find(n=>n.children.some(c=>c.handlers.has('click')));
    const button=actions.children.find(n=>n.textContent.startsWith(op==='document_queue'?'排队整理':'归档文档'));
    button.handlers.get('click')();}
  },retry(){get('retry').handlers.get('click')();},
  async settle(){for(let i=0;i<200&&run('busy');i++)await tick();assert.equal(run('busy'),false);}};
}
const operations=['document_import','document_queue','document_archive'];
for(const op of operations)test(op+' accepts its real-contract receipt without clearing unrelated editor',async()=>{
 const f=fixture();await f.start(op);await f.settle();assert.equal(f.run('pending'),null);
 assert.equal(f.get('content').value,'UNRELATED_DRAFT');assert.equal(f.calls.filter(b=>b.operation===op).length,1);
});
const corruptions={
 document_import:[['id',r=>r.document_id='bad'],['label',r=>r.label='other.md'],['format',r=>r.format='txt'],
  ['size',r=>r.byte_size++],['digest',r=>r.content_sha256='0'.repeat(64)],['BOM',r=>r.has_bom=false],
  ['status',r=>r.status='archived'],['revision',r=>r.revision=2],['agent',r=>r.agent_id='other-agent'],
  ['project',r=>r.project_id='other-project'],['storage',r=>r.storage='not_stored'],['dedup flag',r=>delete r.already_imported]],
 document_queue:[['id',r=>r.document_id=other],['empty fragments',r=>r.fragments=[]],['missing tail',r=>r.fragments.pop()],
  ['overlap',r=>r.fragments[1].byte_start--],['gap',r=>r.fragments[1].byte_start++],['offset unit',r=>r.fragments[0].offset_unit='characters'],
  ['state',r=>r.fragments[0].state='completed'],['duplicate memory',r=>r.fragments[1].memory_id=r.fragments[0].memory_id],
  ['duplicate job',r=>r.fragments[1].job_id=r.fragments[0].job_id],['bad memory',r=>r.fragments[0].memory_id='bad'],
  ['bad job',r=>r.fragments[0].job_id='bad'],['hash',r=>r.fragments[0].fragment_sha256='bad'],
  ['fractional range',r=>r.fragments[0].byte_end+=0.5],['oversized slice',r=>r.fragments[0].byte_end=32769],
  ['outside original',r=>r.fragments.at(-1).byte_end++],['storage',r=>r.storage='stored'],['review',r=>r.review_required=false]],
 document_archive:[['id',r=>r.document_id=other],['status',r=>r.status='active'],['revision',r=>r.revision=3],
  ['original retention',r=>r.original_retained=false],['negative count',r=>r.archived_fragments=-1],
  ['fractional count',r=>r.fenced_jobs=0.5],['missing count',r=>delete r.derived_entries_invalidated],
  ['archive timestamp',r=>r.archived_at=null]],
};
for(const op of operations){
 const cases=[['empty result',()=>({})],['source',r=>r.source_id='foreign'],['event',r=>r.event_id='wrong-event'],
  ['model calls',r=>r.model_calls=1],['replay',r=>r.replayed='false'],['dry run',r=>r.dry_run=true],...corruptions[op]];
 for(const [label,damage]of cases)test(op+' retains the original pending event on invalid '+label,async()=>{
  const f=fixture(async b=>{const r=receipt(b);if(b.operation!==op)return r;const replacement=damage(r);return label==='empty result'?replacement:r;});
  await f.start(op);await f.settle();assert.equal(f.run('pending?.delivery_unconfirmed'),true);
  assert.equal(f.get('content').value,'UNRELATED_DRAFT');assert.match(f.get('message').textContent,/console_receipt_unconfirmed/);
 });
}
for(const op of operations)test(op+' explicitly replays a bad acknowledgement with identical JSON and event',async()=>{
 let attempts=0;const f=fixture(async b=>{const r=receipt(b);if(b.operation===op){if(++attempts===1)return {};r.replayed=true;}return r;});
 await f.start(op);await f.settle();assert.equal(f.run('pending?.delivery_unconfirmed'),true);
 const original=f.calls.find(b=>b.operation===op);f.retry();await f.settle();assert.equal(f.run('pending'),null);
 assert.deepEqual(f.calls.filter(b=>b.operation===op),[original,original]);
});
test('already-imported valid receipt is an acknowledgement, not an extra document',async()=>{
 const f=fixture(async b=>{const r=receipt(b);if(b.operation==='document_import')r.already_imported=true;return r;});
 await f.start('document_import');await f.settle();assert.equal(f.run('pending'),null);
});
test('import selection change after a bad receipt prevents another plaintext transmission',async()=>{
 const f=fixture(async b=>b.operation==='document_import'?{}:receipt(b));await f.start('document_import');await f.settle();
 const event=f.run('pending?.input.event_id');assert.ok(event);f.get('project').value='other';f.retry();await f.settle();
 assert.equal(f.run('pending.input.event_id'),event);assert.equal(f.calls.filter(b=>b.operation==='document_import').length,1);
});
for(const op of ['document_queue','document_archive'])test(op+' freezes the selected document metadata for explicit replay',async()=>{
 const f=fixture(async b=>b.operation===op?{}:receipt(b));await f.start(op);await f.settle();
 assert.equal(f.run('pending.receipt_context.document_id'),id);assert.equal(f.run('pending.receipt_context.byte_size'),bytes.length);
 f.run("pending.receipt_context.byte_size=1;pending.receipt_context.revision=99;");
 assert.equal(f.run('pending.receipt_context.byte_size'),bytes.length);assert.equal(f.run('pending.receipt_context.revision'),1);
 assert.ok(!f.run('JSON.stringify(pending)').includes('PRIVATE_TOKEN'));
});

// Implementation self-review: no extra plaintext read, no manufactured guarantee
// about current state from a replay; compare with the canonical server byte planner.
for(const size of [1,32767,32768,32769,65536,131072])test('canonical full-file queue contract at '+size+' UTF-8 bytes',()=>{
 const f=fixture(),content=Buffer.from('你'.repeat(Math.floor(size/3))+'x'.repeat(size%3));
 const input={event_id:'canonical-boundary',document_id:id};
 const result={source_id:'default',event_id:input.event_id,document_id:id,storage:'journaled',review_required:true,model_calls:0,replayed:false,
  fragments:planDocumentFragments(content).map((r,i)=>({memory_id:uuid(i+100),job_id:uuid(i+200),state:'queued',offset_unit:'utf8-bytes',
   byte_start:r.byte_start,byte_end:r.byte_start+r.byte_length,fragment_sha256:hash(content.subarray(r.byte_start,r.byte_start+r.byte_length))}))};
 assert.doesNotThrow(()=>f.run(`verifyWriteReceipt('document_queue',${JSON.stringify(input)},${JSON.stringify(result)},'default',${JSON.stringify({document_id:id,byte_size:size,revision:1})})`));
});
for(const text of ['\ufeff','\0',' \r\n'])test('import acknowledgement allows unprocessable but valid original bytes '+JSON.stringify(text),async()=>{
 const f=fixture(),content=Buffer.from(text);f.get('document-file').files=[{name:'raw.txt',size:content.length,arrayBuffer:async()=>content}];
 await f.start('document_import');await f.settle();assert.equal(f.run('pending'),null);
 assert.deepEqual(f.calls.map(b=>b.operation),['register','document_import','document_list']);
});
test('queue rejects a full-coverage but noncanonical short interior split',async()=>{
 const f=fixture(async b=>{const r=receipt(b);if(b.operation==='document_queue'){r.fragments[0].byte_end=100;r.fragments[1].byte_start=100;}return r;});
 await f.start('document_queue');await f.settle();assert.equal(f.run('pending?.delivery_unconfirmed'),true);
});
for(const op of operations)test(op+' cannot confirm a late response after the session changes',async()=>{
 let release;const f=fixture(async b=>{if(b.operation===op)await new Promise(r=>release=r);return receipt(b);});
 await f.start(op);for(let i=0;i<100&&!release;i++)await tick();assert.ok(release);
 f.run("token='REPLACED_SESSION'");release();await f.settle();assert.equal(f.run('pending?.delivery_unconfirmed'),true);
 assert.equal(f.get('content').value,'UNRELATED_DRAFT');
});
test('a newer file selection is preserved when the original import is acknowledged',async()=>{
 let release;const f=fixture(async b=>{if(b.operation==='document_import')await new Promise(r=>release=r);return receipt(b);});
 await f.start('document_import');for(let i=0;i<100&&!release;i++)await tick();assert.ok(release);
 const newFile={name:'UNSUBMITTED.txt',size:1,arrayBuffer:async()=>Buffer.from('x')};
 f.get('document-file').files=[newFile];f.get('document-file').handlers.get('change')();release();await f.settle();
 assert.equal(f.run('pending'),null);assert.equal(f.get('document-file').files[0],newFile);
 assert.equal(f.get('document-consent').checked,false);assert.equal(f.get('content').value,'UNRELATED_DRAFT');
 assert.equal(f.calls.filter(b=>b.operation==='document_import').length,1);
});
