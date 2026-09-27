#!/usr/bin/env node
/** Explicit chain selection from bounded stdin. No selected-PR code is executed.
 * Exit 0: metadata conditions met; 2: blocked; 1: incomplete/changed/invalid.
 */
import {pathToFileURL} from 'node:url';
import {parseSnapshotJSON} from '../src/personal-snapshot-contract.mjs';
import {requireCandidate,CandidateError} from '../src/candidate-check.mjs';
import {collectCandidateChain,candidateChainSelection,candidateChainFailure,CANDIDATE_CHAIN_TIMEOUT_MS} from '../src/candidate-chain.mjs';
const MAX_INPUT=16384;
export async function candidateChainInput(stream,signal){
  const cancel=()=>stream.destroy();
  if(signal?.aborted)throw new CandidateError('aborted');
  signal?.addEventListener('abort',cancel,{once:true});
  try{
    const chunks=[];let size=0;
    for await(const chunk of stream){
      requireCandidate(!signal?.aborted,'aborted');const bytes=Buffer.from(chunk);size+=bytes.length;
      requireCandidate(size<=MAX_INPUT,'candidate_input_too_large');chunks.push(bytes);
    }
    requireCandidate(!signal?.aborted,'aborted');
    let parsed;
    try{parsed=parseSnapshotJSON(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.concat(chunks)));}
    catch{throw new CandidateError('candidate_input_invalid');}
    return candidateChainSelection(parsed);
  }catch(error){if(signal?.aborted)throw new CandidateError('aborted');throw error;}
  finally{signal?.removeEventListener('abort',cancel);}
}
export async function candidateChainMain(args,{input=process.stdin,write=s=>process.stdout.write(s),
  collect=collectCandidateChain,token=process.env.GITHUB_TOKEN,signal}={}){
  if(args.length===1&&args[0]==='--help'){
    write('Usage: node scripts/candidate-chain-check.mjs < explicitly-selected-chain.json\n'+
      'One UTF-8 JSON object, at most 16 KiB, explicit anchor/tip and 1..8 contiguous PRs.\n'+
      'Only fixed GitHub GETs. GITHUB_TOKEN is optional. No automatic discovery, merge or deployment.\n'+
      'Exit 0: selected metadata conditions met, NOT approval of the anchor or permission to merge.\n'+
      'Exit 2: one or more selected PRs blocked. Exit 1: invalid, changed or incomplete evidence.\n');return 0;
  }
  const deadline=AbortSignal.timeout(CANDIDATE_CHAIN_TIMEOUT_MS);
  const active=AbortSignal.any([signal,deadline].filter(Boolean));
  try{
    requireCandidate(args.length===0,'invalid_params');
    const selection=await candidateChainInput(input,active);
    const report=await collect(selection,{token,signal:active});
    requireCandidate(!active.aborted,'aborted');
    write(JSON.stringify(report)+'\n');return report.status==='metadata_requirements_met'?0:2;
  }catch(error){
    const failure=deadline.aborted&&!signal?.aborted?new CandidateError('candidate_timeout'):error;
    write(JSON.stringify(candidateChainFailure(failure))+'\n');return 1;
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const controller=new AbortController(),cancel=()=>controller.abort();
  process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
  process.stdout.on('error',()=>{controller.abort();process.exitCode=1;});
  process.exitCode=await candidateChainMain(process.argv.slice(2),{signal:controller.signal});
  process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);
  process.stdin.destroy();
}
