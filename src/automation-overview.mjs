/** Owner-wide read for automation clients. No filesystem, DB, models or mutation. */
import {randomUUID} from 'node:crypto';
import {requireThat,UltraError} from './core.mjs';
import {OVERVIEW_SCOPE,verifyPersonalOverview} from './personal-overview-contract.mjs';
export function automationOverviewRequest(input,settings){
  requireThat(!settings.rootSlug,'scope_denied','Overview requires a source-root credential');
  requireThat(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(settings.expectedInstance??'')&&
    /^[a-f0-9]{64}$/.test(settings.expectedActor??''),'overview_disabled','Observed instance and actor pins required');
  let selection;
  try{
    if(!input||typeof input!=='object'||Array.isArray(input))throw Error();
    const d=Object.getOwnPropertyDescriptors(input),keys=['scope','consent'];
    if(Reflect.ownKeys(d).length!==keys.length)throw Error();
    selection=Object.fromEntries(keys.map(k=>{
      if(!d[k]?.enumerable||!Object.hasOwn(d[k],'value'))throw Error();return [k,d[k].value];
    }));
  }catch{throw new UltraError('invalid_params','Exact overview selection required');}
  requireThat(selection.scope===OVERVIEW_SCOPE,'invalid_params','Explicit owned-all-projects scope required');
  requireThat(selection.consent===true,'overview_consent_required','Explicit metadata read consent required');
  return Object.freeze(selection);
}
/** Caller checks identity before and after this read. Submission is conservative:
 * calling the transport is not proof bytes arrived. Never trust remote diagnostics.
 */
export async function readAutomationOverview(client,settings,{signal}={}){
  requireThat(!signal?.aborted,'cancelled','Overview cancelled before request');
  const request=Object.freeze({request_id:randomUUID()});
  const wire=await client.callTool({name:'ultra_personal_overview',arguments:request},undefined,{signal,timeout:settings.timeoutMs});
  requireThat(!signal?.aborted,'cancelled','Overview cancelled before delivery');
  let overview;
  try{
    // The overview has one JSON text result and no resource/image/extra metadata.
    // Reject extra content instead of silently stripping a potential body channel.
    requireThat(wire&&!wire.isError&&!wire._meta&&Array.isArray(wire.content)&&wire.content.length===1&&
      wire.content[0].type==='text'&&typeof wire.content[0].text==='string','personal_overview_unconfirmed','Overview response rejected');
    const value=JSON.parse(wire.content[0].text);
    overview=verifyPersonalOverview(value,request,settings.source);
  }catch{throw new UltraError('personal_overview_unconfirmed','Overview response was not confirmed');}
  return Object.freeze({overview,memory_writes_requested:false});
}
