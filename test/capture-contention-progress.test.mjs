/** Deterministic sender, receiver and fixture doubles; no native contention run.
 * These tests do not prove native lifecycle/timing equivalence. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createContentionProgress, sealContentionProgress, projectProgressTransport,
  readContentionProgress, projectContentionProgressSummary} from './helpers/capture-contention-progress.mjs';
import {contentionWorkerReport} from './helpers/capture-contention-report.mjs';
import {createContentionDiagnostics, projectContentionDiagnostics} from './helpers/capture-contention-diagnostics.mjs';
const frame = (sequence, event = 0, attempt = 1, phase = 0, outcome = 0) =>
  ({contention_progress: [1, sequence, event, attempt, phase, outcome]});
const plain = value => JSON.parse(JSON.stringify(value));
// Test-only state model for projection inputs. Actual supervisor protocol and
// cutoff ownership are exercised separately by the batch integration doubles.
function receiverDouble() {
  const slots = Array.from({length: 8}, (_, worker) => ({worker, received: 0, gap: false, last: null, receipt: 0}));
  let ordinal = 0, frozen;
  return {receive(worker, message) {
    const slot = slots[worker], value = readContentionProgress(message, slot.last);
    if (!value) return false;
    slot.gap ||= value[1] !== (slot.last?.[1] ?? 0) + 1;
    slot.received++; slot.last = value; slot.receipt = ++ordinal; return true;
  }, freeze(cutoff = 'first_failure') { return frozen ??= projectContentionProgressSummary(slots, cutoff); }};
}
function sender(send, connected = true) {
  const calls = [], callbacks = [];
  const progress = createContentionProgress({connected, send: (v, cb) => {
    calls.push(v); callbacks.push(cb); return send?.(v, cb) ?? true;
  }});
  return {progress, calls, callbacks};
}
function allMilestones(progress) {
  for (let event = 0; event < 3; event++) for (let attempt = 1; attempt <= 8; attempt++) {
    progress.observe(event, attempt, 0, 0);
    progress.observe(event, attempt, 1, attempt === 8 ? event === 1 ? 2 : 1 : 3);
  }
}
test('progress sender double: exact 48 opportunity/send cap and maximum frame bytes', t => {
  const {progress, calls} = sender((_v, cb) => { cb(null); return true; });
  allMilestones(progress); progress.observe(2, 8, 1, 4);
  assert.equal(calls.length, 48); assert.deepEqual(progress.seal(), [1, 48, 48, 0, 0, 16]);
  assert.deepEqual(calls.map(v => v.contention_progress[1]), Array.from({length: 48}, (_, i) => i + 1));
  const bytes = Math.max(...calls.map(v => Buffer.byteLength(JSON.stringify(v) + '\n')));
  // The explicit worst legal sequence/event/attempt/phase/outcome frame.
  assert.equal(bytes, Buffer.byteLength(JSON.stringify(frame(48, 2, 8, 1, 4)) + '\n'));
  assert.ok(bytes <= 64); assert.ok(bytes * 48 <= 3072); assert.ok(bytes * 384 <= 24576);
  t.diagnostic(JSON.stringify({max_frame_bytes_including_newline: bytes}));
});
test('progress sender double: one permanently outstanding callback drops, never queues', () => {
  const {progress, calls, callbacks} = sender(); allMilestones(progress);
  assert.equal(calls.length, 1); assert.deepEqual(progress.seal(), [1, 48, 1, 47, 1, 0]);
  callbacks[0](null); assert.equal(calls.length, 1);
  assert.deepEqual(progress.seal(), [1, 48, 1, 47, 1, 0]);
});
test('progress sender double: dropped sequence stays missing after callback, no catch-up send', () => {
  const {progress, calls, callbacks} = sender();
  progress.observe(0, 1, 0, 0); progress.observe(0, 1, 1, 3);
  callbacks[0](null); assert.equal(calls.length, 1);
  progress.observe(0, 2, 0, 0); assert.deepEqual(calls.map(v => v.contention_progress[1]), [1, 3]);
});
for (const variant of ['false', 'throw', 'callback_error', 'false_error', 'throw_error', 'synchronous_error_throw', 'synchronous_error_false']) {
  test('progress sender double: independent known flags and permanent disable ' + variant, () => {
    const {progress, calls, callbacks} = sender((_v, cb) => {
      if (variant.startsWith('synchronous_error')) cb(Error('PRIVATE_CALLBACK'));
      if (variant.includes('throw')) throw Error('PRIVATE_THROW');
      return variant.includes('false') ? false : true;
    });
    progress.observe(0, 1, 0, 0);
    if (variant.includes('error') && !variant.startsWith('synchronous')) callbacks[0](Error('PRIVATE_LATE'));
    const expected = Number(variant.includes('false')) | (Number(variant.includes('throw')) << 1) | (Number(variant.includes('error')) << 2);
    progress.observe(0, 1, 1, 3); progress.observe(0, 2, 0, 0);
    const capsule = progress.seal();
    assert.equal(calls.length, 1); assert.equal(capsule[5], expected);
    assert.equal(capsule[4], Number(!variant.includes('error')));
    assert.equal(capsule[3], 2); assert.ok(!JSON.stringify(capsule).includes('PRIVATE'));
  });
}
for (const error of [null, Error('PRIVATE_LATE')]) test('progress sender double: sealed pending callback tail stays unconfirmed ' + Boolean(error), () => {
  const {progress, calls, callbacks} = sender(); progress.observe(0, 1, 0, 0);
  const sealed = progress.seal(); callbacks[0](error); callbacks[0](Error('PRIVATE_DUPLICATE'));
  progress.observe(0, 1, 1, 3); assert.equal(calls.length, 1); assert.equal(progress.seal(), sealed);
  assert.deepEqual(sealed, [1, 1, 1, 0, 1, 0]); assert.ok(Object.isFrozen(sealed));
  assert.equal(projectProgressTransport(sealed).tail, 'unconfirmed');
});
test('progress sender double: callback is idempotent and never yields negative pending', () => {
  const {progress, calls, callbacks} = sender(); progress.observe(0, 1, 0, 0);
  callbacks[0](null); callbacks[0](Error('PRIVATE_DUPLICATE'));
  progress.observe(0, 1, 1, 3); assert.equal(calls.length, 2);
  callbacks[1](null); assert.deepEqual(progress.seal(), [1, 2, 2, 0, 0, 0]);
});
for (const port of [{connected: true}, {connected: false, send() { throw Error('must_not_call'); }},
  {get connected() { throw Error('PRIVATE'); }, send() {}}, {connected: true, get send() { throw Error('PRIVATE'); }}]) {
  test('progress sender double: missing/disconnected/throwing channel port is bounded unavailable', () => {
    const progress = createContentionProgress(port); allMilestones(progress); progress.observe(0, 1, 0, 0);
    assert.deepEqual(progress.seal(), [1, 48, 0, 48, 0, 24]);
  });
}
test('progress sender double: optional helper and capsule failures have fixed safe projection', () => {
  assert.equal(sealContentionProgress({seal() { throw Error('PRIVATE'); }}), null);
  assert.equal(sealContentionProgress({seal() { return {toJSON() { throw Error('PRIVATE'); }}; }}), null);
  assert.deepEqual(projectProgressTransport(new Proxy([], {get() { throw Error('PRIVATE'); }})), {status: 'diagnostic_invalid'});
  assert.deepEqual(projectProgressTransport(undefined), {status: 'unavailable'});
  assert.deepEqual(projectProgressTransport([1, 48, 24, 24, 1, 31]), {
    status: 'observed', version: 1, milestones: 48, send_attempts: 24, dropped: 24, pending_at_terminal: true,
    tail: 'unconfirmed', send_returned_false: true, synchronous_send_throw: true, callback_error: true,
    channel_unavailable: true, opportunity_limit_exceeded: true});
});
const badCapsules = [null, {}, [], [1, 0, 0, 0, 0], [2, 0, 0, 0, 0, 0], [1, 49, 0, 49, 0, 0],
  [1, 1, 2, 0, 0, 0], [1, 3, 1, 1, 0, 0], [1, 0, 0, 0, 1, 0], [1, 1, 1, 0, 2, 0],
  [1, 1, 1, 0, 0, 32], [1, 1, 1, 0, 0, -1], [1, 1.5, 1, .5, 0, 0], 'PRIVATE'];
for (const value of badCapsules) test('progress transport: malformed capsule cannot change original queue validity ' + JSON.stringify(value), () => {
  for (const report of [{ok: true, busy_retries: 0, replays: 0}, {ok: false, busy_retries: 0, code: 'outbox_busy'}]) {
    const original = contentionWorkerReport(JSON.stringify(report));
    const withProgress = contentionWorkerReport(JSON.stringify({...report, progress_transport: value}));
    const {progress_transport, ...queue} = withProgress;
    assert.deepEqual(queue, original); assert.deepEqual(progress_transport, {status: 'diagnostic_invalid'});
    assert.ok(!JSON.stringify(withProgress).includes('PRIVATE'));
  }
  assert.deepEqual(contentionWorkerReport(JSON.stringify({ok: true, replays: 4, progress_transport: value})),
    {ok: false, code: 'invalid_worker_report'});
});
test('progress transport: legacy omission and invalid reports stay byte-for-byte compatible', () => {
  assert.deepEqual(contentionWorkerReport('{"ok":true,"busy_retries":0,"replays":1}'), {ok: true, busy_retries: 0, replays: 1});
  for (const value of ['null', 'PRIVATE', '{}', '{"ok":true,"busy_retries":0,"replays":2,"progress_transport":[1,1,1,0,0,0]}'])
    assert.deepEqual(contentionWorkerReport(value), {ok: false, code: 'invalid_worker_report'});
});
const badFrames = [null, [], true, {}, {ready: true}, {...frame(1), secret: 'PRIVATE'}, {contention_progress: null},
  {contention_progress: [1, 1, 0, 1, 0]}, {contention_progress: [2, 1, 0, 1, 0, 0]},
  frame(0), frame(49), frame(1, 3), frame(1, 0, 0), frame(1, 0, 9), frame(1, 0, 1, 2),
  frame(1, 0, 1, 0, 1), frame(2, 0, 1, 1, 0), frame(2, 0, 1, 1, 2), frame(2, 0, 1, 1, 5),
  frame(2), frame(1, 0, 1, 1, 1), frame(3), frame(1, 1), frame(20, 1, 1, 1, 1), frame(1.5)];
for (const value of badFrames) test('progress receiver: malformed or impossible single frame ' + JSON.stringify(value), () => {
  assert.equal(readContentionProgress(value), null);
});
test('progress receiver: settled without before and legal gaps are historical observations only', () => {
  const receiver = receiverDouble();
  assert.equal(receiver.receive(3, frame(4, 0, 2, 1, 1)), true);
  assert.equal(receiver.receive(3, frame(8, 1, 2, 1, 2)), true);
  const snap = receiver.freeze();
  assert.deepEqual(snap.slots[3], {worker: 3, received: 2, gap: true, last: [1, 8, 1, 2, 1, 2], receipt: 2});
  assert.deepEqual(snap.slots[4], {worker: 4, received: 0, gap: false, last: null, receipt: 0});
  assert.ok(Object.isFrozen(snap.slots[3].last));
  assert.equal(receiver.receive(3, frame(10, 2, 1, 1, 1)), true); assert.equal(receiver.freeze(), snap);
  assert.equal(snap.slots[3].received, 2);
});
test('progress receiver: all legal wrapper trace subsequences and impossible pairs, independent model', t => {
  const frames = new Map(), pairs = new Set(); let traces = 0;
  const key = v => v.join(',');
  function end(path) {
    traces++;
    for (let i = 0; i < path.length; i++) {
      frames.set(key(path[i]), path[i]);
      for (let j = i + 1; j < path.length; j++) pairs.add(key(path[i]) + '>' + key(path[j]));
    }
  }
  function walk(event, attempt, prefix) {
    const before = [1, prefix.length + 1, event, attempt, 0, 0];
    for (const outcome of event === 1 ? [1, 2, 3, 4] : [1, 3, 4]) {
      const path = [...prefix, before, [1, prefix.length + 2, event, attempt, 1, outcome]];
      if (outcome === 4 || (outcome === 3 && attempt === 8) || ((outcome === 1 || outcome === 2) && event === 2)) end(path);
      else if (outcome === 3) walk(event, attempt + 1, path);
      else walk(event + 1, 1, path);
    }
  }
  walk(0, 1, []);
  const all = [...frames.values()]; let comparisons = 0;
  for (const v of all) assert.deepEqual(readContentionProgress({contention_progress: v}), v);
  for (const previous of all) for (const next of all) {
    const expected = pairs.has(key(previous) + '>' + key(next));
    assert.equal(Boolean(readContentionProgress({contention_progress: next}, previous)), expected,
      key(previous) + ' -> ' + key(next)); comparisons++;
  }
  t.diagnostic(JSON.stringify({independent_model_terminal_traces: traces, distinct_frames: all.length, pair_comparisons: comparisons}));
});
test('progress receiver: eight maximal slots, receipt ordinal and serialized cap', t => {
  const receiver = receiverDouble();
  const {progress, calls} = sender((_v, cb) => { cb(null); return true; }); allMilestones(progress);
  for (const v of calls) for (let worker = 0; worker < 8; worker++) assert.equal(receiver.receive(worker, v), true);
  const summary = receiver.freeze('failed_outcomes');
  assert.equal(summary.slots[7].receipt, 384); assert.ok(summary.slots.every(v => v.received === 48 && !v.gap));
  const bytes = Buffer.byteLength(JSON.stringify(summary)); assert.ok(bytes <= 2048);
  t.diagnostic(JSON.stringify({max_tested_failure_summary_bytes: bytes}));
});
test('progress summary: invalid state, hostile access and oversized extras remain fixed and private', () => {
  const unavailable = {version: 1, cutoff: 'unavailable', best_effort: true, reason: 'diagnostic_unavailable'};
  assert.deepEqual(projectContentionProgressSummary(new Proxy([], {get() { throw Error('PRIVATE'); }}), 'first_failure'), unavailable);
  assert.deepEqual(projectContentionProgressSummary({toJSON() { return 'PRIVATE'; }}, 'first_failure'), unavailable);
  assert.deepEqual(receiverDouble().freeze('PRIVATE'), unavailable);
  const value = plain(receiverDouble().freeze()); value.secret = 'PRIVATE'.repeat(5000);
  value.slots.forEach(v => { v.secret = 'PRIVATE'; });
  const projected = projectContentionProgressSummary(value.slots, 'first_failure');
  assert.ok(Buffer.byteLength(JSON.stringify(projected)) <= 2048); assert.ok(!JSON.stringify(projected).includes('PRIVATE'));
});
function maximalReport(terminal) {
  const attempts = []; let busy = 0;
  for (let event = 0; event < 3; event++) for (let attempt = 1; attempt <= 8; attempt++) {
    const outcome = attempt < 8 ? 'busy' : event === 2 && terminal !== 'complete' ?
      terminal === 'retry_limit' ? 'busy' : 'error' : event === 1 ? 'replayed' : 'accepted';
    attempts.push([event, attempt, 60000, outcome]); if (outcome === 'busy') busy++;
  }
  const read = {kind: 'profile', phase: 'handle-before', reason: 'permissions', system_code: 'ENAMETOOLONG', close_failed: true};
  const lock = {kind: 'delivery', phase: 'directory-sync', system_code: 'ENAMETOOLONG', file_read: read,
    retirement: {namespace_state: 'not_released', close_failed: true}};
  const journal = {target: 'binding', operation: 'replace', phase: 'temporary-unlink', system_code: 'ENAMETOOLONG',
    publication: 'not_attempted', directory_sync: 'not_attempted',
    secondary: Array.from({length: 2}, () => ({phase: 'temporary-unlink', system_code: 'ENAMETOOLONG'})), lock_release: [lock, lock]};
  const report = {ok: terminal === 'complete', busy_retries: busy - Number(terminal === 'retry_limit'),
    ...(terminal === 'complete' ? {replays: 1} : {code: terminal === 'retry_limit' ? 'outbox_busy' : 'outbox_journal_io',
      lock, journal, native_code: 'ENAMETOOLONG', syscall: 'realpath', target: 'queue-lock'}),
    diagnostics: {version: 1, event_index: 2, completed_events: terminal === 'complete' ? 3 : 2,
      elapsed_ms: 60000, timing_saturated: true, terminal, attempts}, progress_transport: [1, 48, 24, 24, 1, 31]};
  return report;
}
test('progress reporting: maximum retained report variants plus maximal capsule retain unchanged caps', t => {
  let bytes = 0;
  for (const terminal of ['complete', 'retry_limit', 'non_busy_error']) {
    const value = maximalReport(terminal), text = JSON.stringify(value) + '\n';
    assert.equal(value.diagnostics.attempts.length, 24);
    const parsed = contentionWorkerReport(text);
    assert.equal(parsed.ok, value.ok); assert.deepEqual(parsed.diagnostics, value.diagnostics);
    assert.equal(parsed.progress_transport.status, 'observed');
    assert.ok(Buffer.byteLength(text) <= 4096); bytes = Math.max(bytes, Buffer.byteLength(text));
    const exact = text + ' '.repeat(4096 - Buffer.byteLength(text));
    assert.equal(Buffer.byteLength(exact), 4096); assert.deepEqual(contentionWorkerReport(exact), parsed);
    assert.deepEqual(contentionWorkerReport(exact + ' '), {ok: false, code: 'invalid_worker_report'});
    assert.deepEqual(contentionWorkerReport(text, {overflow: true}), {ok: false, code: 'invalid_worker_report'});
  }
  const contribution = ',"progress_transport":' + JSON.stringify([1, 48, 24, 24, 1, 31]);
  assert.ok(Buffer.byteLength(contribution) <= 96);
  t.diagnostic(JSON.stringify({max_tested_terminal_report_bytes_including_newline: bytes,
    max_capsule_field_bytes: Buffer.byteLength(contribution)}));
});
test('progress reporting double: injected projector failure cannot replace any original queue decision', () => {
  const source = readFileSync(new URL('./helpers/capture-contention-report.mjs', import.meta.url), 'utf8')
    .replace(/^import[^;]+;\n/gm, '').replace('export function', 'function');
  const parse = runInNewContext(source + '\ncontentionWorkerReport;', {
    Buffer, projectContentionDiagnostics, projectProgressTransport: () => { throw Error('PRIVATE'); },
    controlWorkerReport: text => ({ok: false, code: JSON.parse(text).code})});
  for (const report of [{ok: true, busy_retries: 0, replays: 1}, {ok: false, busy_retries: 0, code: 'outbox_busy'}]) {
    assert.deepEqual(plain(parse(JSON.stringify({...report, progress_transport: [1, 1, 1, 0, 0, 0]}))),
      {...report, progress_transport: {status: 'diagnostic_invalid'}});
  }
  assert.deepEqual(plain(parse('{"ok":true,"busy_retries":0,"replays":3,"progress_transport":null}')),
    {ok: false, code: 'invalid_worker_report'});
  assert.deepEqual(plain(parse('{"ok":true,"busy_retries":0,"replays":0,"diagnostics":null,"progress_transport":null}')),
    {ok: false, code: 'invalid_worker_report'});
});
const fixtureSource = readFileSync(new URL('./fixtures/capture-contention-worker.mjs', import.meta.url), 'utf8');
async function fixtureDouble({scenario = 'success', failure = null} = {}) {
  const trace = [], stdout = [], sends = []; let handler, enqueueCount = 0, now = 0;
  const process = {connected: true, exitCode: undefined,
    once: (event, fn) => { assert.equal(event, 'message'); assert.equal(handler, undefined); handler = fn; },
    send: (value, cb) => { sends.push(plain(value)); trace.push(value.ready ? 'ready' : 'progress:' + value.contention_progress.slice(1).join(',')); cb?.(null); return true; },
    stdout: {write: value => { stdout.push(value); trace.push('stdout'); }},
    disconnect() { this.connected = false; trace.push('disconnect'); }};
  class Queue {
    async enqueue(payload) {
      enqueueCount++; trace.push('enqueue:' + payload.event_id);
      const busy = scenario === 'retry_limit' || scenario === 'deadline' || (scenario === 'busy_then_success' && enqueueCount === 1);
      if (scenario === 'deadline') now = 10000;
      if (busy || scenario === 'error') throw {get code() { trace.push('error.code'); return busy ? 'outbox_busy' : 'outbox_lock_io'; }};
      return {get replayed() { trace.push('result.replayed'); return payload.event_id === 'shared-event'; }};
    }
  }
  const diagnostics = () => {
    const d = createContentionDiagnostics(() => now);
    return {begin: (...args) => { trace.push('begin'); d.begin(...args); },
      finish: outcome => { trace.push('finish:' + outcome); d.finish(outcome); }, end: terminal => d.end(terminal)};
  };
  runInNewContext(fixtureSource.replace(/^import[^;]+;\n/gm, ''), {process, CaptureOutbox: Queue,
    captureProcessDiagnostic: error => ({code: error.code}),
    performance: {now: () => { trace.push('clock'); return now; }},
    delay: async ms => { assert.equal(ms, 25); trace.push('delay'); now += ms; },
    createContentionDiagnostics: diagnostics,
    createContentionProgress: () => {
      if (failure === 'create') throw Error('PRIVATE_CREATE');
      if (failure === 'observe') return {observe() { throw Error('PRIVATE_OBSERVE'); }, seal: () => [1, 0, 0, 0, 0, 0]};
      return createContentionProgress(process);
    }, sealContentionProgress: sender => { if (failure === 'seal') throw Error('PRIVATE_SEAL'); return sealContentionProgress(sender); }});
  await handler({input: {}, worker: 0});
  assert.equal(stdout.length, 1); assert.ok(Buffer.byteLength(stdout[0]) <= 4096);
  assert.deepEqual(trace.slice(-2), ['stdout', 'disconnect']);
  return {report: JSON.parse(stdout[0]), trace, sends, enqueueCount, exitCode: process.exitCode};
}
for (const scenario of ['success', 'busy_then_success', 'retry_limit', 'deadline', 'error']) {
  test('progress fixture double: original retry decision and single terminal lifecycle order ' + scenario, async () => {
    const r = await fixtureDouble({scenario});
    const expected = {success: [3, 0, 0, 1], busy_then_success: [4, 1, 1, 2], retry_limit: [8, 7, 7, 8], deadline: [1, 0, 0, 2], error: [1, 0, 0, 1]}[scenario];
    assert.equal(r.enqueueCount, expected[0]); assert.equal(r.report.busy_retries, expected[1]);
    assert.equal(r.trace.filter(v => v === 'delay').length, expected[2]);
    assert.equal(r.trace.filter(v => v === 'clock').length, expected[3]);
    assert.equal(r.report.ok, scenario === 'success' || scenario === 'busy_then_success');
    assert.equal(r.exitCode, r.report.ok ? undefined : 1);
    assert.equal(r.report.progress_transport[1], r.enqueueCount * 2);
    assert.equal(r.sends[0].ready, true);
    for (let i = 0; i < r.trace.length; i++) {
      if (r.trace[i].startsWith('progress:') && r.trace[i].split(',').at(-2) === '0') assert.equal(r.trace[i + 1], 'begin');
      if (r.trace[i] === 'finish:busy' || r.trace[i] === 'finish:error') {
        assert.equal(r.trace[i - 1], 'error.code');
        assert.ok(r.trace[i + 1].startsWith('progress:'));
        // All original code/deadline short-circuit reads precede observation.
        assert.ok(!r.trace.slice(i + 1, i + 2).includes('clock'));
      }
    }
    assert.ok(contentionWorkerReport(JSON.stringify(r.report)).diagnostics);
  });
}
for (const failure of ['create', 'observe', 'seal']) for (const scenario of ['success', 'busy_then_success', 'retry_limit', 'deadline', 'error']) {
  test('progress fixture double: injected ' + failure + ' failure preserves ' + scenario + ' workload and result', async () => {
    const original = await fixtureDouble({scenario}), injected = await fixtureDouble({scenario, failure});
    const {progress_transport: _a, ...queueA} = original.report, {progress_transport: _b, ...queueB} = injected.report;
    assert.deepEqual(queueB, queueA); assert.equal(injected.enqueueCount, original.enqueueCount);
    assert.equal(injected.exitCode, original.exitCode);
    assert.deepEqual(injected.trace.filter(v => !v.startsWith('progress:')), original.trace.filter(v => !v.startsWith('progress:')));
    assert.ok(!JSON.stringify(injected.report).includes('PRIVATE'));
    assert.equal(injected.report.progress_transport, null);
    assert.equal(contentionWorkerReport(JSON.stringify(injected.report)).progress_transport.status, 'diagnostic_invalid');
  });
}
test('progress fixture source: no new process listener/ref/timer/drain/await path', () => {
  assert.equal((fixtureSource.match(/process\.once\(/g) ?? []).length, 1);
  assert.equal((fixtureSource.match(/process\.on\(/g) ?? []).length, 0);
  assert.equal((fixtureSource.match(/process\.stdout\.write\(/g) ?? []).length, 2); // mutually exclusive success/error
  assert.equal((fixtureSource.match(/process\.disconnect\(/g) ?? []).length, 1);
  assert.ok(!/\.unref\(|\.ref\(|setInterval|setTimeout\(|await\s+(?:progress|observe|transport)/.test(fixtureSource));
  assert.ok(fixtureSource.includes('retries++;busyRetries++;await delay(25)'));
  assert.ok(fixtureSource.includes('deadline=performance.now()+10000'));
});
test('progress summary double: injected serialization over-bound or failure gets fixed unavailable', () => {
  const source = readFileSync(new URL('./helpers/capture-contention-progress.mjs', import.meta.url), 'utf8').replaceAll('export function', 'function');
  for (const byteLength of [() => 2049, () => { throw Error('PRIVATE_SERIALIZER'); }]) {
    const project = runInNewContext(source + '\nprojectContentionProgressSummary;', {Buffer: {byteLength}});
    assert.deepEqual(plain(project(receiverDouble().freeze().slots, 'first_failure')),
      {version: 1, cutoff: 'unavailable', best_effort: true, reason: 'diagnostic_unavailable'});
  }
});
const batchSource = readFileSync(new URL('./helpers/capture-worker-batch.mjs', import.meta.url), 'utf8')
  .replace(/^import[^;]+;\n/gm, '').replace('export function', 'function');
function batchDouble({projectorFails = false, validatorFails = false, count = 1} = {}) {
  const makeBatch = runInNewContext(batchSource + '\ncaptureWorkerBatch;', {
    Buffer, TextDecoder, setTimeout: () => ({}), clearTimeout() {}, performance: {now: () => 0},
    readContentionProgress: validatorFails ? () => { throw Error('PRIVATE_VALIDATOR'); } : readContentionProgress,
    projectContentionProgressSummary: projectorFails ? () => { throw Error('PRIVATE_PROJECTOR'); } : projectContentionProgressSummary});
  const children = Array.from({length: count}, () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.connected = true;
    child.send = (_v, cb) => { cb(null); return true; };
    child.finish = (exit = 0, signal = null) => { child.emit('exit', exit, signal); child.emit('close', exit, signal); };
    child.kill = () => { child.finish(null, 'SIGKILL'); return true; }; return child;
  });
  const batch = makeBatch({spawnWorker: i => children[i], parseReport: contentionWorkerReport, count, contentionProgress: true});
  return {batch, children, child: children[0], async start() {
    children.forEach(child => child.emit('message', {ready: true})); await batch.ready(); batch.start(() => ({}));
  }};
}
test('progress batch double: sole protocol state saturates at 384 received frames in eight slots', async () => {
  const {batch, children, start} = batchDouble({count: 8}); await start();
  const {progress, calls} = sender((_v, cb) => { cb(null); return true; }); allMilestones(progress);
  for (const value of calls) for (const child of children) child.emit('message', value);
  const snapshot = batch.freezeProgress();
  assert.ok(snapshot.slots.every(slot => slot.received === 48 && !slot.gap)); assert.equal(snapshot.slots[7].receipt, 384);
  for (const child of children) { child.stdout.write('{"ok":true,"busy_retries":0,"replays":0}'); child.finish(); }
  assert.ok((await batch.outcomes()).every(result => result.valid)); await batch.shutdown();
});
for (const failed of [false, true]) {
  test('progress batch double: optional summary projector exception preserves original outcome ' + failed, async () => {
    const {batch, child, start} = batchDouble({projectorFails: true}); await start();
    child.emit('message', frame(1));
    child.stdout.write(JSON.stringify({ok: !failed, busy_retries: 0, ...(failed ? {code: 'outbox_busy'} : {replays: 0})}));
    child.finish(failed ? 1 : 0);
    if (failed) await assert.rejects(batch.outcomes(), /worker_unavailable/);
    else assert.equal((await batch.outcomes())[0].valid, true);
    const snapshot = batch.freezeProgress();
    assert.deepEqual(plain(snapshot), {version: 1, cutoff: 'unavailable', best_effort: true, reason: 'diagnostic_unavailable'});
    assert.equal(batch.freezeProgress(), snapshot); assert.ok(Object.isFrozen(snapshot));
    const closed = await batch.shutdown();
    assert.equal(closed.all_closed, true); assert.equal(closed.outcomes[0].valid, !failed);
    assert.equal(closed.outcomes[0].lifecycle.issue, failed ? 'worker_exit_failed' : null);
    assert.ok(!JSON.stringify(closed).includes('PRIVATE'));
  });
}
for (const projectorFails of [false, true]) for (const mode of ['malformed', 'duplicate', 'post_terminal', 'valid_tail']) {
  test('progress batch double: protocol remains authoritative after projection failure=' + projectorFails + ' ' + mode, async () => {
    const {batch, child, start} = batchDouble({projectorFails}); await start();
    child.emit('message', mode === 'post_terminal' ? frame(2, 0, 1, 1, 4) : frame(1));
    const snapshot = batch.freezeProgress();
    const tail = {malformed: frame(3, 0, 2, 1, 0), duplicate: frame(1), post_terminal: frame(3, 1), valid_tail: frame(2, 0, 1, 1, 1)}[mode];
    child.emit('message', tail);
    if (mode === 'valid_tail') { child.stdout.write('{"ok":true,"busy_retries":0,"replays":0}'); child.finish(); assert.equal((await batch.outcomes())[0].valid, true); }
    else await assert.rejects(batch.outcomes(), /worker_unavailable/);
    const closed = await batch.shutdown();
    assert.equal(closed.outcomes[0].valid, mode === 'valid_tail');
    assert.equal(closed.outcomes[0].lifecycle.issue, mode === 'valid_tail' ? null : 'unexpected_message');
    assert.equal(batch.freezeProgress(), snapshot); assert.ok(!JSON.stringify(closed).includes('PRIVATE'));
    if (projectorFails) assert.equal(snapshot.cutoff, 'unavailable');
  });
}
for (const value of [frame(1), frame(1, 0, 1, 0, 1)]) test('progress batch double: validator exception never accepts unverifiable IPC', async () => {
  const {batch, child, start} = batchDouble({validatorFails: true}); await start(); child.emit('message', value);
  await assert.rejects(batch.outcomes(), /worker_unavailable/); const closed = await batch.shutdown();
  assert.equal(closed.outcomes[0].valid, false); assert.equal(closed.outcomes[0].lifecycle.issue, 'unexpected_message');
  assert.equal(batch.freezeProgress().slots[0].received, 0); assert.ok(!JSON.stringify(closed).includes('PRIVATE'));
});
