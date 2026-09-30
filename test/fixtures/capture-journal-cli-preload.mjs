/** Source CLI fixture: explicit SDK double, real journal IO + one injected errno. */
import {register,syncBuiltinESMExports} from 'node:module';import fs from 'node:fs';
import {Client,reset} from './client-sdk-stub.mjs';
import {CaptureOutbox} from '../../src/capture-outbox.mjs';
import {UltraError} from '../../src/core.mjs';
register(new URL('./client-lineage-cli-loader.mjs',import.meta.url));reset();
Client.prototype.connect=async()=>{throw Error('Unexpected connection in journal failure fixture');};
const mode=process.env.ULTRABRAIN_JOURNAL_FIXTURE;
const nativeLink=fs.linkSync,nativeRename=fs.renameSync,nativeOpen=fs.openSync,nativeUnlink=fs.unlinkSync;
let publishFailed=false;
fs.linkSync=(...args)=>{if(mode==='entry'&&String(args[1]).endsWith('.entry')||mode==='binding')
 throw Object.assign(Error('PRIVATE_NATIVE_ERROR'),{code:'EPERM'});return nativeLink(...args);};
fs.renameSync=(...args)=>{if(['attempt','attempt-release'].includes(mode)&&String(args[1]).endsWith('.entry')){publishFailed=true;
 throw Object.assign(Error('PRIVATE_NATIVE_ERROR'),{code:'ENOSPC'});}return nativeRename(...args);};
fs.openSync=(path,...args)=>{if(mode==='delivery-lock'&&String(path).endsWith('.delivery.lock'))
 throw Object.assign(Error('PRIVATE_NATIVE_ERROR'),{code:'EPERM'});return nativeOpen(path,...args);};
fs.unlinkSync=(path,...args)=>{if(mode==='attempt-release'&&publishFailed&&String(path).endsWith('.lock'))
 throw Object.assign(Error('PRIVATE_NATIVE_ERROR'),{code:'EPERM'});return nativeUnlink(path,...args);};
if(mode==='forged')CaptureOutbox.prototype.flush=async()=>{
 const error=new UltraError('outbox_journal_io','PRIVATE_FORGED_ERROR');
 Object.defineProperties(error,{journal:{get(){throw Error('PRIVATE_GETTER');}},lock:{value:{path:'PRIVATE_FORGED_PATH'}}});throw error;
};
syncBuiltinESMExports();
