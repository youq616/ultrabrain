/** Execute the shipped login/lock handlers with controlled response ordering.
 * Synthetic DOM/HTTP only; browser and PostgreSQL qualification are separate. */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
const app=readFileSync(new URL('../web/personal/app.js',import.meta.url),'utf8');
function fixture(){
  const nodes=new Map(),calls=[],requests=[];
  const element=()=>({value:'',checked:false,dataset:{},hidden:false,disabled:false,textContent:'',children:[],handlers:new Map(),
    addEventListener(k,f){this.handlers.set(k,f);},reset(){},replaceChildren(){this.children=[];},
    append(...xs){this.children.push(...xs);},setAttribute(){},focus(){}});
  const get=id=>{if(!nodes.has(id))nodes.set(id,element());return nodes.get(id);};
  const ctx=vm.createContext({document:{getElementById:get,createElement:element,querySelectorAll:()=>[]},
    window:{addEventListener(){}},TextEncoder,TextDecoder,AbortController,AbortSignal,crypto:webcrypto,confirm:()=>true,
    fetch:async(_url,options)=>{
      const body=JSON.parse(options.body);calls.push({...body,authorization:options.headers.Authorization});
      if(body.operation!=='info')return {ok:true,status:200,json:async()=>({ok:true,result:{memories:[],next_offset:null}})};
      // Deliberately ignore abort here: a response already queued for delivery can
      // settle after cancellation. The handler must independently fence its result.
      return new Promise((resolve,reject)=>requests.push({signal:options.signal,
        success(source='default'){resolve({ok:true,status:200,json:async()=>({ok:true,result:{source_id:source}})});},
        fail(){reject(new Error('Synthetic network failure'));}}));
    }});
  const run=s=>vm.runInContext(s,ctx);run(app);
  get('login').hidden=false;get('workspace').hidden=true;get('logout').hidden=true;
  return {get,run,calls,requests,
    login(value='SYNTHETIC_TOKEN'){get('token').value=value;return get('login-form').handlers.get('submit')({preventDefault(){}});},
    lock(){return get('logout').handlers.get('click')();}};
}
function connected(f,token='SYNTHETIC_TOKEN'){
  assert.equal(f.run('token'),token);assert.equal(f.run('sourceId'),'default');
  assert.equal(f.get('login').hidden,true);assert.equal(f.get('workspace').hidden,false);assert.equal(f.get('logout').hidden,false);
}
function locked(f){
  assert.equal(f.run('token'),'');assert.equal(f.run('sourceId'),'');
  assert.equal(f.get('login').hidden,false);assert.equal(f.get('workspace').hidden,true);assert.equal(f.get('logout').hidden,true);
}
test('a failed earlier login cannot clear a later successful connection',async()=>{
  const f=fixture(),older=f.login(),newer=f.login();
  f.requests[1].success();await newer;connected(f);const text=f.get('message').textContent;
  f.requests[0].fail();await older;connected(f);assert.equal(f.get('message').textContent,text);
  assert.equal(f.calls.filter(x=>x.operation==='search').length,1);
});
test('an earlier success cannot undo the latest rejected login',async()=>{
  const f=fixture(),older=f.login(),newer=f.login('DIFFERENT_SYNTHETIC_TOKEN');
  f.requests[1].fail();await newer;locked(f);const text=f.get('message').textContent;
  f.requests[0].success();await older;locked(f);assert.equal(f.get('message').textContent,text);
  assert.deepEqual(f.calls.map(x=>x.operation),['info','info']);
});
for(const outcome of ['success','fail'])test('locking fences an earlier login '+outcome,async()=>{
  const f=fixture(),older=f.login(),newer=f.login();
  f.requests[1].success();await newer;connected(f);f.lock();locked(f);const text=f.get('message').textContent;
  f.requests[0][outcome]();await older;locked(f);assert.equal(f.get('message').textContent,text);
});
test('ordinary login uses the submitted token, clears the input and loads once',async()=>{
  const f=fixture(),login=f.login('  SYNTHETIC_TOKEN  ');
  assert.equal(f.get('token').value,'');assert.equal(f.get('workspace').hidden,true);
  assert.equal(f.get('logout').hidden,false,'An in-flight login can be locked');
  f.requests[0].success();await login;connected(f);
  assert.deepEqual(f.calls.map(x=>[x.operation,x.authorization]),[['info','Bearer SYNTHETIC_TOKEN'],['search','Bearer SYNTHETIC_TOKEN']]);
});
test('ordinary login failure stays locked and can be retried',async()=>{
  const f=fixture(),first=f.login();f.requests[0].fail();await first;locked(f);
  assert.match(f.get('message').textContent,/连接失败/);
  const retry=f.login();f.requests[1].success();await retry;connected(f);
});
for(const outcome of ['success','fail'])test('lock cancels an in-flight first login '+outcome,async()=>{
  const f=fixture(),login=f.login();f.get('token').value='UNSUBMITTED_TOKEN';f.lock();locked(f);
  assert.equal(f.get('token').value,'');
  assert.equal(f.requests[0].signal.aborted,true);
  const text=f.get('message').textContent;f.requests[0][outcome]();await login;
  locked(f);assert.equal(f.get('message').textContent,text);assert.equal(f.calls.length,1);
});
test('replacing an attempt aborts its request and an older finalizer preserves the newer request',async()=>{
  const f=fixture(),older=f.login(),newer=f.login('NEW_SYNTHETIC_TOKEN');
  assert.equal(f.requests[0].signal.aborted,true);assert.equal(f.requests[1].signal.aborted,false);
  f.requests[0].fail();await older;assert.equal(f.run('loginController !== null'),true);
  f.requests[1].success();await newer;connected(f,'NEW_SYNTHETIC_TOKEN');assert.equal(f.run('loginController'),null);
});
for(const field of ['busy','pending'])test('login cannot replace a session while '+field,async()=>{
  const f=fixture();f.run(field==='busy'?"busy=true;token='EXISTING_SESSION';":"pending={input:{event_id:'existing'}};token='EXISTING_SESSION';");
  await f.login();assert.equal(f.calls.length,0);assert.equal(f.run('token'),'EXISTING_SESSION');
  if(field==='pending')assert.equal(f.run('pending.input.event_id'),'existing');
});
test('hidden login form cannot replace an already connected session',async()=>{
  const f=fixture(),login=f.login();f.requests[0].success();await login;
  await f.login('IGNORED_TOKEN');connected(f);assert.equal(f.calls.filter(x=>x.operation==='info').length,1);
});
test('an older successful login does not replace the latest source or load twice',async()=>{
  const f=fixture(),older=f.login(),newer=f.login();
  f.requests[1].success();await newer;connected(f);
  f.requests[0].success('older-source');await older;connected(f);
  assert.equal(f.calls.filter(x=>x.operation==='search').length,1);
});
