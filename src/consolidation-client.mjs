/** Opt-in MCP worker configuration. No database credential is used. */
import {constants,openSync,fstatSync,readFileSync,closeSync} from 'node:fs';
import {requireThat,sourceId,integer} from './core.mjs';
export function workerOptions(args) {
  const out={once:true,retry:false,interval:60,limit:1};
  for(let i=0;i<args.length;i++) {
    const key=args[i];
    if(key==='--loop'){out.once=false;continue;}
    if(key==='--retry'){out.retry=true;continue;}
    requireThat(['--url','--token-file','--source','--interval','--limit'].includes(key)&&i+1<args.length,
      'invalid_params','Usage: worker --url URL --token-file PATH --source SOURCE [--loop --interval 60] [--retry]');
    out[key.slice(2)]=args[++i];
  }
  sourceId(out.source);
  integer(Number(out.interval),60,5,3600);integer(Number(out.limit),1,1,8);
  requireThat(out.once||!out.retry,'invalid_params','Retry failed/model-unavailable jobs only in an explicit one-shot run');
  const url=new URL(out.url);
  requireThat(!url.username&&!url.password&&!url.search&&!url.hash &&
    (url.protocol==='https:' || (url.protocol==='http:'&&['127.0.0.1','[::1]','localhost'].includes(url.hostname))),
    'insecure_endpoint','Use HTTPS or an explicit loopback HTTP MCP endpoint');
  requireThat(typeof out['token-file']==='string' && out['token-file'].length>0,'invalid_params','Token file required');
  return {...out,url:url.href,interval:Number(out.interval),limit:Number(out.limit)};
}
export function readWorkerToken(path) {
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const st=fstatSync(fd);
    requireThat(st.isFile()&&st.uid===process.getuid()&&!(st.mode&0o077)&&st.size<=8192,
      'insecure_token_file','MCP token must be in an owner-only regular file');
    const token=readFileSync(fd,'utf8').trim();
    requireThat(token.length>15&&!/\s/.test(token),'invalid_token_file','Invalid token file');
    return token;
  } finally {closeSync(fd);}
}
export async function consolidateOnce(client,options,signal) {
  const response=await client.callTool({name:'ultra_process_sessions',arguments:{
    expected_source:sourceId(options.source),limit:integer(options.limit,1,1,8),retry:options.retry===true}},undefined,
    {signal,timeout:120000});
  requireThat(!response.isError,'consolidation_rejected','Server rejected consolidation; inspect scopes, identity and queue status');
  const content=response.content?.find(x=>x.type==='text');
  const result=JSON.parse(content?.text??'null');
  requireThat(result?.source_id===options.source&&Array.isArray(result.results),'mcp_contract_changed','Invalid consolidation result');
  const counts={};for(const row of result.results) counts[row.state]=(counts[row.state]??0)+1;
  return {processed:result.results.length,states:counts};
}
/** Never attach credentials to another origin or follow a redirect. */
export function boundTokenFetch(endpoint,tokenFile,fetchImpl=fetch) {
  const origin=new URL(endpoint).origin;
  return (target,init={})=>{
    const url=new URL(target instanceof Request ? target.url : target);
    requireThat(url.origin===origin,'insecure_endpoint','Refusing to send credentials outside the configured MCP origin');
    const headers=new Headers(init.headers??(target instanceof Request?target.headers:undefined));
    headers.set('Authorization',`Bearer ${readWorkerToken(tokenFile)}`);
    return fetchImpl(target,{...init,headers,redirect:'error'});
  };
}
