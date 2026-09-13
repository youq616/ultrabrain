/** Trusted client profiles can launch processes: bind bytes and reject unsafe paths. */
import {constants,openSync,closeSync,fstatSync,lstatSync,readFileSync,realpathSync} from 'node:fs';
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
  const before=lstatSync(file);
  requireThat(before.isFile()&&!before.isSymbolicLink(),'insecure_profile','Profile must be a regular file');
  let fd;
  try {
    fd=openSync(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
    const st=fstatSync(fd);
    requireThat(st.isFile()&&st.dev===before.dev&&st.ino===before.ino&&st.size<=16384,'insecure_profile','Profile changed or exceeds size limit');
    if(typeof process.getuid==='function')requireThat(st.uid===process.getuid()&&!(st.mode&0o022),'insecure_profile','Profile must be owned and not writable by others');
    const bytes=readFileSync(fd);
    const after=fstatSync(fd);
    requireThat(bytes.length<=16384&&after.size===st.size&&after.mtimeMs===st.mtimeMs&&after.ctimeMs===st.ctimeMs,'insecure_profile','Profile changed during read');
    let input;
    try {input=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
    catch {throw new UltraError('invalid_profile','Profile must contain valid UTF-8 JSON');}
    return {input,profile:clientProfile(input)};
  } finally {if(fd!==undefined)closeSync(fd);}
}
export function matchingWorkspace(profile,value) {
  requireThat(typeof profile.workspace==='string'&&isAbsolute(profile.workspace)&&typeof value==='string'&&isAbsolute(value),
    'workspace_mismatch','Explicit workspace binding required');
  const norm=p=>{const result=realpathSync(p);return process.platform==='win32'?result.toLowerCase():result;};
  requireThat(norm(profile.workspace)===norm(value),'workspace_mismatch','Workspace differs from trusted profile');
}
