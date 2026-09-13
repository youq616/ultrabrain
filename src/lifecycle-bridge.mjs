/** Authenticated programmatic event bridge; never executes strings from an event.
 * The caller supplies events. This is not a promise to capture arbitrary client UI.
 */
import {AgentMemory} from './agent-memory.mjs';
import {DurableOutbox} from './durable-outbox.mjs';
import {parseUri,requireThat,text,integer} from './core.mjs';
import {identifier} from './projects.mjs';
import {clientOptions} from './mcp-client-options.mjs';
import {mode as memoryMode} from './memory-policy.mjs';
const keys=new Set(['event','session_id','event_id','query','transcript','project_id','limit','retry']);
function unpack(r) {
 requireThat(r&&!r.isError&&Array.isArray(r.content),'bridge_rejected','MCP identity request was rejected');
 const value=JSON.parse(r.content.filter(c=>c.type==='text').map(c=>c.text).join('\n'));
 requireThat(value&&typeof value==='object','mcp_contract_changed','Invalid MCP identity');return value;
}
export function bridgeOptions(args) {
 const options={capture:false,memoryPolicy:'current',factRecall:null,personalContext:false};const seen=new Set();
 for(let n=0;n<args.length;n++) {
  const key=args[n];requireThat(!seen.has(key),'invalid_params','Duplicate bridge option');seen.add(key);
  if(key==='--capture'){options.capture=true;continue;}
  if(key==='--personal-context'){options.personalContext=true;continue;}
  if(key==='--facts'){options.factRecall={};continue;}
  requireThat(['--url','--token-file','--root','--outbox','--memory-policy','--visibility','--fact-entity'].includes(key)&&n+1<args.length,'invalid_params','Unknown or incomplete bridge option');
  options[key.slice(2)]=args[++n];
 }
 const native=clientOptions(['--url',options.url,'--token-file',options['token-file'],'--tool','ultra_identity']);
 const root=parseUri(options.root);
 requireThat(!options.personalContext||!root.slug,'scope_denied','Personal context requires a source root');
 options.memoryPolicy=memoryMode(options['memory-policy']??'current');
 requireThat(options['fact-entity']===undefined||options.factRecall!==null,'invalid_params','--fact-entity requires --facts');
 if(options['fact-entity']!==undefined)options.factRecall={entity:text(options['fact-entity'],'fact entity',2048)};
 options.visibility=options.visibility??'private';
 requireThat(['private','world'].includes(options.visibility),'invalid_params','Invalid visibility');
 requireThat(!options.capture||typeof options.outbox==='string','invalid_params','Durable outbox required when capture is enabled');
 return {...options,...native,rootUri:root.uri};
}
export async function bindBridge(client,options,signal) {
 const identity=unpack(await client.callTool({name:'ultra_identity',arguments:{}},undefined,{signal,timeout:30000}));
 requireThat(identity.format===1&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(identity.instance_id??'')&&/^[a-f0-9]{64}$/.test(identity.actor_key??'')&&
  identity.source_id===parseUri(options.rootUri).source,'identity_mismatch','Authenticated identity does not match the configured source');
 const outbox=options.capture?new DurableOutbox({directory:options.outbox,rootUri:options.rootUri,
  principalId:identity.actor_key,serverId:identity.instance_id}):null;
 return {
  identity:{...identity},
  async handle(event) {
   requireThat(event&&typeof event==='object'&&!Array.isArray(event)&&Object.keys(event).every(k=>keys.has(k)),
    'invalid_params','Unknown or invalid lifecycle event field');
   requireThat(['before_turn','after_turn','resume_project','session_status','drain'].includes(event.event),'invalid_params','Unsupported lifecycle event');
   identifier(event.session_id,'session_id');
   if(event.project_id!==undefined)identifier(event.project_id,'project_id');
   const memory=new AgentMemory({client,rootUri:options.rootUri,sessionId:event.session_id,projectId:event.project_id??null,
    capture:options.capture,deferExtraction:true,visibility:options.visibility,memoryPolicy:options.memoryPolicy,personalContext:options.personalContext??false,factRecall:options.factRecall??null,
    outbox,principalId:identity.actor_key,serverId:identity.instance_id});
   // Recheck identity before any event can deliver a pending payload: token rotations
   // that change principal or server must not redirect an existing durable journal.
   const current=unpack(await client.callTool({name:'ultra_identity',arguments:{}},undefined,{signal,timeout:30000}));
   requireThat(current.instance_id===identity.instance_id&&current.actor_key===identity.actor_key&&current.source_id===identity.source_id,
    'identity_mismatch','MCP identity changed; use a separately bound outbox and reauthenticate');
   if(event.event==='before_turn') {
    text(event.query,'query',4096);
    const project=event.project_id?await memory.resumeProject(event.query,{signal}):null;
    return {event:event.event,context:await memory.beforeTurn(project?.retrieval_query??event.query,{signal}),project};
   }
   if(event.event==='after_turn') {
    requireThat(options.capture,'capture_disabled','Enable --capture explicitly before submitting consented transcripts');
    identifier(event.event_id,'event_id');text(event.transcript,'transcript',65536);
    return {event:event.event,delivery:await memory.afterTurn({eventId:event.event_id,transcript:event.transcript,signal})};
   }
   if(event.event==='resume_project')return {event:event.event,project:await memory.resumeProject(text(event.query,'query',4096),{signal})};
   if(event.event==='session_status')return {event:event.event,status:await memory.sessionStatus(event.event_id,{signal})};
   const limit=integer(event.limit,8,1,1000);
   requireThat(event.retry===undefined||typeof event.retry==='boolean','invalid_params','retry must be boolean');
   return {event:event.event,delivery:await memory.flushOutbox({limit,force:event.retry===true,signal})};
  },
 };
}
