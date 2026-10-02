/** Bounded observations for the fixed synthetic contention fixture only.
 * Observations never decide retries, authorization, ownership, or completion. */
import {performance} from 'node:perf_hooks';

export const CONTENTION_ROUND_FORMAT = 'ultrabrain-capture-contention-round-v1';
export const CONTENTION_TEST_NAME = 'contention: real 8-process start barrier preserves unique events and shared replay';
const terminals = new Set(['complete', 'retry_limit', 'deadline', 'non_busy_error', 'setup_error']);
const outcomes = new Set(['accepted', 'replayed', 'busy', 'error']);
const keys = ['version', 'event_index', 'completed_events', 'elapsed_ms', 'timing_saturated', 'terminal', 'attempts'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;

/** Trusted clock port permits deterministic unit tests; it is not profile input. */
export function createContentionDiagnostics(now = () => performance.now()) {
  const start = now(), attempts = [];
  let active, eventIndex = null, completed = 0, saturated = false;
  const milliseconds = duration => {
    if (!Number.isFinite(duration) || duration < 0) throw Error('invalid_diagnostic_clock');
    if (duration > 60000) saturated = true;
    return Math.min(60000, Math.floor(duration));
  };
  return {
    begin(event, attempt) {
      if (active || attempts.length >= 24 || !integer(event, 0, 2) || !integer(attempt, 1, 8))
        throw Error('invalid_diagnostic_attempt');
      eventIndex = event;
      active = [event, attempt, now()];
    },
    finish(outcome) {
      if (!active || !outcomes.has(outcome)) throw Error('invalid_diagnostic_outcome');
      attempts.push([active[0], active[1], milliseconds(now() - active[2]), outcome]);
      active = undefined;
      if (outcome === 'accepted' || outcome === 'replayed') completed++;
    },
    end(terminal) {
      if (active || !terminals.has(terminal)) throw Error('invalid_diagnostic_terminal');
      const elapsed = milliseconds(now() - start);
      return {version: 1, event_index: eventIndex, completed_events: completed, elapsed_ms: elapsed,
        timing_saturated: saturated, terminal, attempts: attempts.map(row => [...row])};
    }
  };
}

/** Serialized reports are untrusted. Return only a checked fixed projection. */
export function projectContentionDiagnostics(value, report) {
  if (!object(value) || Object.keys(value).length !== keys.length ||
      !keys.every(key => Object.hasOwn(value, key)) || value.version !== 1 ||
      !(value.event_index === null || integer(value.event_index, 0, 2)) ||
      !integer(value.completed_events, 0, 3) || !integer(value.elapsed_ms, 0, 60000) ||
      typeof value.timing_saturated !== 'boolean' || !terminals.has(value.terminal) ||
      !Array.isArray(value.attempts) || value.attempts.length > 24 ||
      Buffer.byteLength(JSON.stringify(value)) > 2048 || !object(report) ||
      typeof report.ok !== 'boolean' || !integer(report.busy_retries, 0, 21)) return null;

  let event = 0, attempt = 1, completed = 0, busy = 0, replays = 0, elapsedSum = 0;
  const rows = [];
  for (const row of value.attempts) {
    if (!Array.isArray(row) || row.length !== 4 || row[0] !== event || row[1] !== attempt ||
        !integer(row[0], 0, 2) || !integer(row[1], 1, 8) || !integer(row[2], 0, 60000) ||
        !outcomes.has(row[3])) return null;
    rows.push([...row]); elapsedSum += row[2];
    if (row[3] === 'accepted' || row[3] === 'replayed') {
      completed++; event++; attempt = 1; replays += Number(row[3] === 'replayed');
    } else {
      if (row[3] === 'busy') busy++;
      else if (rows.length !== value.attempts.length) return null;
      attempt++;
    }
  }
  const last = rows.at(-1);
  if (value.completed_events !== completed || value.event_index !== (last?.[0] ?? null) ||
      (!value.timing_saturated && elapsedSum > value.elapsed_ms) ||
      (value.timing_saturated && value.elapsed_ms !== 60000)) return null;
  // Only the middle, shared event can replay in this fixed synthetic sequence.
  if (rows.some(row => row[3] === 'replayed' && row[0] !== 1)) return null;
  if (value.terminal === 'complete') {
    if (!report.ok || completed !== 3 || busy !== report.busy_retries ||
        !integer(report.replays, 0, 1) || replays !== report.replays) return null;
  } else {
    if (report.ok || completed > 2) return null;
    if (value.terminal === 'setup_error') {
      if (rows.length !== 0 || report.busy_retries !== 0) return null;
    } else if (value.terminal === 'non_busy_error') {
      if (last?.[3] !== 'error' || busy !== report.busy_retries || report.code === 'outbox_busy') return null;
    } else {
      if (last?.[3] !== 'busy' || report.code !== 'outbox_busy' || busy - 1 !== report.busy_retries ||
          (value.terminal === 'retry_limit' ? last[1] !== 8 : last[1] >= 8 || value.elapsed_ms < 10000)) return null;
    }
  }
  return {version: 1, event_index: value.event_index, completed_events: completed,
    elapsed_ms: value.elapsed_ms, timing_saturated: value.timing_saturated,
    terminal: value.terminal, attempts: rows};
}

/** A legacy-compatible parsed result alone is not qualified new-run evidence. */
export function contentionRoundEvidence(round) {
  const invalid = reason => ({complete: false, passed: false, reported_workers: 0,
    shutdown_unavailable_workers: 0, reason});
  if (!object(round) || round.diagnostic_format !== CONTENTION_ROUND_FORMAT ||
      typeof round.passed !== 'boolean' || !['writers', 'integrity'].includes(round.stage) ||
      !Array.isArray(round.outcomes) || round.outcomes.length !== 8)
    return invalid('missing_round_or_outcomes');
  if (round.timed_out === true) return invalid('supervisor_timeout');
  if (Object.hasOwn(round, 'timed_out') && round.timed_out !== false) return invalid('invalid_timeout_state');
  if (round.workers_closed === false || round.cleanup_skipped === true) return invalid('unconfirmed_shutdown');
  if (Object.hasOwn(round, 'cleanup')) return invalid('cleanup_failure');
  let reported = 0, unavailable = 0, replayTotal = 0, retryTotal = 0, failedReports = 0;
  const workers = new Set();
  for (const outcome of round.outcomes) {
    if (!object(outcome) || !integer(outcome.worker, 0, 7) || workers.has(outcome.worker) ||
        !object(outcome.lifecycle) || outcome.lifecycle.closed !== true || !object(outcome.result))
      return invalid('invalid_outcome');
    workers.add(outcome.worker);
    if (outcome.lifecycle.issue === 'timed_out') return invalid('supervisor_timeout');
    if (![null, 'stopped', 'worker_exit_failed'].includes(outcome.lifecycle.issue))
      return invalid('supervisor_infrastructure_failure');
    const killed = outcome.valid === false && outcome.exit === null && outcome.signal === 'SIGKILL' &&
      outcome.lifecycle.termination_requested === true && outcome.lifecycle.termination_unconfirmed === false;
    if (killed && !Object.hasOwn(outcome.result, 'diagnostics')) {
      if (round.passed) return invalid('killed_worker_in_passing_round');
      unavailable++; continue;
    }
    if (!projectContentionDiagnostics(outcome.result.diagnostics, outcome.result))
      return invalid('missing_or_invalid_diagnostics');
    if (outcome.signal !== null || outcome.exit !== (outcome.result.ok ? 0 : 1))
      return invalid('inconsistent_completion');
    if (round.passed && (outcome.valid !== true || outcome.result.ok !== true))
      return invalid('invalid_passing_outcome');
    if (outcome.result.ok) replayTotal += outcome.result.replays;
    else failedReports++;
    retryTotal += outcome.result.busy_retries;
    reported++;
  }
  if (reported === 0) return invalid('no_completed_worker_diagnostics');
  if (!round.passed && round.stage === 'writers' && failedReports === 0)
    return invalid('no_completed_failure_diagnostic');
  if (round.passed && (round.stage !== 'integrity' || round.writers !== 8 || round.requests !== 24 ||
      round.records !== 17 || round.identical_replays !== 7 || replayTotal !== 7 ||
      round.busy_retries !== retryTotal)) return invalid('invalid_integrity_summary');
  return {complete: true, passed: round.passed, reported_workers: reported,
    shutdown_unavailable_workers: unavailable, reason: null};
}

/** Fixed flat Node TAP contract: complete suite, one named result and one round.
 * This is intentionally not a general TAP parser. Unsupported shapes fail closed. */
export function contentionTapEvidence(text) {
  const invalid = reason => ({complete: false, passed: false, reason});
  if (typeof text !== 'string' || Buffer.byteLength(text) > 1024 * 1024)
    return invalid('missing_or_oversized_tap');
  const lines = text.split(/\r?\n/), rounds = [], results = [], plans = [], summary = new Map();
  if (lines[0] !== 'TAP version 13') return invalid('missing_tap_header');
  for (const [index, line] of lines.entries()) {
    if (/^\s*Bail out!/i.test(line)) return invalid('tap_bailout');
    const result = /^(not ok|ok) ([1-9][0-9]*) - (.+)$/.exec(line);
    if (result) results.push({index, passed: result[1] === 'ok', id: Number(result[2]), name: result[3]});
    const plan = /^1\.\.([0-9]+)$/.exec(line);
    if (plan) plans.push({index, count: Number(plan[1])});
    const total = /^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) ([0-9]+(?:\.[0-9]+)?)$/.exec(line);
    if (total) {
      if (summary.has(total[1])) return invalid('duplicate_tap_summary');
      summary.set(total[1], {index, value: Number(total[2])});
    }
    if (!line.startsWith('# {') || !line.includes(CONTENTION_ROUND_FORMAT)) continue;
    try { rounds.push({index, value: JSON.parse(line.slice(2))}); }
    catch { return invalid('invalid_round_json'); }
  }
  if (rounds.length !== 1) return invalid('missing_or_ambiguous_round');
  if (plans.length !== 1 || !integer(plans[0].count, 1, 1000) || results.length !== plans[0].count ||
      results.some((result, index) => result.id !== index + 1 || result.index >= plans[0].index) ||
      rounds[0].index >= plans[0].index || summary.size !== 8 ||
      [...summary.values()].some(item => item.index <= plans[0].index || !Number.isFinite(item.value)))
    return invalid('incomplete_or_inconsistent_tap');
  const totals = Object.fromEntries([...summary].map(([key, item]) => [key, item.value]));
  if (totals.cancelled !== 0) return invalid('tap_cancelled');
  if (totals.suites !== 0 || totals.skipped !== 0 || totals.todo !== 0)
    return invalid('unsupported_or_skipped_tap');
  const failed = results.filter(result => !result.passed);
  if (totals.tests !== results.length || totals.fail !== failed.length || totals.pass !== results.length - failed.length)
    return invalid('inconsistent_tap_totals');
  const named = results.filter(result => result.name === CONTENTION_TEST_NAME);
  if (named.length !== 1) return invalid('missing_or_ambiguous_contention_test');
  const evidence = contentionRoundEvidence(rounds[0].value);
  if (!evidence.complete) return evidence;
  if (named[0].passed !== evidence.passed) return invalid('round_test_status_mismatch');
  return {...evidence, test_count: totals.tests, suite_passed: failed.length === 0,
    other_failures: failed.filter(result => result.name !== CONTENTION_TEST_NAME).length,
    expected_exit: failed.length === 0 ? 0 : 1};
}

/** Pure classification of the finite pair; no retries or other work are started. */
export function contentionComparisonEvidence(arms, {identityValid, preflightOutcome, expectedTests = 198} = {}) {
  const invalid = interpretation => ({complete: false, passed: false, interpretation});
  if (identityValid !== true || preflightOutcome !== 'success' || !integer(expectedTests, 1, 1000) ||
      !Array.isArray(arms) || arms.length !== 2) return invalid('inconclusive');
  for (const [index, arm] of arms.entries()) {
    if (!object(arm) || arm.name !== ['grouped', 'serialized'][index] || arm.order !== index + 1 ||
        !integer(arm.exit, 0, 255) || arm.outcome !== (arm.exit === 0 ? 'success' : 'failure') ||
        arm.command_complete !== true || !object(arm.evidence) || arm.evidence.complete !== true ||
        arm.evidence.test_count !== expectedTests || arm.evidence.expected_exit !== arm.exit ||
        typeof arm.evidence.passed !== 'boolean' || typeof arm.evidence.suite_passed !== 'boolean' ||
        !integer(arm.evidence.other_failures, 0, expectedTests - 1) ||
        arm.evidence.suite_passed !== (arm.evidence.expected_exit === 0) ||
        arm.evidence.expected_exit !== (arm.evidence.passed && arm.evidence.other_failures === 0 ? 0 : 1))
      return invalid('inconclusive');
  }
  if (arms.some(arm => arm.evidence.other_failures !== 0)) return invalid('other_test_failure_inconclusive');
  const passed = arms.every(arm => arm.exit === 0 && arm.evidence.passed && arm.evidence.suite_passed);
  return {complete: true, passed, interpretation: !arms[1].evidence.passed ? 'serialized_contention_failure_stop' :
    !arms[0].evidence.passed ? 'consistent_with_suite_load_sensitivity' : 'historical_failure_unexplained'};
}
