import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {clientProfileAuthorization,readClientProfile} from '../src/client-profile-file.mjs';
function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'ub-live-profile-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const path=join(dir,'profile.json'),input={format:1,source:'default',allow_capture:true,server:{transport:'stdio',command:'synthetic',args:[]}};
 const save=value=>writeFileSync(path,JSON.stringify(value),{mode:0o600});save(input);
 return {dir,path,input,save,allowed:clientProfileAuthorization(path,readClientProfile(path).input)};
}
test('unchanged trusted profile can be rechecked repeatedly without writes',t=>{
 const f=fixture(t);f.allowed();f.allowed();assert.deepEqual(readClientProfile(f.path).input,f.input);
});
for(const field of ['allow_capture','source','server'])test('observed '+field+' change permanently revokes this connection',t=>{
 const f=fixture(t),updated={...f.input,[field]:field==='allow_capture'?false:field==='source'?'other':{transport:'stdio',command:'different',args:[]}};
 f.save(updated);assert.throws(f.allowed,{code:'client_authorization_revoked'});
 f.save(f.input);assert.throws(f.allowed,{code:'client_authorization_revoked'});
 clientProfileAuthorization(f.path,f.input)(); // Only a fresh connection may explicitly adopt the restored profile.
});
for(const content of ['{','null','{"format":1,"source":"../wrong"}', ' '.repeat(17000)])test('invalid profile fails closed without reflecting bytes: '+content.length,t=>{
 const f=fixture(t);writeFileSync(f.path,content);assert.throws(f.allowed,{code:'client_authorization_revoked'});
 f.save(f.input);assert.throws(f.allowed,{code:'client_authorization_revoked'});
});
test('missing profile latches revocation even after it reappears',t=>{
 const f=fixture(t);rmSync(f.path);assert.throws(f.allowed,{code:'client_authorization_revoked'});
 f.save(f.input);assert.throws(f.allowed,{code:'client_authorization_revoked'});
});
test('replacing the profile with a directory is rejected safely',t=>{
 const f=fixture(t);rmSync(f.path);mkdirSync(f.path);assert.throws(f.allowed,{code:'client_authorization_revoked'});
});
test('mutating the caller expected object cannot broaden the bound authority',t=>{
 const f=fixture(t);f.input.source='other';f.save(f.input);assert.throws(f.allowed,{code:'client_authorization_revoked'});
});
test('equivalent whitespace is not permission or destination change',t=>{
 const f=fixture(t);writeFileSync(f.path,JSON.stringify(f.input,null,2)+'\n');f.allowed();
});
