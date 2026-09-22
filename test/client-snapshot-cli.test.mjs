/** Actual independent Node executable, no SDK doubles; filesystem/network guard. */
import test from 'node:test';import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';import {fileURLToPath} from 'node:url';
import {encoded,envelope,row,uuid} from './helpers/snapshot-audit-fixture.mjs';
const sourceCli=fileURLToPath(new URL('../packages/ultrabrain-client/src/snapshot-cli.mjs',import.meta.url));
const guard=fileURLToPath(new URL('./fixtures/snapshot-offline-guard.cjs',import.meta.url));
async function run(t,{request,raw,args=[],slow=false}={}){
  const dir=mkdtempSync(join(tmpdir(),'ub-snapshot-cli-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const file=join(dir,'private snapshot 中文.json');writeFileSync(file,encoded(envelope([row(1,{content:'PRIVATE_CLI_BODY'})])));
  const input=request===undefined?{operation:'inspect',consent:true,files:[{path:file}]}:
    typeof request==='function'?request(file):request;
  const child=spawn(process.execPath,['--require',guard,sourceCli,...args],{stdio:['pipe','pipe','pipe'],
    env:{...process.env,ULTRABRAIN_HOME:join(dir,'must-not-open'),ULTRABRAIN_PROFILE:'PRIVATE_INVALID_PROFILE'}});
  let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.stdin.on('error',()=>{});
  const timer=setTimeout(()=>child.kill('SIGKILL'),10000);
  try{
    const exit=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
    if(slow){child.stdin.write(raw);/* Keep the pipe open: oversized input must exit on its own. */}
    else child.stdin.end(raw??JSON.stringify(input));
    const code=await exit;assert.equal(stderr,'');assert.ok(!stdout.includes(dir),'Local paths must not be printed');
    assert.ok(!stdout.includes('OFFLINE_FORBIDDEN_OPERATION'));return {code,stdout,data:args.includes('--help')?null:JSON.parse(stdout)};
  }finally{clearTimeout(timer);child.stdin.destroy();}
}
test('snapshot CLI: default inspection runs without SDK, network, subprocess or filesystem writes',async t=>{
  const r=await run(t);assert.equal(r.code,0);assert.equal(r.data.result.record_count,1);assert.ok(!r.stdout.includes('PRIVATE_CLI_BODY'));
});
for(const [operation,options]of [['compare',{}],['page',{options:{query:'PRIVATE_CLI_BODY'}}],
  ['record',{memory_id:uuid(1)}],['record',{memory_id:uuid(1),include_text:true}]])
  test('snapshot CLI: complete '+operation+' path '+JSON.stringify(options),async t=>{
    const r=await run(t,{request:path=>({operation,consent:true,files:operation==='compare'?[{path},{path}]:[{path}],...options})});
    assert.equal(r.code,0);assert.equal(r.data.operation,operation);
    assert.equal(r.stdout.includes('PRIVATE_CLI_BODY'),options.include_text===true);
  });
for(const [raw,code]of [
  ['{ "PRIVATE_PARSE_FRAGMENT":','snapshot_file_invalid_json'],
  ['{"operation":"inspect","consent":false,"consent":true}','snapshot_file_duplicate_key'],
  ['{"operation":"inspect","consent":false,"\\u0063onsent":true}','snapshot_file_duplicate_key'],
  [Buffer.from([0xc3,0x28]),'snapshot_file_invalid_utf8'],
  ['x'.repeat(16385),'snapshot_input_too_large'],
])test('snapshot CLI: malformed stdin is private and rejected '+code,async t=>{
  const r=await run(t,{raw});assert.equal(r.code,1);assert.equal(r.data.error,code);
  assert.ok(!r.stdout.includes('PRIVATE'));assert.equal(r.data.local_only,true);assert.equal(r.data.memory_writes_requested,false);
});
test('snapshot CLI: over-limit stdin exits even when producer leaves pipe open',async t=>{
  const r=await run(t,{raw:' '.repeat(16385),slow:true});assert.equal(r.code,1);assert.equal(r.data.error,'snapshot_input_too_large');
});
test('snapshot CLI: --help needs no files or profile',async t=>{
  const r=await run(t,{args:['--help']});assert.equal(r.code,0);assert.ok(r.stdout.includes('compare'));
});
test('snapshot CLI: unknown arguments and denied consent are not silently ignored',async t=>{
  assert.equal((await run(t,{args:['--profile','PRIVATE_PROFILE_PATH']})).data.error,'invalid_params');
  const r=await run(t,{request:path=>({operation:'inspect',files:[{path}],consent:false})});
  assert.equal(r.code,1);assert.equal(r.data.error,'snapshot_consent_required');
});
