/** Reuse the pinned native provider gateway; personal consent is independent of summaries. */
import {loadNative} from './gbrain.mjs';
import {personalModelProfile} from '../personal-consolidation-core.mjs';
import {requireThat} from '../core.mjs';
export async function configuredPersonalModel() {
  const config=await loadNative('src/core/config.ts');
  const profile=personalModelProfile(config.loadConfig()?.ultrabrain_personal_consolidation);
  if(!profile)return {profile};
  const gateway=await loadNative('src/core/ai/gateway.ts');
  requireThat(typeof gateway.chat==='function'&&typeof gateway.isAvailable==='function','upstream_contract_changed','Native model gateway changed');
  return {profile,generate({system,prompt,signal,model,maxTokens}) {
    requireThat(profile&&model===profile.model,'model_unavailable','Personal consolidation is not enabled');
    gateway.configureGatewayIfUninitialized();
    requireThat(gateway.isAvailable('chat',model),'model_unavailable','Personal model credentials are unavailable');
    return gateway.chat({model,system,messages:[{role:'user',content:prompt}],maxTokens,abortSignal:signal});
  }};
}
