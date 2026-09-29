/** Runs the actual packaged Node runtime. Context is synthetic, not the n8n engine.
 * Optional IPC barriers simulate a competing edit or a lost acknowledgement. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module');
const root=process.argv[2],input=JSON.parse(fs.readFileSync(0,'utf8'));
const entry=path.join(root,'dist/runtime.cjs');let attempts=0;
if(input.barrier){
 const installed=createRequire(entry),{Client}=installed('@modelcontextprotocol/sdk/client/index.js');
 const original=Client.prototype.callTool;
 Client.prototype.callTool=async function(req,...args){
  if(req.name==='ultra_personal_update')attempts++;
  const reply=await original.call(this,req,...args);
  if(input.barrier==='race'&&req.name==='ultra_memory_read')await new Promise(resolve=>{process.once('message',resolve);process.send({checkpoint:'read'});});
  if(input.barrier==='lost'&&req.name==='ultra_personal_update'&&!reply.isError)throw Error('Injected lost reply after the real server write');
  return reply;
 };
}
const context={getInputData:()=>[{get json(){throw Error('No implicit item JSON');},get binary(){throw Error('No binary reads');}}],
 getCredentials:async()=>input.credentials,continueOnFail:()=>false,
 getNodeParameter:(name,_index,fallback)=>Object.hasOwn(input.parameters,name)?input.parameters[name]:fallback};
require(entry).execute(context).then(items=>process.stdout.write(JSON.stringify({ok:true,items,attempts})+'\n'))
 .catch(e=>{process.stdout.write(JSON.stringify({ok:false,error:e.code,write_delivery:e.write_delivery,memory_writes_requested:e.memory_writes_requested,attempts})+'\n');process.exitCode=1;})
 .finally(()=>{if(process.connected)process.disconnect();});
