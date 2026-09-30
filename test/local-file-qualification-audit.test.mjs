/** Implementation-assistant review probes, not a second reviewer agent. */
import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
import {qualifyLocalFileRuntime} from '../src/local-file-qualification.mjs';
function patch(t,name,fn){const old=fs[name];fs[name]=(...a)=>fn(old,...a);syncBuiltinESMExports();
 t.after(()=>{fs[name]=old;syncBuiltinESMExports();});return old;}
test('qualification audit: inherited cancellation/options refused before IO',t=>{
 let opened=0;const c=new AbortController();c.abort();patch(t,'mkdtempSync',()=>{opened++;throw Error('PRIVATE');});
 assert.throws(()=>qualifyLocalFileRuntime(Object.create({signal:c.signal})),{code:'invalid_params'});assert.equal(opened,0);
});
test('qualification audit: unrelated prototype cannot inject an option descriptor',t=>{
 const c=new AbortController();c.abort();let calls=0;
 // Stop at a deterministic native boundary: Node internals are not promised
 // to remain operational under global prototype corruption.
 patch(t,'mkdtempSync',()=>{calls++;throw Object.assign(Error('PRIVATE'),{code:'ENOSPC'});});
 const previous=Object.getOwnPropertyDescriptor(Object.prototype,'signal');
 Object.defineProperty(Object.prototype,'signal',{value:{value:c.signal},configurable:true});
 try{const r=qualifyLocalFileRuntime();assert.equal(calls,1);assert.equal(r.failure.system_code,'ENOSPC');
  assert.notEqual(r.failure.error,'aborted');
 }finally{if(previous)Object.defineProperty(Object.prototype,'signal',previous);else delete Object.prototype.signal;}
});
test('qualification audit: null-prototype empty options are supported',()=>{
 assert.equal(qualifyLocalFileRuntime(Object.create(null)).passed,true);
});
test('qualification audit: cleanup cancellation cannot deliver positive qualification',t=>{
 const c=new AbortController();let selected;patch(t,'mkdtempSync',(fn,...a)=>{selected=fn(...a);return selected;});
 patch(t,'rmSync',(fn,...a)=>{fn(...a);c.abort();});
 const r=qualifyLocalFileRuntime({signal:c.signal});assert.equal(r.passed,false);assert.equal(r.failure.error,'aborted');
 assert.ok(r.checks.every(c=>c.passed));assert.equal(fs.existsSync(selected),false);
});
test('qualification audit: successful reads plus cleanup failure cannot be overall success',t=>{
 let selected;patch(t,'mkdtempSync',(fn,...a)=>{selected=fn(...a);return selected;});
 const remove=patch(t,'rmSync',()=>{throw Object.assign(Error('PRIVATE'),{code:'EPERM'});});
 try{const r=qualifyLocalFileRuntime();assert.equal(r.passed,false);assert.equal(r.failure,null);
  assert.equal(r.checks.length,2);assert.ok(r.checks.every(c=>c.passed));assert.equal(r.cleanup_failure.phase,'cleanup-directory');
 }finally{remove(selected,{recursive:true,force:true});}
});
test('qualification audit: same-sized corrupt read is not mistaken for support',t=>{
 patch(t,'readSync',(fn,...a)=>{const n=fn(...a);if(n>0)a[1][a[2]]^=1;return n;});
 const r=qualifyLocalFileRuntime();assert.equal(r.passed,false);assert.ok(r.checks.every(c=>!c.passed));
});
test('qualification audit: options accessors and Symbols are rejected without invoking them',()=>{
 let n=0;assert.throws(()=>qualifyLocalFileRuntime({get signal(){n++;return undefined;}}));assert.equal(n,0);
 assert.throws(()=>qualifyLocalFileRuntime({[Symbol('PRIVATE')]:true}),{code:'invalid_params'});
});
test('qualification audit: SDK import is offline and CLI/build/package are connected',()=>{
 const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
 const source=read('src/local-file-qualification.mjs')+read('packages/ultrabrain-client/src/local-check.mjs')+read('packages/ultrabrain-client/src/local-check-cli.mjs');
 for(const no of ['@modelcontextprotocol/sdk','node:child_process','node:http','fetch(','readClientProfile(','CaptureOutbox','process.stdin'])assert.ok(!source.includes(no));
 const manifest=JSON.parse(read('packages/ultrabrain-client/package.json'));assert.equal(manifest.bin['ultrabrain-local-check'],'dist/local-check-cli.cjs');
 assert.ok(read('scripts/build-client.mjs').includes("['local-check.mjs','local-check.cjs']"));
 assert.ok(read('scripts/package-client.sh').includes('package/dist/local-check-cli.cjs'));
});
