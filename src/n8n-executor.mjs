/** Testable n8n execution contract. The node wrapper creates platform errors, never echoes input on failure. */
import {automationSettings,validateAutomationRequest} from './automation-session.mjs';
import {requireThat,integer,UltraError} from './core.mjs';

function requestFor(context,operation,index) {
  const value=name=>context.getNodeParameter(name,index);
  if(operation==='identity')return {};
  if(operation==='personal_overview')return {scope:value('overviewScope'),consent:value('overviewConsent')};
  const p={session_id:value('sessionId')};
  if(['before_turn','resume_project'].includes(operation)) {
    p.query=value('query');const project=value('projectId');if(project!=='')p.project_id=project;
  }
  if(['session_status','after_turn'].includes(operation))p.event_id=value('eventId');
  if(operation==='after_turn')Object.assign(p,{transcript:value('transcript'),consent:value('captureConsent'),visibility:value('visibility')});
  return p;
}
function failure(error,overview=false) {
  // Only known typed local/server codes, never a raw SDK/provider/n8n exception string.
  if(overview)return {ok:false,error:error instanceof UltraError?error.code:'adapter_failed',
    read_delivery:error instanceof UltraError&&error.read_delivery==='unconfirmed'?'unconfirmed':'not_started',memory_writes_requested:false};
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
  try {credentials=Object.freeze(structuredClone(await context.getCredentials('ultrabrainApi')));}
  catch {throw new UltraError('invalid_credentials','Configure an Ultrabrain credential');}
  try {
    for(let index=0;index<items.length;index++) {
      let operation;
      try {
        const get=(name,fallback)=>context.getNodeParameter(name,index,fallback);
        operation=get('operation','before_turn');
        requireThat(!signal?.aborted,'cancelled','Execution cancelled');
        const identitySettings={rootUri:credentials.rootUri,
          expectedInstance:credentials.expectedInstance??'',expectedActor:credentials.expectedActor??'',
          timeoutMs:integer(get('timeoutMs',30000),30000,1000,120000)};
        // The overview must not evaluate hidden query/transcript/context fields.
        const settings=automationSettings(operation==='personal_overview'?identitySettings:{...identitySettings,
          allowCapture:credentials.allowCapture===true,allowSharedCapture:credentials.allowSharedCapture===true,
          memoryPolicy:get('memoryPolicy','current'),summary:get('summary','prefer'),
          budgetBytes:integer(get('budgetBytes',16000),16000,512,131072),
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
        const safe=failure(e,operation==='personal_overview');
        if(!context.continueOnFail()) {
          const error=new UltraError(safe.error,'Ultrabrain operation failed; check operation code and delivery state');
          if(operation==='personal_overview'){error.read_delivery=safe.read_delivery;error.memory_writes_requested=false;}
          else error.delivery=safe.delivery;error.itemIndex=index;throw error;
        }
        output.push({json:safe,pairedItem:{item:index}});
        if(signal?.aborted)break;
      }
    }
  }finally{
    // A confirmed write is not relabeled failed merely because session cleanup failed.
    if(connection)try{await connection.close();}catch{}
  }
  // n8n receives items only after cleanup. Cancellation during a later item or
  // cleanup invalidates earlier private overview observations, not confirmed writes.
  if(signal?.aborted)for(const item of output)if(item.json.ok&&item.json.operation==='personal_overview'){
    const error=new UltraError('cancelled','Overview cancelled before node delivery');
    error.read_delivery='unconfirmed';error.memory_writes_requested=false;error.itemIndex=item.pairedItem.item;
    if(!context.continueOnFail())throw error;
    item.json=failure(error,true);
  }
  return output;
}
