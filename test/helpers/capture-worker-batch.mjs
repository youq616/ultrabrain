/** Lifecycle supervision for fixed SYNTHETIC test workers, not client execution.
 * IPC acknowledgement is not process completion. Only close plus a validated
 * final report can pass. No retries, arbitrary commands or user paths here. */
import {performance} from 'node:perf_hooks';
const SIGNALS = new Set(['SIGKILL', 'SIGTERM', 'SIGINT', 'SIGABRT', 'SIGSEGV']);
const unavailable = () => Error('worker_unavailable');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  // A later barrier may fail before the caller starts awaiting it.
  promise.catch(() => {});
  return {promise, resolve, reject};
};
const invalid = () => ({ok: false, code: 'invalid_worker_report'});

/** Internal trusted ports only: callers supply the fixed spawn/report functions.
 * The timeout bounds work; shutdown allows up to two more seconds for close.
 * Unconfirmed shutdown never permits removal of the scratch directory. */
export function captureWorkerBatch({spawnWorker, parseReport, count = 8,
  staged = false, timeoutMs = 15000} = {}) {
  if (typeof spawnWorker !== 'function' || typeof parseReport !== 'function' ||
      !Number.isSafeInteger(count) || count < 1 || count > 8 ||
      typeof staged !== 'boolean' || !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 || timeoutMs > 15000) throw Error('invalid_worker_batch');
  const records = [];
  const deadline = performance.now() + timeoutMs;
  let timedOut = false, stopping = false, shutdownPromise;
  const phaseError = deferred();
  const fail = (r, code) => {
    r.issue ??= code;
    r.ready.reject(unavailable());
    r.staged.reject(unavailable());
    phaseError.reject(unavailable());
  };
  const terminate = r => {
    if (!r.child || r.closed || r.exited || r.spawnFailed || r.killRequested) return;
    r.killRequested = true;
    try { if (!r.child.kill('SIGKILL')) r.killUnconfirmed = true; }
    catch { r.killUnconfirmed = true; }
  };
  const stopRecord = r => {
    // Let already-exiting workers drain their bounded report; do not truncate
    // the authentic queue error by killing on the earlier disconnect event.
    if (r.disconnected && !r.exited && !r.closed && !r.drainTimer) {
      r.drainTimer = setTimeout(() => terminate(r), 50);
    } else if (!r.disconnected) terminate(r);
  };
  const project = r => {
    let report = invalid();
    if (r.closed && !r.overflow) {
      try {
        const text = new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(r.chunks, r.bytes));
        report = parseReport(text, {overflow: r.overflow});
        if (!report || typeof report !== 'object' || typeof report.ok !== 'boolean') report = invalid();
      } catch { report = invalid(); }
    }
    return {worker: r.worker, exit: Number.isSafeInteger(r.exit) ? r.exit : null,
      signal: SIGNALS.has(r.signal) ? r.signal : null,
      valid: r.closed && r.exited && r.finalSent && !r.issue && !r.stderr && !r.overflow &&
        r.exit === 0 && r.signal === null && r.pendingSends === 0 && report.ok === true,
      result: report, stderr_seen: r.stderr, output_truncated: r.overflow,
      lifecycle: {ready: r.readySeen, staged: r.stagedSeen, closed: r.closed,
        issue: r.issue, termination_requested: r.killRequested,
        termination_unconfirmed: r.killUnconfirmed, send_callbacks_pending: r.pendingSends}};
  };
  for (let worker = 0; worker < count; worker++) {
    const r = {worker, ready: deferred(), staged: deferred(), done: deferred(), child: null,
      expected: 'ready', readySeen: false, stagedSeen: false, finalSent: false,
      chunks: [], bytes: 0, stderr: false, overflow: false, closed: false,
      exited: false, disconnected: false, spawnFailed: false,
      issue: null, exit: null, signal: null, pendingSends: 0, killRequested: false, killUnconfirmed: false};
    records.push(r);
    try { r.child = spawnWorker(worker); }
    catch {
      r.spawnFailed = true; r.closed = true;
      fail(r, 'spawn_failed'); r.done.resolve(); continue;
    }
    const child = r.child;
    child.on('message', message => {
      if (r.closed || r.issue || stopping) return;
      const keys = message && typeof message === 'object' && !Array.isArray(message) ? Object.keys(message) : [];
      if (keys.length !== 1 || keys[0] !== r.expected || message[r.expected] !== true) {
        fail(r, 'unexpected_message'); stopRecord(r); return;
      }
      if (r.expected === 'ready') { r.readySeen = true; r.ready.resolve(); }
      else { r.stagedSeen = true; r.staged.resolve(); }
      r.expected = null;
    });
    child.stdout.on('data', data => {
      if (r.closed || r.overflow) return;
      const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (r.bytes + bytes.length > 4096) {
        r.overflow = true; r.bytes = 0; r.chunks = [];
        fail(r, 'output_overflow'); stopRecord(r);
      } else { r.bytes += bytes.length; r.chunks.push(Buffer.from(bytes)); }
    });
    child.stderr.on('data', () => {
      r.stderr = true; fail(r, 'stderr_output'); stopRecord(r);
    });
    // Pipe failures must never surface arbitrary native error text or hang.
    for (const stream of [child.stdout, child.stderr]) stream.on('error', () => {
      fail(r, 'pipe_failed'); stopRecord(r);
    });
    child.on('error', () => {
      // ENOENT may have no exit event, but Node still emits close after error.
      r.spawnFailed = !child.pid;
      fail(r, r.spawnFailed ? 'spawn_failed' : 'process_error'); stopRecord(r);
    });
    child.once('disconnect', () => {
      r.disconnected = true;
      if (!r.finalSent && !r.closed) fail(r, 'ipc_disconnected');
    });
    child.once('exit', () => {
      r.exited = true;
      if (!r.finalSent && !r.closed) fail(r, 'exited_before_completion');
    });
    child.once('close', (exit, signal) => {
      r.closed = true; r.exit = exit; r.signal = signal;
      clearTimeout(r.drainTimer);
      if (!stopping && performance.now() >= deadline) { timedOut = true; fail(r, 'timed_out'); }
      if (!r.finalSent) fail(r, 'closed_before_completion');
      else if (exit !== 0 || signal !== null) fail(r, 'worker_exit_failed');
      r.done.resolve();
    });
  }
  const allDone = Promise.all(records.map(r => r.done.promise));
  const expire = () => {
    if (records.every(r => r.closed)) return;
    timedOut = true;
    for (const r of records) if (!r.closed) { fail(r, 'timed_out'); stopRecord(r); }
  };
  const timer = setTimeout(expire, timeoutMs);
  const check = () => {
    if (!stopping && performance.now() >= deadline) expire();
    if (stopping || records.some(r => r.issue)) throw unavailable();
  };
  const send = (makeMessage, final) => {
    if (typeof makeMessage !== 'function') throw Error('invalid_worker_message');
    check();
    for (const r of records) {
      if (!r.readySeen || r.expected !== null || r.finalSent ||
          (final && staged && !r.stagedSeen) || r.closed || r.exited ||
          r.disconnected || r.child.connected !== true) {
        fail(r, 'invalid_dispatch'); throw unavailable();
      }
    }
    // Prepare ALL messages before dispatch: a throwing trusted factory must
    // not start only part of an intended barrier.
    const messages = records.map(r => makeMessage(r.worker));
    for (const [i, r] of records.entries()) {
      check(); r.finalSent = final; r.expected = final ? null : 'staged';
      r.pendingSends++; let settled = false;
      const sent = error => {
        if (settled) return;
        settled = true; r.pendingSends--;
        if (error) { fail(r, 'ipc_send_failed'); stopRecord(r); }
      };
      try { r.child.send(messages[i], sent); }
      catch (error) { sent(error); throw unavailable(); }
      // A false return is IPC backpressure, NOT a send failure. No retries.
    }
  };
  const shutdown = () => shutdownPromise ??= (async () => {
    stopping = true; clearTimeout(timer);
    for (const r of records) if (!r.closed) {
      fail(r, r.issue ?? 'stopped'); stopRecord(r);
    }
    let reapTimer;
    await Promise.race([allDone, new Promise(resolve => { reapTimer = setTimeout(resolve, 2000); })]);
    clearTimeout(reapTimer);
    const allClosed = records.every(r => r.closed);
    const outcomes = records.map(project);
    for (const r of records) {
      clearTimeout(r.drainTimer);
      if (!r.closed) {
        // No close evidence: retain scratch data. Detach handles so a failed
        // kill/pipe close does not itself hang this diagnostic CLI forever.
        r.child?.unref(); r.child?.stdout.destroy(); r.child?.stderr.destroy();
        try { if (r.child?.connected) r.child.disconnect(); } catch {}
      }
    }
    return {outcomes, all_closed: allClosed, timed_out: timedOut};
  })();
  return {
    ready: async () => { await Promise.race([Promise.all(records.map(r => r.ready.promise)), phaseError.promise]); check(); },
    staged: async () => {
      if (!staged) throw Error('invalid_worker_barrier');
      await Promise.race([Promise.all(records.map(r => r.staged.promise)), phaseError.promise]); check();
    },
    start: makeMessage => send(makeMessage, !staged),
    resume: makeMessage => { if (!staged) throw Error('invalid_worker_barrier'); send(makeMessage, true); },
    outcomes: async () => { await Promise.race([allDone, phaseError.promise]); check(); return records.map(project); },
    shutdown,
    get timedOut() { return timedOut; }
  };
}
