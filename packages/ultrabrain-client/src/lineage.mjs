/** Installable Node entry point. Explicit operator profile and request only;
 * does not read a profile/transcript file or enable a Hook on the caller's behalf.
 */
import {connectClient} from './runtime.mjs';
import {clientProfile} from '../../../src/client-kit.mjs';
import {lineageRequest,clientLineageFailure} from '../../../src/client-lineage.mjs';
import {assertClientAuthorized} from '../../../src/client-authorization.mjs';
import {UltraError} from '../../../src/core.mjs';
export async function inspectClientLineage(input,request,{authorize=()=>{},signal}={}){
 let result;
 try{
  assertClientAuthorized(authorize,signal);
  let pinned;
  try{pinned=structuredClone(input);}catch{throw new UltraError('invalid_profile','Cloneable client profile required');}
  // Denied or malformed requests never launch a configured transport.
  const selection=lineageRequest(request,clientProfile(pinned));
  let client;
  try{
   client=await connectClient(pinned,{authorize,signal});
   result=await client.lineage(selection,{authorize,signal});
  }finally{if(client)try{await client.close();}catch{/* Cleanup must not erase the read outcome. */}}
  // Cleanup is asynchronous too: authority must still be live at public delivery.
  assertClientAuthorized(authorize,signal);return result;
 }catch(error){throw clientLineageFailure(error,result?.read_requests??0);}
}
