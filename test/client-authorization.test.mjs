import test from 'node:test';import assert from 'node:assert/strict';
import {assertClientAuthorized,deliverClientRequest} from '../src/client-authorization.mjs';
const setup=()=>{const calls=[];return {calls,prepare:r=>r,checkIdentity:async()=>calls.push('identity'),send:async r=>{calls.push(r);return 'OK';}};};
test('abort inside synchronous authorization never reaches identity',async()=>{
 const f=setup(),controller=new AbortController();
 await assert.rejects(deliverClientRequest({}, {...f,signal:controller.signal,authorize:()=>controller.abort()}),{code:'aborted'});
 assert.deepEqual(f.calls,[]);
});
test('rejected thenable is consumed and cannot authorize a request',async()=>{
 const f=setup();await assert.rejects(deliverClientRequest({}, {...f,authorize:()=>Promise.reject(Error('PRIVATE_ERROR'))}),{code:'invalid_params'});
 await new Promise(r=>setImmediate(r));assert.deepEqual(f.calls,[]);
});
test('synchronous thrown denial is preserved and never transmitted',async()=>{
 const f=setup(),denial=Error('synthetic denial');await assert.rejects(deliverClientRequest({}, {...f,authorize:()=>{throw denial;}}),e=>e===denial);
 assert.deepEqual(f.calls,[]);
});
test('non-cloneable request fails with safe code before any asynchronous work',async()=>{
 const f=setup();await assert.rejects(deliverClientRequest({fn:()=>{}},f),{code:'invalid_params'});assert.deepEqual(f.calls,[]);
});
test('revocation during request preparation prevents identity work',async()=>{
 const f=setup();let permitted=true;
 await assert.rejects(deliverClientRequest({}, {...f,prepare:r=>{permitted=false;return r;},authorize:()=>permitted}),{code:'client_authorization_revoked'});
 assert.deepEqual(f.calls,[]);
});
test('cancelled response is not returned and already sent work is not retried',async()=>{
 const f=setup(),controller=new AbortController();let sent=0;
 await assert.rejects(deliverClientRequest({}, {...f,signal:controller.signal,send:async()=>{sent++;controller.abort();return {private:'not returned'};}}),{code:'aborted'});
 assert.equal(sent,1);
});
