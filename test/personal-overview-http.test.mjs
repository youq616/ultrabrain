/** Actual loopback HTTP server/headers; synthetic database adapter, NOT PostgreSQL. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {request as httpRequest} from 'node:http';
import {startPersonalConsole} from '../src/personal-console.mjs';
import {overviewReceipt,overviewId} from './helpers/overview-fixture.mjs';
const token='a'.repeat(64);
async function fixture(t){
 const calls=[];let answer=overviewReceipt();
 const sql=async (query,args)=>{
  calls.push({query,args});
  if(query.startsWith('SELECT id FROM public.sources'))return [{id:'selected'}];
  if(query.trimStart().startsWith('WITH ')){
   if(answer instanceof Error)throw answer;
   const {observed_at,memories,jobs,documents,agents}=answer;
   return [{observed_at,memories,jobs,documents,agents}];
  }
  return [];
 };
 const engine={kind:'postgres',executeRaw:sql,transaction:fn=>fn({executeRaw:sql})};
 const service=await startPersonalConsole({engine,source:'selected',token,port:0,configureModel:()=>assert.fail('No model access')});
 t.after(()=>service.close());
 // Use the raw HTTP client so the test actually transmits an overridden Host.
 const send=(body={operation:'overview',input:{request_id:overviewId}},headers={})=>new Promise((resolve,reject)=>{
  const req=httpRequest(service.origin+'/api/call',{method:'POST',headers:{Origin:service.origin,Authorization:'Bearer '+token,
   'Content-Type':'application/json',...headers}},res=>{
    let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>{
     try{resolve({status:res.statusCode,headers:new Headers(res.headers),body:JSON.parse(text)});}catch(error){reject(error);}
    });
  });
  req.on('error',reject);req.end(JSON.stringify(body));
 });
 return {...service,calls,send,set:value=>answer=value};
}
test('overview HTTP: authenticated request is routed read-only with UUID-bound metadata',async t=>{
 const f=await fixture(t),r=await f.send();assert.equal(r.status,200);
 assert.deepEqual(r.body,{ok:true,result:overviewReceipt()});
 assert.equal(f.calls.filter(c=>c.query.startsWith('WITH ')).length,1);
 assert.ok(f.calls.some(c=>c.query==='SET LOCAL transaction_read_only=on'));
 assert.equal(r.headers.get('cache-control'),'no-store');
 assert.ok(!JSON.stringify(r.body).includes(token));
});
for(const [name,headers,status]of [['no token',{Authorization:''},401],['foreign origin',{Origin:'https://attacker.invalid'},403],
 ['foreign host',{Host:'attacker.invalid'},403],['cross-site',{'Sec-Fetch-Site':'cross-site'},403]])
 test('overview HTTP: '+name+' fails before aggregation',async t=>{
  const f=await fixture(t),r=await f.send(undefined,headers);assert.equal(r.status,status);assert.equal(f.calls.length,1);
 });
for(const extra of [{source_id:'other'},{actor_key:'other'},{project_id:'x'},{limit:1}])
 test('overview HTTP: caller scope/page override rejected '+JSON.stringify(extra),async t=>{
  const f=await fixture(t),r=await f.send({operation:'overview',input:{request_id:overviewId,...extra}});
  assert.equal(r.status,400);assert.equal(r.body.error,'invalid_params');assert.equal(r.body.delivery,'rejected');assert.equal(f.calls.length,1);
 });
test('overview HTTP: invalid partitions are not a successful empty database',async t=>{
 const f=await fixture(t),bad=overviewReceipt();bad.jobs.total++;f.set(bad);
 const r=await f.send();assert.equal(r.status,400);assert.equal(r.body.error,'personal_overview_unconfirmed');assert.equal(r.body.result,undefined);
});
test('overview HTTP: storage failures omit private diagnostics and do not claim a write',async t=>{
 const f=await fixture(t);f.set(Error('PRIVATE_SQL_AND_MEMORY'));
 const r=await f.send();assert.equal(r.status,500);assert.equal(r.body.error,'personal_storage_error');
 assert.equal(r.body.delivery,'rejected');assert.ok(!JSON.stringify(r.body).includes('PRIVATE'));
});
test('overview HTTP: fixed scripts preserve CSP, and arbitrary asset paths remain rejected',async t=>{
 const f=await fixture(t);
 for(const path of ['/overview-ui.js','/overview-contract.mjs']){
  const r=await fetch(f.origin+path);assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');
  assert.match(r.headers.get('content-security-policy'),/script-src 'self'/);assert.equal(r.headers.get('access-control-allow-origin'),null);
  const text=await r.text();for(const bad of ['innerHTML','localStorage','sessionStorage','setInterval(','unsafe-eval'])assert.ok(!text.includes(bad));
 }
 for(const path of ['/overview-ui.js?source=other','/overview-contract.mjs?token='+token,'/api/overview'])
  assert.equal((await fetch(f.origin+path)).status,404);
 assert.equal(f.calls.length,1);
});
