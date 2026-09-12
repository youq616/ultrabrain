/** Host-only configuration/reporting. No equivalent policy-editing MCP tool. */
import {requireThat} from './core.mjs';
import {configureEnterpriseSource,enterpriseStatus,enterpriseAudit} from './enterprise.mjs';
export function enterpriseArguments(args) {
  const [action,...rest]=args,out={action};
  requireThat(['configure','status','audit'].includes(action),'invalid_params','enterprise configure|status|audit');
  const allowed=action==='configure'?['source','expected-revision','mode','requests-per-minute','actor-requests-per-minute','max-inflight','actor-max-inflight','allow-history']:
    action==='audit'?['source','after','limit']:['source'];
  for(let i=0;i<rest.length;i+=2){const k=rest[i]?.slice(2);
    requireThat(rest[i]?.startsWith('--')&&allowed.includes(k)&&!Object.hasOwn(out,k)&&rest[i+1]!==undefined,'invalid_params','Unknown, duplicate or incomplete enterprise argument');out[k]=rest[i+1];}
  requireThat(typeof out.source==='string','invalid_params','--source is required');return out;
}
export async function enterpriseCLI(args,engine) {
  const p=enterpriseArguments(args);
  if(p.action==='status')return enterpriseStatus(engine,p.source);
  if(p.action==='audit')return enterpriseAudit(engine,p.source,{after:p.after===undefined?0:Number(p.after),limit:p.limit===undefined?100:Number(p.limit)});
  requireThat(p['expected-revision']!==undefined,'invalid_params','--expected-revision is required (0 for enrollment)');
  const policy={};for(const k of ['mode','requests-per-minute','actor-requests-per-minute','max-inflight','actor-max-inflight'])
    if(p[k]!==undefined)policy[k.replaceAll('-','_')]=k==='mode'?p[k]:Number(p[k]);
  if(p['allow-history']!==undefined){requireThat(['true','false'].includes(p['allow-history']),'invalid_params','--allow-history true|false');policy.allow_history=p['allow-history']==='true';}
  return configureEnterpriseSource(engine,p.source,Number(p['expected-revision']),policy);
}
