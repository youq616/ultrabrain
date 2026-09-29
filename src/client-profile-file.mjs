/** Trusted client profiles can launch processes: bind bytes and reject unsafe paths. */
import {lstatSync,realpathSync} from 'node:fs';
import {readLocalFileBytes} from './local-file-read.mjs';
import {resolve,dirname,parse,isAbsolute} from 'node:path';
import {clientProfile} from './client-kit.mjs';
import {requireThat,UltraError} from './core.mjs';
export function readClientProfile(path) {
  requireThat(typeof path==='string'&&isAbsolute(path),'insecure_profile','Absolute profile path required');
  const file=resolve(path);
  for(let dir=dirname(file);dir!==parse(dir).root;dir=dirname(dir)) {
    const st=lstatSync(dir);
    requireThat(st.isDirectory()&&!st.isSymbolicLink(),'insecure_profile','Symlinked profile parent');
  }
  const bytes=readLocalFileBytes(file,'profile');
  let input;
  try {input=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
  catch {throw new UltraError('invalid_profile','Profile must contain valid UTF-8 JSON');}
  return {input,profile:clientProfile(input)};
}
export function matchingWorkspace(profile,value) {
  requireThat(typeof profile.workspace==='string'&&isAbsolute(profile.workspace)&&typeof value==='string'&&isAbsolute(value),
    'workspace_mismatch','Explicit workspace binding required');
  const norm=p=>{const result=realpathSync(p);return process.platform==='win32'?result.toLowerCase():result;};
  requireThat(norm(profile.workspace)===norm(value),'workspace_mismatch','Workspace differs from trusted profile');
}

/** A long-lived proxy never adopts new permissions/destinations in place.
 * Latch an OBSERVED change or read failure until restart. This does not watch for
 * transient edits restored between checks or isolate malicious same-UID code.
 */
export function clientProfileAuthorization(path,expectedInput) {
  const expected=JSON.stringify(expectedInput);let revoked=false;
  return ()=>{
    if(!revoked) {
      try{revoked=JSON.stringify(readClientProfile(path).input)!==expected;}
      catch{revoked=true;}
    }
    requireThat(!revoked,'client_authorization_revoked','Trusted profile changed or is unavailable; restart the client');
  };
}
