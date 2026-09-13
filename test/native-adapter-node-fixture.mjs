/** Real compiled Node/native hooks -> MCP -> PostgreSQL. Callback payloads are host fixtures. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createOpenCodePlugin,registerOpenClaw}=require(process.env.ULTRABRAIN_NATIVE_LIBRARY);
const profilePath=process.env.ULTRABRAIN_NATIVE_PROFILE,workspace=process.env.ULTRABRAIN_NATIVE_WORKSPACE;
let checks=0;const pass=()=>checks++;
const h=await createOpenCodePlugin({profilePath})({directory:workspace});
const out={system:['original']};await h['experimental.chat.system.transform']({sessionID:'synthetic-session'},out);
assert.equal(out.system[0],'original');assert.match(out.system[1],/NATIVE_ADAPTER_CANARY/);pass();
const compact={context:['keep'],prompt:'keep-prompt'};await h['experimental.session.compacting']({sessionID:'s'},compact);
assert.equal(compact.context.length,2);assert.match(compact.context[1],/NATIVE_ADAPTER_CANARY/);assert.equal(compact.prompt,'keep-prompt');pass();
await h.dispose();
const hooks={};registerOpenClaw({pluginConfig:{profilePath,agentIds:['mine'],sessionKeys:['private-session']},on:(n,f)=>hooks[n]=f});
assert.equal(await hooks.before_prompt_build({}, {agentId:'mine',sessionKey:'group-session',workspaceDir:workspace}),undefined);pass();
const result=await hooks.before_prompt_build({}, {agentId:'mine',sessionKey:'private-session',workspaceDir:workspace,trigger:'user'});
assert.match(result.prependContext,/NATIVE_ADAPTER_CANARY/);assert.deepEqual(Object.keys(result),['prependContext']);pass();
await hooks.gateway_stop();
console.log(JSON.stringify({passed:true,checks,scope:'Actual compiled Node adapters with host callback fixtures; not OpenClaw engine certification'}));
