/** Pure worker configuration and privacy-preserving result reporting. */
import {requireThat,sourceId,integer} from './core.mjs';
import {automationEndpoint} from './automation-transport.mjs';
export function personalWorkerOptions(args) {
  const p={},seen=new Set();
  for(let i=0;i<args.length;i++) {
    const key=args[i];requireThat(!seen.has(key),'invalid_params','Duplicate worker option');seen.add(key);
    if(['--local','--allow-model-call','--loop','--retry'].includes(key)){p[key]=true;continue;}
    requireThat(['--url','--token-file','--source','--limit','--interval'].includes(key)&&args[i+1]!==undefined,'invalid_params','Invalid worker option');p[key]=args[++i];
  }
  requireThat(p['--allow-model-call']===true,'model_consent_required','Explicit --allow-model-call required');
  requireThat(!!p['--local']!==!!p['--url'],'invalid_params','Choose --local owner or --url authenticated MCP, not both');
  requireThat(p['--local']?!p['--token-file']:(typeof p['--token-file']==='string'&&p['--token-file'].length>0),'invalid_params','HTTP requires a token file; local mode must not impersonate a token');
  requireThat(!(p['--loop']&&p['--retry']),'invalid_params','Failed/expired jobs may be retried only in an explicit one-shot run');
  return Object.freeze({local:p['--local']===true,url:p['--url']?automationEndpoint(p['--url']):null,tokenFile:p['--token-file']??null,
    source:sourceId(p['--source']),loop:p['--loop']===true,retry:p['--retry']===true,
    limit:integer(p['--limit']===undefined?1:Number(p['--limit']),1,1,4),
    interval:integer(p['--interval']===undefined?300:Number(p['--interval']),300,30,86400)});
}
export function personalWorkerSummary(result,source) {
  requireThat(result?.source_id===source&&Array.isArray(result.results),'mcp_contract_changed','Unexpected personal worker response');
  const states={};
  for(const row of result.results) {
    requireThat(['completed','failed','stale','lease_lost'].includes(row.state),'mcp_contract_changed','Unknown personal job result');
    states[row.state]=(states[row.state]??0)+1;
  }
  return {source_id:source,state:result.state==='needs_model'?'needs_model':'processed',processed:result.results.length,states,
    model_requests_attempted:result.model_requests_attempted??0,
    note:'Counts only; no transcript or candidate content. Completion does not mean approval or truth.'};
}
