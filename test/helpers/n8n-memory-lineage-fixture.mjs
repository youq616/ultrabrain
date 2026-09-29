/** Production executor/session; explicit synthetic n8n and MCP only. */
import {executeN8n} from '../../src/n8n-executor.mjs';
import {automationSession} from '../../src/automation-session.mjs';
import {row,uuid,hash} from './snapshot-audit-fixture.mjs';
export {row,uuid,hash};
export const identity={format:1,instance_id:uuid(99),actor_key:'a'.repeat(64),source_id:'selected'};
export const credentials={rootUri:'ultra://selected/',expectedInstance:identity.instance_id,expectedActor:identity.actor_key,
 lineageProject:'mine',inspectProject:'different',reviewProject:'another',allowCapture:false};
export const reference=()=>({job_id:uuid(20),input_id:uuid(2),input_revision:1,input_hash:hash('PRIVATE_SOURCE'),
 profile_hash:'c'.repeat(64),quote:'PRIVATE',start:0,end:7,offset_unit:'UTF-16 code units'});
export const request=()=>({memory_id:uuid(1),scope:'global-only',consent:true,follow_consent:true,include_text:false});
export const wire=v=>({content:[{type:'text',text:JSON.stringify(v)}]});
export function fixture({rows=[{}],creds=credentials,keepGoing=false,phase=()=>{},reply,child={},source={}}={}){
 const controller=new AbortController(),calls=[],parameters=[];let closed=0,connections=0,credentialReads=0;
 const defaults={operation:'personal_lineage',lineageMemoryId:uuid(1),lineageScope:'global-only',lineageConsent:true,
  lineageFollowConsent:true,lineageIncludeText:false,timeoutMs:10000};
 const context={getInputData:()=>rows.map(()=>({get json(){throw Error('No JSON read');},get binary(){throw Error('No binary read');}})),
  getCredentials:async()=>{credentialReads++;return creds;},continueOnFail:()=>keepGoing,getExecutionCancelSignal:()=>controller.signal,
  getNodeParameter:(k,i,f)=>{parameters.push(k);return Object.hasOwn(rows[i],k)?rows[i][k]:Object.hasOwn(defaults,k)?defaults[k]:f;}};
 const client={callTool:async(req,_,options)=>{
  calls.push({name:req.name,args:structuredClone(req.arguments),signal:options.signal});await phase(req,controller,calls);
  const value=req.name==='ultra_identity'?{...identity}:{source_id:'selected',read_only:true,trust:'untrusted-memory-data',coverage:'one',
   memory:req.arguments.memory_id===uuid(1)?row(1,{content:'PRIVATE_CHILD',derivation:reference(),...child}):row(2,{content:'PRIVATE_SOURCE',...source})};
  return reply?reply(req,value,calls):wire(value);
 }};
 const connect=async()=>{connections++;return {session:(s,o)=>automationSession(client,s,o),close:async()=>{closed++;await phase({name:'close'},controller,calls);}};};
 return {context,client,calls,parameters,controller,run:()=>executeN8n(context,connect),get closed(){return closed;},get connections(){return connections;},get credentialReads(){return credentialReads;}};
}
