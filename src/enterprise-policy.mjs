/** Fixed product surface. New upstream or ultra_* operations are NOT automatically published. */
import {readFileSync} from 'node:fs';
import {sourceId,integer,requireThat,sha256} from './core.mjs';
export const GOVERNED_TOOLS=Object.freeze(JSON.parse(readFileSync(new URL('../compat/governed-tools-v1.json',import.meta.url),'utf8')).operations);
export function deploymentProfile(value='compatibility') {
  requireThat(['compatibility','governed'].includes(value),'invalid_profile','Unknown MCP deployment profile');return value;
}
export function normalizeEnterprisePolicy(input={}) {
  const keys=['mode','requests_per_minute','actor_requests_per_minute','max_inflight','actor_max_inflight','allow_history'];
  requireThat(input&&typeof input==='object'&&!Array.isArray(input)&&Object.keys(input).every(k=>keys.includes(k)),
    'invalid_params','Unknown enterprise policy field');
  const mode=input.mode??'read-only';
  requireThat(['read-only','read-write','disabled'].includes(mode),'invalid_params','Invalid source operating mode');
  const p={mode,requests_per_minute:integer(input.requests_per_minute,300,1,60000),
    actor_requests_per_minute:integer(input.actor_requests_per_minute,120,1,60000),
    max_inflight:integer(input.max_inflight,8,1,256),actor_max_inflight:integer(input.actor_max_inflight,4,1,256),
    allow_history:input.allow_history??false};
  requireThat(typeof p.allow_history==='boolean'&&p.actor_requests_per_minute<=p.requests_per_minute&&p.actor_max_inflight<=p.max_inflight,
    'invalid_params','Actor limits cannot exceed source limits; history permission must be boolean');
  return Object.freeze(p);
}
export function enterprisePrincipal(ctx) {
  sourceId(ctx.sourceId);
  requireThat(ctx.remote===true&&ctx.transport==='http'&&ctx.auth?.sourceId===ctx.sourceId&&ctx.auth.hasSourceGrant!==false&&ctx.engine?.kind==='postgres',
    'enterprise_identity_required','Governed MCP requires authenticated HTTP with an explicit source grant');
  requireThat(!ctx.viaSubagent&&!ctx.auth.boundSlugPrefixes&&!ctx.auth.fenceProjectionDegraded&&!ctx.auth.grantProjectionDegraded&&
    !ctx.localFederatedSourceIds?.length&&(!ctx.auth.allowedSources||(Array.isArray(ctx.auth.allowedSources)&&ctx.auth.allowedSources.length===1&&ctx.auth.allowedSources[0]===ctx.sourceId)),'permission_denied','Governed profile requires a complete non-degraded single-source grant');
  const principal=ctx.auth.principal;
  const parts=principal?[principal.kind,principal.id]:['client',ctx.auth.clientId];
  requireThat(parts.every(s=>typeof s==='string'&&s.length>0&&s.length<=256),'enterprise_identity_required','No stable authenticated principal');
  return sha256(JSON.stringify(parts)); // Never log the token or the raw identity.
}
export function policyDenial(policy,op,params) {
  if(policy.mode==='disabled')return 'enterprise_source_disabled';
  if(policy.mode==='read-only'&&op.mutating)return 'enterprise_read_only';
  if(!policy.allow_history&&(['ultra_project_history','ultra_memory_history'].includes(op.name)||params.memory_policy==='history'))return 'enterprise_history_disabled';
  return null;
}
/** Strict per-process running-handler count. No queue, no lease, no distributed claim.
 * A cancellation/timeout does not release a slot until the handler actually settles.
 */
export class InflightGate {
  #sources=new Map();#actors=new Map();
  acquire(source,actor,policy) {
    const key=JSON.stringify([source,actor]);
    const total=this.#sources.get(source)??0,own=this.#actors.get(key)??0;
    if(total>=policy.max_inflight||own>=policy.actor_max_inflight)return null;
    this.#sources.set(source,total+1);this.#actors.set(key,own+1);let released=false;
    return ()=>{if(released)return;released=true;
      for(const [map,k] of [[this.#sources,source],[this.#actors,key]]) {
        const n=map.get(k)-1;if(n===0)map.delete(k);else map.set(k,n);
      }
    };
  }
  get tracked(){return this.#sources.size+this.#actors.size;}
}
