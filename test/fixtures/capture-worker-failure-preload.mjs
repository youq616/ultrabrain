/** Synthetic checker fault injection only. Never imported by client bundles. */
import fs from 'node:fs';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
const mode = process.env.ULTRABRAIN_WORKER_CHECK_TEST;
const entry = process.argv[1] ?? '';
const checker = entry.endsWith('check-capture-contention.mjs');
const worker = entry.endsWith('capture-contention-worker.mjs');
if (checker && ['spawn-throw', 'spawn-enoent', 'send-error', 'backpressure'].includes(mode)) {
  const spawn = cp.spawn; let index = 0;
  cp.spawn = (...args) => {
    const selected = index++ === 3;
    if (selected && mode === 'spawn-throw') throw Error('PRIVATE_SPAWN');
    if (selected && mode === 'spawn-enoent') args[0] = 'NEVER_EXISTS_SYNTHETIC_WORKER';
    const child = spawn(...args);
    if (selected && mode === 'send-error') child.send = (_m, callback) => {
      queueMicrotask(() => callback(Error('PRIVATE_SEND'))); return false;
    };
    if (mode === 'backpressure') {
      const send = child.send;
      child.send = function(...a) { send.apply(this, a); return false; };
    }
    return child;
  };
  syncBuiltinESMExports();
}
if (checker && mode === 'timeout') {
  const timer = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...args) => timer(fn, ms === 15000 ? 500 : ms, ...args);
}
if (worker) {
  if (mode === 'early-exit') await new Promise(() => process.stdout.write('PRIVATE_INVALID', () => process.exit(73)));
  if (mode === 'overflow') await new Promise(() => process.stdout.write('PRIVATE'.repeat(2000), () => process.exit(73)));
  if (mode === 'stderr') await new Promise(() => process.stderr.write('PRIVATE_STDERR', () => setInterval(() => {}, 1000)));
  if (mode === 'timeout') await new Promise(() => setInterval(() => {}, 1000));
  if (mode === 'premature-staged') await new Promise(() => {
    process.send({staged: true}); setInterval(() => {}, 1000);
  });
  if (mode === 'disconnect') await new Promise(() => {
    process.disconnect(); setInterval(() => {}, 1000);
  });
  if (mode === 'report-extra') {
    let selected = false;
    process.prependListener('message', m => { selected = m?.worker === 4; });
    const open = fs.openSync;
    fs.openSync = (...a) => {
      if (selected && typeof a[0] === 'string' && a[0].endsWith('.queue.lock'))
        throw Object.assign(Error('PRIVATE_NATIVE'), {code: 'EPERM', path: 'PRIVATE_PATH'});
      return open(...a);
    };
    const write = process.stdout.write;
    process.stdout.write = function(chunk, ...rest) {
      let r; try { r = JSON.parse(chunk); } catch {}
      if (r && typeof r === 'object') chunk = JSON.stringify({...r, secret: 'PRIVATE_REPORT', path: 'PRIVATE_PATH'}) + '\n';
      return write.call(this, chunk, ...rest);
    };
    syncBuiltinESMExports();
  }
}
