/** Abrupt Node child termination after a named real syscall. Synthetic fixtures
 * only; process.exit skips JS finally, but is NOT a power-loss simulation. */
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {CaptureOutbox} from '../../src/capture-outbox.mjs';
import {payload} from '../helpers/capture-journal-fixture.mjs';
const [profileFile,checkpoint,action]=process.argv.slice(2),input=JSON.parse(fs.readFileSync(profileFile,'utf8'));
const q=new CaptureOutbox(input),fds=new Map();let published=false;
const exitAt=step=>{if(step===checkpoint)process.exit(73);};
for(const method of ['openSync','writeFileSync','fsyncSync','closeSync','linkSync','renameSync','unlinkSync']){
 const native=fs[method];fs[method]=function(first,...rest){
  const path=method==='openSync'?first:fds.get(first),temporary=typeof path==='string'&&path.includes('.tmp-');
  const value=native(first,...rest);
  if(method==='openSync'){fds.set(value,first);if(String(first).includes('.tmp-'))exitAt('create');}
  if(temporary&&method==='writeFileSync')exitAt('write');
  if(temporary&&method==='fsyncSync')exitAt('file-sync');
  if(method==='closeSync'){fds.delete(first);if(temporary)exitAt('close');}
  if((method==='linkSync'||method==='renameSync')&&String(rest[0]).endsWith('.entry')){published=true;exitAt('publish');}
  if(method==='unlinkSync'&&String(first).includes('.tmp-'))exitAt('temporary-unlink');
  if(method==='fsyncSync'&&path===q.directory&&published)exitAt('directory-sync');
  return value;
 };
}
syncBuiltinESMExports();
try{
 if(action==='replace')await q.flush(()=>{throw Error('Unexpected network boundary');});
 else await q.enqueue(payload);
 process.exitCode=2; // Every selected checkpoint must actually have executed.
}catch{process.exitCode=3;}
