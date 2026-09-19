// Test-process-only SDK doubles. Runtime source and its other dependencies are unchanged.
const targets=new Set(['@modelcontextprotocol/sdk/client/index.js',
 '@modelcontextprotocol/sdk/client/stdio.js','@modelcontextprotocol/sdk/client/streamableHttp.js']);
export async function resolve(specifier,context,nextResolve){
 if(targets.has(specifier))return {url:new URL('./client-sdk-stub.mjs',import.meta.url).href,shortCircuit:true};
 return nextResolve(specifier,context);
}
