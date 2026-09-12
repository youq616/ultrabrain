#!/usr/bin/env bun
/** Explicitly launched MCP client; never impersonates the database administrator. */
import {Client} from '../vendor/gbrain/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import {StreamableHTTPClientTransport} from '../vendor/gbrain/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';
import {setTimeout as sleep} from 'node:timers/promises';
import {workerOptions,boundTokenFetch,consolidateOnce} from '../src/consolidation-client.mjs';
let client;const controller=new AbortController();
const stop=()=>controller.abort();process.on('SIGINT',stop);process.on('SIGTERM',stop);
try {
  const options=workerOptions(process.argv.slice(2));
  client=new Client({name:'ultrabrain-consolidation-worker',version:'0.4.0-alpha.1'});
  const authenticatedFetch=boundTokenFetch(options.url,options['token-file']);
  await client.connect(new StreamableHTTPClientTransport(new URL(options.url),{
    fetch:authenticatedFetch,reconnectionOptions:{maxRetries:0},requestInit:{signal:controller.signal}}));
  do {
    if(controller.signal.aborted) break;
    console.log(JSON.stringify(await consolidateOnce(client,options,controller.signal)));
    if(options.once) break;
    await sleep(options.interval*1000,undefined,{signal:controller.signal});
  } while(!controller.signal.aborted);
} catch(e) {
  if(!controller.signal.aborted) {console.error('ultrabrain worker: request failed; no credentials or raw memory logged');process.exitCode=1;}
} finally {
  if(client) try{await client.close();}catch{}
  process.off('SIGINT',stop);process.off('SIGTERM',stop);
}
