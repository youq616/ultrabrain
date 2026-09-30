/** Old delete-pending semantics injected at the IO boundary, not a Windows claim. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {CaptureOutbox} from '../src/capture-outbox.mjs';
for (const kind of ['queue', 'delivery']) test('retirement regression: stale reader cannot poison the reused '+kind+' lock name', async t => {
 const root=fs.mkdtempSync(join(tmpdir(),'ub-retire-regression-')); const workspace=join(root,'work');fs.mkdirSync(workspace,{mode:0o700});
 const input={format:1,source:'synthetic',allow_capture:true,workspace,outbox_directory:join(root,'queue'),expected_actor:'a'.repeat(64),expected_instance:'11111111-1111-4111-8111-111111111111',server:{transport:'stdio',command:'NEVER_RUN',args:[]}};
 const platform=Object.getOwnPropertyDescriptor(process,'platform');Object.defineProperty(process,'platform',{...platform,value:'win32'});
 const path=join(input.outbox_directory,'.'+kind+'.lock'),open=fs.openSync,unlink=fs.unlinkSync;let pending=false,denials=0;
 fs.unlinkSync=(p,...a)=>{const r=unlink(p,...a);if(p===path)pending=true;return r;};
 fs.openSync=(p,flags,...a)=>{if(p===path&&pending&&(flags&fs.constants.O_EXCL)){denials++;throw Object.assign(Error('Synthetic delete-pending'),{code:'EPERM'});}return open(p,flags,...a);};
 syncBuiltinESMExports();
 t.after(()=>{fs.openSync=open;fs.unlinkSync=unlink;Object.defineProperty(process,'platform',platform);syncBuiltinESMExports();fs.rmSync(root,{recursive:true,force:true});});
 const q=new CaptureOutbox(input);const action=kind==='queue'?()=>q.status():()=>q.flush(()=>assert.fail('No network'));
 await action();await action();assert.equal(denials,0);assert.equal(pending,false);
});
