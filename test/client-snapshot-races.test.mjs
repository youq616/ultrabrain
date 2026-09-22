/** Real file descriptors, controlled scheduling hooks. Not a hostile-kernel test. */
import test from 'node:test';import assert from 'node:assert/strict';
import {register} from 'node:module';
import {mkdtempSync,writeFileSync,renameSync,readFileSync,existsSync,unlinkSync,rmSync,mkdirSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {state,reset} from './fixtures/snapshot-fs-hook.mjs';
import {encoded,envelope,row,uuid,hash} from './helpers/snapshot-audit-fixture.mjs';
register(new URL('./fixtures/snapshot-fs-loader.mjs',import.meta.url));
const {inspectClientSnapshots}=await import('../src/client-snapshot-files.mjs');
function fixture(t){
  reset();const dir=mkdtempSync(join(tmpdir(),'ub-snapshot-race-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'snapshot.json');writeFileSync(path,encoded());
  return {dir,path,request:{operation:'record',consent:true,memory_id:uuid(1),include_text:true,files:[{path}]}};
}
// An OS-blocked attack is not a successful replacement. Keep the mutation
// outcome separate from product IO so EPERM cannot impersonate a product error.
function renameAttempt(from,to,outcome){
  try {renameSync(from,to);return true;}
  catch(error){
    if(process.platform!=='win32'||!['EPERM','EACCES','EBUSY'].includes(error.code))throw error;
    outcome.blocked=error.code;return false;
  }
}
async function assertReplacement(t,f,outcome,expected){
  const settled=await inspectClientSnapshots(f.request).then(value=>({value}),error=>({error}));
  if(outcome.blocked){
    assert.equal(process.platform,'win32');assert.equal(settled.error,undefined);
    assert.equal(settled.value.result.text.content,row(1).content);
    assert.equal(settled.value.files[0].file_sha256,hash(encoded()));
    assert.deepEqual(readFileSync(f.request.files[0].path),Buffer.from(encoded()));
    assert.equal(outcome.changed,false,'An already-completed mutation must not be called OS-blocked');
    t.diagnostic('Replacement refused by Windows: '+outcome.blocked+'; original bytes verified');
  }else{assert.equal(outcome.changed,true);assert.equal(settled.error?.code,expected);assert.equal(settled.value,undefined);}
  assert.equal(state.opened,1);assert.equal(state.closed,1);
}
for(const point of ['stat','open','read','close'])for(const mode of ['revoke','abort'])
  test('snapshot race: '+mode+' during '+point+' suppresses delivery and closes any descriptor',async t=>{
    const f=fixture(t),c=new AbortController();let allowed=true;
    state['on'+point[0].toUpperCase()+point.slice(1)]=()=>{if(mode==='abort')c.abort();else allowed=false;};
    await assert.rejects(inspectClientSnapshots(f.request,{authorize:()=>allowed,signal:c.signal}),
      {code:mode==='abort'?'aborted':'client_authorization_revoked'});
    assert.equal(state.closed,state.opened);if(point==='open')assert.equal(state.reads,0);
  });
for(const change of ['resize','rewrite','replace'])test('snapshot race: '+change+' during descriptor read is rejected',async t=>{
  const f=fixture(t);let changed=false;const outcome={changed:false};
  state.onRead=()=>{
    if(changed)return;changed=true;
    if(change==='resize')writeFileSync(f.path,'short');
    else if(change==='rewrite')writeFileSync(f.path,encoded(envelope([row(1,{content:'CHANGED'})])));
    else {const replacement=join(f.dir,'replacement');writeFileSync(replacement,encoded());
      outcome.changed=renameAttempt(replacement,f.path,outcome);}
  };
  if(change==='replace')await assertReplacement(t,f,outcome,'snapshot_file_changed');
  else {await assert.rejects(inspectClientSnapshots(f.request),{code:'snapshot_file_changed'});assert.equal(state.closed,1);}
});
test('snapshot race: replacement between lstat and open is rejected before reading',async t=>{
  const f=fixture(t);let done=false;
  state.onStat=path=>{if(path===f.path&&!done){done=true;renameSync(f.path,f.path+'.old');writeFileSync(f.path,encoded());}};
  await assert.rejects(inspectClientSnapshots(f.request),{code:'snapshot_file_changed'});
  assert.equal(state.reads,0);assert.equal(state.closed,1);
});
test('snapshot race: parent replacement during read is rejected',async t=>{
  const f=fixture(t),parent=join(f.dir,'parent');mkdirSync(parent);const path=join(parent,'snapshot.json');writeFileSync(path,encoded());
  f.request.files=[{path}];let done=false;const outcome={changed:false};
  state.onRead=()=>{if(done)return;done=true;if(!renameAttempt(parent,parent+'.old',outcome))return;
    outcome.changed=true;mkdirSync(parent);writeFileSync(path,encoded());};
  await assertReplacement(t,f,outcome,'snapshot_file_changed');
  if(outcome.blocked)assert.equal(existsSync(parent+'.old'),false);
});
test('snapshot race: close failure refuses successful data and never exposes raw error',async t=>{
  const f=fixture(t);state.onClose=()=>{throw Error('PRIVATE_CLOSE_PATH');};
  await assert.rejects(inspectClientSnapshots(f.request),e=>e.code==='snapshot_operation_unconfirmed'&&!e.message.includes('PRIVATE'));
  assert.equal(state.closed,1);
});
test('snapshot race: invalid second path, options and sparse selections cause zero IO',async t=>{
  const f=fixture(t);
  for(const request of [
    {...f.request,operation:'page',memory_id:undefined,options:null},
    {operation:'compare',consent:true,files:[{path:f.path},{path:'relative'}]},
    {operation:'compare',consent:true,files:Object.assign(new Array(2),{0:{path:f.path}})},
  ]){await assert.rejects(inspectClientSnapshots(request));assert.equal(state.stats,0);assert.equal(state.opened,0);}
});
test('snapshot race: a failed first fingerprint does not open the second selection',async t=>{
  const f=fixture(t);const other=join(f.dir,'second');writeFileSync(other,encoded());
  await assert.rejects(inspectClientSnapshots({operation:'compare',consent:true,files:[
    {path:f.path,expected_sha256:'0'.repeat(64)},{path:other}]}),{code:'snapshot_hash_mismatch'});
  assert.equal(state.opened,1);assert.equal(state.closed,1);
});
test('snapshot race: live input mutation cannot redirect the second file while the first is pending',async t=>{
  const f=fixture(t),files=[{path:f.path},{path:f.path}];
  state.onOpen=()=>{files[1].path=join(f.dir,'PRIVATE_OTHER');};
  const r=await inspectClientSnapshots({operation:'compare',consent:true,files});
  assert.equal(r.result.counts.unchanged,1);assert.equal(state.opened,2);assert.equal(state.closed,2);
});

// The descriptor still names the original bytes, but its ancestor was replaced
// by a link while reading. Windows junctions exercise the same rejection without
// requiring the Create Symbolic Links privilege. No platform skip is allowed.
test('snapshot race: linked ancestor introduced during read refuses delivery',async t=>{
  const f=fixture(t),parent=join(f.dir,'selected-parent'),moved=parent+'-moved';
  mkdirSync(parent);const path=join(parent,'snapshot.json');writeFileSync(path,encoded());
  f.request.files=[{path}];let attempted=false;const outcome={changed:false};
  state.onRead=()=>{
    if(attempted)return;attempted=true;if(!renameAttempt(parent,moved,outcome))return;
    outcome.changed=true;symlinkSync(moved,parent,process.platform==='win32'?'junction':'dir');
  };
  await assertReplacement(t,f,outcome,'snapshot_path_invalid');assert.equal(attempted,true);
  if(outcome.blocked)assert.equal(existsSync(moved),false);
});
