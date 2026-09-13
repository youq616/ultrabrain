#!/usr/bin/env node
/** Hook reads only event metadata, never prompt text, transcripts, or arbitrary event paths. */
import {serveProxy} from './proxy.mjs';
import {clientProfile} from '../../../src/client-kit.mjs';
import {readClientProfile,matchingWorkspace} from '../../../src/client-profile-file.mjs';
import {resolve,dirname,parse} from 'node:path';
import {connectClient} from './runtime.mjs';
import {claudeContext,captureRequest} from '../../../src/client-kit.mjs';
import {requireThat,UltraError} from '../../../src/core.mjs';
export async function readBounded(stream,limit=65536){const chunks=[];let size=0;for await(const c of stream){const b=Buffer.from(c);size+=b.length;requireThat(size<=limit,'input_too_large','Input too large');chunks.push(b);}try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{throw new UltraError('invalid_params','Invalid input JSON');}}
export async function main(args=process.argv.slice(2)) {
  let connection,hook=args[0]==='claude-hook',writing=false;
  const controller=new AbortController(),deadline=setTimeout(()=>{controller.abort();process.stdin.destroy();},25000);deadline.unref();
  try{
    requireThat(args.length===3&&['probe','context','bound-context','capture','claude-hook','mcp'].includes(args[0])&&args[1]==='--profile','invalid_params','Usage: ultrabrain-client probe|context|bound-context|capture|claude-hook --profile PATH');
    const {input,profile}=readClientProfile(resolve(args[2]));let event,payload;
    if(args[0]==='bound-context'){event=await readBounded(process.stdin);requireThat(event&&typeof event==='object'&&!Array.isArray(event)&&Object.keys(event).every(k=>k==='workspace'),'invalid_params','Only workspace metadata is accepted');matchingWorkspace(profile,event.workspace);}
    if(hook){event=await readBounded(process.stdin);requireThat(['SessionStart','UserPromptSubmit'].includes(event?.hook_event_name),'unsupported_hook','Unsupported hook');
      matchingWorkspace(profile,event.cwd);}
    if(args[0]==='capture'){payload=await readBounded(process.stdin);captureRequest(payload,profile);}
    connection=await connectClient(input,{signal:controller.signal});let output;
    if(args[0]==='mcp'){clearTimeout(deadline);await serveProxy(connection);return;}
    if(hook)output=claudeContext(event.hook_event_name,await connection.context());
    else if(args[0]==='probe')output=await connection.probe();
    else if(['context','bound-context'].includes(args[0]))output=await connection.context();
    else{const p=captureRequest(payload,connection.profile);writing=true;const r=await connection.capture(p);
      requireThat(r?.source_id===connection.profile.source&&r.event_id===p.event_id&&r.storage==='journaled'&&typeof r.job_id==='string','mcp_contract_changed','Unconfirmed capture receipt');output={ok:true,result:r};}
    process.stdout.write(JSON.stringify(output)+'\n');
  }catch(e){const code=e instanceof UltraError&&/^[a-z0-9_]{1,64}$/.test(e.code)?e.code:'client_failed';
    if(hook)process.stdout.write(JSON.stringify({systemMessage:'Ultrabrain personal memory unavailable ('+code+'). Continue without recalled memory; no text was captured.'})+'\n');
    else{const out=args[0]==='mcp'?process.stderr:process.stdout;out.write(JSON.stringify({ok:false,error:code,delivery:writing?'unconfirmed':'not_submitted'})+'\n');process.exitCode=1;}
  }finally{clearTimeout(deadline);if(connection)try{await connection.close();}catch{}}
}
void main();
