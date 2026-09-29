/** Production executor/session with explicitly synthetic n8n context and MCP responses. */
import {executeN8n} from '../../src/n8n-executor.mjs';
import {automationSession} from '../../src/automation-session.mjs';
import {row,uuid,hash} from './snapshot-audit-fixture.mjs';
export {uuid,hash};
export const identity={format:1,instance_id:uuid(99),actor_key:'a'.repeat(64),source_id:'selected'};
export const credentials={endpoint:'https://synthetic.invalid/mcp',token:'PRIVATE_TOKEN',rootUri:'ultra://selected/',
 expectedInstance:identity.instance_id,expectedActor:identity.actor_key,correctionProject:'mine',reviewProject:'other',inspectProject:'another',candidateProject:'different',
 allowMemoryCorrection:true,allowCorrectionScopeChange:false,allowCapture:false,allowMemoryActivation:false,allowMemoryArchive:false};
export const replacement=(extra={})=>({type:'preference',content:'PRIVATE_CORRECTED',provenance:'PRIVATE_EXPLICIT_REASON',importance:'normal',confidence:null,visibility:'private',project_id:null,...extra});
export const wire=v=>({content:[{type:'text',text:JSON.stringify(v)}]});
export const defaults={operation:'personal_correct',correctMode:'apply',correctMemoryId:uuid(1),correctScope:'global-only',
 correctEventId:'correction-original',correctExpectedRevision:1,correctExpectedHash:hash('PRIVATE_BODY'),correctExpectedStatus:'candidate',
 correctExpectedVisibility:'private',correctExpectedProject:'',correctReplacement:JSON.stringify(replacement()),correctConsent:true,
 correctAcknowledgeReset:true,correctScopeChangeConsent:false,timeoutMs:10000};
export const request=(extra={})=>({mode:'apply',memory_id:uuid(1),scope:'global-only',event_id:'correction-original',expected_revision:1,
 expected_content_hash:hash('PRIVATE_BODY'),expected_status:'candidate',expected_visibility:'private',expected_project_id:null,
 memory:replacement(),consent:true,acknowledge_reset:true,scope_change_consent:false,...extra});
export function fixture({items=[{}],creds=credentials,keepGoing=false,phase=()=>{},reply,connectError,record={},ack={}}={}){
 const calls=[],parameters=[],controller=new AbortController();let closed=0,connections=0,credentialReads=0;
 const context={getInputData:()=>items.map(()=>({get json(){throw Error('No implicit JSON read');},get binary(){throw Error('No binary read');}})),
 getCredentials:async()=>{credentialReads++;return creds;},getExecutionCancelSignal:()=>controller.signal,continueOnFail:()=>keepGoing,
 getNodeParameter:(k,i,f)=>{parameters.push(k);return Object.hasOwn(items[i],k)?items[i][k]:Object.hasOwn(defaults,k)?defaults[k]:f;}};
 const client={callTool:async(req,_,options)=>{
  calls.push({name:req.name,args:structuredClone(req.arguments),signal:options.signal});await phase(req.name,controller,calls);
  const value=req.name==='ultra_identity'?{...identity}:req.name==='ultra_memory_read'?{
   source_id:'selected',memory:{...row(1,{content:'PRIVATE_BODY',provenance:'PRIVATE_PROVENANCE',...record}),...record},read_only:true,trust:'untrusted-memory-data',coverage:'one'}:
   {id:uuid(1),revision:2,status:'candidate',replayed:false,review_required:true,...ack};
  return reply?reply(req,value):wire(value);
 }};
 const connect=async()=>{connections++;if(connectError)throw connectError;return {session:(s,o)=>automationSession(client,s,o),
 close:async()=>{closed++;await phase('close',controller,calls);}};};
 return {context,client,calls,parameters,controller,run:()=>executeN8n(context,connect),
 get closed(){return closed;},get connections(){return connections;},get credentialReads(){return credentialReads;}};
}
