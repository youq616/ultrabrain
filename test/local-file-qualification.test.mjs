import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {qualifyLocalFileRuntime,localFileObservation} from '../src/local-file-qualification.mjs';
function patch(t,name,handler){const original=fs[name];fs[name]=(...a)=>handler(original,...a);syncBuiltinESMExports();
 t.after(()=>{fs[name]=original;syncBuiltinESMExports();});return original;}
function seam(t,handle=211n){const platform=Object.getOwnPropertyDescriptor(process,'platform');
 Object.defineProperty(process,'platform',{...platform,value:'win32'});t.after(()=>Object.defineProperty(process,'platform',platform));
 patch(t,'lstatSync',(original,...a)=>{const s=original(...a);if(s.isFile())s.dev=0n;return s;});
 patch(t,'fstatSync',(original,...a)=>{const s=original(...a);s.dev=handle;return s;});
}
const stats=(extra={})=>({dev:1n,ino:2n,mode:33152n,nlink:1n,uid:1n,gid:1n,size:4n,mtimeNs:5n,ctimeNs:6n,birthtimeNs:7n,...extra});
test('qualification: real native file, both production policies, no user-file claim',()=>{
 const r=qualifyLocalFileRuntime();assert.equal(r.passed,true);assert.deepEqual(r.checks.map(c=>c.kind),['profile','outbox']);
 assert.ok(r.checks.every(c=>c.passed));assert.equal(r.scope,'temporary-directory-filesystem');
 assert.equal(r.user_files_selected,false);assert.equal(r.synthetic_writes_only,true);assert.equal(r.production_queue_verified,false);
 assert.equal(r.network_requests,0);assert.equal(r.model_calls,0);assert.ok(Object.isFrozen(r.checks));
});
test('qualification: zero path device is observed, not hidden, while readers anchor it',t=>{
 seam(t);const r=qualifyLocalFileRuntime();assert.equal(r.passed,true);assert.equal(r.observation.path_device_zero,true);
 assert.equal(r.observation.handle_device_zero,false);assert.equal(r.observation.device_relation,'unrecognized');
 assert.deepEqual(r.observation.changed_fields,['dev']);assert.ok(!JSON.stringify(r).includes('211'));
});
for(const field of ['dev','ino','mode','nlink','uid','gid','size','mtimeNs','ctimeNs','birthtimeNs'])test('observation: differing '+field+' name without its value',()=>{
 const a=stats(),b=stats({[field]:222333444555666777n});const r=localFileObservation(a,b);
 assert.deepEqual(r.changed_fields,[field]);assert.ok(!JSON.stringify(r).includes('222333444555666777'));
});
for(const value of [null,{},stats({dev:0}),stats({ino:'PRIVATE'}),stats({size:undefined})])test('observation: unsupported shape never fabricates complete metadata',()=>{
 assert.throws(()=>localFileObservation(value,stats()),{code:'invalid_stat_observation'});
});
test('observation: getters never executed and arbitrary fields never emitted',()=>{
 let calls=0;const a=stats({path:'PRIVATE',message:'PRIVATE'});Object.defineProperty(a,'dev',{get(){calls++;return 1n;}});
 assert.throws(()=>localFileObservation(a,stats()));assert.equal(calls,0);
 assert.ok(!JSON.stringify(localFileObservation(stats({private:'PRIVATE'}),stats())).includes('PRIVATE'));
});
for(const option of [null,0,[],{path:'/PRIVATE'},{signal:null},{signal:{aborted:true}},{network:true}])test('qualification: invalid options before scratch creation',t=>{
 let calls=0;patch(t,'mkdtempSync',()=>{calls++;throw Error('Unexpected IO');});assert.throws(()=>qualifyLocalFileRuntime(option));assert.equal(calls,0);
});
test('qualification: pre-cancellation creates no files',t=>{
 const c=new AbortController();c.abort();let calls=0;patch(t,'mkdtempSync',()=>{calls++;throw Error('Unexpected IO');});
 const r=qualifyLocalFileRuntime({signal:c.signal});assert.equal(r.passed,false);assert.equal(r.failure.error,'aborted');assert.equal(calls,0);
});
test('qualification: cancellation after directory creation still cleans owned scratch',t=>{
 const c=new AbortController();let selected;patch(t,'mkdtempSync',(fn,...a)=>{selected=fn(...a);c.abort();return selected;});
 const r=qualifyLocalFileRuntime({signal:c.signal});assert.equal(r.passed,false);assert.equal(r.failure.error,'aborted');assert.equal(fs.existsSync(selected),false);
});
for(const name of ['mkdtempSync','writeFileSync','lstatSync','openSync','fstatSync'])test('qualification: '+name+' fails safely without retry',t=>{
 let calls=0;patch(t,name,()=>{calls++;throw Object.assign(Error('PRIVATE_NATIVE'),{code:'EPERM',path:'PRIVATE_PATH'});});
 const r=qualifyLocalFileRuntime();assert.equal(r.passed,false);assert.equal(r.failure.system_code,'EPERM');assert.equal(calls,1);assert.ok(!JSON.stringify(r).includes('PRIVATE'));
});
test('qualification: observation close attempted once even if close throws',t=>{
 let calls=0,observed;patch(t,'openSync',(fn,...a)=>{const fd=fn(...a);if(a[1]==='r')observed=fd;return fd;});
 patch(t,'closeSync',(fn,...a)=>{const r=fn(...a);if(a[0]===observed){calls++;throw Object.assign(Error('PRIVATE_CLOSE'),{code:'EBADF'});}return r;});
 const r=qualifyLocalFileRuntime();assert.equal(calls,1);assert.equal(r.failure.phase,'observation-close');assert.equal(r.cleanup_failure,null);
});
test('qualification: read refusal preserved separately for each policy',t=>{
 let count=0;patch(t,'fstatSync',(fn,...a)=>{const s=fn(...a);if(++count>1)s.ino+=1n;return s;});
 const r=qualifyLocalFileRuntime();assert.equal(r.passed,false);assert.equal(r.checks.length,2);
 assert.ok(r.checks.every(c=>!c.passed&&c.failure.diagnostic.reason==='identity'));assert.equal(r.failure,null);
});
test('qualification: cleanup error never erases primary error',t=>{
 const dirs=[];patch(t,'mkdtempSync',(fn,...a)=>{const p=fn(...a);dirs.push(p);return p;});
 patch(t,'writeFileSync',()=>{throw Object.assign(Error('PRIVATE_WRITE'),{code:'ENOSPC'});});
 const remove=patch(t,'rmSync',()=>{throw Object.assign(Error('PRIVATE_CLEANUP'),{code:'EPERM'});});
 try{const r=qualifyLocalFileRuntime();assert.equal(r.passed,false);assert.equal(r.failure.system_code,'ENOSPC');assert.equal(r.cleanup_failure.system_code,'EPERM');}
 finally{for(const p of dirs)remove(p,{recursive:true,force:true});}
});
test('qualification: native error getters not evaluated',t=>{
 let count=0;patch(t,'mkdtempSync',()=>{throw {get code(){count++;throw Error('PRIVATE');}};});
 const r=qualifyLocalFileRuntime();assert.equal(r.passed,false);assert.equal(r.failure.system_code,null);assert.equal(count,0);
});
for(const args of [[],['--help'],['--profile','PRIVATE_PATH']])test('qualification CLI: bounded output, no stdin consumption '+JSON.stringify(args),()=>{
 const p=fileURLToPath(new URL('../packages/ultrabrain-client/src/local-check-cli.mjs',import.meta.url));
 const r=spawnSync(process.execPath,[p,...args],{encoding:'utf8',input:'PRIVATE_STDIN',timeout:10000});assert.ifError(r.error);
 assert.equal(r.status,args[0]==='--profile'?1:0);assert.equal(r.stderr,'');assert.ok(!r.stdout.includes('PRIVATE'));
 if(args[0]!=='--help')assert.equal(JSON.parse(r.stdout).network_requests,0);else assert.match(r.stdout,/temporary-directory filesystem/);
});
