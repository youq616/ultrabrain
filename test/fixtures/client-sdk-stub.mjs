// Synthetic transport observations only; not evidence of official MCP SDK behavior.
export const identity={format:1,source_id:'default',instance_id:'11111111-1111-4111-8111-111111111111',actor_key:'a'.repeat(64)};
export const state={};
export function reset(){Object.assign(state,{calls:[],connections:0,closed:0,onCall:null,onList:null});}
export class Client {
 async connect(){state.connections++;}
 async callTool(request,_schema,options){
  state.calls.push({name:request.name,args:structuredClone(request.arguments),signal:options?.signal});
  const value=state.onCall?await state.onCall(request,options):request.name==='ultra_identity'?identity:{source_id:'default'};
  return {content:[{type:'text',text:JSON.stringify(value)}]};
 }
 async listTools(_params,options){state.calls.push({name:'tools/list',signal:options?.signal});return state.onList?await state.onList(options):{tools:[{name:'ultra_personal_capture'}]};}
 async close(){state.closed++;}
}
export class StdioClientTransport {}
export class StreamableHTTPClientTransport {async terminateSession(){}}
