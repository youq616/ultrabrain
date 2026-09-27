/** Test-only IPC barrier: resolve from the installed entry, not a guessed node_modules layout. */
import {join,isAbsolute} from 'node:path';
export function memoryReadBarrierPreload(packageRoot){
 if(typeof packageRoot!=='string'||!isAbsolute(packageRoot))throw new TypeError('Absolute installed package root required');
 return `const {createRequire}=require('node:module');const installedRequire=createRequire(${JSON.stringify(join(packageRoot,'dist/memory-review-cli.cjs'))});
const {Client}=installedRequire('@modelcontextprotocol/sdk/client/index.js');
const original=Client.prototype.callTool;let stopped=false;
Client.prototype.callTool=async function(request,...rest){const result=await original.call(this,request,...rest);
if(!stopped&&request.name==='ultra_memory_read'){stopped=true;await new Promise(resolve=>{process.once('message',resolve);process.send({observed:true});});process.disconnect();}return result;};`;
}
