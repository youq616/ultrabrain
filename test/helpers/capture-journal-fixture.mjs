import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CaptureOutbox} from '../../src/capture-outbox.mjs';
export const payload={agent_id:'fixture',event_id:'stable',consent:true,transcript:'PRIVATE_SYNTHETIC_JOURNAL_BODY'};
export function setupJournal(t){
 const root=fs.mkdtempSync(join(tmpdir(),'ub-journal-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true,maxRetries:3}));
 const workspace=join(root,'work');fs.mkdirSync(workspace,{mode:0o700});
 const input={format:1,source:'synthetic',allow_capture:true,workspace,outbox_directory:join(root,'queue'),
  expected_actor:'a'.repeat(64),expected_instance:'11111111-1111-4111-8111-111111111111',server:{transport:'stdio',command:'never-started',args:[]}};
 return {root,input,q:new CaptureOutbox(input)};
}
export function patchFS(method,fn){const original=fs[method];fs[method]=(...a)=>fn(original,...a);syncBuiltinESMExports();
 return()=>{fs[method]=original;syncBuiltinESMExports();};}
export const ioError=code=>Object.assign(Error('PRIVATE_NATIVE_PATH_TOKEN'),{code,path:'/PRIVATE_PATH',syscall:'PRIVATE_SYSCALL'});
