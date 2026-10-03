/** Synthetic writer reports are untrusted JSON, never server receipts. */
import {controlWorkerReport} from './capture-control-report.mjs';
import {projectContentionDiagnostics} from './capture-contention-diagnostics.mjs';
import {projectProgressTransport} from './capture-contention-progress.mjs';
const invalid = () => ({ok: false, code: 'invalid_worker_report'});
export function contentionWorkerReport(text, {overflow = false} = {}) {
  let r;
  try {
    if (!overflow && typeof text === 'string' && Buffer.byteLength(text) <= 4096) r = JSON.parse(text);
  } catch {}
  if (!r || typeof r !== 'object' || Array.isArray(r) || typeof r.ok !== 'boolean' ||
      !Number.isSafeInteger(r.busy_retries) || r.busy_retries < 0 || r.busy_retries > 21) return invalid();
  let observed;
  if (Object.hasOwn(r, 'diagnostics')) {
    const diagnostics = projectContentionDiagnostics(r.diagnostics, r);
    if (!diagnostics) return invalid();
    observed = {diagnostics};
  }
  // Legacy omission remains compatible and denotes unavailable transport.
  // Project only after the original diagnostics validity decision, and never
  // let optional telemetry replace that decision (including a helper throw).
  if (Object.hasOwn(r, 'progress_transport')) {
    let progress_transport;
    try { progress_transport = projectProgressTransport(r.progress_transport); }
    catch { progress_transport = {status: 'diagnostic_invalid'}; }
    observed = {...observed, progress_transport};
  }
  if (r.ok) {
    if (!Number.isSafeInteger(r.replays) || r.replays < 0 || r.replays > 1) return invalid();
    return {ok: true, busy_retries: r.busy_retries, replays: r.replays, ...observed};
  }
  return {...controlWorkerReport(text), busy_retries: r.busy_retries, ...observed};
}
