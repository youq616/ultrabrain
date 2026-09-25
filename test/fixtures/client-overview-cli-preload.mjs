/** Test-only SDK replacement and IPC coordination; not an actual server. */
import {register} from 'node:module';
import {state,identity,reset,Client} from './client-sdk-stub.mjs';
import {overviewReceipt} from '../helpers/overview-fixture.mjs';
register(new URL('./client-lineage-cli-loader.mjs',import.meta.url));reset();
const mode=process.env.ULTRABRAIN_OVERVIEW_CLI_FIXTURE;
const pause=phase=>new Promise(resolve=>{process.once('message',resolve);process.send?.({phase});});
state.onCall=async req=>{
 if(req.name==='ultra_identity')return identity;
 if(req.name!=='ultra_personal_overview')throw Error('Unexpected fixture operation');
 if(mode==='failure')throw Error('PRIVATE_SERVER_ERROR');
 if(mode==='response-change')await pause('response');
 const result=overviewReceipt(req.arguments.request_id,'default');
 if(mode==='bad-count')result.jobs.total++;return result;
};
if(mode==='cleanup-change'){
 const close=Client.prototype.close;Client.prototype.close=async function(){await close.call(this);await pause('cleanup');};
}
const iterate=process.stdin[Symbol.asyncIterator].bind(process.stdin);
process.stdin[Symbol.asyncIterator]=()=>{process.send?.({phase:'input'});return iterate();};
process.once('beforeExit',()=>process.send?.({observedCalls:state.calls.map(c=>c.name),connections:state.connections,closed:state.closed}));
