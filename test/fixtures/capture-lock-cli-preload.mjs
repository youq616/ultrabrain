/** Real CLI filesystem + explicit SDK double; no connection should occur. */
import {register,syncBuiltinESMExports} from 'node:module';
import fs from 'node:fs';
import {Client,state,reset} from './client-sdk-stub.mjs';
register(new URL('./client-lineage-cli-loader.mjs',import.meta.url));reset();
Client.prototype.connect=async()=>{throw Error('Unexpected SDK connection in lock fixture');};
const native=fs.openSync;let noticed=false;
fs.openSync=function(path,...args){
 if(typeof path==='string'&&path.endsWith('.queue.lock')){
  if(process.env.ULTRABRAIN_LOCK_CLI_FIXTURE==='denied')throw Object.assign(Error('PRIVATE_PATH_TOKEN'),{code:'EACCES'});
  if(!noticed){noticed=true;setImmediate(()=>process.emit('SIGTERM'));}
 }
 return native(path,...args);
};
syncBuiltinESMExports();
