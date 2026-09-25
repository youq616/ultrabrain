import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {clientProxyFixtureOptions} from './helpers/client-proxy-options.mjs';
const bearer='gbrain_'+'a'.repeat(64);
test('proxy fixture: stdio receives no ambient bearer or full environment',()=>{
 const options=clientProxyFixtureOptions('client.cjs','profile.json');
 assert.deepEqual(options,{command:'node',args:['client.cjs','mcp','--profile','profile.json'],stderr:'pipe',env:{}});
});
test('proxy fixture: HTTP bearer is an explicit one-key child environment',()=>{
 const options=clientProxyFixtureOptions('client.cjs','profile.json',bearer);
 assert.deepEqual(options.env,{ULTRABRAIN_KIT_FIXTURE:bearer});
 assert.ok(!JSON.stringify(options.args).includes(bearer));
});
for(const value of ['',null,42,'not-a-bearer','gbrain_'+'A'.repeat(64)])test('proxy fixture: malformed bearer rejected without echo '+typeof value,()=>{
 assert.throws(()=>clientProxyFixtureOptions('c','p',value),error=>error instanceof TypeError&&error.message==='Invalid fixture bearer');
});
test('proxy fixture: child actually receives explicit bearer, never unrelated secrets',()=>{
 const options=clientProxyFixtureOptions('client.cjs','profile.json',bearer);
 const result=spawnSync(process.execPath,['-e',`process.stdout.write(JSON.stringify({received:process.env.ULTRABRAIN_KIT_FIXTURE==='gbrain_'+'a'.repeat(64),provider:process.env.ULTRABRAIN_OTHER_SECRET!==undefined}))`],
  {env:options.env,encoding:'utf8',timeout:5000});
 assert.ifError(result.error);assert.equal(result.status,0);assert.equal(result.stderr,'');
 assert.deepEqual(JSON.parse(result.stdout),{received:true,provider:false});
});
test('proxy fixture: each invocation gets independent argument and environment copies',()=>{
 const one=clientProxyFixtureOptions('c','p',bearer),two=clientProxyFixtureOptions('c','p',bearer);
 one.env.ULTRABRAIN_KIT_FIXTURE='changed';one.args.push('--bad');
 assert.equal(two.env.ULTRABRAIN_KIT_FIXTURE,bearer);assert.deepEqual(two.args,['c','mcp','--profile','p']);
 assert.deepEqual(clientProxyFixtureOptions('c','p').env,{});
});
