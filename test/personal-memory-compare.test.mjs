/** Shipped browser handlers with synthetic DOM/HTTP. Real Chromium + PostgreSQL is separate. */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createHash,webcrypto} from 'node:crypto';
const app=readFileSync(new URL('../web/personal/app.js',import.meta.url),'utf8');
const id='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const hash=s=>createHash('sha256').update(s).digest('hex');
const row=(revision=2,content='ORIGINAL',extra={})=>({id,revision,content,content_hash:hash(content),type:'preference',origin_kind:'agent',
  status:'active',confidence:0.4,importance:'normal',visibility:'private',owned_by_caller:true,provenance:'Synthetic origin',project_id:null,
  derivation:null,derivation_current:true,...extra});
const receipt=memory=>({source_id:'default',memory,trust:'untrusted-memory-data',read_only:true,coverage:'single read'});
const tick=()=>new Promise(r=>setImmediate(r));
function fixture(route=async()=>receipt(row(3,'CONCURRENT',{status:'candidate',confidence:0.9})),base=row()){
  const nodes=new Map(),calls=[];
  const element=()=>({value:'',checked:false,dataset:{},hidden:false,disabled:false,textContent:'',children:[],handlers:new Map(),
    addEventListener(k,f){this.handlers.set(k,f);},reset(){},replaceChildren(){this.children=[];},append(...xs){this.children.push(...xs);},setAttribute(){},focus(){}});
  const get=id=>{if(!nodes.has(id))nodes.set(id,element());return nodes.get(id);};
  let confirmation=()=>true;
  const ctx=vm.createContext({document:{getElementById:get,querySelectorAll:()=>[],createElement:element},window:{addEventListener(){}},
    TextEncoder,TextDecoder,AbortSignal,AbortController,crypto:webcrypto,confirm:()=>confirmation(),
    fetch:async(_url,options)=>{const body=JSON.parse(options.body);calls.push({body,signal:options.signal});
      const result=await route(body);return {ok:true,json:async()=>({ok:true,result})};}});
  const run=s=>vm.runInContext(s,ctx);
  run(app);run("token='synthetic-session';sourceId='default';view='lookup';");run(`edit(${JSON.stringify(base)})`);
  get('content').value='MY DRAFT';get('consent').checked=true;
  return {get,run,calls,confirm:f=>confirmation=f,read:()=>run('compareCurrentMemory()'),
    click:(id,event='click')=>get(id).handlers.get(event)({preventDefault(){}}),
    async settled(){for(let i=0;i<100&&run('busy');i++)await tick();assert.equal(run('busy'),false);}};
}
test('shipped UI includes comparison and a separate explicit adoption control',()=>{
  const html=readFileSync(new URL('../web/personal/index.html',import.meta.url),'utf8');
  for(const id of ['compare-current','comparison-panel','comparison-original','comparison-latest','comparison-draft','comparison-consent','comparison-adopt','comparison-cancel'])
    assert.ok(html.includes('id="'+id+'"'),id);
});
test('comparison reads only the ID, keeps the baseline and draft and never writes',async()=>{
  const f=fixture();await f.read();assert.deepEqual(f.calls.map(x=>x.body),[{operation:'memory_read',input:{memory_id:id}}]);
  assert.equal(f.run('editing.revision'),2);assert.equal(f.get('content').value,'MY DRAFT');assert.equal(f.get('comparison-panel').hidden,false);
  assert.match(f.get('comparison-original').textContent,/ORIGINAL/);assert.match(f.get('comparison-latest').textContent,/CONCURRENT/);
  assert.match(f.get('comparison-draft').textContent,/MY DRAFT/);assert.equal(f.get('comparison-adopt').disabled,true);
  assert.equal(f.get('consent').checked,false);
});
test('adoption needs its own explicit checkbox',async()=>{
  const f=fixture();await f.read();f.click('comparison-adopt');assert.equal(f.run('editing.revision'),2);assert.equal(f.calls.length,1);
});
test('explicit adoption preserves all draft fields, including its confidence estimate, and resets save consent',async()=>{
  const f=fixture(async body=>body.operation==='memory_read'?receipt(row(3,'CONCURRENT',{confidence:0.9})):
    body.operation==='update'?{id,revision:4,status:'candidate',review_required:true}:{memories:[]});
  f.get('project').value='project-draft';f.get('importance').value='high';f.get('provenance').value='Draft source';
  await f.read();f.get('comparison-consent').checked=true;f.click('comparison-consent','change');assert.equal(f.get('comparison-adopt').disabled,false);
  f.click('comparison-adopt');assert.equal(f.run('editing.revision'),3);assert.equal(f.run('editing.content'),'CONCURRENT');
  assert.equal(f.get('content').value,'MY DRAFT');assert.equal(f.get('project').value,'project-draft');
  assert.equal(f.get('consent').checked,false);assert.equal(f.calls.length,1);
  f.get('consent').checked=true;f.click('memory-form','submit');await f.settled();
  const writes=f.calls.filter(x=>x.body.operation==='update');assert.equal(writes.length,1);
  assert.equal(writes[0].body.input.expected_revision,3);assert.equal(writes[0].body.input.memory.confidence,0.4);
  assert.equal(writes[0].body.input.memory.content,'MY DRAFT');assert.equal(writes[0].body.input.memory.project_id,'project-draft');
});
test('declining the adoption confirmation leaves the old baseline unchanged',async()=>{
  const f=fixture();await f.read();f.get('comparison-consent').checked=true;f.confirm(()=>false);f.click('comparison-adopt');
  assert.equal(f.run('editing.revision'),2);assert.equal(f.get('content').value,'MY DRAFT');assert.equal(f.calls.length,1);
});
test('same version can be compared but cannot pretend there is a newer baseline',async()=>{
  const f=fixture(async()=>receipt(row()));await f.read();f.get('comparison-consent').checked=true;f.click('comparison-consent','change');
  assert.equal(f.get('comparison-adopt').disabled,true);f.click('comparison-adopt');assert.equal(f.run('editing.revision'),2);
});
for(const change of [{revision:1},{revision:0},{id:other},{owned_by_caller:false,visibility:'source'},
  {origin_kind:'document_fragment'},{content_hash:'0'.repeat(64)},{status:'invalid'}])
  test('fresh unusable read cannot authorize adoption '+JSON.stringify(change),async()=>{
    const f=fixture(async()=>receipt(row(3,'CONCURRENT',change)));await f.read();
    assert.equal(f.get('comparison-panel').hidden,true);assert.equal(f.run('editing.revision'),2);assert.equal(f.get('content').value,'MY DRAFT');
  });
for(const kind of ['no-editor','pending','busy','shared','document','recall'])test('comparison refuses before HTTP for '+kind,async()=>{
  const f=fixture();
  if(kind==='no-editor')f.run('editing=null');else if(kind==='pending')f.run("pending={operation:'update',input:{event_id:'uncertain'},delivery_unconfirmed:true}");
  else if(kind==='busy')f.run('busy=true');else if(kind==='shared')f.run('editing.owned_by_caller=false');
  else if(kind==='document')f.run("editing.origin_kind='document_fragment'");else f.run("view='recall'");
  await f.read();assert.equal(f.calls.length,0);assert.equal(f.get('content').value,'MY DRAFT');
  if(kind==='pending')assert.equal(f.run('pending.input.event_id'),'uncertain');
});
for(const change of ['draft','revision','source','session','cancel','navigation','logout','editor'])test('late comparison is suppressed after '+change,async()=>{
  let release;const f=fixture(async()=>{await new Promise(r=>release=r);return receipt(row(3,'LATE_PRIVATE_RESULT'));});
  const request=f.read();await tick();assert.ok(release);
  if(change==='draft')f.get('content').value='CHANGED WITHOUT EVENT';
  else if(change==='revision')f.run('editing.revision=9');else if(change==='source')f.run("sourceId='other'");
  else if(change==='session')f.run("token='new-session'");else if(change==='cancel')f.click('comparison-cancel');
  else if(change==='navigation'){f.run("view='recall'");await f.run('load()');}
  else if(change==='logout')f.click('logout');else f.run(`edit(${JSON.stringify(row(2,'OTHER',{id:other}))})`);
  release();await request;assert.equal(f.get('comparison-panel').hidden,true);assert.ok(!f.get('comparison-latest').textContent.includes('LATE_PRIVATE_RESULT'));
});
for(const change of ['draft','source','session','pending','revision'])test('completed comparison cannot adopt after silent '+change+' change',async()=>{
  const f=fixture();await f.read();f.get('comparison-consent').checked=true;
  if(change==='draft')f.get('content').value='CHANGED';else if(change==='source')f.run("sourceId='foreign'");else if(change==='session')f.run("token='replaced'");
  else if(change==='pending')f.run("pending={operation:'update',input:{event_id:'unconfirmed'},delivery_unconfirmed:true}");else f.run('editing.revision=9');
  f.click('comparison-adopt');assert.notEqual(f.run('editing.revision'),3);assert.equal(f.calls.length,1);
});
test('draft input clears a completed comparison without replacing the draft',async()=>{
  const f=fixture();await f.read();f.get('content').value='REVISED DRAFT';f.click('memory-form','input');
  assert.equal(f.get('comparison-panel').hidden,true);assert.equal(f.get('comparison-latest').textContent,'');
  assert.equal(f.get('content').value,'REVISED DRAFT');assert.equal(f.run('editing.revision'),2);assert.equal(f.calls.length,1);
});
test('adoption rechecks authority after the confirmation dialog',async()=>{
  const f=fixture();await f.read();f.get('comparison-consent').checked=true;f.confirm(()=>{f.run("token='replaced'");return true;});
  f.click('comparison-adopt');assert.equal(f.run('editing.revision'),2);assert.equal(f.calls.length,1);
});
test('hash verification cannot deliver a comparison after authority changes',async()=>{
  const f=fixture();f.run(`sha256Hex=async()=>{sourceId='other';return '${hash('CONCURRENT')}';}`);await f.read();
  assert.equal(f.get('comparison-panel').hidden,true);assert.equal(f.run('editing.revision'),2);
});
test('older response cannot replace a newer completed comparison',async()=>{
  let release,n=0;const f=fixture(async()=>{const which=++n;if(which===1)await new Promise(r=>release=r);return receipt(row(which+2,'VERSION_'+which));});
  const first=f.read();await tick();await f.read();assert.match(f.get('comparison-latest').textContent,/VERSION_2/);
  release();await first;assert.match(f.get('comparison-latest').textContent,/VERSION_2/);assert.equal(f.get('comparison-cancel').disabled,false);
});
test('archived current version must be displayed and adoption does not reactivate it',async()=>{
  const f=fixture(async()=>receipt(row(4,'ARCHIVED',{status:'archived'})));await f.read();assert.match(f.get('comparison-latest').textContent,/archived/);
  f.get('comparison-consent').checked=true;f.click('comparison-adopt');assert.equal(f.run('editing.revision'),4);
  assert.equal(f.run('editing.status'),'archived');assert.equal(f.calls.length,1);assert.equal(f.get('consent').checked,false);
});
test('read failure preserves the draft and old baseline without automatically retrying',async()=>{
  const f=fixture(async()=>{throw Error('Synthetic read failure');});await f.read();assert.equal(f.calls.length,1);
  assert.equal(f.run('editing.revision'),2);assert.equal(f.get('content').value,'MY DRAFT');assert.equal(f.get('comparison-panel').hidden,true);
});
test('comparison is isolated from the existing results page and export',async()=>{
  const f=fixture();f.run("current={sentinel:'existing read'}");await f.read();assert.equal(f.run('current.sentinel'),'existing read');
});

test('same revision with changed editable metadata fails instead of presenting consistency',async()=>{
  const f=fixture(async()=>receipt(row(2,'ORIGINAL',{visibility:'source'})));await f.read();
  assert.equal(f.get('comparison-panel').hidden,true);assert.match(f.get('message').textContent,/memory_same_revision_changed/);
  assert.equal(f.get('visibility').value,'private');assert.equal(f.run('editing.revision'),2);
});
test('terminal revision is inspectable but cannot be adopted for an impossible next update',async()=>{
  const f=fixture(async()=>receipt(row(2147483647,'TERMINAL')));await f.read();
  assert.equal(f.get('comparison-panel').hidden,false);assert.equal(f.get('comparison-adopt').disabled,true);
  f.get('comparison-consent').checked=true;f.click('comparison-adopt');assert.equal(f.run('editing.revision'),2);
});
test('a draft confidence change cannot evade the frozen adoption selection',async()=>{
  const f=fixture();await f.read();f.get('comparison-consent').checked=true;f.run('draftConfidence=0.1');
  f.click('comparison-adopt');assert.equal(f.run('editing.revision'),2);assert.equal(f.calls.length,1);
});
test('revoking the comparison checkbox during confirmation prevents adoption',async()=>{
  const f=fixture();await f.read();f.get('comparison-consent').checked=true;
  f.confirm(()=>{f.get('comparison-consent').checked=false;return true;});f.click('comparison-adopt');
  assert.equal(f.run('editing.revision'),2);assert.equal(f.get('content').value,'MY DRAFT');
});
test('unknown write delivery cannot be bypassed by the comparison controls',async()=>{
  const f=fixture(async body=>{if(body.operation==='update')throw Error('Synthetic lost write receipt');return receipt(row(3,'CURRENT'));});
  f.click('memory-form','submit');await f.settled();const event=f.run('pending.input.event_id');
  await f.read();assert.equal(f.calls.length,1);assert.equal(f.get('compare-current').disabled,true);
  assert.equal(f.run('pending.input.event_id'),event);assert.equal(f.run('pending.delivery_unconfirmed'),true);
});
