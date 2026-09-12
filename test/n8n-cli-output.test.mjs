import test from 'node:test';
import assert from 'node:assert/strict';
import {executionFromOutput} from './n8n-cli-output.mjs';
const result={data:{resultData:{runData:{Status:[{data:{main:[[{json:{ok:true}}]]}}]}}}};
test('n8n CLI parser accepts the real envelope after unrelated diagnostics',()=>{
 const raw='starting\n'+JSON.stringify({notice:'metadata'})+'\n'+JSON.stringify(result,null,2)+'\nshutdown';
 assert.deepEqual(executionFromOutput(raw),result);
});
test('CLI JSON braces and escapes in strings do not end the envelope early',()=>{
 const value={...result,fixture:'escaped "value" { } \\ path'};
 assert.deepEqual(executionFromOutput(JSON.stringify(value)),value);
});
test('empty, suppressed or malformed CLI output cannot pass execution validation',()=>{
 for(const raw of ['', 'exit code 0', '{"success":true}', '{', undefined])
  assert.throws(()=>executionFromOutput(raw),/No execution envelope/);
});
test('workflow errors remain visible for the caller to reject',()=>{
 const value={data:{resultData:{error:{message:'capture_disabled'}}}};
 assert.ok(executionFromOutput(JSON.stringify(value)).data.resultData.error);
});
