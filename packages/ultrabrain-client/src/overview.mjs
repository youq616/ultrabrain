/** Installable one-shot SDK entry. Does not read profile files, enable hooks or
 * persist output. Caller supplies an explicit trusted profile and live authority.
 */
import {connectClient} from './runtime.mjs';
import {clientProfile} from '../../../src/client-kit.mjs';
import {clientOverviewRequest,clientOverviewFailure} from '../../../src/client-overview.mjs';
import {assertClientAuthorized} from '../../../src/client-authorization.mjs';
import {UltraError} from '../../../src/core.mjs';
export async function inspectClientOverview(input,request,{authorize=()=>{},signal}={}){
 let result,client;
 try{
  assertClientAuthorized(authorize,signal);
  let pinned;
  try{pinned=structuredClone(input);}catch{throw new UltraError('invalid_profile','Cloneable client profile required');}
  const profile=clientProfile(pinned),selection=clientOverviewRequest(request,profile);
  try{
   client=await connectClient(pinned,{authorize,signal});
   result=await client.overview(selection,{authorize,signal});
  }finally{if(client)try{await client.close();}catch{/* Preserve the read outcome, not cleanup diagnostics. */}}
  assertClientAuthorized(authorize,signal);clientOverviewRequest(selection,profile);
  assertClientAuthorized(authorize,signal);return result;
 }catch(error){throw clientOverviewFailure(error,result?1:0);}
}
