import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {automaticCapture} from '../src/automatic-capture.mjs';
const setup=t=>{
  const root=mkdtempSync(join(tmpdir(),'ub-profile-swap-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const workspace=join(root,'work');mkdirSync(workspace,{mode:0o700});
  const input={format:1,source:'default',workspace,allow_capture:true,
    expected_instance:'11111111-1111-4111-8111-111111111111',expected_actor:'a'.repeat(64),
    outbox_directory:join(root,'queue'),automatic_capture:['claude-user'],
    server:{transport:'stdio',command:'node',args:['synthetic-server.mjs']}};
  const path=join(root,'profile.json');writeFileSync(path,JSON.stringify(input),{mode:0o600});
  return {root,input,path};
};
for(const field of ['project','destination','outbox','consent'])test('writer rejects profile '+field+' replacement after event authorization',t=>{
  const {root,input,path}=setup(t),replacement=structuredClone(input);
  if(field==='project')replacement.project_id='different-project';
  if(field==='destination')replacement.server.args=['different-server.mjs'];
  if(field==='outbox')replacement.outbox_directory=join(root,'other-queue');
  if(field==='consent')replacement.automatic_capture=[];
  writeFileSync(path,JSON.stringify(replacement));
  let writer;
  try{assert.throws(()=>{writer=automaticCapture(path,()=>assert.fail('Must not connect'),{authorizedProfileInput:input});},{code:'capture_disabled'});}
  finally{writer?.close();}
  assert.equal(existsSync(input.outbox_directory),false);
  assert.equal(existsSync(replacement.outbox_directory),false);
});
test('automatic writer requires the original authorized profile snapshot',t=>{
  const {path}=setup(t);let writer;
  try{assert.throws(()=>{writer=automaticCapture(path,()=>assert.fail('Must not connect'));},{code:'invalid_profile'});}
  finally{writer?.close();}
});
test('matching authorized profile can be bound without network or raw writes',t=>{
  const {path,input}=setup(t);
  const writer=automaticCapture(path,()=>assert.fail('Must not connect'),{authorizedProfileInput:input});
  t.after(()=>writer.close());assert.deepEqual(writer.scopes,['claude-user']);assert.equal(existsSync(input.outbox_directory),false);
});
