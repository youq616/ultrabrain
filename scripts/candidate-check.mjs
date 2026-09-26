#!/usr/bin/env node
/** Inspect a pinned PR. Exit 0=metadata requirements met, 2=blocked, 1=unconfirmed.
 * No code execution from the selected PR, no writes, merge or deployment. */
import {pathToFileURL} from 'node:url';
import {candidateSelection,candidateFailure,requireCandidate} from '../src/candidate-check.mjs';
import {collectCandidate} from '../src/candidate-github.mjs';
export function candidateArgs(args){
  const p={repository:'youq616/ultrabrain',reviewer_ids:[]};const seen=new Set();
  for(let i=0;i<args.length;i+=2){
    const key=args[i],value=args[i+1];requireCandidate(value!==undefined,'invalid_params');
    if(key==='--reviewer-id'){requireCandidate(/^[1-9][0-9]*$/.test(value),'invalid_params');p.reviewer_ids.push(Number(value));continue;}
    const name={'--pr':'pr','--head':'head_sha','--base':'base_sha'}[key];
    requireCandidate(name&&!seen.has(name),'invalid_params');seen.add(name);
    if(name==='pr')requireCandidate(/^[1-9][0-9]*$/.test(value),'invalid_params');
    p[name]=name==='pr'?Number(value):value;
  }
  return candidateSelection(p);
}
export async function candidateMain(args,{write=text=>process.stdout.write(text),collect=collectCandidate,token=process.env.GITHUB_TOKEN,signal}={}){
  if(args.length===1&&args[0]==='--help'){
    write('Usage: node scripts/candidate-check.mjs --pr N --head FULL_SHA --base FULL_SHA [--reviewer-id NUMERIC_ID]\n'+
      'Repository: youq616/ultrabrain. GITHUB_TOKEN optional; read-only HTTPS GET. Reviewer IDs are trusted operator configuration.\n'+
      'Exit 0: metadata requirements met, NOT merge approval. Exit 2: blocked. Exit 1: incomplete or changed evidence.\n');return 0;
  }
  try{
    const p=candidateArgs(args),r=await collect(p,{token,signal});
    requireCandidate(!signal?.aborted,'aborted');
    write(JSON.stringify(r)+'\n');return r.status==='metadata_requirements_met'?0:2;
  }catch(e){write(JSON.stringify(candidateFailure(e))+'\n');return 1;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const c=new AbortController(),cancel=()=>c.abort();process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
  process.stdout.on('error',()=>{c.abort();process.exitCode=1;});
  process.exitCode=await candidateMain(process.argv.slice(2),{signal:c.signal});
  process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);
}
