/** Separate review-pass regressions; preserve native stdio's remote:true convention. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {personalPrincipal} from '../src/personal-memory-store.mjs';
import {text} from '../src/core.mjs';
const base={sourceId:'default',engine:{kind:'postgres'}};
test('unauthenticated HTTP must not become host owner even with contradictory remote:false',()=>{
  assert.throws(()=>personalPrincipal({...base,transport:'http',remote:false}),{code:'permission_denied'});
});
test('native remote:true stdio remains the explicit local-pipe owner boundary',()=>{
  assert.equal(personalPrincipal({...base,transport:'stdio',remote:true}),personalPrincipal({...base,transport:'stdio',remote:false}));
});
test('unknown unauthenticated transport cannot gain host identity',()=>{
  assert.throws(()=>personalPrincipal({...base,transport:'unknown',remote:false}),{code:'permission_denied'});
});
test('ill-formed Unicode is rejected before UTF-8 encoding can replace it silently',()=>{
  for(const value of ['\ud800','x\udfffy'])assert.throws(()=>text(value,'content'),{code:'invalid_params'});
  assert.equal(text('中文😀否定词','content'),'中文😀否定词');
});
