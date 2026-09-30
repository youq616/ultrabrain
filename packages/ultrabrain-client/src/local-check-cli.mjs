#!/usr/bin/env node
/** Independent offline entry. Does not read stdin, profiles or model credentials. */
import {qualifyLocalFileRuntime} from './local-check.mjs';
export function localCheckMain(args=process.argv.slice(2),output=process.stdout){
 if(args.length===1&&args[0]==='--help'){
  output.write('Usage: ultrabrain-local-check\nChecks one new synthetic temporary file with production profile/outbox readers.\nNo user paths, stdin, profiles, server, retries or permission repair.\nSuccess covers only this temporary-directory filesystem, not a production queue.\n');return 0;
 }
 if(args.length!==0){output.write(JSON.stringify({passed:false,error:'invalid_params',user_files_selected:false,memory_writes_requested:false,network_requests:0})+'\n');return 1;}
 const report=qualifyLocalFileRuntime();output.write(JSON.stringify(report)+'\n');return report.passed?0:1;
}
process.stdout.on('error',()=>{process.exitCode=1;});
process.exitCode=localCheckMain();
