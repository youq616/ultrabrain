import {resolve as sdkResolve} from './client-sdk-loader.mjs';
const unused=new Set(['@modelcontextprotocol/sdk/server/index.js','@modelcontextprotocol/sdk/server/stdio.js','@modelcontextprotocol/sdk/types.js']);
export async function resolve(specifier,context,next){
 if(unused.has(specifier))return {url:new URL('./client-lineage-unused-server.mjs',import.meta.url).href,shortCircuit:true};
 return sdkResolve(specifier,context,next);
}
