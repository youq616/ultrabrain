/** Synthetic writer reports are untrusted JSON, never server receipts. */
import {controlWorkerReport} from './capture-control-report.mjs';
const invalid = () => ({ok: false, code: 'invalid_worker_report'});
export function contentionWorkerReport(text, {overflow = false} = {}) {
  let r;
  try {
    if (!overflow && typeof text === 'string' && Buffer.byteLength(text) <= 4096) r = JSON.parse(text);
  } catch {}
  if (!r || typeof r !== 'object' || Array.isArray(r) || typeof r.ok !== 'boolean' ||
      !Number.isSafeInteger(r.busy_retries) || r.busy_retries < 0 || r.busy_retries > 21) return invalid();
  if (r.ok) {
    if (!Number.isSafeInteger(r.replays) || r.replays < 0 || r.replays > 1) return invalid();
    return {ok: true, busy_retries: r.busy_retries, replays: r.replays};
  }
  return {...controlWorkerReport(text), busy_retries: r.busy_retries};
}
