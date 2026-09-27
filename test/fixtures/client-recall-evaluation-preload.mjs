/** Synthetic SDK + IPC only; actual subprocess profile/CLI are unchanged. */
import {register} from 'node:module';import {state,identity,reset,Client} from './client-sdk-stub.mjs';import {sha256} from '../../src/core.mjs';
register(new URL('./client-sdk-loader.mjs',import.meta.url));reset();
const pause=phase=>new Promise(r=>{process.once('message',r);process.send?.({phase});});
const mode=process.env.ULTRABRAIN_EVAL_TEST_MODE;
state.onCall=async req=>{
 if(req.name==='ultra_identity')return identity;
 if(req.name!=='ultra_personal_context')throw Error('Unexpected operation');
 if(mode==='failure')throw Error('PRIVATE_RAW_ERROR');if(mode==='response-change')await pause('response');
 return {source_id:'default',memories:[{id:'00000001-1111-4111-8111-111111111111',type:'preference',content:'PRIVATE_MEMORY',
 content_hash:sha256('PRIVATE_MEMORY'),status:'active',project_id:null,owned_by_caller:true,derivation_current:true}]};
};
if(mode==='cleanup-change'){const close=Client.prototype.close;Client.prototype.close=async function(){await close.call(this);await pause('cleanup');};}
const iterate=process.stdin[Symbol.asyncIterator].bind(process.stdin);process.stdin[Symbol.asyncIterator]=()=>{process.send?.({phase:'input'});return iterate();};
process.once('beforeExit',()=>process.send?.({observed:true,calls:state.calls.map(c=>c.name),connections:state.connections,closed:state.closed}));
