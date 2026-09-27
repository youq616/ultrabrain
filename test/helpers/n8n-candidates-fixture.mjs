/** Synthetic protocol/execution context. Production automation/session/executor are exercised. */
import {executeN8n} from '../../src/n8n-executor.mjs';
import {automationSession} from '../../src/automation-session.mjs';
import {row,uuid} from './snapshot-audit-fixture.mjs';
export {uuid};
export const identity={format:1,instance_id:uuid(99),actor_key:'a'.repeat(64),source_id:'selected'};
export const creds={endpoint:'https://memory.invalid/mcp',token:'PRIVATE_TOKEN',rootUri:'ultra://selected/',candidateProject:'mine',
  expectedInstance:identity.instance_id,expectedActor:identity.actor_key,allowCapture:false};
export const selection=(more={})=>({scope:'global-only',consent:true,limit:2,...more});
export function page(input,more={}){
 const metadata=n=>{const r=row(n);return Object.fromEntries(['id','type','agent_id','project_id','importance','confidence','visibility','revision','content_hash',
  'status','origin_kind','created_at','updated_at','derivation_current'].map(k=>[k,r[k]]));};
 const start=input.after_id?parseInt(input.after_id.slice(0,8),10)+1:1;
 return {format:'ultrabrain-personal-candidates-v1',scope:'owned-agent-candidates-global-and-project',source_id:'selected',request_id:input.request_id,
  project_id:input.project_id??null,after_id:input.after_id??null,limit:input.limit??20,observed_at:'2026-09-27T00:00:00.000Z',
  memories:[metadata(start),metadata(start+1)].slice(0,input.limit??20),returned:Math.min(2,input.limit??20),has_more:false,next_after:null,
  read_only:true,model_calls:0,trust:'untrusted-memory-metadata',snapshot:false,...more};
}
export function fixture({rows=[{}],credentials=creds,keepGoing=false,phase=()=>{},response,connectError}={}){
 const calls=[],parameters=[],connections=[],controller=new AbortController();let closed=0,credentialCalls=0;
 const defaults={operation:'personal_candidates',candidateScope:'global-only',candidateConsent:true,candidateLimit:2,candidateAfter:'',timeoutMs:10000};
 const items=rows.map(()=>({get json(){throw Error('Input JSON must not be read');},get binary(){throw Error('Input binary must not be read');}}));
 const context={getInputData:()=>items,getExecutionCancelSignal:()=>controller.signal,
  getCredentials:async()=>{credentialCalls++;return credentials;},continueOnFail:()=>keepGoing,
  getNodeParameter:(name,i,fallback)=>{parameters.push(name);return Object.hasOwn(rows[i],name)?rows[i][name]:Object.hasOwn(defaults,name)?defaults[name]:fallback;}};
 const client={callTool:async(req,_,options)=>{
  calls.push({name:req.name,args:structuredClone(req.arguments),signal:options.signal});await phase(req.name,controller,calls);
  const value=req.name==='ultra_identity'?{...identity}:page(req.arguments);
  return response?response(req,value):{content:[{type:'text',text:JSON.stringify(value)}]};
 }};
 const connect=async c=>{connections.push(c);if(connectError)throw connectError;return {
  session:(settings,options)=>automationSession(client,settings,options),close:async()=>{closed++;await phase('close',controller,calls);},
 }};
 return {context,calls,parameters,connections,controller,client,run:()=>executeN8n(context,connect),get closed(){return closed;},get credentialCalls(){return credentialCalls;}};
}
