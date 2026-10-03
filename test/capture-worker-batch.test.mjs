/** Deterministic event-order tests; these doubles are NOT native-process tests. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {readFileSync} from 'node:fs';
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


// These opt-in tests use only the deterministic Child double above. They do
// not spawn the contention fixture or establish native-process timing parity.
const progressFrame = (sequence = 1, event = 0, attempt = 1, phase = 0, outcome = 0) =>
  ({contention_progress: [1, sequence, event, attempt, phase, outcome]});
function completeProgress(child) {
  for (const frame of [progressFrame(), progressFrame(2, 0, 1, 1, 1),
    progressFrame(3, 1), progressFrame(4, 1, 1, 1, 2),
    progressFrame(5, 2), progressFrame(6, 2, 1, 1, 1)]) child.emit('message', frame);
}
function assertFrozenProgress(summary) {
  assert.equal(Object.isFrozen(summary), true);
  assert.equal(Object.isFrozen(summary.slots), true);
  assert.equal(summary.slots.length, 8);
  for (const slot of summary.slots) {
    assert.equal(Object.isFrozen(slot), true);
    if (slot.last) assert.equal(Object.isFrozen(slot.last), true);
  }
  assert.ok(Buffer.byteLength(JSON.stringify(summary)) <= 2048);
}
for (const options of [{}, {contentionProgress: false}])
  test('worker batch double: progress is strictly opt-out by default ' + JSON.stringify(options), async t => {
    const {batch, child, children} = setup(t, options); await start(batch, children);
    child.emit('message', progressFrame());
    await assert.rejects(batch.outcomes(), /worker_unavailable/);
    const r = await batch.shutdown();
    assert.equal(r.outcomes[0].lifecycle.issue, 'unexpected_message');
    assert.equal(r.outcomes[0].valid, false);
    assert.equal(Object.hasOwn(r.outcomes[0], 'progress_transport'), false);
    assert.equal(batch.freezeProgress(), undefined);
  });
for (const patch of [
  {contentionProgress: 'true'}, {contentionProgress: 1}, {contentionProgress: null},
  {contentionProgress: []}, {contentionProgress: {}}, {contentionProgress: true, staged: true}
]) test('worker batch double: progress option is a boolean and excludes staged mode ' + JSON.stringify(patch), () => {
  let spawned = 0;
  assert.throws(() => captureWorkerBatch({spawnWorker: () => { spawned++; return new Child(); },
    parseReport: controlWorkerReport, ...patch}), /invalid_worker_batch/);
  assert.equal(spawned, 0);
});
for (const readySeen of [false, true])
  test('worker batch double: progress cannot replace ready or precede start, ready=' + readySeen, async t => {
    const {batch, child} = setup(t, {contentionProgress: true});
    if (readySeen) { child.emit('message', {ready: true}); await batch.ready(); }
    child.emit('message', progressFrame());
    await assert.rejects(batch.ready(), /worker_unavailable/);
    assert.throws(() => batch.start(() => ({})), /worker_unavailable/);
    const r = await batch.shutdown();
    assert.equal(r.outcomes[0].lifecycle.ready, readySeen);
    assert.equal(r.outcomes[0].lifecycle.issue, 'unexpected_message');
    assert.equal(child.sends.length, 0);
    const snapshot = batch.freezeProgress();
    assert.equal(snapshot.cutoff, 'first_failure');
    assert.ok(snapshot.slots.every(slot => slot.received === 0 && slot.last === null));
  });
test('worker batch double: opt-out progress cannot replace a staged acknowledgement', async t => {
  const {batch, child, children} = setup(t, {staged: true}); await start(batch, children);
  child.emit('message', progressFrame()); await assert.rejects(batch.staged(), /worker_unavailable/);
  const r = await batch.shutdown();
  assert.equal(r.outcomes[0].lifecycle.staged, false);
  assert.equal(r.outcomes[0].lifecycle.issue, 'unexpected_message');
  assert.equal(child.sends.length, 1);
});
const malformedProgress = [
  ['extra envelope field', {...progressFrame(), private: 'PRIVATE'}],
  ['wrong envelope key', {progress: [1, 1, 0, 1, 0, 0]}],
  ['array envelope', [[1, 1, 0, 1, 0, 0]]],
  ['null tuple', {contention_progress: null}],
  ['short tuple', {contention_progress: [1, 1, 0, 1, 0]}],
  ['long tuple', {contention_progress: [1, 1, 0, 1, 0, 0, 0]}],
  ['wrong version', {contention_progress: [2, 1, 0, 1, 0, 0]}],
  ['zero sequence', progressFrame(0)], ['over-limit sequence', progressFrame(49)],
  ['fractional sequence', progressFrame(1.5)], ['string sequence', progressFrame('1')],
  ['out-of-range event', progressFrame(1, 3)], ['zero attempt', progressFrame(1, 0, 0)],
  ['over-limit attempt', progressFrame(1, 0, 9)], ['invalid phase', progressFrame(1, 0, 1, 2)],
  ['before with outcome', progressFrame(1, 0, 1, 0, 1)],
  ['settled without outcome', progressFrame(2, 0, 1, 1, 0)],
  ['replay outside shared event', progressFrame(2, 0, 1, 1, 2)],
  ['even before sequence', progressFrame(2)], ['odd settled sequence', progressFrame(1, 0, 1, 1, 1)],
  ['impossible first event history', progressFrame(1, 1)],
  ['impossible first attempt history', progressFrame(1, 0, 2)],
  ['duplicate ready remains invalid', {ready: true}], ['staged ack remains invalid', {staged: true}]
];
for (const [name, message] of malformedProgress)
  test('worker batch double: invalid opt-in IPC takes original unexpected_message path: ' + name, async t => {
    const {batch, child, children} = setup(t, {contentionProgress: true}); await start(batch, children);
    child.emit('message', message); await assert.rejects(batch.outcomes(), /worker_unavailable/);
    const r = await batch.shutdown();
    assert.equal(r.outcomes[0].lifecycle.issue, 'unexpected_message');
    assert.equal(r.outcomes[0].valid, false);
    assert.equal(batch.freezeProgress().slots[0].received, 0);
    assert.equal(child.kills, 1);
    assert.ok(!JSON.stringify({...r, progress: batch.freezeProgress()}).includes('PRIVATE'));
  });
const impossibleSubsequences = [
  ['duplicate', progressFrame(), progressFrame()],
  ['sequence regression', progressFrame(3, 0, 2), progressFrame()],
  ['event regression', progressFrame(3, 1), progressFrame(5, 0, 3)],
  ['completed earlier attempts change within event', progressFrame(3, 1), progressFrame(7, 1, 2)],
  ['after same-event acceptance', progressFrame(2, 0, 1, 1, 1), progressFrame(3, 0, 2)],
  ['after terminal error', progressFrame(2, 0, 1, 1, 4), progressFrame(3, 1)],
  ['after exhausted busy attempt', progressFrame(16, 0, 8, 1, 3), progressFrame(17, 1)],
  ['after final-event success', progressFrame(6, 2, 1, 1, 1), progressFrame(7, 2, 2)],
  ['busy cannot advance immediately to next event', progressFrame(2, 0, 1, 1, 3), progressFrame(3, 1)],
  ['accepted attempt cannot invent another omitted attempt', progressFrame(2, 0, 1, 1, 1), progressFrame(5, 1)],
  ['event transition exceeds remaining attempts', progressFrame(3, 1), progressFrame(23, 2)]
];
for (const [name, first, second] of impossibleSubsequences)
  test('worker batch double: impossible received subsequence fails exactly unexpected_message: ' + name, async t => {
    const {batch, child, children} = setup(t, {contentionProgress: true}); await start(batch, children);
    child.emit('message', first); child.emit('message', second);
    await assert.rejects(batch.outcomes(), /worker_unavailable/); const r = await batch.shutdown();
    assert.equal(r.outcomes[0].lifecycle.issue, 'unexpected_message');
    const slot = batch.freezeProgress().slots[0];
    assert.equal(slot.received, 1); assert.deepEqual(slot.last, first.contention_progress);
  });
test('worker batch double: valid gaps and settled-without-before are best-effort observations only', async t => {
  const {batch, child, children} = setup(t, {contentionProgress: true}); await start(batch, children);
  child.emit('message', progressFrame(2, 0, 1, 1, 3));
  child.emit('message', progressFrame(5, 1));
  child.emit('message', progressFrame(8, 2, 1, 1, 1));
  report(child); child.finish(); const [r] = await batch.outcomes();
  assert.equal(r.valid, true); assert.equal(r.lifecycle.issue, null);
  assert.deepEqual(batch.freezeProgress().slots[0],
    {worker: 0, received: 3, gap: true, last: [1, 8, 2, 1, 1, 1], receipt: 3});
  assert.deepEqual(r.progress_transport, {status: 'unavailable'});
});
test('worker batch double: full progress never consumes a parent final-send callback', async t => {
  const {batch, child, children} = setup(t, {contentionProgress: true}); let callback;
  child.send = (message, cb) => { child.sends.push(message); callback = cb; return true; };
  await start(batch, children); completeProgress(child); report(child); child.finish();
  const [r] = await batch.outcomes();
  assert.equal(r.valid, false); assert.equal(r.lifecycle.issue, null);
  assert.equal(r.lifecycle.send_callbacks_pending, 1);
  const snapshot = batch.freezeProgress(); assert.equal(snapshot.cutoff, 'failed_outcomes');
  callback(null); callback(Error('PRIVATE_LATE_DUPLICATE'));
  const closed = await batch.shutdown();
  assert.equal(closed.outcomes[0].lifecycle.send_callbacks_pending, 0);
  assert.equal(closed.outcomes[0].lifecycle.issue, null);
  assert.equal(batch.freezeProgress(), snapshot);
});
test('worker batch double: valid progress cannot hide a final-send callback failure', async t => {
  const {batch, child, children} = setup(t, {contentionProgress: true}); let callback;
  child.send = (_message, cb) => { callback = cb; return true; };
  await start(batch, children); completeProgress(child); callback(Error('PRIVATE_SEND'));
  await assert.rejects(batch.outcomes(), /worker_unavailable/); const r = await batch.shutdown();
  assert.equal(r.outcomes[0].lifecycle.issue, 'ipc_send_failed');
  assert.equal(r.outcomes[0].lifecycle.send_callbacks_pending, 0);
  assert.equal(batch.freezeProgress().cutoff, 'first_failure');
  assert.ok(!JSON.stringify(r).includes('PRIVATE'));
});
for (const [name, output, exit, signal, expectedIssue] of [
  ['missing stdout', '', 0, null, null], ['invalid stdout', 'PRIVATE', 0, null, null],
  ['nonzero exit', '{"ok":true,"outcome":"resumed"}', 1, null, 'worker_exit_failed'],
  ['signal', '{"ok":true,"outcome":"resumed"}', null, 'SIGKILL', 'worker_exit_failed']
]) test('worker batch double: full progress cannot rescue ' + name, async t => {
  const {batch, child, children} = setup(t, {contentionProgress: true}); await start(batch, children);
  completeProgress(child); child.stdout.write(output); child.finish(exit, signal);
  if (expectedIssue) await assert.rejects(batch.outcomes(), /worker_unavailable/);
  else assert.equal((await batch.outcomes())[0].valid, false);
  const r = await batch.shutdown();
  assert.equal(r.outcomes[0].valid, false); assert.equal(r.outcomes[0].lifecycle.issue, expectedIssue);
  assert.ok(!JSON.stringify(r).includes('PRIVATE'));
});
for (const [stream, output, issue] of [
  ['stderr', 'PRIVATE', 'stderr_output'], ['stdout', ' '.repeat(4097), 'output_overflow']
]) test('worker batch double: full progress cannot rescue ' + issue, async t => {
  const {batch, child, children} = setup(t, {contentionProgress: true}); await start(batch, children);
  completeProgress(child); child[stream].write(output);
  await assert.rejects(batch.outcomes(), /worker_unavailable/); const r = await batch.shutdown();
  assert.equal(r.outcomes[0].valid, false); assert.equal(r.outcomes[0].lifecycle.issue, issue);
  assert.equal(batch.freezeProgress().slots[0].received, 6);
});
test('worker batch double: full progress and stdout still wait for close after exit', async t => {
  const {batch, child, children} = setup(t, {contentionProgress: true}); await start(batch, children);
  completeProgress(child); report(child);
  let done = false; const pending = batch.outcomes().then(r => { done = true; return r; });
  await new Promise(setImmediate); assert.equal(done, false);
  child.emit('exit', 0, null); await new Promise(setImmediate); assert.equal(done, false);
  child.emit('close', 0, null); assert.equal((await pending)[0].valid, true);
});
test('worker batch double: full progress and close cannot manufacture exit evidence', async t => {
  const {batch, child, children} = setup(t, {contentionProgress: true}); await start(batch, children);
  completeProgress(child); report(child); child.emit('close', 0, null);
  const [r] = await batch.outcomes(); assert.equal(r.valid, false);
  assert.equal(r.lifecycle.closed, true); assert.equal(r.lifecycle.issue, null);
});
test('worker batch double: first failure freezes all eight slots before synchronous stop effects', async t => {
  const {batch, children} = setup(t, {count: 8, contentionProgress: true}); await start(batch, children);
  for (const child of children) child.emit('message', progressFrame());
  let atKill;
  children[3].kill = signal => {
    children[3].kills++;
    atKill = batch.freezeProgress();
    // A valid tail on a different, still-running slot is emitted synchronously
    // inside the original stop path. The cutoff must already have happened.
    children[7].emit('message', progressFrame(2, 0, 1, 1, 3));
    children[3].finish(null, signal); return true;
  };
  children[3].emit('message', progressFrame(0));
  await assert.rejects(batch.outcomes(), /worker_unavailable/);
  const snapshot = batch.freezeProgress(); assert.equal(snapshot, atKill);
  assert.equal(snapshot.cutoff, 'first_failure'); assert.equal(snapshot.best_effort, true);
  assert.equal(snapshot.version, 1); assertFrozenProgress(snapshot);
  assert.deepEqual(snapshot.slots, Array.from({length: 8}, (_, worker) => ({
    worker, received: 1, gap: false, last: [1, 1, 0, 1, 0, 0], receipt: worker + 1
  })));
  const serialized = JSON.stringify(snapshot);
  children[6].emit('message', progressFrame(3, 0, 2));
  children[3].stderr.write('PRIVATE_SECOND_FAILURE');
  assert.throws(() => { snapshot.slots[7].received = 99; }, TypeError);
  assert.throws(() => { snapshot.slots[7].last[1] = 48; }, TypeError);
  assert.throws(() => snapshot.slots.push({}), TypeError);
  const r = await batch.shutdown();
  assert.equal(r.outcomes[3].lifecycle.issue, 'unexpected_message');
  assert.equal(batch.freezeProgress(), snapshot); assert.equal(JSON.stringify(snapshot), serialized);
  assert.ok(children.every(child => child.kills === 1));
});
for (const duplicate of [false, true])
  test('worker batch double: post-cutoff peer ' + (duplicate ? 'duplicate' : 'malformed frame') + ' still fails unexpected_message without changing the snapshot', async t => {
    const {batch, children} = setup(t, {count: 2, contentionProgress: true}); await start(batch, children);
    children[0].emit('message', progressFrame()); children[1].emit('message', progressFrame());
    children[0].stderr.write('PRIVATE_FIRST_FAILURE');
    await assert.rejects(batch.outcomes(), /worker_unavailable/);
    const snapshot = batch.freezeProgress(); const serialized = JSON.stringify(snapshot);
    // This peer has no issue and shutdown has not started. A frozen historical
    // copy must not switch its existing message handler to permissive mode.
    const tail = progressFrame(2, 0, 1, 1, 3);
    children[1].emit('message', tail);
    children[1].emit('message', duplicate ? tail : progressFrame(3, 0, 2, 1, 0));
    const r = await batch.shutdown();
    assert.equal(r.outcomes[0].lifecycle.issue, 'stderr_output');
    assert.equal(r.outcomes[1].lifecycle.issue, 'unexpected_message');
    assert.equal(snapshot.cutoff, 'first_failure');
    assert.equal(snapshot.slots[1].received, 1);
    assert.deepEqual(snapshot.slots[1].last, [1, 1, 0, 1, 0, 0]);
    assert.equal(batch.freezeProgress(), snapshot);
    assert.equal(JSON.stringify(snapshot), serialized);
  });
test('worker batch double: failed outcomes without a batch issue freeze before unchanged shutdown', async t => {
  const {batch, children} = setup(t, {count: 8, contentionProgress: true}); await start(batch, children);
  children[0].emit('message', progressFrame(2, 0, 1, 1, 1));
  for (const [worker, child] of children.entries()) { if (worker !== 7) report(child); child.finish(); }
  const outcomes = await batch.outcomes();
  assert.equal(outcomes.filter(v => !v.valid).length, 1);
  assert.ok(outcomes.every(v => v.lifecycle.issue === null));
  const snapshot = batch.freezeProgress(); assert.equal(snapshot.cutoff, 'failed_outcomes');
  assertFrozenProgress(snapshot);
  assert.deepEqual(snapshot.slots[0], {worker: 0, received: 1, gap: true, last: [1, 2, 0, 1, 1, 1], receipt: 1});
  assert.ok(snapshot.slots.slice(1).every(v => v.received === 0 && v.last === null && v.receipt === 0));
  const closed = await batch.shutdown();
  assert.equal(closed.all_closed, true); assert.equal(batch.freezeProgress(), snapshot);
  assert.ok(children.every(child => child.kills === 0));
});
test('worker batch double with fake timers: disconnected failure keeps the original 50ms report drain', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const {batch, child, children} = setup(t, {contentionProgress: true}); await start(batch, children);
  child.emit('message', progressFrame()); child.disconnect(); child.stderr.write('PRIVATE');
  await assert.rejects(batch.outcomes(), /worker_unavailable/);
  const snapshot = batch.freezeProgress(); const closing = batch.shutdown();
  t.mock.timers.tick(49); assert.equal(child.kills, 0);
  child.stdout.write('{"ok":false,"code":"outbox_lock_io","lock":{"kind":"queue","phase":"create","system_code":"EPERM"}}');
  child.finish(1, null); const r = await closing;
  assert.equal(r.all_closed, true); assert.equal(child.kills, 0);
  assert.equal(r.outcomes[0].result.lock.system_code, 'EPERM');
  assert.equal(r.outcomes[0].lifecycle.issue, 'stderr_output');
  assert.equal(batch.freezeProgress(), snapshot);
});
test('worker batch double with fake timers: unclosed disconnected worker is killed at the original 50ms boundary', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const {batch, child, children} = setup(t, {contentionProgress: true}); await start(batch, children);
  child.disconnect(); child.stderr.write('PRIVATE'); await assert.rejects(batch.outcomes());
  const closing = batch.shutdown(); t.mock.timers.tick(49); assert.equal(child.kills, 0);
  t.mock.timers.tick(1); assert.equal(child.kills, 1);
  assert.equal((await closing).all_closed, true);
});
test('worker batch double with fake timers: deadline freezes observations and preserves one kill per worker', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const {batch, children} = setup(t, {count: 8, contentionProgress: true, timeoutMs: 20}); await start(batch, children);
  children[5].emit('message', progressFrame());
  const failed = assert.rejects(batch.outcomes(), /worker_unavailable/);
  t.mock.timers.tick(20); await failed;
  const snapshot = batch.freezeProgress(); assert.equal(snapshot.cutoff, 'first_failure');
  assert.equal(snapshot.slots[5].received, 1);
  const closing = batch.shutdown(); assert.equal(batch.shutdown(), closing);
  const r = await closing; assert.equal(r.timed_out, true); assert.equal(r.all_closed, true);
  assert.ok(r.outcomes.every(outcome => outcome.lifecycle.issue === 'timed_out'));
  assert.ok(children.every(child => child.kills === 1));
});
for (const killResult of [false, true, 'throw'])
  test('worker batch double with fake timers: unconfirmed close still uses two-second reap and retains cleanup gate, kill=' + killResult, async t => {
    t.mock.timers.enable({apis: ['setTimeout']});
    const {batch, child, children} = setup(t, {contentionProgress: true}); await start(batch, children);
    child.emit('message', progressFrame()); let unrefs = 0, disconnects = 0;
    child.kill = () => { child.kills++; if (killResult === 'throw') throw Error('PRIVATE_KILL'); return killResult; };
    child.unref = () => { unrefs++; };
    child.disconnect = () => { disconnects++; child.connected = false; child.emit('disconnect'); };
    child.stderr.write('PRIVATE'); await assert.rejects(batch.outcomes(), /worker_unavailable/);
    const snapshot = batch.freezeProgress(); const closing = batch.shutdown();
    let done = false; closing.then(() => { done = true; });
    t.mock.timers.tick(1999); await Promise.resolve();
    assert.equal(done, false); assert.equal(unrefs, 0); assert.equal(disconnects, 0);
    t.mock.timers.tick(1); const r = await closing;
    assert.equal(r.all_closed, false); assert.equal(r.outcomes[0].valid, false);
    assert.equal(r.outcomes[0].lifecycle.closed, false);
    assert.equal(r.outcomes[0].lifecycle.issue, 'stderr_output');
    assert.equal(r.outcomes[0].lifecycle.termination_requested, true);
    assert.equal(r.outcomes[0].lifecycle.termination_unconfirmed, killResult !== true);
    assert.equal(child.kills, 1); assert.equal(unrefs, 1); assert.equal(disconnects, 1);
    assert.equal(child.stdout.destroyed, true); assert.equal(child.stderr.destroyed, true);
    assert.equal(batch.freezeProgress(), snapshot);
    assert.ok(!JSON.stringify({...r, progress: snapshot}).includes('PRIVATE'));
  });
test('contention runner source-only: failed-writer freeze precedes original shutdown and all_closed cleanup gate', () => {
  // Read text only: importing this script would load production queue code.
  const source = readFileSync(new URL('../scripts/check-capture-contention.mjs', import.meta.url), 'utf8');
  const compact = source.replace(/\s+/g, '');
  assert.ok(compact.includes("if(result?.passed===false&&stage==='writers'&&batch)result.progress=batch.freezeProgress();"));
  const freezeAt = compact.indexOf('result.progress=batch.freezeProgress();');
  const shutdownAt = compact.indexOf('constclosed=batch?awaitbatch.shutdown():{outcomes:[],all_closed:true,timed_out:false};');
  assert.ok(freezeAt >= 0 && shutdownAt > freezeAt);
  assert.equal((compact.match(/awaitbatch\.shutdown\(\)/g) ?? []).length, 1);
  assert.ok(compact.includes('if(result?.passed===false&&!result.outcomes)result.outcomes=closed.outcomes;'));
  assert.ok(compact.includes('if(!closed.all_closed)result={...result,passed:false,workers_closed:false,cleanup_skipped:true};' +
    'elseif(root!==undefined)try{rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:30});}'));
  assert.ok(compact.includes('constrounds=args.length?Number(args[1]):3,observations=[];'));
  assert.ok(compact.includes('observations.push(r);if(!r.passed)break;'));
});
test('worker batch source-only: shutdown has no progress wait or new drain/reap mechanism', () => {
  const source = readFileSync(new URL('./helpers/capture-worker-batch.mjs', import.meta.url), 'utf8');
  const shutdown = source.slice(source.indexOf('  const shutdown ='), source.indexOf('\n  return {\n    ready:'));
  assert.ok(shutdown.includes('stopping = true; clearTimeout(timer);'));
  assert.ok(shutdown.includes("fail(r, r.issue ?? 'stopped'); stopRecord(r);"));
  assert.ok(shutdown.includes('await Promise.race([allDone, new Promise(resolve => { reapTimer = setTimeout(resolve, 2000); })]);'));
  assert.ok(shutdown.includes('const allClosed = records.every(r => r.closed);'));
  assert.equal(/progress|pendingSends/.test(shutdown), false);
  assert.ok(source.includes('r.drainTimer = setTimeout(() => terminate(r), 50);'));
});
