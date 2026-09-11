import test from 'node:test';
import assert from 'node:assert/strict';
import { registerPlugin } from '../src/plugin.mjs';
function fixture() {
  const calls=[];
  const operations=['get_page','put_page','delete_page','list_pages','search','extract_facts'].map(name=>({name,
    async handler(ctx,p){calls.push({name,ctx,p}); return {source_id:'default',slug:p.slug,title:'Test',content:'original'};}}));
  class OperationError extends Error {constructor(code,message){super(message);this.code=code;}}
  const native={validateParams:()=>null,OperationError,enforceClientSlugFence:()=>{}};
  return {operations,native,calls};
}
test('plugin registers six explicit read/write operations',()=>{
  const f=fixture();assert.equal(registerPlugin(f.operations,f.native).length,6);
  for(const op of f.operations.filter(x=>x.name.startsWith('ultra_')))
    assert.equal(op.mutating,op.scope==='write');
});
test('upstream operation removal fails closed',()=>{
  const f=fixture();f.operations.pop();assert.throws(()=>registerPlugin(f.operations,f.native),{code:'upstream_contract_changed'});
});
test('duplicate registration is rejected',()=>{
  const f=fixture();registerPlugin(f.operations,f.native);
  assert.throws(()=>registerPlugin(f.operations,f.native),{code:'upstream_contract_changed'});
});
test('read forwards the exact original context including remote and grant objects',async()=>{
  const f=fixture();registerPlugin(f.operations,f.native);
  const ctx={sourceId:'default',remote:true,auth:{sourceId:'default'},subagentGrant:{test:true}};
  await f.operations.find(x=>x.name==='ultra_read').handler(ctx,{uri:'ultra://default/a'});
  assert.strictEqual(f.calls[0].ctx,ctx);assert.equal(f.calls[0].p.include_content,true);
});
test('native parameter contract drift stops before handler execution',async()=>{
  const f=fixture();f.native.validateParams=()=> 'shape changed';registerPlugin(f.operations,f.native);
  await assert.rejects(f.operations.find(x=>x.name==='ultra_read').handler({sourceId:'default'},{uri:'ultra://default/a'}),{code:'upstream_contract_changed'});
  assert.equal(f.calls.length,0);
});
test('cross-source write is refused before native mutation',async()=>{
  const f=fixture();registerPlugin(f.operations,f.native);
  await assert.rejects(f.operations.find(x=>x.name==='ultra_write').handler({sourceId:'default'},{uri:'ultra://secret/a',content:'x'}),{code:'scope_denied'});
  assert.equal(f.calls.length,0);
});
test('delegated session receipt writes are refused before SQL',async()=>{
  const f=fixture();registerPlugin(f.operations,f.native);
  const ctx={sourceId:'default',viaSubagent:true,engine:{executeRaw(){throw new Error('must not run');}}};
  await assert.rejects(f.operations.find(x=>x.name==='ultra_commit_session').handler(ctx,{session_id:'s',event_id:'e',transcript:'consented'}),{code:'scope_denied'});
});
