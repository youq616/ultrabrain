/** Actual official MCP SDK client; profile command is trusted operator configuration. */
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {deliverCapture} from '../../../src/capture-delivery.mjs';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {credentialFetch} from '../../../src/automation-transport.mjs';
import {clientProfile,clientIdentity,clientContext,requiredClientTools} from '../../../src/client-kit.mjs';
import {UltraError,requireThat} from '../../../src/core.mjs';
function decoded(r) {
  requireThat(r&&Array.isArray(r.content),'mcp_contract_changed','Invalid MCP response');
  let value;try{value=JSON.parse(r.content.filter(x=>x.type==='text').map(x=>x.text).join('\n'));}catch{throw new UltraError('mcp_contract_changed','Invalid JSON result');}
  if(r.isError)throw new UltraError(['permission_denied','capture_disabled','conflict','revision_conflict','agent_not_registered','not_found'].includes(value?.error)?value.error:'mcp_rejected','Memory request rejected');
  requireThat(!r._meta?.brain_hot_memory,'mcp_contract_changed','Unexpected ungoverned metadata');return value;
}
export const READ_TOOLS=Object.freeze(['ultra_identity','ultra_personal_context','ultra_memory_profile','ultra_memory_search','ultra_agent_list','ultra_personal_jobs']);
export const WRITE_TOOLS=Object.freeze(['ultra_agent_register','ultra_memory_commit','ultra_personal_capture','ultra_personal_review','ultra_personal_update','ultra_personal_cancel']);
export async function connectClient(input,{signal}={}) {
  const profile=clientProfile(input),client=new Client({name:'ultrabrain-client',version:'0.14.0-alpha.1'});let transport;
  try {
    if(profile.server.transport==='stdio') {
      // Explicitly avoid inheriting ambient database/provider/token variables.
      const env={};for(const k of ['PATH','HOME','USERPROFILE','SystemRoot','SYSTEMROOT','TEMP','TMP','LANG','LC_ALL'])if(process.env[k])env[k]=process.env[k];
      Object.assign(env,{GBRAIN_SWEEP:'0',ULTRABRAIN_MCP_PROFILE:'compatibility'},profile.server.env??{});
      transport=new StdioClientTransport({command:profile.server.command,args:profile.server.args,env,stderr:'pipe'});
    }else{
      const secret=process.env[profile.server.bearer_env];
      requireThat(typeof secret==='string','missing_credentials','Configured bearer environment is not set');
      transport=new StreamableHTTPClientTransport(new URL(profile.server.url),{fetch:credentialFetch(profile.server.url,secret,{signal,timeoutMs:profile.timeoutMs}),reconnectionOptions:{maxRetries:0},requestInit:{signal}});
    }
    // Drain stderr without forwarding logs that might contain memory or credentials.
    if(transport.stderr)transport.stderr.on('data',()=>{});
    await client.connect(transport,{signal,timeout:profile.timeoutMs});
    if(transport.stderr&&!transport.stderr.listenerCount('data'))transport.stderr.on('data',()=>{});
    const invoke=async(name,args={})=>decoded(await client.callTool({name,arguments:args},undefined,{signal,timeout:profile.timeoutMs}));
    const identity=clientIdentity(await invoke('ultra_identity'),profile);
    const check=async()=>{const now=clientIdentity(await invoke('ultra_identity'),profile);requireThat(JSON.stringify(now)===JSON.stringify(identity),'identity_mismatch','Server identity changed within connection');};
    return {profile,identity,
      async catalog(){const tools=[];let cursor;for(let page=0;page<20;page++){
        const r=await client.listTools(cursor?{cursor}:{},{signal,timeout:profile.timeoutMs});tools.push(...r.tools);
        if(!r.nextCursor)return tools.filter(t=>READ_TOOLS.includes(t.name)||(profile.allowCapture&&WRITE_TOOLS.includes(t.name)));
        requireThat(r.nextCursor!==cursor,'mcp_contract_changed','Repeated tool cursor');cursor=r.nextCursor;
      }throw new UltraError('mcp_contract_changed','Tool listing exceeded page limit');},
      async callAllowed(name,args,requestSignal){
        requireThat(READ_TOOLS.includes(name)||(profile.allowCapture&&WRITE_TOOLS.includes(name)),'permission_denied','Tool not enabled in client profile');
        if(['ultra_memory_commit','ultra_personal_capture'].includes(name))requireThat(args?.consent===true,'capture_disabled','Capture consent required');
        await check();
        const r=await client.callTool({name,arguments:args},undefined,{signal:requestSignal?AbortSignal.any([requestSignal,signal].filter(Boolean)):signal,timeout:profile.timeoutMs});
        decoded(r);return r;
      },
      async context(){await check();return clientContext(await invoke('ultra_personal_context',{limit:20,budget_bytes:profile.budgetBytes,...(profile.projectId?{project_id:profile.projectId}:{})}),profile);},
      async capture(p,{authorize}={}){return deliverCapture(p,profile,{checkIdentity:check,invoke,signal,authorize});},
      async probe(){const required=requiredClientTools(profile),names=new Set();let cursor;for(let page=0;page<20;page++){
        const result=await client.listTools(cursor?{cursor}:{},{signal,timeout:profile.timeoutMs});for(const tool of result.tools)names.add(tool.name);
        if(!result.nextCursor){cursor=null;break;}requireThat(result.nextCursor!==cursor,'mcp_contract_changed','Repeated tool cursor');cursor=result.nextCursor;
      }requireThat(!cursor&&required.every(name=>names.has(name)),'missing_personal_tools','Required personal tools absent');
        const context=await this.context();return {ok:true,identity,required_tools:required,visible_active_memories:context.memories.length,model_calls:0,scope:'protocol/identity/read probe, not an Agent model or automatic capture test'};},
      async close(){try{if(profile.server.transport==='http')await transport.terminateSession();}finally{await client.close();}},
    };
  }catch(e){try{await client.close();}catch{}throw e;}
}
