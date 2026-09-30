/** Separate implementer review, NOT a second-agent approval or Windows test. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtempSync, readdirSync, rmSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {captureWorkerBatch} from './helpers/capture-worker-batch.mjs';
import {controlWorkerReport} from './helpers/capture-control-report.mjs';
const preload = new URL('./fixtures/capture-worker-audit-preload.mjs', import.meta.url).href;
for (const script of ['check-capture-contention.mjs', 'check-capture-delivery-control.mjs']) {
  for (const mode of ['second-setup', 'workspace-setup']) test('worker audit: setup failures retain prior rounds and clean owned scratch: ' + script + ' ' + mode, t => {
    const scratch = mkdtempSync(join(tmpdir(), 'ub-worker-audit-'));
    t.after(() => rmSync(scratch, {recursive: true, force: true}));
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/' + script, import.meta.url)), '--rounds', '2'], {
      encoding: 'utf8', timeout: 22000, maxBuffer: 65536,
      env: {...process.env, TMPDIR: scratch, TEMP: scratch, TMP: scratch, NODE_OPTIONS: '--import ' + preload, ULTRABRAIN_WORKER_AUDIT: mode}
    });
    assert.ifError(child.error); assert.equal(child.status, 1); assert.equal(child.stderr, ''); assert.ok(!child.stdout.includes('PRIVATE'));
    const report = JSON.parse(child.stdout); assert.equal(report.passed, false);
    assert.equal(report.rounds.length, mode === 'second-setup' ? 2 : 1);
    if (mode === 'second-setup') assert.equal(report.rounds[0].passed, true);
    const failed = report.rounds.at(-1); assert.equal(failed.passed, false); assert.equal(failed.stage, 'setup');
    assert.equal(failed.error.native_code, mode === 'second-setup' ? 'EACCES' : 'ENOSPC'); assert.deepEqual(failed.outcomes, []);
    assert.deepEqual(readdirSync(scratch), []);
  });
}
class Child extends EventEmitter {
  constructor() { super(); this.stdout = new PassThrough(); this.stderr = new PassThrough(); this.connected = true; this.pid = 1234; this.sends = 0; this.kills = 0; }
  send(_message, callback) { this.sends++; callback(null); return true; }
  finish() { this.emit('exit', 0, null); this.emit('close', 0, null); }
  kill() { this.kills++; queueMicrotask(() => this.finish()); return true; }
  unref() {}
  disconnect() { this.connected = false; this.emit('disconnect'); }
}
function scope(t, options = {}) {
  const child = new Child();
  const batch = captureWorkerBatch({count: 1, parseReport: controlWorkerReport, spawnWorker: () => child, ...options});
  t.after(() => batch.shutdown()); return {child, batch};
}
test('worker audit: delayed timer cannot authorize dispatch after monotonic deadline', async t => {
  const {child, batch} = scope(t, {timeoutMs: 15}); child.emit('message', {ready: true}); await batch.ready();
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
  assert.throws(() => batch.start(() => ({}))); assert.equal(child.sends, 0);
  const result = await batch.shutdown(); assert.equal(result.timed_out, true); assert.equal(result.outcomes[0].valid, false);
});
test('worker audit: missing IPC callback acknowledgement cannot produce a passing report', async t => {
  const {child, batch} = scope(t); child.send = () => true;
  child.emit('message', {ready: true}); await batch.ready(); batch.start(() => ({}));
  child.stdout.write('{"ok":true,"outcome":"resumed"}'); child.finish();
  const result = await batch.outcomes(); assert.equal(result[0].valid, false);
});
test('worker audit: failed termination is not close evidence and shutdown stays bounded', async t => {
  const {child, batch} = scope(t); child.kill = () => { child.kills++; return false; };
  const result = await batch.shutdown();
  assert.equal(result.all_closed, false); assert.equal(result.outcomes[0].lifecycle.closed, false);
  assert.equal(result.outcomes[0].lifecycle.termination_unconfirmed, true); assert.equal(child.kills, 1);
});
test('worker audit: runtime, journal, CLI package and existing native scripts are not replaced by this supervisor', () => {
  const source = readFileSync(new URL('./helpers/capture-worker-batch.mjs', import.meta.url), 'utf8');
  for (const unwanted of ['capture-outbox.mjs', 'node:fs', 'node:http', 'node:https', 'node:net', 'child_process']) assert.ok(!source.includes(unwanted));
  for (const script of ['check-capture-contention.mjs', 'check-capture-delivery-control.mjs']) {
    const text = readFileSync(new URL('../scripts/' + script, import.meta.url), 'utf8');
    assert.ok(text.includes('captureWorkerBatch')); assert.ok(text.includes('if(!closed.all_closed)'));
    assert.ok(text.includes('cleanup_skipped:true')); assert.ok(text.includes("command:'never-executed'"));
  }
});
