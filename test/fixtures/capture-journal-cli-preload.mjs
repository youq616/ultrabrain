/** Source CLI fixture: explicit SDK double, real journal IO + one injected errno. */
import {register,syncBuiltinESMExports} from 'node:module';import fs from 'node:fs';
import {Client,reset} from './client-sdk-stub.mjs';
register(new URL('./client-lineage-cli-loader.mjs',import.meta.url));reset();
Client.prototype.connect=async()=>{throw Error('Unexpected connection in journal failure fixture');};
const native=fs.linkSync;
fs.linkSync=(...args)=>{if(String(args[1]).endsWith('.entry')||process.env.ULTRABRAIN_JOURNAL_FIXTURE==='binding')
 throw Object.assign(Error('PRIVATE_NATIVE_ERROR'),{code:'EPERM'});return native(...args);};
syncBuiltinESMExports();
