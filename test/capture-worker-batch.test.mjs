/** Deterministic event-order tests; these doubles are NOT native-process tests. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {captureWorkerBatch} from './helpers/capture-worker-batch.mjs';
import {controlWorkerReport} from './helpers/capture-control-report.mjs';
import {contentionWorkerReport} from './helpers/capture-contention-report.mjs';
class Child extends EventEmitter {
  constructor() { super(); this.stdout = new PassThrough(); this.stderr = new PassThrough(); this.connected = true; this.pid = 1234; this.sends = []; this.kills = 0; }
  send(message, callback) { this.sends.push(message); callback(null); return true; }
  kill(signal) { this.kills++; queueMicrotask(() => this.finish(null, signal)); return true; }
  finish(exit = 0, signal = null) { this.connected = false; this.emit('exit', exit, signal); this.emit('close', exit, signal); }
  unref() {}
  disconnect() { this.connected = false; this.emit('disconnect'); }
}
function setup(t, {staged = false, count = 1, ...rest} = {}) {
  const children = Array.from({length: count}, () => new Child());
  const batch = captureWorkerBatch({staged, count, parseReport: controlWorkerReport, spawnWorker: i => children[i], ...rest});
  t.after(() => batch.shutdown()); return {batch, children, child: children[0]};
}
async function start(batch, children) {
  for (const child of children) child.emit('message', {ready: true});
  await batch.ready(); batch.start(worker => ({worker}));
}
function report(child, extra = '') { child.stdout.write('{"ok":true,"outcome":"resumed"}' + extra); }
test('worker batch: requires final dispatch AND close, not just ready/exit', async t => {
  const {batch, children, child} = setup(t); await start(batch, children); report(child);
  let complete = false; const result = batch.outcomes().then(r => { complete = true; return r; });
  child.emit('exit', 0, null); await new Promise(setImmediate); assert.equal(complete, false);
  child.emit('close', 0, null); const outcomes = await result;
  assert.equal(outcomes[0].valid, true); assert.equal(outcomes[0].lifecycle.closed, true);
  assert.equal(child.kills, 0); assert.equal((await batch.shutdown()).all_closed, true);
});
test('worker batch: control staged barrier must follow a start dispatch', async t => {
  const {batch, child, children} = setup(t, {staged: true}); await start(batch, children);
  child.emit('message', {staged: true}); await batch.staged(); batch.resume(() => ({expectedHash: 'synthetic'}));
  report(child); child.finish(); const [outcome] = await batch.outcomes();
  assert.equal(outcome.valid, true); assert.equal(outcome.lifecycle.staged, true); assert.equal(child.sends.length, 2);
});
for (const message of [{staged: true}, {ready: false}, {ready: true, secret: 'PRIVATE'}, [], null, 'PRIVATE'])
  test('worker batch: rejects unexpected startup IPC ' + JSON.stringify(message), async t => {
    const {batch, child} = setup(t); child.emit('message', message);
    await assert.rejects(batch.ready(), /worker_unavailable/);
    const result = await batch.shutdown(); assert.equal(result.outcomes[0].lifecycle.issue, 'unexpected_message');
    assert.ok(!JSON.stringify(result).includes('PRIVATE')); assert.equal(child.kills, 1);
  });
test('worker batch: duplicate ready acknowledgement is not reusable', async t => {
  const {batch, child} = setup(t); child.emit('message', {ready: true}); child.emit('message', {ready: true});
  await assert.rejects(batch.ready()); assert.throws(() => batch.start(() => ({}))); assert.equal(child.sends.length, 0);
});
test('worker batch: close before start cannot turn a success JSON into a passed worker', async t => {
  const {batch, child} = setup(t); report(child); child.finish(); await assert.rejects(batch.ready());
  const {outcomes} = await batch.shutdown(); assert.equal(outcomes[0].valid, false); assert.equal(outcomes[0].result.ok, true);
});
test('worker batch: resume before enqueue acknowledgement is refused without a send', async t => {
  const {batch, child} = setup(t, {staged: true}); child.emit('message', {ready: true}); await batch.ready();
  assert.throws(() => batch.resume(() => ({}))); assert.equal(child.sends.length, 0);
});
test('worker batch: whole-group dispatch is prepared before any send', async t => {
  const {batch, children} = setup(t, {count: 3});
  children.forEach(c => c.emit('message', {ready: true})); await batch.ready();
  assert.throws(() => batch.start(i => { if (i === 1) throw Error('PRIVATE'); return {}; }));
  assert.ok(children.every(c => c.sends.length === 0));
});
for (const variant of ['throw', 'callback']) test('worker batch: IPC failure never retries ' + variant, async t => {
  const {batch, children, child} = setup(t); let sends = 0;
  child.send = (_m, cb) => { sends++; if (variant === 'throw') throw Error('PRIVATE'); cb(Error('PRIVATE')); return false; };
  child.emit('message', {ready: true}); await batch.ready();
  try { batch.start(() => ({})); } catch {}
  await assert.rejects(batch.outcomes()); const r = await batch.shutdown();
  assert.equal(r.outcomes[0].lifecycle.issue, 'ipc_send_failed'); assert.equal(sends, 1); assert.equal(child.kills, 1);
  assert.ok(!JSON.stringify(r).includes('PRIVATE'));
});
test('worker batch: backpressure false with successful callback is allowed', async t => {
  const {batch, child, children} = setup(t);
  child.send = (_m, cb) => { cb(null); return false; };
  await start(batch, children); report(child); child.finish(); assert.equal((await batch.outcomes())[0].valid, true);
});
for (const bytes of [Buffer.from('PRIVATE'), Buffer.from('{"ok":true,"outcome":"resumed"}\n{}'), Buffer.from([0xff, 0xfe])])
  test('worker batch: malformed/extra/invalid UTF-8 report cannot pass', async t => {
    const {batch, child, children} = setup(t); await start(batch, children); child.stdout.write(bytes); child.finish();
    const [r] = await batch.outcomes(); assert.equal(r.valid, false); assert.deepEqual(r.result, {ok: false, code: 'invalid_worker_report'});
  });
test('worker batch: bounded UTF-8 chunks are joined without per-chunk replacement', async t => {
  const {batch, child, children} = setup(t); await start(batch, children);
  const bytes = Buffer.from('{"ok":true,"outcome":"resumed","ignored":"中"}');
  for (const byte of bytes) child.stdout.write(Buffer.from([byte])); child.finish();
  const [r] = await batch.outcomes(); assert.equal(r.valid, true); assert.ok(!JSON.stringify(r).includes('中'));
});
for (const size of [4096, 4097]) test('worker batch: exact output byte bound ' + size, async t => {
  const {batch, child, children} = setup(t); await start(batch, children);
  const json = '{"ok":true,"outcome":"resumed"}'; child.stdout.write(json + ' '.repeat(size - Buffer.byteLength(json)));
  if (size === 4096) { child.finish(); assert.equal((await batch.outcomes())[0].valid, true); }
  else { await assert.rejects(batch.outcomes()); const r = await batch.shutdown(); assert.equal(r.outcomes[0].output_truncated, true); }
});
for (const stream of ['stdout', 'stderr']) test('worker batch: pipe failure is bounded and private ' + stream, async t => {
  const {batch, child} = setup(t); child[stream].emit('error', Error('PRIVATE_PIPE'));
  await assert.rejects(batch.ready()); const r = await batch.shutdown(); assert.equal(r.outcomes[0].lifecycle.issue, 'pipe_failed');
  assert.ok(!JSON.stringify(r).includes('PRIVATE'));
});
test('worker batch: stderr invalidates otherwise valid success report', async t => {
  const {batch, child, children} = setup(t); await start(batch, children); report(child); child.stderr.write('PRIVATE');
  await assert.rejects(batch.outcomes()); const r = await batch.shutdown(); assert.equal(r.outcomes[0].valid, false); assert.equal(r.outcomes[0].stderr_seen, true);
});
test('worker batch: unknown signal is withheld, never normalized into success', async t => {
  const {batch, child, children} = setup(t); await start(batch, children); report(child); child.finish(0, 'PRIVATE_SIGNAL');
  await assert.rejects(batch.outcomes()); const r = await batch.shutdown(); assert.equal(r.outcomes[0].signal, null); assert.equal(r.outcomes[0].valid, false);
});
test('worker batch: authentic failure drains after disconnect and exit before close', async t => {
  const {batch, child, children} = setup(t, {staged: true}); await start(batch, children);
  child.disconnect(); await assert.rejects(batch.staged());
  const closing = batch.shutdown(); child.stdout.write('{"ok":false,"code":"outbox_lock_io","lock":{"kind":"queue","phase":"create","system_code":"EPERM"}}');
  child.finish(1, null); const r = await closing;
  assert.equal(r.outcomes[0].result.lock.system_code, 'EPERM'); assert.equal(r.outcomes[0].valid, false); assert.equal(child.kills, 0);
});
test('worker batch: deadline and idempotent shutdown terminate every active worker once', async t => {
  const {batch, children} = setup(t, {count: 3, timeoutMs: 20}); await assert.rejects(batch.ready());
  const p = batch.shutdown(); assert.equal(batch.shutdown(), p); const r = await p;
  assert.equal(r.timed_out, true); assert.equal(r.all_closed, true); assert.ok(children.every(c => c.kills === 1));
});
test('worker batch: synchronous partial spawn failure still supervises earlier children', async t => {
  const children = [new Child(), new Child()];
  const batch = captureWorkerBatch({count: 3, parseReport: controlWorkerReport, spawnWorker: i => { if (i === 1) throw Error('PRIVATE'); return children[i === 0 ? 0 : 1]; }});
  t.after(() => batch.shutdown()); await assert.rejects(batch.ready()); const r = await batch.shutdown();
  assert.equal(r.outcomes.length, 3); assert.equal(r.outcomes[1].lifecycle.issue, 'spawn_failed'); assert.ok(children.every(c => c.kills === 1));
});
for (const patch of [{count: 0}, {count: 9}, {count: 1.2}, {timeoutMs: 0}, {timeoutMs: 15001}, {staged: 'true'}, {spawnWorker: null}, {parseReport: null}])
  test('worker batch: reject invalid configuration before spawning', () => {
    let called = 0;
    assert.throws(() => captureWorkerBatch({count: 1, spawnWorker: () => { called++; }, parseReport: controlWorkerReport, ...patch}));
    assert.equal(called, 0);
  });
for (const bad of ['PRIVATE', 'null', '[]', '{}', ' '.repeat(4097),
  JSON.stringify({ok: true, busy_retries: 0, replays: 2}), JSON.stringify({ok: true, busy_retries: 22, replays: 0}),
  JSON.stringify({ok: true, busy_retries: 0.5, replays: 0}), JSON.stringify({ok: true, busy_retries: -1, replays: 0})])
  test('worker report: reject invalid shape or counter bounds', () => {
    assert.deepEqual(contentionWorkerReport(bad), {ok: false, code: 'invalid_worker_report'});
  });
test('worker report: all success and failure fields are projected, not echoed', () => {
  assert.deepEqual(contentionWorkerReport('{"ok":true,"busy_retries":21,"replays":1,"path":"PRIVATE"}'), {ok: true, busy_retries: 21, replays: 1});
  const report = contentionWorkerReport(JSON.stringify({ok: false, busy_retries: 0, code: 'outbox_lock_io', path: 'PRIVATE', message: 'PRIVATE',
    lock: {kind: 'queue', phase: 'verify-release', file_read: {kind: 'outbox', phase: 'anchor-open', reason: 'io', system_code: 'EPERM', close_failed: false, path: 'PRIVATE'}}}));
  assert.equal(report.lock.file_read.phase, 'anchor-open'); assert.ok(!JSON.stringify(report).includes('PRIVATE'));
});
