/** One-shot installed SDK: owns connection and fences delivery after cleanup. */
import {connectClient} from './runtime.mjs';
import {clientProfile} from '../../../src/client-kit.mjs';
import {assertClientAuthorized} from '../../../src/client-authorization.mjs';
import {memoryReviewRequest,memoryReviewFailure} from '../../../src/client-memory-review.mjs';
import {UltraError} from '../../../src/core.mjs';
export async function reviewClientMemory(input,request,{authorize=()=>{},signal}={}){
 let connection,result,primary;
 try{
  assertClientAuthorized(authorize,signal);
  let copy;try{copy=structuredClone(input);}catch{throw new UltraError('invalid_profile','Cloneable trusted profile required');}
  const profile=clientProfile(copy),selection=memoryReviewRequest(request,profile);
  try{
   connection=await connectClient(copy,{authorize,signal});
   result=await connection.reviewMemory(selection,{authorize,signal});
  }catch(error){primary=error;throw error;}
  finally{
   if(connection)try{await connection.close();}catch{
    if(!primary)throw memoryReviewFailure(new UltraError('memory_review_cleanup_failed','Connection cleanup failed'),result);
   }
  }
  assertClientAuthorized(authorize,signal);memoryReviewRequest(selection,profile);assertClientAuthorized(authorize,signal);
  return result;
 }catch(error){throw memoryReviewFailure(error,result??primary);}
}
