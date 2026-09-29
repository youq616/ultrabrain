#!/usr/bin/env node
/** Standalone local-only binary: works without importing or installing the SDK. */
import {resolve} from 'node:path';
import {auditCaptureOutbox} from '../../../src/capture-audit.mjs';
import {readClientProfile,clientProfileAuthorization} from '../../../src/client-profile-file.mjs';
import {UltraError,requireThat} from '../../../src/core.mjs';
export async function main(args=process.argv.slice(2)){
 const controller=new AbortController(),cancel=()=>controller.abort();
 const timer=setTimeout(cancel,25000);timer.unref();
 process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
 try{
  if(args.length===1&&args[0]==='--help'){
   process.stdout.write('Usage: ultrabrain-queue-audit --profile PATH\nRead-only local audit; no network, lock acquisition, repair or capture.\n');return;
  }
  requireThat(args.length===2&&args[0]==='--profile','invalid_params','Use --profile PATH');
  const path=resolve(args[1]),{input}=readClientProfile(path),authorize=clientProfileAuthorization(path,input);
  const result=await auditCaptureOutbox(input,{signal:controller.signal,authorize});authorize();
  const ok=['healthy','absent','uninitialized'].includes(result.status);
  process.stdout.write(JSON.stringify({ok,result})+'\n');if(!ok)process.exitCode=1;
 }catch(e){
  const codes=new Set(['aborted','capture_disabled','invalid_params','invalid_profile','insecure_profile','profile_changed','profile_revoked','client_authorization_revoked']);
  const code=e instanceof UltraError&&codes.has(e.code)?e.code:'audit_failed';
  process.stdout.write(JSON.stringify({ok:false,error:code,read_only:true,server_confirmation:false})+'\n');process.exitCode=1;
 }finally{clearTimeout(timer);process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);}
}
void main();
