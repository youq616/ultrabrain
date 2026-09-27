/** Installed one-shot API; all connections are closed before public delivery. */
import {connectClient} from './runtime.mjs';
import {clientProfile} from '../../../src/client-kit.mjs';
import {assertClientAuthorized} from '../../../src/client-authorization.mjs';
import {candidatesRequest,candidatesFailure} from '../../../src/client-candidates.mjs';
import {UltraError} from '../../../src/core.mjs';
export async function listClientCandidates(input,request,{authorize=()=>{},signal}={}){
 let connection,result,primary;
 try{
  assertClientAuthorized(authorize,signal);let copy;
  try{copy=structuredClone(input);}catch{throw new UltraError('invalid_profile','Cloneable trusted profile required');}
  const profile=clientProfile(copy),selection=candidatesRequest(request,profile);
  try{connection=await connectClient(copy,{authorize,signal});result=await connection.candidates(selection,{authorize,signal});}
  catch(error){primary=error;throw error;}
  finally{if(connection)try{await connection.close();}catch{
   if(!primary)throw candidatesFailure(new UltraError('candidates_cleanup_failed','Connection cleanup failed'),result);
  }}
  assertClientAuthorized(authorize,signal);candidatesRequest(selection,profile);assertClientAuthorized(authorize,signal);
  return result;
 }catch(error){throw candidatesFailure(error,result??primary);}
}
