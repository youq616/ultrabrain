import test from 'node:test';
import assert from 'node:assert/strict';
import {requireMissingUnit, cleanupFixture} from './personal-services-harness.mjs';
const absent = 'LoadState=not-found\nActiveState=inactive\nFragmentPath=\n';
test('missing unit is recognized from exact properties with exit 0 or 5', () => {
  for (const code of [0, 5]) assert.doesNotThrow(() => requireMissingUnit({code,text:absent}));
});
test('unrelated failures, missing output and contradictory missing-unit state refuse', () => {
  for (const result of [
    {code:1,text:absent}, {code:null,text:absent}, {code:5,text:''},
    {code:0,text:'not-found'}, {code:0,text:absent.replace('not-found','loaded')},
    {code:5,text:absent.replace('inactive','active')},
    {code:0,text:absent.replace('FragmentPath=','FragmentPath=/unreviewed.service')},
    {code:0,text:absent+'LoadState=not-found\n'},
    {code:0,text:absent.replace('FragmentPath=\n','')},
  ]) assert.throws(() => requireMissingUnit(result));
});
test('cleanup finishes all steps before removing the fixture', async () => {
  const calls=[];
  await cleanupFixture({shutdown:[()=>calls.push('stop'),()=>calls.push('disconnect')],
    unlink:[()=>calls.push('unlink')],reload:()=>calls.push('reload'),remove:()=>calls.push('remove')});
  assert.deepEqual(calls,['stop','disconnect','unlink','reload','remove']);
});
test('shutdown failure still attempts other shutdown steps but preserves files', async () => {
  const calls=[];
  await assert.rejects(cleanupFixture({shutdown:[()=>{calls.push('stop');throw Error('synthetic');},()=>calls.push('disconnect')],
    unlink:[()=>calls.push('unlink')],reload:()=>calls.push('reload'),remove:()=>calls.push('remove')}));
  assert.deepEqual(calls,['stop','disconnect']);
});
test('unlink failure and reload failure are not suppressed as a passed lifecycle test', async () => {
  for(const fail of ['unlink','reload']) {
    let removed=false;
    await assert.rejects(cleanupFixture({shutdown:[],unlink:[()=>{if(fail==='unlink')throw Error('synthetic');}],
      reload:()=>{if(fail==='reload')throw Error('synthetic');},remove:()=>{removed=true;}}));
    assert.equal(removed,false);
  }
});
