/** Reuse the pinned native provider gateway; personal consent is independent of summaries. */
import {loadNative} from './gbrain.mjs';
import {personalModelProfile,personalProfileHash} from '../personal-consolidation-core.mjs';
import {requireThat} from '../core.mjs';
export async function configuredPersonalModel(load=loadNative) {
  const config=await load('src/core/config.ts');
  const profile=personalModelProfile(config.loadConfig()?.ultrabrain_personal_consolidation);
  if(!profile)return {profile};
  const gateway=await load('src/core/ai/gateway.ts');
  requireThat(typeof gateway.chat==='function'&&typeof gateway.isAvailable==='function','upstream_contract_changed','Native model gateway changed');
  return {profile,generate({system,prompt,signal,model,maxTokens}) {
    requireThat(profile&&model===profile.model,'model_unavailable','Personal consolidation is not enabled');
    gateway.configureGatewayIfUninitialized();
    // Module loading and caller admission may await after the initial snapshot. Keep the
    // last host-consent check synchronous with gateway invocation, using the bound profile.
    const current=personalModelProfile(config.loadConfig()?.ultrabrain_personal_consolidation);
    requireThat(current&&personalProfileHash(current)===personalProfileHash(profile),
      'model_profile_changed','Personal model profile changed before gateway invocation');
    requireThat(!signal?.aborted,'personal_model_timeout','Cancelled before gateway invocation');
    requireThat(gateway.isAvailable('chat',model),'model_unavailable','Personal model credentials are unavailable');
    return gateway.chat({model,system,messages:[{role:'user',content:prompt}],maxTokens,abortSignal:signal});
  }};
}
