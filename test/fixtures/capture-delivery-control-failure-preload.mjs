/** Synthetic checker fault injection, never loaded by the production client. */
import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
if(process.argv[1]?.endsWith('check-capture-delivery-control.mjs')&&process.env.ULTRABRAIN_CONTROL_CHECK_TEST==='timeout'){
 const timer=globalThis.setTimeout;globalThis.setTimeout=(fn,ms,...args)=>timer(fn,ms===15000?500:ms,...args);
}
if(process.argv[1]?.endsWith('capture-delivery-control-worker.mjs')){
 const mode=process.env.ULTRABRAIN_CONTROL_CHECK_TEST;let chosen=false;
 if(mode==='timeout')await new Promise(()=>setInterval(()=>{},1000));
 process.prependListener('message',m=>{if(m?.worker===4)chosen=true;});
 if(mode==='enqueue-eperm'){
  const open=fs.openSync;fs.openSync=function(path,...args){
   if(chosen&&typeof path==='string'&&path.endsWith('.queue.lock'))throw Object.assign(Error('PRIVATE_NATIVE_ERROR'),{code:'EPERM',path:'PRIVATE_PATH'});
   return open(path,...args);
  };syncBuiltinESMExports();
 }
 if(mode==='resume-enospc'){
  const rename=fs.renameSync;fs.renameSync=function(a,b,...args){
   if(typeof b==='string'&&b.endsWith('delivery-control.json'))throw Object.assign(Error('PRIVATE_NATIVE_ERROR'),{code:'ENOSPC'});
   return rename(a,b,...args);
  };syncBuiltinESMExports();
 }
 if(mode==='early-exit')process.stdout.write('PRIVATE_INVALID_REPORT',()=>process.exit(73));
 if(mode==='overflow')process.stdout.write('PRIVATE'.repeat(2000),()=>process.exit(73));
}
