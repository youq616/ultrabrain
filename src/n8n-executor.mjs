/** Testable n8n execution contract. The node wrapper creates platform errors, never echoes input on failure. */
import {automationSettings,validateAutomationRequest} from './automation-session.mjs';
import {requireThat,integer,UltraError} from './core.mjs';

function requestFor(context,operation,index) {
  const value=name=>context.getNodeParameter(name,index);
  if(operation==='identity')return {};
  const p={session_id:value('sessionId')};
  if(['before_turn','resume_project'].includes(operation)) {
    p.query=value('query');const project=value('projectId');if(project!=='')p.project_id=project;
  }
  if(['session_status','after_turn'].includes(operation))p.event_id=value('eventId');
  if(operation==='after_turn')Object.assign(p,{transcript:value('transcript'),consent:value('captureConsent'),visibility:value('visibility')});
  return p;
}
function failure(error) {
  // Only known typed local/server codes, never a raw SDK/provider/n8n exception string.
  return {ok:false,error:error instanceof UltraError?error.code:'adapter_failed',
    delivery:error?.delivery==='unconfirmed'?'unconfirmed':'not_submitted'};
}
export async function executeN8n(context,connect) {
  const items=context.getInputData();
  requireThat(Array.isArray(items)&&items.length<=1000,'invalid_params','At most 1000 input items per node execution');
  if(items.length===0)return [];
  let connection,openError;
  const output=[];
  const signal=typeof context.getExecutionCancelSignal==='function'?context.getExecutionCancelSignal():undefined;
  // Freeze credential resolution once per execution; never accept endpoint/token/source from item JSON.
  let credentials;
  try {credentials=await context.getCredentials('ultrabrainApi');}
  catch {throw new UltraError('invalid_credentials','Configure an Ultrabrain credential');}
  try {
    for(let index=0;index<items.length;index++) {
      try {
        requireThat(!signal?.aborted,'cancelled','Execution cancelled');
        const get=(name,fallback)=>context.getNodeParameter(name,index,fallback);
        const operation=get('operation','before_turn');
        const settings=automationSettings({rootUri:credentials.rootUri,
          allowCapture:credentials.allowCapture===true,allowSharedCapture:credentials.allowSharedCapture===true,
          expectedInstance:credentials.expectedInstance??'',expectedActor:credentials.expectedActor??'',
          memoryPolicy:get('memoryPolicy','current'),summary:get('summary','prefer'),
          budgetBytes:integer(get('budgetBytes',16000),16000,512,131072),
          timeoutMs:integer(get('timeoutMs',30000),30000,1000,120000),
          includeFacts:get('includeFacts',false),includePersonal:get('includePersonal',false),factEntity:get('factEntity','')});
        const request=requestFor(context,operation,index);
        // Preflight before connecting prevents unconsented capture from touching the network.
        validateAutomationRequest(operation,request,settings);
        if(openError)throw openError;
        if(!connection) {
          try {connection=await connect(credentials,{signal});}
          catch(e) {openError=e;throw e;}
        }
        // Item expressions may alter search settings, not connection identity or capture ceilings.
        const session=await connection.session(settings,{signal});
        const result=await session.run(operation,request);
        output.push({json:{ok:true,operation,result},pairedItem:{item:index}});
      }catch(e){
        const safe=failure(e);
        if(!context.continueOnFail()) {
          const error=new UltraError(safe.error,'Ultrabrain operation failed; check operation code and delivery state');
          error.delivery=safe.delivery;error.itemIndex=index;throw error;
        }
        output.push({json:safe,pairedItem:{item:index}});
        if(signal?.aborted)break;
      }
    }
    return output;
  }finally{
    // A confirmed write is not relabeled failed merely because session cleanup failed.
    if(connection)try{await connection.close();}catch{}
  }
}
