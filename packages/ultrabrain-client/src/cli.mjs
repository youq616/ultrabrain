#!/usr/bin/env node
import {lineageRequest} from '../../../src/client-lineage.mjs';
import {taskContextRequest,claudeTaskRequest,requireTaskProfile} from '../../../src/client-task-context.mjs';
import {readLocalDocument,documentImportRequest} from '../../../src/client-document.mjs';
import {objectFields,personalId} from '../../../src/personal-memory.mjs';
/** Read-only hooks remain separate from explicitly authorized capture hooks. No event file paths are read. */
import {CaptureOutbox} from '../../../src/capture-outbox.mjs';
import {automaticCapture,claudeCapture,captureCode} from '../../../src/automatic-capture.mjs';
import {serveProxy} from './proxy.mjs';
import {clientProfile} from '../../../src/client-kit.mjs';
import {readClientProfile,matchingWorkspace,clientProfileAuthorization} from '../../../src/client-profile-file.mjs';
import {resolve,dirname,parse} from 'node:path';
import {connectClient} from './runtime.mjs';
import {claudeContext,captureRequest} from '../../../src/client-kit.mjs';
import {requireThat,UltraError} from '../../../src/core.mjs';
export async function readBounded(stream,limit=65536){const chunks=[];let size=0;for await(const c of stream){const b=Buffer.from(c);size+=b.length;requireThat(size<=limit,'input_too_large','Input too large');chunks.push(b);}try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{throw new UltraError('invalid_params','Invalid input JSON');}}
export async function main(args=process.argv.slice(2)) {
  let connection,autoWriter,hook=args[0]==='claude-hook'||args[0]==='claude-capture-hook'||args[0]==='claude-task-hook',writing=false,taskQueryStarted=false,lineageReadCompleted=false;
  const controller=new AbortController(),deadline=setTimeout(()=>{controller.abort();process.stdin.destroy();},25000);deadline.unref();
  try{
    const command=args[0];
    const regular=['lineage','task-context','claude-task-hook','document-import','probe','context','bound-context','capture','claude-hook','claude-capture-hook','mcp','queue-capture','queue-status','queue-flush'];
    const valid=regular.includes(command)&&(args.length===3||command==='queue-flush'&&args.length===4&&args[3]==='--retry-blocked')||
      command==='queue-lock'&&args.length===5&&args[3]==='--kind'||
      command==='queue-recover-lock'&&args.length===8&&args[3]==='--kind'&&args[5]==='--expected-sha'&&args[7]==='--confirm-writer-stopped';
    requireThat(valid&&args[1]==='--profile','invalid_params','Use a supported client command and --profile PATH');
    const {input,profile}=readClientProfile(resolve(args[2]));let event,payload;
    const assertProfile=()=>requireThat(JSON.stringify(readClientProfile(resolve(args[2])).input)===JSON.stringify(input),'capture_disabled','Profile changed; reload before capture');
    if(command==='lineage') {
      // Bind the existing trusted profile before waiting for input. This command
      // is manual and read-only; capture/model/automatic-Hook grants are irrelevant.
      const authorize=clientProfileAuthorization(resolve(args[2]),input);
      payload=lineageRequest(await readBounded(process.stdin,16384),profile);authorize();
      connection=await connectClient(input,{signal:controller.signal,authorize});authorize();
      const result=await connection.lineage(payload,{authorize});lineageReadCompleted=true;authorize();
      process.stdout.write(JSON.stringify(result)+'\n');return;
    }
    if(command==='task-context'||command==='claude-task-hook') {
      // Permission and destination are frozen BEFORE stdin/connection waits, not reloaded into new authority.
      requireTaskProfile(profile,command==='claude-task-hook');
      event=await readBounded(process.stdin);
      payload=command==='claude-task-hook'?claudeTaskRequest(event,profile):event;
      taskContextRequest(payload,profile);
      const authorize=()=>requireThat(JSON.stringify(readClientProfile(resolve(args[2])).input)===JSON.stringify(input),
        'task_context_disabled','Profile changed; reload before task recall');
      authorize();connection=await connectClient(input,{signal:controller.signal});authorize();
      // Entering delivery is uncertain on error, even if the read may already have reached the server.
      taskQueryStarted=true;
      const result=await connection.taskContext(payload,{authorize});authorize();
      process.stdout.write(JSON.stringify(command==='claude-task-hook'?claudeContext('UserPromptSubmit',result):result)+'\n');return;
    }
    if(command==='document-import') {
      const chosen=await readBounded(process.stdin);
      objectFields(chosen,['path','agent_id','event_id','consent']);
      requireThat(chosen.consent===true&&profile.allowDocuments,'capture_disabled','Explicit per-file and profile permission required');
      personalId(chosen.agent_id,'agent_id');personalId(chosen.event_id,'event_id');assertProfile();
      const selected=readLocalDocument(chosen.path);assertProfile();
      const request=documentImportRequest({...selected,agent_id:chosen.agent_id,event_id:chosen.event_id,consent:chosen.consent},profile);
      connection=await connectClient(input,{signal:controller.signal});assertProfile();writing=true;
      const result=await connection.importDocument(request,{authorize:assertProfile});
      process.stdout.write(JSON.stringify({ok:true,result})+'\n');return;
    }
    if(command==='claude-capture-hook'){
      event=await readBounded(process.stdin,220000);payload=claudeCapture(event,profile);
      if(!payload){process.stdout.write(JSON.stringify({systemMessage:'Ultrabrain: no eligible automatic observation; nothing captured.'})+'\n');return;}
      autoWriter=automaticCapture(resolve(args[2]),connectClient,{authorizedProfileInput:input});
      const role=event.hook_event_name==='Stop'?'assistant':'user';
      const result=await autoWriter.submit(payload,event.cwd,'claude-'+role);
      process.stdout.write(JSON.stringify({systemMessage:result.delivery.delivered?'Ultrabrain: observation journaled by the server; not yet confirmed knowledge.':'Ultrabrain: observation kept in the private client queue; server delivery not confirmed.'})+'\n');return;
    }
    if(command.startsWith('queue-')){
      const queue=new CaptureOutbox(input);let result;
      if(command==='queue-status')result=await queue.status();
      else if(command==='queue-lock')result=queue.inspectLock(args[4]);
      else if(command==='queue-recover-lock')result=queue.recoverLock(args[4],args[6],{writerStopped:true});
      else {
        let queued;
        if(command==='queue-capture'){payload=await readBounded(process.stdin,220000);captureRequest(payload,profile);writing=true;queued=await queue.enqueue(payload,{authorize:assertProfile});}
        else{requireThat(profile.allowCapture,'capture_disabled','Capture permission required before delivery');writing=true;}
        try {result={...(queued?{queued}:{}),delivery:await queue.flush(connectClient,{limit:4,retryBlocked:args[3]==='--retry-blocked',signal:controller.signal,
          authorize:assertProfile})};}
        catch(e){if(!queued)throw e;result={queued,delivery:{delivered:0,retained:1,last_error:captureCode(e)}};}
        if(result.delivery.retained||result.delivery.blocked||result.delivery.last_error||result.delivery.remaining_pending||result.delivery.remaining_blocked)process.exitCode=1;
      }
      process.stdout.write(JSON.stringify({ok:!process.exitCode,result})+'\n');return;
    }
    if(args[0]==='bound-context'){event=await readBounded(process.stdin);requireThat(event&&typeof event==='object'&&!Array.isArray(event)&&Object.keys(event).every(k=>k==='workspace'),'invalid_params','Only workspace metadata is accepted');matchingWorkspace(profile,event.workspace);}
    if(command==='claude-hook'){event=await readBounded(process.stdin);requireThat(['SessionStart','UserPromptSubmit'].includes(event?.hook_event_name),'unsupported_hook','Unsupported hook');
      matchingWorkspace(profile,event.cwd);}
    if(args[0]==='capture'){payload=await readBounded(process.stdin);captureRequest(payload,profile);}
    connection=await connectClient(input,{signal:controller.signal,...(command==='mcp'?{authorize:clientProfileAuthorization(resolve(args[2]),input)}:{})});let output;
    if(args[0]==='mcp'){clearTimeout(deadline);await serveProxy(connection);return;}
    if(hook)output=claudeContext(event.hook_event_name,await connection.context());
    else if(args[0]==='probe')output=await connection.probe();
    else if(['context','bound-context'].includes(args[0]))output=await connection.context();
    else{const p=captureRequest(payload,connection.profile);writing=true;const r=await connection.capture(p,{authorize:assertProfile});
      requireThat(r?.source_id===connection.profile.source&&r.event_id===p.event_id&&r.storage==='journaled'&&typeof r.job_id==='string','mcp_contract_changed','Unconfirmed capture receipt');output={ok:true,result:r};}
    process.stdout.write(JSON.stringify(output)+'\n');
  }catch(e){const code=e instanceof UltraError&&/^[a-z0-9_]{1,64}$/.test(e.code)?e.code:'client_failed';
    if(hook)process.stdout.write(JSON.stringify({systemMessage:args[0]==='claude-task-hook'?'Ultrabrain task recall unavailable ('+code+'). Task query delivery '+(taskQueryStarted?'is unconfirmed':'has not started')+'. Continue without task-ranked recall; this hook requested no memory writes.':args[0]==='claude-capture-hook'?'Ultrabrain automatic capture not confirmed ('+code+'). Check the client queue; do not assume the observation was saved.':'Ultrabrain personal memory unavailable ('+code+'). Continue without recalled memory; no text was captured.'})+'\n');
    else{const out=args[0]==='mcp'?process.stderr:process.stdout;
      const failure=args[0]==='lineage'?{ok:false,error:code,read_delivery:e.read_delivery==='unconfirmed'||lineageReadCompleted?'unconfirmed':'not_started',memory_writes_requested:false}:
        args[0]==='task-context'?{ok:false,error:code,query_delivery:taskQueryStarted?'unconfirmed':'not_started',memory_writes_requested:false}:
        {ok:false,error:code,delivery:writing?'unconfirmed':'not_submitted'};
      out.write(JSON.stringify(failure)+'\n');process.exitCode=1;}
  }finally{autoWriter?.close();clearTimeout(deadline);if(connection)try{await connection.close();}catch{}}
}
void main();
