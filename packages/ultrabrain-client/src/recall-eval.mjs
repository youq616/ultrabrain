/** Explicit online benchmark, no implicit profile/file loading or persistence. */
import {connectClient} from './runtime.mjs';
import {clientProfile} from '../../../src/client-kit.mjs';
import {assertClientAuthorized} from '../../../src/client-authorization.mjs';
import {recallEvaluationRequest,recallEvaluationFailure} from '../../../src/client-recall-evaluation.mjs';
import {UltraError} from '../../../src/core.mjs';
export async function evaluateClientRecall(input,request,{authorize=()=>{},signal}={}){
 const active=AbortSignal.any([signal,AbortSignal.timeout(120000)].filter(Boolean));
 let report,client;
 try{
  assertClientAuthorized(authorize,active);
  let pinned;try{pinned=structuredClone(input);}catch{throw new UltraError('invalid_profile','Cloneable trusted profile required');}
  const profile=clientProfile(pinned),selection=recallEvaluationRequest(request,profile);
  try{
   client=await connectClient(pinned,{authorize,signal:active});
   report=await client.evaluateRecall(selection,{authorize,signal:active});
  }finally{if(client)try{await client.close();}catch{/* Cleanup is not query completion evidence. */}}
  assertClientAuthorized(authorize,active);recallEvaluationRequest(selection,profile);assertClientAuthorized(authorize,active);
  return report;
 }catch(error){throw recallEvaluationFailure(error,report?{attempted:report.query_requests,completed:report.cases.length}:undefined);}
}
