import assert from 'node:assert/strict';
import { connect, loadNative } from '../src/runtime.mjs';
const opts={remote:true,transport:'stdio',sourceId:'default'};
const id=`bound-${Date.now()}`;

// Prefix-bound clients: permit the audited CRUD wrappers, not broad entity extraction.
const boundEngine=await connect();
const { dispatchToolCall }=await loadNative('src/mcp/dispatch.ts');
try {
  const auth={token:'test-only',clientId:'bound-integration',sourceId:'default',scopes:['read','write'],
    principal:{kind:'oauth_client',id:'bound-integration'},boundSlugPrefixes:['bounded/']};
  const invoke=(name,args,overrides={})=>dispatchToolCall(boundEngine,name,args,{...opts,auth,...overrides});
  let response=await invoke('ultra_write',{uri:`ultra://default/bounded/${id}`,content:'---\ntype: note\nvisibility: world\n---\nFenced'});
  assert.ok(!response.isError,JSON.stringify(response));
  response=await invoke('ultra_write',{uri:`ultra://default/outside/${id}`,content:'not permitted'});
  assert.ok(response.isError);
  assert.equal(JSON.parse(response.content[0].text).error,'permission_denied');
  response=await invoke('ultra_delete',{uri:`ultra://default/bounded/${id}`});
  assert.ok(!response.isError,JSON.stringify(response));
  response=await invoke('ultra_commit_session',{session_id:id,event_id:'bound',transcript:'forbidden broad extraction'});
  assert.ok(response.isError);
  assert.equal(JSON.parse(response.content[0].text).error,'permission_denied');
  response=await invoke('ultra_read',{uri:`ultra://default/resources/${id}`},{auth:{...auth,allowedOperations:[]}});
  assert.ok(response.isError);
  assert.equal(JSON.parse(response.content[0].text).error,'permission_denied');
  response=await invoke('ultra_write',{uri:`ultra://default/bounded/${id}`,content:'blocked'},
    {auth:{...auth,fenceProjectionDegraded:true}});
  assert.ok(response.isError);
  assert.equal(JSON.parse(response.content[0].text).error,'permission_denied');
  console.log('PASS 6 real authorization checks: bound CRUD, out-of-prefix denial, extraction denial, grant snapshot, degraded grant');
} finally {await boundEngine.disconnect();}
