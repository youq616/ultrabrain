#!/usr/bin/env bun
/** One JSON lifecycle event on stdin; one JSON result on stdout. stdout contains memory data. */
import {Client} from '../vendor/gbrain/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import {StreamableHTTPClientTransport} from '../vendor/gbrain/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';
import {snapshotTokenFetch} from '../src/consolidation-client.mjs';
import {readArguments} from '../src/mcp-client-options.mjs';
import {bridgeOptions,bindBridge} from '../src/lifecycle-bridge.mjs';
let client;const controller=new AbortController();
const stop=()=>controller.abort();process.on('SIGINT',stop);process.on('SIGTERM',stop);
const timer=setTimeout(stop,180000);
try {
 const options=bridgeOptions(process.argv.slice(2)),event=await readArguments(process.stdin);
 client=new Client({name:'ultrabrain-lifecycle-bridge',version:'0.6.0-alpha.1'});
 await client.connect(new StreamableHTTPClientTransport(new URL(options.url),{
  fetch:snapshotTokenFetch(options.url,options.tokenFile),reconnectionOptions:{maxRetries:0},requestInit:{signal:controller.signal}}));
 const bridge=await bindBridge(client,options,controller.signal);
 console.log(JSON.stringify({ok:true,result:await bridge.handle(event)}));
}catch(e){
 const code=typeof e?.code==='string'&&/^[a-z0-9_]{1,64}$/.test(e.code)?e.code:'bridge_failed';
 console.log(JSON.stringify({ok:false,error:code,durably_queued:e?.durablyQueued===true}));process.exitCode=1;
}finally{
 clearTimeout(timer);if(client)try{await client.close();}catch{}
 process.off('SIGINT',stop);process.off('SIGTERM',stop);
}
