import test from 'node:test';
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {mkdtempSync,rmSync,readFileSync,chmodSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startPersonalConsole,consoleOptions,consoleToken} from '../src/personal-console.mjs';
const token='a'.repeat(64);
async function fixture(t){
 let queries=0;const engine={kind:'postgres',executeRaw:async()=>{queries++;return [{id:'default'}];},transaction:async()=>{assert.fail('No write expected');}};
 const s=await startPersonalConsole({engine,source:'default',token,port:0});t.after(()=>s.close());return {...s,get queries(){return queries;}};
}
function raw(origin,{method='POST',path='/api/call',body={operation:'info'},headers={}}={}) {
 return new Promise((resolve,reject)=>{
  const data=typeof body==='string'?body:JSON.stringify(body);
  const r=request(origin+path,{method,headers:{'Content-Type':'application/json','Origin':origin,'Authorization':'Bearer '+token,...headers}},res=>{
   let text='';res.on('data',x=>text+=x);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text}));});
  r.on('error',reject);r.end(method==='GET'?undefined:data);
 });
}
test('console supports only bounded source/port/token-file options',()=>{
 assert.equal(consoleOptions([]).port,3132);
 for(const args of [['--bind','0.0.0.0'],['--source','a','--source','b'],['--port','0'],['--source','../a'],['--token-file']])assert.throws(()=>consoleOptions(args));
});
test('console token is private, persistent and never overwritten',t=>{
 const d=mkdtempSync(join(tmpdir(),'ub-console-token-'));t.after(()=>rmSync(d,{recursive:true,force:true}));const file=join(d,'token');
 const a=consoleToken(file);assert.match(a,/^[a-f0-9]{64}$/);assert.equal(consoleToken(file),a);assert.equal(readFileSync(file,'utf8').trim(),a);
 chmodSync(file,0o644);assert.throws(()=>consoleToken(file),{code:'insecure_token_file'});
});
test('console refuses unsafe token directories, malformed files and symlinks',t=>{
 const d=mkdtempSync(join(tmpdir(),'ub-console-token-'));t.after(()=>rmSync(d,{recursive:true,force:true}));const f=join(d,'file');writeFileSync(f,'invalid',{mode:0o600});
 assert.throws(()=>consoleToken(f),{code:'invalid_token_file'});symlinkSync(f,join(d,'link'));assert.throws(()=>consoleToken(join(d,'link')));
 chmodSync(d,0o755);assert.throws(()=>consoleToken(f),{code:'insecure_token_file'});
});
test('static UI does not contain a token; strict security headers are present',async t=>{
 const s=await fixture(t),r=await raw(s.origin,{method:'GET',path:'/'});assert.equal(r.status,200);assert.ok(!r.text.includes(token));assert.equal(r.headers['cache-control'],'no-store');assert.match(r.headers['content-security-policy'],/frame-ancestors 'none'/);
 assert.ok(!r.headers['access-control-allow-origin']);assert.equal(r.headers['x-content-type-options'],'nosniff');
});
test('authenticated info exposes only the selected source, not paths or credentials',async t=>{
 const s=await fixture(t),r=await raw(s.origin);assert.equal(r.status,200);assert.equal(JSON.parse(r.text).result.source_id,'default');assert.ok(!r.text.includes(token));assert.equal(s.queries,1);
});
for(const [name,headers,status] of [
 ['missing token',{Authorization:''},401],['wrong token',{Authorization:'Bearer '+'b'.repeat(64)},401],
 ['foreign origin',{Origin:'https://attacker.invalid'},403],['null origin',{Origin:'null'},403],['missing origin',{Origin:''},403],
 ['rebound host',{Host:'attacker.invalid'},403],['localhost alias',{Host:'localhost'},403],
 ['forwarded host',{'X-Forwarded-Host':'example.invalid'},403],['cross-site fetch',{'Sec-Fetch-Site':'cross-site'},403],
 ['simple content type',{'Content-Type':'text/plain'},415],['compressed body',{'Content-Encoding':'gzip'},415]])
 test('reject '+name+' before store access',async t=>{const s=await fixture(t),r=await raw(s.origin,{headers});assert.equal(r.status,status);assert.equal(s.queries,1);});
test('fixed routes reject token query, traversal, CORS and alternate methods',async t=>{
 const s=await fixture(t);
 for(const opts of [{method:'GET',path:'/api/call'}, {path:'/api/call?token='+token},{method:'GET',path:'/../AGENTS.md'},{method:'OPTIONS'}]){
  const r=await raw(s.origin,opts);assert.equal(r.status,404);assert.ok(!r.headers['access-control-allow-origin']);
 }assert.equal(s.queries,1);
});
test('arbitrary tools, input source overrides and unconsented writes are rejected',async t=>{
 const s=await fixture(t);
 for(const body of [{operation:'query',input:{sql:'select 1'}},{operation:'__proto__'},{operation:'info',input:{source_id:'foreign'}},{operation:'search',input:{source_id:'foreign'}},{operation:'commit',input:{agent_id:'custom',event_id:'e',consent:false,summary:'secret'}}]){
  const r=await raw(s.origin,{body});assert.equal(r.status,400);assert.ok(!r.text.includes('secret'));
 }assert.equal(s.queries,1);
});
test('invalid JSON and advertised oversize bodies do not reach store',async t=>{
 const s=await fixture(t);assert.equal((await raw(s.origin,{body:'{bad'})).status,400);
 assert.equal((await raw(s.origin,{headers:{'Content-Length':'300000'}})).status,413);assert.equal(s.queries,1);
});
test('served JS does not use HTML insertion or browser token storage',async t=>{
 const s=await fixture(t),r=await raw(s.origin,{method:'GET',path:'/app.js'});
 assert.equal(r.status,200);for(const text of ['innerHTML','outerHTML','insertAdjacentHTML','localStorage','sessionStorage','document.cookie'])assert.ok(!r.text.includes(text),text);
 assert.match(r.text,/textContent/);assert.match(r.text,/crypto\.randomUUID/);
});

test('local inspector is a fixed code-only asset, not a new data API',async t=>{
 const s=await fixture(t),r=await raw(s.origin,{method:'GET',path:'/snapshot-inspector-ui.js'});
 assert.equal(r.status,200);assert.equal(r.headers['cache-control'],'no-store');
 for(const forbidden of ['innerHTML','localStorage','sessionStorage',"api('","fetch('"])assert.ok(!r.text.includes(forbidden));
 assert.equal((await raw(s.origin,{method:'GET',path:'/snapshot-inspector-ui.js?file=secret'})).status,404);
 assert.equal(s.queries,1);
});
