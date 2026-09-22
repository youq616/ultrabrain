/** Fresh disposable bootstrap -> explicit token initialization -> real console API.
 * The initializer itself never connects. This test separately opens the database
 * and console after proving its offline state, then closes both test handles.
 */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,existsSync,lstatSync,mkdirSync,rmdirSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';
import {ROOT,HOME,connect} from '../src/runtime.mjs';
import {consoleToken,startPersonalConsole} from '../src/personal-console.mjs';
if(process.env.GITHUB_ACTIONS!=='true'||process.env.ULTRABRAIN_TEST_ALLOW_WRITE!=='1'||
   typeof process.getuid!=='function'||process.getuid()===0||HOME!==join(homedir(),'ultrabrain-personal-services-test'))
 throw Error('Only the explicitly authorized fresh CI installation may run this test');
let checks=0,engine,ui;const pass=()=>checks++;
const tokenFile=join(HOME,'personal-console-token');
const files=['postgres/state.json','postgres/runtime.json','postgres/data/PG_VERSION','postgres/data/postmaster.pid','gbrain/.gbrain/config.json'];
const sha=b=>createHash('sha256').update(b).digest('hex');
function snapshot(){return files.map(name=>({name,sha:sha(readFileSync(join(HOME,name))),ino:lstatSync(join(HOME,name)).ino}));}
function invoke(action,expected,{rejected=false}={}){
 const p=spawnSync(process.execPath,[join(ROOT,'src/cli.mjs'),'personal-init',action,'--home',HOME],
  {encoding:'utf8',timeout:10000,maxBuffer:16384,env:{...process.env,ULTRABRAIN_DEBUG:'1'}});
 assert.ifError(p.error);assert.equal(p.status,expected);assert.equal(p.stderr,'');
 const value=JSON.parse(p.stdout);
 for(const key of ['services_started','database_connected','model_called','configuration_changed','application_ready','token_value_returned'])
  assert.equal(value[key],false);
 if(!rejected)assert.equal(value.instance_identity_verified,false);
 return {value,text:p.stdout};
}
try {
 assert.equal(existsSync(tokenFile),false,'Do not adopt a previously initialized fixture');
 assert.equal(existsSync(join(HOME,'personal-deployment')),false);
 const before=snapshot();
 const absent=invoke('status',1);assert.equal(absent.value.token_creation,'absent');assert.equal(existsSync(tokenFile),false);pass();
 const created=invoke('create-token',0);assert.equal(created.value.token_creation,'created');
 const raw=readFileSync(tokenFile),token=raw.toString('ascii').trim();assert.match(token,/^[a-f0-9]{64}$/);
 assert.equal(lstatSync(tokenFile).mode&0o777,0o600);assert.ok(!created.text.includes(token));pass();
 const ino=lstatSync(tokenFile).ino;
 for(const action of ['create-token','status']){
  const r=invoke(action,0);assert.equal(r.value.token_creation,'existing');assert.ok(!r.text.includes(token));
  assert.ok(readFileSync(tokenFile).equals(raw),'Existing token bytes must be preserved');assert.equal(lstatSync(tokenFile).ino,ino);pass();
 }
 // A credential that a permissive trim() reader accepts is still unusable by
 // managed activation. Exercise both public entrypoints before opening any UI.
 const wrapped=Buffer.from(token+'\r\n','ascii');
 try {
  writeFileSync(tokenFile,wrapped);
  for(const action of ['status','create-token']){
   const r=invoke(action,1,{rejected:true});
   assert.equal(r.value.error,'invalid_console_token');assert.equal(r.value.token_creation,'not_proven');
   assert.ok(!r.text.includes(token));assert.ok(readFileSync(tokenFile).equals(wrapped));
   assert.equal(lstatSync(tokenFile).ino,ino);pass();
  }
 }finally{writeFileSync(tokenFile,raw);}
 // Only this disposable fixture moves its own generated credential. Existing
 // deployment/activation history must mean recovery, even for read-only status.
 const history=join(HOME,'personal-activation'),held=join(HOME,'personal-init-test-held-token');
 assert.equal(existsSync(history),false);assert.equal(existsSync(held),false);
 renameSync(tokenFile,held);
 try {
  mkdirSync(history,{mode:0o700});
  try {
   for(const action of ['status','create-token']){
    const r=invoke(action,1,{rejected:true});
    assert.equal(r.value.error,'token_recovery_required');assert.equal(r.value.token_creation,'not_proven');
    assert.equal(existsSync(tokenFile),false);assert.ok(readFileSync(held).equals(raw));pass();
   }
  }finally{rmdirSync(history);}
 }finally{renameSync(held,tokenFile);}
 assert.deepEqual(snapshot(),before,'Offline initialization must not change managed configuration or database process identity');pass();
 assert.equal(consoleToken(tokenFile),token);assert.ok(readFileSync(tokenFile).equals(raw));pass();
 engine=await connect();
 const [identityBefore]=await engine.executeRaw('SELECT instance_id FROM ultrabrain.instance_identity');
 ui=await startPersonalConsole({engine,source:'default',token,port:0});
 const response=await fetch(ui.origin+'/api/call',{method:'POST',headers:{Origin:ui.origin,'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({operation:'info'})});
 assert.equal(response.status,200);assert.equal((await response.json()).result.source_id,'default');pass();
 const [identityAfter]=await engine.executeRaw('SELECT instance_id FROM ultrabrain.instance_identity');
 assert.deepEqual(identityAfter,identityBefore);assert.deepEqual(snapshot(),before);
 assert.ok(readFileSync(tokenFile).equals(raw));pass();
 console.log(`PASS ${checks} fresh credential bootstrap checks: actual CLI, existing managed PostgreSQL and separately authenticated console; no model calls or user deployment`);
} finally {try{await ui?.close();}finally{await engine?.disconnect();}}
