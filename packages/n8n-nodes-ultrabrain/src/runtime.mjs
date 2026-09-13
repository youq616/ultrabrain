import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {automationEndpoint,credentialFetch} from '../../../src/automation-transport.mjs';
import {automationSession} from '../../../src/automation-session.mjs';
import {executeN8n} from '../../../src/n8n-executor.mjs';
import {UltraError} from '../../../src/core.mjs';

export async function connectN8n(credentials,{signal}={}) {
  const endpoint=automationEndpoint(credentials.endpoint);
  const client=new Client({name:'ultrabrain-n8n',version:'0.8.2-alpha.1'});
  let transport;
  try {
    const authenticated=credentialFetch(endpoint,credentials.token,{signal});
    transport=new StreamableHTTPClientTransport(new URL(endpoint),{fetch:authenticated,
      reconnectionOptions:{maxRetries:0},requestInit:{signal}});
    await client.connect(transport,{signal,timeout:30000});
    let bound;
    return {
      async session(settings,options) {
        const session=await automationSession(client,settings,options);
        if(bound && JSON.stringify(bound)!==JSON.stringify(session.identity))
          throw new UltraError('identity_mismatch','Server identity changed during execution');
        bound=session.identity;return session;
      },
      async close() {try{await transport.terminateSession();}finally{await client.close();}},
    };
  }catch(e){
    try{await client.close();}catch{}
    if(e instanceof UltraError)throw e;
    throw new UltraError('connection_failed','Cannot establish authenticated MCP session');
  }
}
export const execute = context=>executeN8n(context,connectN8n);
