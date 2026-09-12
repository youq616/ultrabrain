#!/usr/bin/env bun
/** Generic programmatic MCP client. Stdout intentionally contains requested memory data. */
import {Client} from '../vendor/gbrain/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import {StreamableHTTPClientTransport} from '../vendor/gbrain/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';
import {boundTokenFetch} from '../src/consolidation-client.mjs';
import {clientOptions,readArguments} from '../src/mcp-client-options.mjs';
let client;const controller=new AbortController();
const stop=()=>controller.abort();process.on('SIGINT',stop);process.on('SIGTERM',stop);
const timer=setTimeout(stop,180000);
try {
  const options=clientOptions(process.argv.slice(2)),args=await readArguments(process.stdin);
  client=new Client({name:'ultrabrain-json-client',version:'0.5.0-alpha.1'});
  await client.connect(new StreamableHTTPClientTransport(new URL(options.url),{
    fetch:boundTokenFetch(options.url,options.tokenFile),reconnectionOptions:{maxRetries:0},requestInit:{signal:controller.signal}}));
  const result=await client.callTool({name:options.tool,arguments:args},undefined,{signal:controller.signal,timeout:150000});
  console.log(JSON.stringify(result));process.exitCode=result.isError?2:0;
} catch {
  console.error('Ultrabrain MCP call failed; check arguments, credentials, connection and server policy. No raw exception logged.');
  process.exitCode=1;
} finally {
  clearTimeout(timer);if(client)try{await client.close();}catch{}
  process.off('SIGINT',stop);process.off('SIGTERM',stop);
}
