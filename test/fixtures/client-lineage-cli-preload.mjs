/** Isolated child-process fixture only. Real CLI, synthetic SDK; no transport launched. */
import {register} from 'node:module';
import {state,identity} from './client-sdk-stub.mjs';
import {lineagePair} from '../helpers/lineage-fixture.mjs';
register(new URL('./client-lineage-cli-loader.mjs',import.meta.url));
const pair=lineagePair();
state.calls=[];state.connections=0;state.closed=0;
state.onCall=async request=>{
 if(request.name==='ultra_identity')return identity;
 if(request.name!=='ultra_memory_read')throw Error('unexpected fixture operation');
 if(process.env.ULTRABRAIN_LINEAGE_CLI_FIXTURE==='failure')throw Error('PRIVATE_SERVER_ERROR');
 return {source_id:'default',memory:request.arguments.memory_id===pair.memory.id?pair.memory:pair.source,
  read_only:true,trust:'untrusted-memory-data',coverage:'current'};
};
const iterator=process.stdin[Symbol.asyncIterator].bind(process.stdin);
process.stdin[Symbol.asyncIterator]=()=>{
 process.send?.({inputReady:true});return iterator();
};
process.once('beforeExit',()=>{process.send?.({observedCalls:state.calls.map(c=>c.name),connections:state.connections,closed:state.closed});});
