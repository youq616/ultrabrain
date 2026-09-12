import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {clientOptions,readArguments} from '../src/mcp-client-options.mjs';
const base=['--url','http://127.0.0.1:3131/mcp','--token-file','/private/token','--tool','ultra_read'];
test('generic client requires explicit tool, endpoint and private credential reference',()=>{
  assert.equal(clientOptions(base).tool,'ultra_read');
  assert.throws(()=>clientOptions([...base,'--tool','ultra_delete']),{code:'invalid_params'});
  assert.throws(()=>clientOptions([...base.slice(0,-1),'query']),{code:'invalid_params'});
  assert.throws(()=>clientOptions(['--url','http://external.invalid',...base.slice(2)]),{code:'insecure_endpoint'});
});
test('JSON adapter bounds input and only accepts objects',async()=>{
  assert.deepEqual(await readArguments(Readable.from(['{"uri":','"ultra://default/a"}'])),{uri:'ultra://default/a'});
  await assert.rejects(readArguments(Readable.from(['[]'])),{code:'invalid_params'});
  await assert.rejects(readArguments(Readable.from(['a'.repeat(524289)])),{code:'invalid_params'});
});

test('AgentMemory exposes source verification and explicit summarization without global capture',async()=>{
  const {AgentMemory}=await import('../src/agent-memory.mjs');let request;
  const citation={uri:'ultra://default/project/page',content_sha256:'a'.repeat(64),start:0,end:4,quote:'text'};
  const client={async callTool(p){request=p;return {content:[{type:'text',text:JSON.stringify(p.name==='ultra_excerpt'?{...citation,content:'text'}:{state:'ready'})}]};}};
  const memory=new AgentMemory({client,rootUri:'ultra://default/project',sessionId:'test'});
  assert.equal((await memory.sourceExcerpt(citation)).content,'text');
  await memory.summarizeResource(citation.uri);assert.equal(request.arguments.allow_model_call,false);
  await assert.rejects(memory.sourceExcerpt({...citation,uri:'ultra://secret/a'}),{code:'scope_denied'});
});
