import {register} from 'node:module';
import {Client,reset} from './client-sdk-stub.mjs';
register(new URL('./client-lineage-cli-loader.mjs',import.meta.url));reset();
Client.prototype.connect=async()=>{throw Error('Unexpected network connection in read-only queue audit');};
