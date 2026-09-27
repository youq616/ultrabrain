/** IPC fixture only; never an actual server or Agent. */
import {register} from 'node:module';
import {state,identity,reset,Client} from './client-sdk-stub.mjs';
import {row,uuid} from '../helpers/snapshot-audit-fixture.mjs';
register(new URL('./client-sdk-loader.mjs',import.meta.url));reset();
const mode=process.env.ULTRABRAIN_REVIEW_FIXTURE;
const pause=phase=>new Promise(resolve=>{process.once('message',resolve);process.send?.({phase});});
state.onCall=async req=>{
 if(req.name==='ultra_identity')return identity;
 if(req.name==='ultra_memory_read')return {source_id:'default',memory:row(1,{content:'PRIVATE_BODY'}),read_only:true,trust:'untrusted-memory-data',coverage:'one'};
 if(req.name!=='ultra_personal_review')throw Error('Unexpected fixture call');
 if(mode==='lost')throw Error('PRIVATE_REMOTE');if(mode==='response-change')await pause('response');
 return {id:uuid(1),revision:2,status:'active',replayed:false,assurance:'caller review'};
};
if(mode==='cleanup-change'){const close=Client.prototype.close;Client.prototype.close=async function(){await close.call(this);await pause('cleanup');};}
const iterate=process.stdin[Symbol.asyncIterator].bind(process.stdin);
process.stdin[Symbol.asyncIterator]=()=>{process.send?.({phase:'input'});return iterate();};
process.once('beforeExit',()=>process.send?.({observed:true,calls:state.calls.map(c=>c.name),connections:state.connections,closed:state.closed}));
