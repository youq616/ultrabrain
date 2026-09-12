/** JSON stdin / stdout adapter over the existing MCP SDK, not a new server protocol. */
import {requireThat} from './core.mjs';
export function clientOptions(args) {
  const out={};
  for(let i=0;i<args.length;i+=2) {
    requireThat(['--url','--token-file','--tool'].includes(args[i])&&i+1<args.length&&!Object.hasOwn(out,args[i]),
      'invalid_params','Usage: mcp-call --url URL --token-file PATH --tool ultra_tool < arguments.json');
    out[args[i]]=args[i+1];
  }
  const url=new URL(out['--url']);
  requireThat(!url.username&&!url.password&&!url.search&&!url.hash&&
    (url.protocol==='https:'||(url.protocol==='http:'&&['127.0.0.1','[::1]','localhost'].includes(url.hostname))),
    'insecure_endpoint','HTTPS or loopback HTTP required');
  requireThat(typeof out['--token-file']==='string'&&out['--token-file'].length>0,'invalid_params','Token file required');
  requireThat(typeof out['--tool']==='string'&&/^ultra_[a-z_]{1,80}$/.test(out['--tool']),
    'invalid_params','Only named Ultrabrain tools are accepted; server authorization still applies');
  return {url:url.href,tokenFile:out['--token-file'],tool:out['--tool']};
}
export async function readArguments(stream) {
  const chunks=[];let size=0;
  for await(const chunk of stream) {
    const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
    size+=bytes.length;requireThat(size<=524288,'invalid_params','Input exceeds 512 KiB');chunks.push(bytes);
  }
  const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  requireThat(value&&typeof value==='object'&&!Array.isArray(value),'invalid_params','Expected a JSON argument object');
  return value;
}
