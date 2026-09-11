import test from 'node:test';
import assert from 'node:assert/strict';
import { commitSession } from '../src/sessions.mjs';
const payload={session_id:'s1',event_id:'e1',transcript:'A consented test conversation.'};
function mock() {
  let row; const calls=[];
  return {source:'default',actor:'client-1',calls, async assertWrite(){},
    async call(name,p) {calls.push([name,p]); return name==='extract_facts'? {skipped:'extraction_unavailable',inserted:0}:{slug:p.slug};},
    async sql(q,p) {
      if(q.includes('INSERT')) {
        if(row && !(p[6] && row.state==='needs_model' && row.content_hash===p[4])) return [];
        row={content_hash:p[4],state:'processing',lease:p[5]}; return [{state:row.state}];
      }
      if(q.includes('SELECT')) return [row];
      if(q.includes('UPDATE') && q.includes('state=$5')) {row.state=p[4];row.result=JSON.parse(p[5]);return [{state:row.state}];}
      throw new Error('unhandled SQL in mock');
    }};
}
test('keyless session is needs_model, never fake completed extraction', async () => {
  const store=mock(), result=await commitSession(store,payload);
  assert.equal(result.state,'needs_model'); assert.equal(store.calls[1][1].visibility,'private');
  assert.ok(store.calls[0][1].content.includes('visibility: private'));
});
test('receipt replay does not call extraction twice', async () => {
  const store=mock(); await commitSession(store,payload);
  const result=await commitSession(store,payload); assert.equal(result.replayed,true);assert.equal(store.calls.length,2);
  assert.equal(result.storage,'stored');assert.equal(typeof result.uri,'string');
});
test('event id collision rejects changed content', async () => {
  const store=mock();await commitSession(store,payload);
  await assert.rejects(commitSession(store,{...payload,transcript:'Other text'}),{code:'conflict'});
});
test('explicit retry attempts a needs_model event again', async () => {
  const store=mock(); await commitSession(store,payload);await commitSession(store,{...payload,retry:true});
  assert.equal(store.calls.length,4);
});
test('dry run is side-effect free', async () => {
  const store=mock();store.dryRun=true;
  assert.equal((await commitSession(store,payload)).dry_run,true);assert.equal(store.calls.length,0);
});
test('session event identifiers cannot escape path namespaces', async () => {
  await assert.rejects(commitSession(mock(),{...payload,event_id:'../secret'}),{code:'invalid_params'});
});
test('write grant failure happens before database receipt mutation', async () => {
  const store=mock();store.assertWrite=async()=>{throw new Error('fenced');};
  store.sql=()=>{throw new Error('SQL should not be called');};
  await assert.rejects(commitSession(store,payload),/fenced/);
});
