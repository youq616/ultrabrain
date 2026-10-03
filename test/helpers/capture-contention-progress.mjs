/** Best-effort historical wrapper milestones for the SYNTHETIC contention test.
 * Extra IPC may change failures in either direction. No delivery, lock-state,
 * native lifetime equivalence, or historical failure clearance is implied. */
const integer = (v, lo, hi) => Number.isSafeInteger(v) && v >= lo && v <= hi;
const MAX = 48;
const unavailable = () => ({status: 'unavailable'});
const invalid = () => ({status: 'diagnostic_invalid'});

/** One outstanding send, no queue/timer/listener/retry or callback-driven send.
 * The port is trusted test-only dependency injection, never profile input. */
export function createContentionProgress(port = process) {
  let milestones = 0, sends = 0, pending = false, flags = 0, disabled = false, sealed;
  return {
    observe(event, attempt, phase, outcome) {
      if (milestones === MAX) { flags |= 16; return; }
      const sequence = ++milestones;
      if (sealed || disabled || pending) return;
      // Only fixed bounded primitive values ever enter the IPC serializer.
      if (!integer(event, 0, 2) || !integer(attempt, 1, 8) ||
          !integer(phase, 0, 1) || !integer(outcome, 0, 4) ||
          (phase === 0 ? outcome !== 0 : outcome === 0) || (outcome === 2 && event !== 1)) return;
      try {
        if (typeof port.send !== 'function' || port.connected !== true) {
          flags |= 8; disabled = true; return;
        }
        const frame = {contention_progress: [1, sequence, event, attempt, phase, outcome]};
        pending = true; sends++;
        let settled = false;
        const callback = error => {
          if (settled) return;
          settled = true; pending = false;
          if (error !== null && error !== undefined) { flags |= 4; disabled = true; }
        };
        try {
          if (port.send(frame, callback) === false) { flags |= 1; disabled = true; }
        } catch {
          flags |= 2; disabled = true;
          // A throwing port may still invoke its callback. Keep it outstanding
          // until that callback: no invented settlement, including in doubles.
        }
      } catch { flags |= 8; disabled = true; }
    },
    seal() {
      // Immutable point-in-time capsule; a late callback only changes local flags.
      return sealed ??= Object.freeze([1, milestones, sends, milestones - sends, Number(pending), flags]);
    }
  };
}

function capsule(value) {
  if (!Array.isArray(value) || value.length !== 6 || Object.keys(value).length !== 6 ||
      value[0] !== 1 || !value.slice(1, 4).every(v => integer(v, 0, MAX)) ||
      !integer(value[4], 0, 1) || !integer(value[5], 0, 31) || value[2] > value[1] ||
      value[3] !== value[1] - value[2] || (value[4] === 1 && value[2] === 0)) return null;
  return [1, value[1], value[2], value[3], value[4], value[5]];
}

/** Never serialize a helper's arbitrary return value into the terminal report. */
export function sealContentionProgress(sender) {
  try { return capsule(sender?.seal()); } catch { return null; }
}

/** Missing field means unavailable, not error-free; pending means unconfirmed.
 * Annotation never changes the independently derived queue-report validity. */
export function projectProgressTransport(value) {
  if (value === undefined) return unavailable();
  try {
    const v = capsule(value);
    if (!v) return invalid();
    return {status: 'observed', version: 1, milestones: v[1], send_attempts: v[2], dropped: v[3],
      pending_at_terminal: Boolean(v[4]), tail: v[4] ? 'unconfirmed' : 'none_pending_at_seal',
      send_returned_false: Boolean(v[5] & 1), synchronous_send_throw: Boolean(v[5] & 2),
      callback_error: Boolean(v[5] & 4), channel_unavailable: Boolean(v[5] & 8),
      opportunity_limit_exceeded: Boolean(v[5] & 16)};
  } catch { return invalid(); }
}

/** A possible ordered subsequence, never a reconstruction of dropped history. */
export function readContentionProgress(message, previous = null) {
  try {
    if (!message || typeof message !== 'object' || Array.isArray(message) ||
        Object.keys(message).length !== 1 || !Object.hasOwn(message, 'contention_progress')) return null;
    const v = message.contention_progress;
    if (!Array.isArray(v) || v.length !== 6 || Object.keys(v).length !== 6 || v[0] !== 1 ||
        !integer(v[1], 1, MAX) || !integer(v[2], 0, 2) || !integer(v[3], 1, 8) ||
        !integer(v[4], 0, 1) || !integer(v[5], 0, 4) ||
        v[1] % 2 !== 1 - v[4] || (v[4] === 0 ? v[5] !== 0 : v[5] === 0) ||
        (v[5] === 2 && v[2] !== 1)) return null;
    const [, sequence, event, attempt, phase, outcome] = v;
    const c = (sequence - phase - 1) / 2 - (attempt - 1);
    if (!integer(c, event, 8 * event)) return null;
    if (previous) {
      const [, seq, e, a, p, o] = previous;
      if (sequence <= seq || event < e ||
          (p === 1 && (o === 4 || (o === 3 && a === 8) || ((o === 1 || o === 2) && e === 2)))) return null;
      const priorC = (seq - p - 1) / 2 - (a - 1);
      if (event === e) {
        if (c !== priorC || (p === 1 && (o === 1 || o === 2)) ||
            !(attempt > a || (attempt === a && phase > p))) return null;
      } else {
        const skipped = event - e - 1;
        const min = p === 0 ? a : o === 3 ? a + 1 : a;
        const max = p === 1 && (o === 1 || o === 2) ? a : 8;
        if (c - priorC < min + skipped || c - priorC > max + 8 * skipped) return null;
      }
    }
    return [1, sequence, event, attempt, phase, outcome];
  } catch { return null; }
}

const missingSummary = () => Object.freeze({version: 1, cutoff: 'unavailable', best_effort: true,
  reason: 'diagnostic_unavailable'});

/** Optional pure projection of the supervisor's fixed protocol state. Receipt
 * ordinals order parent arrivals, not emission time or lock chronology. Failure
 * cannot disable or replace the batch's authoritative protocol validation. */
export function projectContentionProgressSummary(state, cutoff) {
  try {
    if (!['first_failure', 'failed_outcomes'].includes(cutoff) ||
        !Array.isArray(state) || state.length !== 8) return missingSummary();
    const slots = state.map((slot, worker) => {
      if (slot.worker !== worker || !integer(slot.received, 0, 48) || typeof slot.gap !== 'boolean' ||
          !integer(slot.receipt, 0, 384) || (slot.received === 0 ? slot.last !== null || slot.receipt !== 0 :
            slot.receipt === 0 || !readContentionProgress({contention_progress: slot.last}))) throw Error('invalid_progress_snapshot');
      return Object.freeze({worker, received: slot.received, gap: slot.gap,
        last: slot.last === null ? null : Object.freeze([...slot.last]), receipt: slot.receipt});
    });
    const projected = {version: 1, cutoff, best_effort: true, slots: Object.freeze(slots)};
    if (Buffer.byteLength(JSON.stringify(projected)) > 2048) return missingSummary();
    return Object.freeze(projected);
  } catch { return missingSummary(); }
}
