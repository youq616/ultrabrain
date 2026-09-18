import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import {request} from 'node:http';
import {startPersonalConsole} from '../src/personal-console.mjs';
import {createPersonalReadiness} from '../src/personal-readiness.mjs';

const token='0123456789abcdef'.repeat(4),invocation='23'.repeat(16),nonce='10'.repeat(32);
const row={source_exists:true,schema_ready:true,instance_id:'00000000-0000-4000-8000-000000000001',
  backend_pid:1235,database_port:55432,database_name:'ultrabrain',database_user:'ultrabrain',
  database_address:'127.0.0.1',database_session_user:'ultrabrain',postmaster_started:'1799999900'};
const canonicalRequest=p=>JSON.stringify([1,p.nonce,p.origin,p.invocation_id,p.issued_at]);
const requestProof=(p,key=token)=>createHmac('sha256',Buffer.from(key,'hex'))
  .update('ultrabrain-personal-ready-request-v1\n'+canonicalRequest(p),'ascii').digest('hex');
const responseProof=(r,key=token)=>createHmac('sha256',Buffer.from(key,'hex'))
  .update('ultrabrain-personal-ready-response-v1\n'+JSON.stringify([1,r.request_sha256,r.nonce,r.origin,r.source_id,r.invocation_id,
    r.pid,r.instance_id,r.backend_pid,r.database_port,r.database_name,r.database_user,r.database_address,
    r.database_session_user,r.postmaster_started]),'ascii').digest('hex');
function body(origin,overrides={},key=token) {
  const p={format:1,nonce,origin,invocation_id:invocation,issued_at:Math.floor(Date.now()/1000),...overrides};
  return {...p,proof:requestProof(p,key)};
}
async function fixture(t,{transaction,query,source='personal',invocationId=invocation}={}) {
  let transactions=0;const statements=[];
  const engine={kind:'postgres',executeRaw:async(sql,params)=>{
    assert.equal(sql,'SELECT id FROM public.sources WHERE id=$1');assert.deepEqual(params,[source]);return [{id:source}];
  },transaction:async fn=>{
    transactions++;
    if(transaction)return transaction(fn);
    return fn({executeRaw:async(sql,params)=>{
      statements.push({sql,params});if(sql.startsWith('SET '))return [];
      return query?query(sql,params):[{...row}];
    }});
  }};
  const s=await startPersonalConsole({engine,source,token,port:0,invocationId});
  t.after(()=>s.close());return {...s,engine,statements,get transactions(){return transactions;}};
}
function raw(origin,{path='/api/readiness',method='POST',data=body(origin),headers={}}={}) {
  return new Promise((done,fail)=>{
    const bytes=Buffer.isBuffer(data)?data:Buffer.from(typeof data==='string'?data:JSON.stringify(data));
    const req=request(origin+path,{method,headers:{'Content-Type':'application/json','Content-Length':bytes.length,Origin:origin,...headers}},res=>{
      const chunks=[];res.on('data',x=>chunks.push(x));res.on('end',()=>{
        clearTimeout(timer);const text=Buffer.concat(chunks).toString('utf8');done({status:res.statusCode,headers:res.headers,text});
      });res.on('error',fail);
    });
    const timer=setTimeout(()=>req.destroy(new Error('test HTTP deadline')),6000);
    req.on('error',e=>{clearTimeout(timer);fail(e);});req.end(bytes);
  });
}
function safeError(response,status) {
  assert.equal(response.status,status);
  const value=JSON.parse(response.text);assert.equal(value.ok,false);assert.equal(value.delivery,'rejected');
  for(const secret of [token,'database-secret','proof','instance_id','backend_pid'])assert.ok(!response.text.includes(secret),secret);
  return value;
}

test('readiness protocol matches independently generated Python HMAC/SHA256 vectors',async t=>{
  t.mock.method(Date,'now',()=>1800000000000);
  const pid=Object.getOwnPropertyDescriptor(process,'pid');Object.defineProperty(process,'pid',{...pid,value:1234});
  try {
    const probe=createPersonalReadiness({source:'personal',token,invocationId:invocation,
      engine:{transaction:fn=>fn({executeRaw:async sql=>sql.startsWith('SET ')?[]:[row]})}});
    const request=body('http://127.0.0.1:3132');
    assert.equal(request.proof,'f25940f0c217695b1c2846f001f312170df9926d5383d70f6a6650f4026e4af9');
    const authenticated=probe.authenticate(request,request.origin);
    assert.equal(authenticated.request_sha256,'985fb4de8b70292ba86fd529b8af6a68786e2a5c03ea97a6994dde20ce9cb39f');
    const result=await probe.query(authenticated,request.origin);
    assert.equal(result.proof,'308f0cda6178591e05d502038c7bcd26254e8d6a92e7ee3fcf1c485e6a4de436');
  } finally {Object.defineProperty(process,'pid',pid);}
});

test('HTTP readiness signs a fresh source/process/database proof using only a read-only transaction',async t=>{
  const s=await fixture(t),p=body(s.origin),r=await raw(s.origin,{data:p});assert.equal(r.status,200);
  assert.equal(r.headers['content-type'],'application/json; charset=utf-8');assert.equal(r.headers['cache-control'],'no-store');
  assert.equal(Number(r.headers['content-length']),Buffer.byteLength(r.text));assert.equal(r.headers.connection,'close');
  assert.equal(r.headers['transfer-encoding'],undefined);assert.ok(!r.text.includes(token));
  const result=JSON.parse(r.text).result;
  assert.deepEqual(Object.keys(result),['format','request_sha256','nonce','origin','source_id','invocation_id','pid','instance_id',
    'backend_pid','database_port','database_name','database_user','database_address','database_session_user','postmaster_started','proof']);
  assert.equal(result.source_id,'personal');assert.equal(result.origin,s.origin);assert.equal(result.invocation_id,invocation);
  assert.equal(result.pid,process.pid);assert.equal(result.nonce,p.nonce);assert.equal(result.backend_pid,row.backend_pid);
  assert.equal(result.postmaster_started,1799999900);
  assert.equal(result.request_sha256,createHash('sha256').update(canonicalRequest(p),'ascii').digest('hex'));
  assert.equal(result.proof,responseProof(result));assert.notEqual(result.proof,requestProof(p));
  assert.equal(s.transactions,1);assert.equal(s.statements.length,4);
  assert.deepEqual(s.statements.slice(0,3).map(x=>x.sql),['SET TRANSACTION READ ONLY',"SET LOCAL statement_timeout='2s'","SET LOCAL lock_timeout='1s'"]);
  assert.deepEqual(s.statements[3].params,['personal']);assert.match(s.statements[3].sql,/public\.sources WHERE id=\$1/);
  assert.match(s.statements[3].sql,/pg_catalog\.pg_backend_pid\(\)/);assert.match(s.statements[3].sql,/pg_catalog\.pg_postmaster_start_time\(\)/);
  assert.ok(s.statements.every(x=>! /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|CALL)\b/.test(x.sql)));
});

for(const [name,headers,status] of [
  ['bearer token',{Authorization:'Bearer '+token},401],['empty Authorization',{Authorization:''},401],
  ['foreign origin',{Origin:'https://attacker.invalid'},403],['absent origin',{Origin:''},403],
  ['foreign Host',{Host:'attacker.invalid'},403],['localhost alias',{Host:'localhost'},403],
  ['forwarded', {Forwarded:'for=127.0.0.1'},403],['forwarded host',{'X-Forwarded-Host':'127.0.0.1'},403],
  ['forwarded for',{'X-Forwarded-For':'127.0.0.1'},403],['cross-site',{'Sec-Fetch-Site':'cross-site'},403],
  ['non-JSON',{'Content-Type':'text/plain'},415],['compressed',{'Content-Encoding':'gzip'},415],
  ['oversize advertised',{'Content-Length':'1025'},413]
])test('readiness rejects '+name+' before database access',async t=>{
  const s=await fixture(t);safeError(await raw(s.origin,{headers}),status);assert.equal(s.transactions,0);
});

test('fixed readiness method and path reject queries, alternate methods and bearer substitution',async t=>{
  const s=await fixture(t),p=body(s.origin);
  for(const opts of [{path:'/api/readiness?nonce='+nonce},{method:'GET'},{method:'OPTIONS'}])safeError(await raw(s.origin,opts),404);
  safeError(await raw(s.origin,{path:'/api/call',data:{operation:'info'},headers:{Authorization:'Bearer '+p.proof}}),401);
  assert.equal(s.transactions,0);
});

test('request proofs bind every request field, own origin and captured invocation before SQL',async t=>{
  const s=await fixture(t),p=body(s.origin);
  for(const data of [
    {...p,nonce:'11'.repeat(32)}, {...p,issued_at:p.issued_at+1}, {...p,proof:'00'.repeat(32)},
    body(s.origin,{},'f'.repeat(64)),body(s.origin,{origin:'http://127.0.0.1:1'}),
    body(s.origin,{invocation_id:'45'.repeat(16)}),body(s.origin,{invocation_id:'00'.repeat(16)})
  ])safeError(await raw(s.origin,{data}),401);
  assert.equal(s.transactions,0);
});

test('canonical bounded requests reject duplicate, unknown, missing and malformed fields before SQL',async t=>{
  const s=await fixture(t),p=body(s.origin),text=JSON.stringify(p);
  const missing={...p};delete missing.proof;
  for(const data of [
    {...p,source_id:'foreign'},missing,{...p,format:true},{...p,issued_at:1.5},{...p,nonce:'A'.repeat(64)},
    {...p,proof:token+'x'},{...p,nonce:null},[],null,'{bad',text.slice(0,-1)+',"nonce":"'+nonce+'"}',
    ' '+text,text.replace('"format":1','"format":1.0'),text.replace('"nonce"','"\\u006eonce"'),
    Buffer.from([0xff,0xfe]),Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from(text)])
  ])safeError(await raw(s.origin,{data}),400);
  assert.equal(s.transactions,0);
});

test('request replay is limited to its ten-second read-only validity window',async t=>{
  let now=1800000000000;t.mock.method(Date,'now',()=>now);
  const s=await fixture(t),p=body(s.origin);
  assert.equal((await raw(s.origin,{data:p})).status,200);
  now+=10000;assert.equal((await raw(s.origin,{data:p})).status,200);
  now+=1000;safeError(await raw(s.origin,{data:p}),401);
  safeError(await raw(s.origin,{data:body(s.origin,{issued_at:Math.floor(now/1000)+3})}),401);
  assert.equal((await raw(s.origin,{data:body(s.origin,{issued_at:Math.floor(now/1000)+2})})).status,200);
  assert.equal(s.transactions,3);
});

test('a response proof covers fresh request binding and every claimed process/database field',async t=>{
  const s=await fixture(t),p=body(s.origin),first=JSON.parse((await raw(s.origin,{data:p})).text).result;
  const next=JSON.parse((await raw(s.origin,{data:body(s.origin,{nonce:'11'.repeat(32)})})).text).result;
  assert.notEqual(first.request_sha256,next.request_sha256);assert.notEqual(first.proof,next.proof);
  for(const field of Object.keys(first).filter(x=>x!=='proof'&&x!=='format')) {
    const changed={...first,[field]:typeof first[field]==='number'?first[field]+1:first[field]+'x'};
    assert.notEqual(responseProof(changed),first.proof,field);
  }
});

for(const invocationId of ['', '0'.repeat(32),'X'.repeat(32),'bad'])
  test('readiness refuses missing/invalid systemd invocation '+JSON.stringify(invocationId),async t=>{
    const s=await fixture(t,{invocationId});safeError(await raw(s.origin),503);assert.equal(s.transactions,0);
    const info=await raw(s.origin,{path:'/api/call',data:{operation:'info'},headers:{Authorization:'Bearer '+token}});
    assert.equal(info.status,200);assert.deepEqual(Object.keys(JSON.parse(info.text).result),['source_id','identity_scope','version']);
  });

test('default invocation is captured at console start and ignores later environment changes',async t=>{
  const prior=process.env.INVOCATION_ID;process.env.INVOCATION_ID=invocation;
  let s;
  try {
    const engine={kind:'postgres',executeRaw:async()=>[{id:'personal'}],
      transaction:fn=>fn({executeRaw:async sql=>sql.startsWith('SET ')?[]:[row]})};
    s=await startPersonalConsole({engine,source:'personal',token,port:0});
    process.env.INVOCATION_ID='45'.repeat(16);
    assert.equal((await raw(s.origin)).status,200);
    safeError(await raw(s.origin,{data:body(s.origin,{invocation_id:process.env.INVOCATION_ID})}),401);
  } finally {
    if(prior===undefined)delete process.env.INVOCATION_ID;else process.env.INVOCATION_ID=prior;
    await s?.close();
  }
});

test('live source deletion, missing schema and invalid database facts cannot produce readiness',async t=>{
  let current=row;const s=await fixture(t,{query:()=>current});
  for(const invalid of [
    [],[row,row],[{...row,source_exists:false}],[{...row,schema_ready:false}],
    [{...row,instance_id:null}],[{...row,instance_id:'00000000-0000-0000-0000-000000000000'}],
    [{...row,backend_pid:0}],[{...row,backend_pid:'1235'}],[{...row,database_port:65536}],
    [{...row,database_name:'other'}],[{...row,database_user:'postgres'}],[{...row,database_session_user:'postgres'}],
    [{...row,database_address:'::1'}],[{...row,postmaster_started:'9007199254740992'}],
    [{...row,postmaster_started:'001'}],[{...row,postmaster_started:0}]
  ]){current=invalid;safeError(await raw(s.origin),503);}
  current=[row];assert.equal((await raw(s.origin)).status,200);
});

test('SQL and transaction failures produce only a safe unavailable response',async t=>{
  const s=await fixture(t,{query:()=>{throw new Error('database-secret '+token);}});
  assert.equal(safeError(await raw(s.origin),503).error,'readiness_unavailable');
  const failed=await fixture(t,{transaction:()=>Promise.reject(new Error('database-secret '+token))});
  safeError(await raw(failed.origin),503);
});

test('hung probes end HTTP within deadline while retaining all four shared operation slots',async t=>{
  const releases=[];const s=await fixture(t,{transaction:()=>new Promise(resolve=>releases.push(resolve))});
  const began=performance.now();
  try {
    const responses=await Promise.all(Array.from({length:4},()=>raw(s.origin)));
    assert.ok(performance.now()-began<5500);responses.forEach(r=>safeError(r,503));assert.equal(releases.length,4);
    safeError(await raw(s.origin),429);
    safeError(await raw(s.origin,{path:'/api/call',data:{operation:'info'},headers:{Authorization:'Bearer '+token}}),429);
    assert.equal(s.transactions,4);
  } finally {releases.forEach(resolve=>resolve([row]));}
  await new Promise(resolve=>setImmediate(resolve));
  const info=await raw(s.origin,{path:'/api/call',data:{operation:'info'},headers:{Authorization:'Bearer '+token}});
  assert.equal(info.status,200);
});

test('an unfinished body receives a bounded unavailable response and never starts SQL',async t=>{
  const s=await fixture(t),began=performance.now();
  const result=await new Promise((done,fail)=>{
    const req=request(s.origin+'/api/readiness',{method:'POST',headers:{Origin:s.origin,'Content-Type':'application/json','Content-Length':'900'}},res=>{
      let text='';res.on('data',x=>text+=x);res.on('end',()=>done({status:res.statusCode,text}));res.on('error',fail);
    });req.on('error',fail);req.write('{');
  });
  safeError(result,503);assert.ok(performance.now()-began<5500);assert.equal(s.transactions,0);
  assert.equal((await raw(s.origin)).status,200);
});
