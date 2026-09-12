/** Reuse the pinned provider gateway; never accept endpoints or API keys through MCP. */
import {loadNative} from './gbrain.mjs';
import {summaryProfile} from '../semantic-core.mjs';
import {requireThat} from '../core.mjs';
export async function configuredSummaryModel() {
  const config=await loadNative('src/core/config.ts');
  const profile=summaryProfile(config.loadConfig()?.ultrabrain_semantics);
  return {profile,async generate({system,prompt,signal,model,maxTokens}) {
    requireThat(profile&&model===profile.model,'model_unavailable','Explicit summary model profile required');
    const gateway=await loadNative('src/core/ai/gateway.ts');
    requireThat(typeof gateway.chat==='function'&&typeof gateway.isAvailable==='function','upstream_contract_changed','Native chat adapter changed');
    gateway.configureGatewayIfUninitialized();
    requireThat(gateway.isAvailable('chat',model),'model_unavailable','Configured summary model credentials are unavailable');
    return gateway.chat({model,system,messages:[{role:'user',content:prompt}],maxTokens,abortSignal:signal});
  }};
}
