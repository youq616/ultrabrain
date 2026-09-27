/** Actual child CLI source, synthetic SDK + explicit IPC profile-revocation checkpoints. */
import {register} from 'node:module';import {state,identity,reset,Client} from './client-sdk-stub.mjs';
import {CANDIDATES_FORMAT,CANDIDATES_SCOPE} from '../../src/personal-candidates-contract.mjs';
register(new URL('./client-sdk-loader.mjs',import.meta.url));reset();
const mode=process.env.ULTRABRAIN_CANDIDATES_FIXTURE;
const pause=phase=>new Promise(resolve=>{process.once('message',resolve);process.send?.({phase});});
state.onCall=async req=>{
 if(req.name==='ultra_identity')return identity;
 if(req.name!=='ultra_personal_candidates')throw Error('Unexpected synthetic tool');
 if(mode==='response')await pause('response');if(mode==='lost')throw Error('PRIVATE_RAW_ERROR');
 const r=req.arguments;return {format:CANDIDATES_FORMAT,scope:CANDIDATES_SCOPE,source_id:'default',request_id:r.request_id,
  project_id:r.project_id??null,after_id:r.after_id??null,limit:r.limit,observed_at:'2026-09-27T00:00:00.000Z',memories:[],returned:0,
  has_more:false,next_after:null,read_only:true,model_calls:0,trust:'untrusted-memory-metadata',snapshot:false};
};
if(mode==='cleanup'){const close=Client.prototype.close;Client.prototype.close=async function(){await close.call(this);await pause('cleanup');};}
const iterator=process.stdin[Symbol.asyncIterator].bind(process.stdin);
process.stdin[Symbol.asyncIterator]=()=>{process.send?.({phase:'input'});return iterator();};
process.once('beforeExit',()=>process.send?.({observed:true,calls:state.calls.map(c=>c.name),connections:state.connections,closed:state.closed}));
