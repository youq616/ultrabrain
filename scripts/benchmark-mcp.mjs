#!/usr/bin/env bun
/** Explicit bounded read load. No transcript, token, endpoint or page content in report. */
import {Client} from '../vendor/gbrain/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import {StreamableHTTPClientTransport} from '../vendor/gbrain/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';
import {snapshotTokenFetch} from '../src/consolidation-client.mjs';
import {automationSession} from '../src/automation-session.mjs';
import {benchmarkOptions,benchmarkReport} from '../src/benchmark.mjs';
import {requireThat,UltraError} from '../src/core.mjs';
let client,transport;const controller=new AbortController(),stop=()=>controller.abort();
process.once('SIGINT',stop);process.once('SIGTERM',stop);const deadline=setTimeout(stop,180000);
try {
  const p=benchmarkOptions(process.argv.slice(2));
  client=new Client({name:'ultrabrain-read-benchmark',version:'0.9.0'});
  transport=new StreamableHTTPClientTransport(new URL(p.url),{fetch:snapshotTokenFetch(p.url,p.tokenFile),reconnectionOptions:{maxRetries:0},requestInit:{signal:controller.signal}});
  await client.connect(transport,{signal:controller.signal,timeout:30000});
  await automationSession(client,{rootUri:`ultra://${p.source}/`},{signal:controller.signal});
  const read=async()=>{
    const r=await client.callTool({name:'ultra_read',arguments:{uri:p.uri,level:'L2',summary:'off',memory_policy:'current',max_bytes:4096}},undefined,{signal:controller.signal,timeout:30000});
    requireThat(!r._meta?.brain_hot_memory,'ungoverned_metadata','Unbudgeted metadata on governed read');
    const result=JSON.parse(r.content.filter(x=>x.type==='text').map(x=>x.text).join('\n'));
    if(r.isError)throw new UltraError(['enterprise_rate_limited','enterprise_concurrency_limited','enterprise_source_disabled','enterprise_read_only','memory_not_current'].includes(result.error)?result.error:'request_rejected','Benchmark request rejected');
    requireThat(result.uri===p.uri&&typeof result.content==='string'&&Buffer.byteLength(result.content)<=4096,'invalid_response','Unexpected read result');
  };
  await read(); // Fail immediately on invalid credentials/page; one warmup is not measured.
  const samples=[],started=performance.now();let next=0;
  await Promise.all(Array.from({length:Math.min(p.concurrency,p.requests)},async()=>{
    while(next<p.requests&&!controller.signal.aborted){next++;const begin=performance.now();
      try{await read();samples.push({ok:true,ms:performance.now()-begin});}
      catch(e){samples.push({ok:false,ms:performance.now()-begin,code:e instanceof UltraError?e.code:'transport_error'});}
    }
  }));
  const report=benchmarkReport(samples,performance.now()-started,p);
  console.log(JSON.stringify({...report,runtime:typeof Bun==='undefined'?process.version:`Bun ${Bun.version}`,finished_at:new Date().toISOString()}));
  if(report.failed_requests||samples.length!==p.requests)process.exitCode=1;
}catch(e){console.log(JSON.stringify({ok:false,error:e instanceof UltraError?e.code:'benchmark_failed'}));process.exitCode=1;}
finally{clearTimeout(deadline);process.off('SIGINT',stop);process.off('SIGTERM',stop);try{await transport?.terminateSession();}catch{}try{await client?.close();}catch{}}
