/** Measurement helpers; percentiles describe observed completions, not a service SLA. */
import {requireThat,integer,parseUri} from './core.mjs';
import {workerOptions} from './consolidation-client.mjs';
export function benchmarkOptions(args) {
  const p={};
  for(let i=0;i<args.length;i++) {
    const key=args[i];
    requireThat(!Object.hasOwn(p,key),'invalid_params','Duplicate benchmark argument');
    if(key==='--allow-load'){p[key]=true;continue;}
    requireThat(['--url','--token-file','--uri','--requests','--concurrency'].includes(key)&&args[i+1]!==undefined,'invalid_params','Unknown benchmark argument');p[key]=args[++i];
  }
  requireThat(p['--allow-load']===true,'load_consent_required','Explicit --allow-load required; use an isolated source');
  const uri=parseUri(p['--uri']);requireThat(uri.slug,'invalid_params','Exact page URI required');
  const connection=workerOptions(['--url',p['--url'],'--token-file',p['--token-file'],'--source',uri.source]);
  return {url:connection.url,tokenFile:p['--token-file'],uri:uri.uri,source:uri.source,
    requests:integer(p['--requests']===undefined?100:Number(p['--requests']),100,1,10000),
    concurrency:integer(p['--concurrency']===undefined?2:Number(p['--concurrency']),2,1,32)};
}
export function benchmarkReport(samples,elapsedMs,settings) {
  requireThat(samples.length>0&&elapsedMs>0,'invalid_benchmark','No completed measurement');
  const successes=samples.filter(x=>x.ok),sorted=successes.map(x=>x.ms).sort((a,b)=>a-b);
  const quantile=p=>sorted.length?sorted[Math.max(0,Math.ceil(sorted.length*p)-1)]:null;
  const errors={};for(const sample of samples)if(!sample.ok)errors[sample.code]=(errors[sample.code]??0)+1;
  return {format:1,workload:'same-page-current-L2-4KiB',planned_requests:settings.requests,completed_requests:samples.length,
    successful_requests:successes.length,failed_requests:samples.length-successes.length,concurrency:settings.concurrency,
    elapsed_ms:Math.round(elapsedMs),successful_requests_per_second:successes.length/(elapsedMs/1000),
    attempted_requests_per_second:samples.length/(elapsedMs/1000),success_latency_ms:{p50:quantile(.5),p95:quantile(.95),p99:quantile(.99)},errors,
    assurance:'One warmed repeated-page path including authentication/admission/audit; not a diverse-corpus search, cold-cache, model-quality, HA or enterprise capacity certificate'};
}
