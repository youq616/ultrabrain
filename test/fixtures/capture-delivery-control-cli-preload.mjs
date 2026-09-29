/** Source-CLI test double only. Normal control operations must never connect. */
import {register,syncBuiltinESMExports} from 'node:module';
import fs from 'node:fs';
import {Client,reset} from './client-sdk-stub.mjs';
register(new URL('./client-lineage-cli-loader.mjs',import.meta.url));reset();
Client.prototype.connect=async()=>{
 if(process.env.ULTRABRAIN_CONTROL_CONNECT_MARKER)fs.writeFileSync(process.env.ULTRABRAIN_CONTROL_CONNECT_MARKER,'unexpected');
 throw Error('Unexpected connection in control-only fixture');
};
if(process.env.ULTRABRAIN_CONTROL_CANCEL==='yes'){
 const original=fs.openSync;let triggered=false;
 fs.openSync=function(path,...args){if(typeof path==='string'&&path.endsWith('.queue.lock')&&!triggered){triggered=true;setImmediate(()=>process.emit('SIGTERM'));}return original(path,...args);};
 syncBuiltinESMExports();
}
