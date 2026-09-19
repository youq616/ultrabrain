/** One explicitly selected file. No scan, URL fetch, transcript discovery or implicit consent. */
import {ensureOwnedAgent} from './client-agent.mjs';
import {constants,lstatSync,openSync,fstatSync,readSync,closeSync} from 'node:fs';
import {basename,resolve,dirname,parse} from 'node:path';
import {requireThat} from './core.mjs';
import {objectFields,personalId} from './personal-memory.mjs';
import {documentLabel,documentFormat,documentContent,importDocumentRequest,PERSONAL_DOCUMENT_MAX_BYTES} from './personal-document-core.mjs';
function parentSnapshots(path) {
  const rows=[];
  for(let p=dirname(path);p!==parse(p).root;p=dirname(p)){
    const st=lstatSync(p);requireThat(st.isDirectory()&&!st.isSymbolicLink(),'invalid_path','Linked parent directories are not accepted');
    rows.push([p,st.dev,st.ino]);
  }
  return rows;
}
function sameFile(a,b){return a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;}
export function readLocalDocument(path) {
  requireThat(typeof path==='string'&&path.length>0&&!path.includes('\0'),'invalid_params','One explicit local file path is required');
  path=resolve(path);const parents=parentSnapshots(path),before=lstatSync(path);
  requireThat(!before.isSymbolicLink()&&before.isFile(),'invalid_path','Select a regular file, not a symlink or junction');
  requireThat(before.size>=1&&before.size<=PERSONAL_DOCUMENT_MAX_BYTES,'file_too_large','File exceeds 128 KiB or is empty; nothing is truncated');
  const label=documentLabel(basename(path));documentFormat(label);
  const fd=openSync(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));
  try {
    const opened=fstatSync(fd);
    // On platforms without O_NOFOLLOW, matching inode identity is still required BEFORE reading.
    requireThat(opened.isFile()&&sameFile(before,opened),'file_changed','Selected file was replaced before reading');
    requireThat(JSON.stringify(parentSnapshots(path))===JSON.stringify(parents),'file_changed','Parent directory changed');
    requireThat(!lstatSync(path).isSymbolicLink(),'invalid_path','Selected file became a link');
    const buffer=Buffer.alloc(opened.size+1);let n=0;
    while(n<buffer.length){const got=readSync(fd,buffer,n,buffer.length-n,null);if(!got)break;n+=got;}
    requireThat(n===opened.size&&sameFile(opened,fstatSync(fd))&&sameFile(opened,lstatSync(path)),
      'file_changed','File changed during bounded descriptor read');
    requireThat(JSON.stringify(parentSnapshots(path))===JSON.stringify(parents),'file_changed','Parent directory changed');
    const bytes=buffer.subarray(0,n),content=documentContent(bytes);
    return {label,content_base64:bytes.toString('base64'),content_sha256:content.content_sha256,byte_size:n,has_bom:content.has_bom};
  }finally{closeSync(fd);}
}
export function documentImportRequest(input,profile) {
  objectFields(input,['agent_id','event_id','consent','label','content_base64','content_sha256','project_id','byte_size','has_bom']);
  requireThat(profile.allowDocuments===true&&input.consent===true,'capture_disabled','Profile file permission and explicit per-file consent are required');
  personalId(input.agent_id,'agent_id');personalId(input.event_id,'event_id');
  requireThat(!Object.hasOwn(input,'project_id')||input.project_id===(profile.projectId??null),'scope_denied','Project differs from trusted profile');
  const request={agent_id:input.agent_id,event_id:input.event_id,consent:input.consent,label:input.label,
    content_base64:input.content_base64,content_sha256:input.content_sha256,...(profile.projectId?{project_id:profile.projectId}:{})};
  const checked=importDocumentRequest(request);
  requireThat((input.byte_size===undefined||input.byte_size===checked.byte_size)&&(input.has_bom===undefined||input.has_bom===checked.has_bom),'fingerprint_mismatch','Selection metadata disagrees with original bytes');
  return request;
}
export async function deliverDocumentImport(file,profile,{checkIdentity,invoke,signal,authorize=()=>{}}) {
  const request=documentImportRequest(structuredClone(file),profile);
  requireThat(typeof authorize==='function','invalid_params','Synchronous authorization assertion required');
  const allowed=()=>{
    requireThat(!signal?.aborted,'aborted','Document import cancelled');const result=authorize();
    if(result&&typeof result.then==='function'){Promise.resolve(result).catch(()=>{});requireThat(false,'invalid_params','Authorization must be synchronous');}
    requireThat(result!==false,'capture_disabled','Document import authorization declined');
    requireThat(!signal?.aborted,'aborted','Document import cancelled during authorization');
  };
  allowed();await checkIdentity();allowed();
  await ensureOwnedAgent(request.agent_id,profile,{checkIdentity,invoke,assertAuthorized:allowed});
  await checkIdentity();allowed();
  const receipt=await invoke('ultra_personal_document_import',request);
  requireThat(receipt?.source_id===profile.source&&receipt.event_id===request.event_id&&receipt.storage==='stored'&&
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(receipt.document_id??'')&&receipt.content_sha256===request.content_sha256&&
    receipt.agent_id===request.agent_id&&(receipt.project_id??null)===(profile.projectId??null),
    'mcp_contract_changed','Document receipt does not match selection and destination; delivery unconfirmed');
  return receipt;
}
