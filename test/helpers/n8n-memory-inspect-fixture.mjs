/** Production adapter/session with explicit synthetic protocol and context. */
import {executeN8n} from '../../src/n8n-executor.mjs';
import {automationSession} from '../../src/automation-session.mjs';
import {row,uuid} from './snapshot-audit-fixture.mjs';
export {uuid};
export const identity={format:1,instance_id:uuid(99),actor_key:'a'.repeat(64),source_id:'selected'};
export const credentials={endpoint:'https://synthetic.invalid/mcp',token:'PRIVATE_TOKEN',rootUri:'ultra://selected/',
 expectedInstance:identity.instance_id,expectedActor:identity.actor_key,inspectProject:'mine',candidateProject:'different',allowCapture:false};
export function envelope(extra={}){return {source_id:'selected',memory:row(1,{content:'PRIVATE_BODY <script>not executable</script>',provenance:'PRIVATE_PROVENANCE',...extra}),
 read_only:true,trust:'untrusted-memory-data',coverage:'one record'};}
export function fixture({items=[{}],creds=credentials,keepGoing=false,phase=()=>{},reply,connectError}={}){
 const calls=[],parameters=[],controller=new AbortController();let closed=0,connections=0,credentialReads=0;
 const defaults={operation:'personal_inspect',inspectMemoryId:uuid(1),inspectScope:'global-only',inspectConsent:true,inspectIncludeText:false,timeoutMs:10000};
 const context={getInputData:()=>items.map(()=>({get json(){throw Error('No implicit JSON reads');},get binary(){throw Error('No binary reads');}})),
 getCredentials:async()=>{credentialReads++;return creds;},getExecutionCancelSignal:()=>controller.signal,continueOnFail:()=>keepGoing,
 getNodeParameter:(k,i,f)=>{parameters.push(k);return Object.hasOwn(items[i],k)?items[i][k]:Object.hasOwn(defaults,k)?defaults[k]:f;}};
 const client={callTool:async(req,_,options)=>{
  calls.push({name:req.name,args:structuredClone(req.arguments),signal:options.signal});await phase(req.name,controller,calls);
  const value=req.name==='ultra_identity'?{...identity}:envelope();
  return reply?reply(req,value):{content:[{type:'text',text:JSON.stringify(value)}]};
 }};
 const connect=async()=>{connections++;if(connectError)throw connectError;return {session:(s,o)=>automationSession(client,s,o),
 close:async()=>{closed++;await phase('close',controller,calls);}};};
 return {context,client,calls,parameters,controller,run:()=>executeN8n(context,connect),
 get closed(){return closed;},get connections(){return connections;},get credentialReads(){return credentialReads;}};
}
