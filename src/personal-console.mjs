/** Local-owner personal console, not a public service or an alternate MCP administrator.
 * No cookies, CORS, remote binds, tokens in URLs, arbitrary file serving or native tool proxy.
 */
import {createServer} from 'node:http';
import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {constants,openSync,closeSync,fstatSync,readFileSync,writeFileSync,fsyncSync,lstatSync} from 'node:fs';
import {resolve,dirname,parse,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {requireThat,sourceId,integer,UltraError} from './core.mjs';
import {objectFields} from './personal-memory.mjs';
import {PersonalConsolidator} from './personal-consolidation.mjs';
import {configuredPersonalModel} from './adapters/personal-model.mjs';
import {PersonalMemoryStore} from './personal-memory-store.mjs';
import {PersonalDocumentStore} from './personal-documents.mjs';
import {createPersonalReadiness} from './personal-readiness.mjs';
const WEB=fileURLToPath(new URL('../web/personal/',import.meta.url));
const METHODS=Object.freeze({capture:'capture',jobs:'job_status',consolidate:'job_process',cancel_job:'job_cancel',memory_read:'read',search:'search',profile:'profile',context:'context',agents:'agents',register:'register',commit:'commit',review:'review',update:'update',
  document_import:'documentImport',document_list:'documentList',document_read:'documentRead',document_queue:'documentQueue',document_archive:'documentArchive'});
const WRITES=new Set(['register','commit','review','update','capture','consolidate','cancel_job','document_import','document_queue','document_archive']);
const DOCUMENT_METHODS=new Set(['documentImport','documentList','documentRead','documentQueue','documentArchive']);
const ASSETS=new Map([['/',['index.html','text/html; charset=utf-8']],['/app.js',['app.js','text/javascript; charset=utf-8']],['/style.css',['style.css','text/css; charset=utf-8']]]);
const SAFE_CODES=new Set(['invalid_params','not_found','revision_conflict','conflict','agent_not_registered','capture_disabled','permission_denied','queue_full','model_consent_required','stale_source','invalid_personal_model',
  'memory_read_too_large','invalid_label','unsupported_format','file_too_large','invalid_utf8','fingerprint_mismatch','document_bound','document_corrupt','fragment_not_processable','fragment_boundary']);
export function consoleOptions(args) {
  const out={source:'default',port:3132};
  for(let i=0;i<args.length;i+=2) {
    const key=args[i];
    requireThat(['--source','--port','--token-file'].includes(key)&&i+1<args.length,'invalid_params','personal-ui [--source SOURCE --port PORT --token-file PATH]');
    const name=key.slice(2);requireThat(!Object.hasOwn(out,'seen-'+name),'invalid_params','Duplicate option');out['seen-'+name]=true;out[name]=args[i+1];
  }
  return {source:sourceId(out.source),port:integer(Number(out.port),3132,1024,65535),tokenFile:out['token-file']};
}
/** Create the secret once in an already private directory, or read the owner-only file.
 * The token persists until the operator rotates the file AND restarts the console.
 */
export function consoleToken(path) {
  requireThat(typeof process.getuid==='function','unsupported_platform','Run the console as the ordinary Linux service user');
  path=resolve(path);let cursor=dirname(path);
  while(cursor!==parse(cursor).root) {
    requireThat(!lstatSync(cursor).isSymbolicLink(),'insecure_token_file','Symlinked token directories are not accepted');cursor=dirname(cursor);
  }
  const parent=lstatSync(dirname(path));
  requireThat(parent.isDirectory()&&parent.uid===process.getuid()&&!(parent.mode&0o077),'insecure_token_file','Token directory must be owned by this user and mode 0700');
  let fd;
  try {
    try {
      fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
      writeFileSync(fd,randomBytes(32).toString('hex')+'\n');fsyncSync(fd);closeSync(fd);fd=undefined;
      const directory=openSync(dirname(path),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
      try{fsyncSync(directory);}finally{closeSync(directory);}
    }catch(e){if(e.code!=='EEXIST')throw e;}
    fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);const stat=fstatSync(fd);
    requireThat(stat.isFile()&&stat.uid===process.getuid()&&!(stat.mode&0o077)&&stat.size<=128,'insecure_token_file','Token must be an owner-only regular file');
    const token=readFileSync(fd,'utf8').trim();requireThat(/^[a-f0-9]{64}$/.test(token),'invalid_token_file','Invalid console token');return token;
  }finally{if(fd!==undefined)closeSync(fd);}
}
function headers(res) {
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; font-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  res.setHeader('Cross-Origin-Resource-Policy','same-origin');res.setHeader('Cross-Origin-Opener-Policy','same-origin');
  res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
}
function send(res,status,value,readiness=false) {
  if(res.destroyed||res.writableEnded)return;
  const body=JSON.stringify(value);
  res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');
  if(readiness){res.setHeader('Content-Length',Buffer.byteLength(body));res.setHeader('Connection','close');}
  res.end(body);
}
async function jsonBody(req,limit=280000,canonical=false) {
  requireThat(/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type']??''),'invalid_content_type','JSON required');
  requireThat(!req.headers['content-encoding'],'invalid_content_type','Compressed bodies are not accepted');
  const size=Number(req.headers['content-length']);requireThat(!Number.isFinite(size)||size<=limit,'request_too_large','Request exceeds limit');
  let n=0;const chunks=[];
  // Do not parse partial/invalid UTF-8 or execute after the client has aborted the body.
  for await(const chunk of req){n+=chunk.length;requireThat(n<=limit,'request_too_large','Request exceeds limit');chunks.push(chunk);}
  requireThat(req.complete,'invalid_params','Incomplete request');
  try{
    const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:canonical}).decode(Buffer.concat(chunks)),value=JSON.parse(text);
    // Readiness has a single canonical wire spelling; duplicate keys, lossy numbers
    // and alternate escapes are refused rather than silently normalized.
    requireThat(!canonical||JSON.stringify(value)===text,'invalid_params','Canonical JSON required');
    return value;
  }
  catch{throw new UltraError('invalid_params','Invalid JSON request');}
}
export async function startPersonalConsole({engine,source,token,port=3132,invocationId=process.env.INVOCATION_ID,configureModel=configuredPersonalModel}) {
  sourceId(source);integer(port,3132,0,65535);
  requireThat(typeof token==='string'&&/^[a-f0-9]{64}$/.test(token),'invalid_token_file','A full console token is required');
  const hash=createHash('sha256').update(token).digest();
  const readiness=createPersonalReadiness({engine,source,token,invocationId});
  const [exists]=await engine.executeRaw('SELECT id FROM public.sources WHERE id=$1',[source]);
  requireThat(exists,'not_found','Create or select an existing source; the console never guesses ownership or creates a source');
  const store=new PersonalMemoryStore({sourceId:source,engine,remote:false,transport:'stdio'});
  const assets=new Map([...ASSETS].map(([url,[name,type]])=>[url,{body:readFileSync(join(WEB,name)),type}]));
  let origin='',host='',inflight=0,stopping=false;
  const running=new Set();
  const server=createServer({maxHeaderSize:8192,requestTimeout:15000,headersTimeout:10000,keepAliveTimeout:1000},(req,res)=>{
    headers(res);
    const task=(async()=>{
      let submitted=false,held=false,probing=false,expired=false,deadline;
      try {
        requireThat(!stopping,'unavailable','Console is shutting down');
        requireThat(req.socket.remoteAddress==='127.0.0.1','permission_denied','Loopback only');
        requireThat(req.headers.host===host&&!req.headers.forwarded&&!req.headers['x-forwarded-host']&&!req.headers['x-forwarded-for'],
          'permission_denied','Unexpected host or proxy headers');
        requireThat(!req.headers['sec-fetch-site']||['same-origin','none'].includes(req.headers['sec-fetch-site']),'permission_denied','Cross-site access rejected');
        // Fixed resource paths: no query-string token, path resolution or generic file endpoint.
        if(req.method==='GET'&&assets.has(req.url)) {
          const a=assets.get(req.url);res.setHeader('Content-Type',a.type);res.end(a.body);return;
        }
        requireThat(['/api/call','/api/readiness'].includes(req.url)&&req.method==='POST','not_found','Unknown route');
        requireThat(req.headers.origin===origin,'permission_denied','Exact browser origin required');
        if(req.url==='/api/readiness') {
          probing=true;
          requireThat(req.headers.authorization===undefined,'unauthorized','Readiness uses a dedicated request proof');
          requireThat(inflight<4,'busy','Too many console requests');inflight++;held=true;
          // End the HTTP response even if the adapter hangs. Keep this task and its
          // shared concurrency slot until the real operation finishes, so timed-out
          // probes cannot accumulate unbounded database work.
          deadline=setTimeout(()=>{
            expired=true;
            if(!res.destroyed&&!res.writableEnded) {
              res.setHeader('Connection','close');
              if(!req.complete)res.once('finish',()=>req.destroy());
              send(res,503,{ok:false,error:'readiness_unavailable',delivery:'rejected'},true);
            }
          },3000);deadline.unref();
          const body=await jsonBody(req,1024,true);
          requireThat(!expired&&!req.aborted&&!res.destroyed,'readiness_unavailable','Readiness is unavailable');
          const request=readiness.authenticate(body,origin);
          const result=await readiness.query(request,origin);
          if(!expired)send(res,200,{ok:true,result},true);
          return;
        }
        const auth=req.headers.authorization??'';
        const candidate=/^Bearer ([a-f0-9]{64})$/.exec(auth)?.[1]??'';
        requireThat(timingSafeEqual(hash,createHash('sha256').update(candidate).digest()),'unauthorized','Console authentication required');
        requireThat(inflight<4,'busy','Too many console requests');inflight++;held=true;
        const body=await jsonBody(req);objectFields(body,['operation','input']);
        objectFields(body.input??{},body.operation==='info'?[]:Object.keys(body.input??{}));
        if(body.operation==='info') {send(res,200,{ok:true,result:{source_id:source,identity_scope:'local Linux service owner, same as unauthenticated stdio',version:'0.12.0-alpha.1'}});return;}
        requireThat(Object.hasOwn(METHODS,body.operation),'invalid_params','Unknown personal operation');
        submitted=WRITES.has(body.operation);
        const method=METHODS[body.operation];
        const result=method.startsWith('job_')?await new PersonalConsolidator(store.ctx,configureModel)[method.slice(4)](body.input??{})
          :DOCUMENT_METHODS.has(method)?await new PersonalDocumentStore(store.ctx)[method](body.input??{})
          :await store[method](body.input??{});
        send(res,200,{ok:true,result});
      }catch(e){
        const local=e instanceof UltraError;
        const code=local&&(SAFE_CODES.has(e.code)||['permission_denied','unauthorized','not_found','busy','request_too_large','invalid_content_type','unavailable','readiness_unavailable'].includes(e.code))?e.code:probing?'readiness_unavailable':'personal_storage_error';
        const status=code==='unauthorized'?401:code==='permission_denied'?403:code==='not_found'?404:code==='request_too_large'?413:code==='invalid_content_type'?415:code==='busy'?429:['unavailable','readiness_unavailable'].includes(code)?503:code==='personal_storage_error'?500:400;
        // A storage/transport failure after submission must not assert that nothing was stored.
        send(res,status,{ok:false,error:code,delivery:submitted&&code==='personal_storage_error'?'unconfirmed':'rejected'},probing);
      }finally{clearTimeout(deadline);if(held)inflight--;}
    })();running.add(task);task.finally(()=>running.delete(task));
  });
  server.on('clientError',(_error,socket)=>socket.destroy());
  await new Promise((done,fail)=>{server.once('error',fail);server.listen(port,'127.0.0.1',()=>{server.off('error',fail);done();});});
  host=`127.0.0.1:${server.address().port}`;origin=`http://${host}`;
  return {origin,server,async close(){
    stopping=true;
    const closed=new Promise((done,fail)=>server.close(error=>error?fail(error):done()));
    server.closeIdleConnections();
    const force=setTimeout(()=>server.closeAllConnections(),2000);force.unref();
    try{await closed;await Promise.allSettled([...running]);}finally{clearTimeout(force);}
  }};
}
export async function personalConsoleCLI(args,{connect,home}) {
  const p=consoleOptions(args),tokenFile=p.tokenFile??join(home,'personal-console-token');
  const engine=await connect();let service;
  try {
    const token=consoleToken(tokenFile);service=await startPersonalConsole({engine,source:p.source,token,port:p.port});
    console.log(JSON.stringify({url:service.origin,source_id:p.source,token_file:resolve(tokenFile),
      notice:'Read this owner-only file locally and paste the token into the login form. Do not publish it. Use an SSH tunnel with the same local port; do not expose this port publicly.'}));
    await new Promise(done=>{const stop=()=>{process.off('SIGTERM',stop);process.off('SIGINT',stop);done();};process.once('SIGTERM',stop);process.once('SIGINT',stop);});
  }finally{try{await service?.close();}finally{await engine.disconnect();}}
}
