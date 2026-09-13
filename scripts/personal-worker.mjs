#!/usr/bin/env bun
/** Explicit owner or authenticated MCP worker. Never scheduled or started by installation. */
import {setTimeout as sleep} from 'node:timers/promises';
import {personalWorkerOptions,personalWorkerSummary} from '../src/personal-worker.mjs';
import {requireThat} from '../src/core.mjs';
let engine,client,transport;const controller=new AbortController();
const stop=()=>controller.abort();process.on('SIGINT',stop);process.on('SIGTERM',stop);
try {
  const p=personalWorkerOptions(process.argv.slice(2));let processBatch;
  if(p.local) {
    const {connect}=await import('../src/runtime.mjs');
    const {PersonalConsolidator}=await import('../src/personal-consolidation.mjs');
    engine=await connect();
    const worker=new PersonalConsolidator({engine,sourceId:p.source,remote:false,transport:'stdio'});
    processBatch=args=>worker.process(args,{signal:controller.signal});
  }else{
    const {Client}=await import('../vendor/gbrain/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
    const {StreamableHTTPClientTransport}=await import('../vendor/gbrain/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js');
    const {snapshotTokenFetch}=await import('../src/consolidation-client.mjs');
    client=new Client({name:'ultrabrain-personal-worker',version:'0.11.0-alpha.1'});
    transport=new StreamableHTTPClientTransport(new URL(p.url),{fetch:snapshotTokenFetch(p.url,p.tokenFile),reconnectionOptions:{maxRetries:0},requestInit:{signal:controller.signal}});
    await client.connect(transport,{signal:controller.signal,timeout:30000});
    const invoke=async(name,args)=>{
      const result=await client.callTool({name,arguments:args},undefined,{signal:controller.signal,timeout:550000});
      requireThat(!result.isError,'personal_worker_rejected','Server rejected the worker');
      return JSON.parse(result.content.filter(c=>c.type==='text').map(c=>c.text).join('\n'));
    };
    const identity=await invoke('ultra_identity',{});
    requireThat(identity.source_id===p.source&&/^[a-f0-9]{64}$/.test(identity.actor_key??'')&&typeof identity.instance_id==='string','identity_mismatch','Unexpected server identity');
    processBatch=async args=>{
      const current=await invoke('ultra_identity',{});
      requireThat(current.source_id===identity.source_id&&current.actor_key===identity.actor_key&&current.instance_id===identity.instance_id,'identity_mismatch','Server identity changed');
      return invoke('ultra_personal_consolidate',args);
    };
  }
  do {
    if(controller.signal.aborted)break;
    const summary=personalWorkerSummary(await processBatch({expected_source:p.source,allow_model_call:true,limit:p.limit,retry:p.retry}),p.source);
    console.log(JSON.stringify(summary));
    if(summary.state==='needs_model'){process.exitCode=2;break;}
    if(!p.loop){if((summary.states.failed??0)+(summary.states.stale??0)+(summary.states.lease_lost??0)>0)process.exitCode=2;break;}
    await sleep(p.interval*1000,undefined,{signal:controller.signal});
  }while(!controller.signal.aborted);
}catch {
  if(!controller.signal.aborted){console.error('Personal worker failed; inspect owned job status. No raw input or credentials logged.');process.exitCode=1;}
}finally {
  process.off('SIGINT',stop);process.off('SIGTERM',stop);
  try{await transport?.terminateSession();}catch{}try{await client?.close();}catch{}try{await engine?.disconnect();}catch{}
}
