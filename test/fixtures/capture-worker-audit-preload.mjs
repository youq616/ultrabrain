/** Implementation-assistant audit: deliberate setup faults in SYNTHETIC CLIs. */
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const entry = process.argv[1] ?? '';
if (entry.endsWith('check-capture-contention.mjs') || entry.endsWith('check-capture-delivery-control.mjs')) {
  const mode = process.env.ULTRABRAIN_WORKER_AUDIT;
  if (mode === 'second-setup') {
    const temp = fs.mkdtempSync; let count = 0;
    fs.mkdtempSync = (...a) => { if (++count === 2) throw Object.assign(Error('PRIVATE_SETUP'), {code: 'EACCES'}); return temp(...a); };
  }
  if (mode === 'workspace-setup') {
    const mkdir = fs.mkdirSync;
    fs.mkdirSync = (path, ...a) => {
      if (typeof path === 'string' && /[/\\]work$/.test(path)) throw Object.assign(Error('PRIVATE_WORKSPACE'), {code: 'ENOSPC'});
      return mkdir(path, ...a);
    };
  }
  syncBuiltinESMExports();
}
