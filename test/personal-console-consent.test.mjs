/** Execute the shipped browser handlers with a synthetic DOM and controlled HTTP barriers.
 * Real Chromium/PostgreSQL coverage remains in personal-console-browser.py. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';
const app=readFileSync(new URL('../web/personal/app.js',import.meta.url),'utf8');
const turn=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(route=async()=>{}) {
  const elements=new Map(),calls=[];
  function element(){return {value:'',checked:false,dataset:{},hidden:false,disabled:false,textContent:'',handlers:new Map(),
    addEventListener(name,handler){this.handlers.set(name,handler);},reset(){},replaceChildren(){},setAttribute(){},append(){},focus(){}};}
  const get=id=>{if(!elements.has(id))elements.set(id,element());return elements.get(id);};
  const ctx=vm.createContext({document:{getElementById:get,querySelectorAll:()=>[],createElement:element},
    window:{addEventListener(){}},crypto:{randomUUID},AbortSignal,confirm:()=>true,
    fetch:async(_url,options)=>{const body=JSON.parse(options.body);calls.push(body);await route(body);
      const p=body.input;
      const result=body.operation==='register'?{source_id:'default',agent_id:p.agent_id,actor_key:'a'.repeat(64),revision:1,replayed:true}
        :body.operation==='commit'?{source_id:'default',event_id:p.event_id,entries:[{id:'11111111-1111-4111-8111-111111111111',revision:1,status:'candidate'}],storage:'stored',state:'candidate',model_calls:0,review_required:true,replayed:false}
        :body.operation==='capture'?{source_id:'default',event_id:p.event_id,input_id:'11111111-1111-4111-8111-111111111111',job_id:'22222222-2222-4222-8222-222222222222',input_revision:1,storage:'journaled',state:'queued',model_calls:0,review_required:true,replayed:false}
        :body.operation==='update'?{id:p.memory_id,revision:p.expected_revision+1,status:'candidate',review_required:true,replayed:false}
        :{memories:[],next_offset:null};
      return {ok:true,json:async()=>({ok:true,result})};}});
  vm.runInContext(app,ctx);
  vm.runInContext("token='synthetic-token';sourceId='default';",ctx);
  get('content').value='Synthetic explicitly selected text';get('consent').checked=true;
  get('type').value='preference';get('visibility').value='private';get('importance').value='normal';get('provenance').value='Synthetic user input';
  const run=expression=>vm.runInContext(expression,ctx);
  return {get,calls,run,click:(id,event='click')=>get(id).handlers.get(event)({preventDefault(){}}),
    async settled(){for(let i=0;i<100&&run('busy');i++)await turn();assert.equal(run('busy'),false,'Request did not settle');}};
}
for(const operation of ['commit','capture'])for(const change of ['consent','content','project','visibility'])
  test(`browser ${operation} does not send text when ${change} changes during registration`,async()=>{
    let release;const f=fixture(async body=>{if(body.operation==='register')await new Promise(resolve=>release=resolve);});
    if(operation==='commit')f.click('memory-form','submit');else f.click('queue-personal');
    await turn();assert.equal(typeof release,'function');
    if(change==='consent')f.get(change).checked=false;else f.get(change).value='changed';
    release();await f.settled();
    assert.deepEqual(f.calls.map(call=>call.operation),['register']);
    assert.match(f.get('message').textContent,/memory_consent_or_selection_changed/);
    assert.equal(f.run('pending'),null);
  });
for(const operation of ['commit','capture','update'])
  test(`browser ${operation} retains an unconfirmed event and does not retry after consent withdrawal`,async()=>{
    let attempts=0;const f=fixture(async body=>{if(body.operation===operation&&++attempts===1)throw new Error('Synthetic response lost after submission');});
    if(operation==='update')f.run("editing={id:'11111111-1111-4111-8111-111111111111',revision:4,confidence:null};");
    if(operation==='capture')f.click('queue-personal');else f.click('memory-form','submit');
    await f.settled();assert.equal(attempts,1);
    const before=JSON.stringify(f.calls.find(call=>call.operation===operation)),count=f.calls.length;
    f.get('consent').checked=false;f.click('retry');await f.settled();
    assert.equal(f.calls.length,count,'Revoked retry must perform no HTTP call');
    assert.equal(f.run('pending.delivery_unconfirmed'),true);
    assert.match(f.get('message').textContent,/此前提交仍未确认/);
    f.get('consent').checked=true;f.click('retry');await f.settled();
    assert.equal(attempts,2);assert.equal(f.run('pending'),null);
    const writes=f.calls.filter(call=>call.operation===operation);
    assert.equal(JSON.stringify(writes[1]),before,'Retry must preserve the exact original input and event');
  });
test('browser update retry rejects changed form content while preserving its original event',async()=>{
  const f=fixture(async body=>{if(body.operation==='update')throw new Error('Synthetic lost response');});
  f.run("editing={id:'11111111-1111-4111-8111-111111111111',revision:4,confidence:null};");f.click('memory-form','submit');await f.settled();
  const event=f.run('pending.input.event_id');f.get('content').value='Different unapproved content';
  f.click('retry');await f.settled();
  assert.equal(f.calls.filter(call=>call.operation==='update').length,1);
  assert.equal(f.run('pending.input.event_id'),event);assert.equal(f.run('pending.delivery_unconfirmed'),true);
});
