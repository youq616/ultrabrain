/** Transport primitives without SDK or n8n dependencies. Endpoint and token are trusted configuration. */
import {requireThat,text,UltraError,integer} from './core.mjs';
export function automationEndpoint(value) {
  text(value,'endpoint',4096);let url;
  try {url=new URL(value);}catch{throw new UltraError('insecure_endpoint','Invalid endpoint');}
  requireThat(!url.username&&!url.password&&!url.search&&!url.hash&&
    (url.protocol==='https:' || (url.protocol==='http:'&&['127.0.0.1','[::1]','localhost'].includes(url.hostname))),
    'insecure_endpoint','Use credential-free HTTPS or explicit loopback HTTP');
  return url.href;
}
export function credentialFetch(endpoint,token,{fetchImpl=fetch,signal,timeoutMs=120000,maxResponseBytes=2097152}={}) {
  const target=new URL(automationEndpoint(endpoint));
  requireThat(typeof token==='string'&&token.length>=16&&token.length<=8192&&!/\s/.test(token),
    'invalid_credentials','A valid bearer token is required');
  integer(timeoutMs,120000,1000,180000);integer(maxResponseBytes,2097152,1024,8388608);
  return async(input,init={})=>{
    const url=new URL(input instanceof Request?input.url:input);
    requireThat(url.origin===target.origin&&!url.username&&!url.password,'insecure_endpoint','Credential forwarding is confined to the configured origin');
    const headers=new Headers(init.headers??(input instanceof Request?input.headers:undefined));
    headers.set('Authorization',`Bearer ${token}`);
    const signals=[signal,init.signal,input instanceof Request?input.signal:null,AbortSignal.timeout(timeoutMs)].filter(Boolean);
    const response=await fetchImpl(input,{...init,headers,redirect:'error',signal:AbortSignal.any(signals)});
    const length=Number(response.headers.get('content-length'));
    if(Number.isFinite(length)&&length>maxResponseBytes) {
      await response.body?.cancel();throw new UltraError('response_too_large','MCP response exceeds the configured limit');
    }
    if(!response.body)return response;
    let size=0;
    const body=response.body.pipeThrough(new TransformStream({transform(chunk,controller){
      size+=chunk.byteLength;
      if(size>maxResponseBytes)controller.error(new UltraError('response_too_large','MCP response exceeds the configured limit'));
      else controller.enqueue(chunk);
    }}));
    return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
  };
}
