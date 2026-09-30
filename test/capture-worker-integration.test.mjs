/** Real OS processes and unchanged queue operations; no user queues or server. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const checker = fileURLToPath(new URL('../scripts/check-capture-contention.mjs', import.meta.url));
const preload = new URL('./fixtures/capture-worker-failure-preload.mjs', import.meta.url).href;
function run(mode, success = false) {
  const r = spawnSync(process.execPath, [checker, '--rounds', '2'], {
    encoding: 'utf8', timeout: 22000, maxBuffer: 65536,
    env: {...process.env, NODE_OPTIONS: '--import ' + preload, ULTRABRAIN_WORKER_CHECK_TEST: mode}
  });
  assert.ifError(r.error); assert.equal(r.signal, null); assert.equal(r.status, success ? 0 : 1);
  assert.equal(r.stderr, ''); assert.ok(!r.stdout.includes('PRIVATE'), 'Raw worker data leaked');
  const report = JSON.parse(r.stdout);
  assert.equal(report.format, 'ultrabrain-capture-contention-v1');
  assert.equal(report.passed, success); assert.equal(report.rounds_requested, 2);
  assert.equal(report.network_calls, 0); assert.equal(report.model_calls, 0); assert.equal(report.user_queue_access, false);
  if (!success) {
    assert.equal(report.rounds.length, 1); assert.equal(report.rounds[0].passed, false);
    assert.equal(report.rounds[0].outcomes.length, 8);
    assert.ok(report.rounds[0].outcomes.every(r => r.lifecycle.closed));
  }
  return report;
}
for (const mode of ['early-exit', 'overflow', 'stderr', 'premature-staged', 'disconnect', 'timeout', 'spawn-throw', 'spawn-enoent'])
  test('worker integration: failed startup retains the entire round: ' + mode, () => {
    const report = run(mode); const round = report.rounds[0];
    assert.equal(round.stage, 'ready');
    assert.ok(round.outcomes.some(r => !r.valid && r.lifecycle.issue));
    assert.equal(round.timed_out, mode === 'timeout');
  });
test('worker integration: IPC send callback failure is fatal and bounded', () => {
  const round = run('send-error').rounds[0];
  assert.equal(round.stage, 'writers');
  assert.equal(round.outcomes[3].lifecycle.issue, 'ipc_send_failed');
});
test('worker integration: IPC backpressure is not a failed send or retry', () => {
  const report = run('backpressure', true);
  assert.equal(report.rounds.length, 2);
  for (const r of report.rounds) {
    assert.equal(r.passed, true); assert.equal(r.records, 17); assert.equal(r.identical_replays, 7);
  }
});
test('worker integration: native EPERM stays fatal but arbitrary worker fields are dropped', () => {
  const round = run('report-extra').rounds[0];
  assert.equal(round.stage, 'writers');
  const failed = round.outcomes[4]; assert.equal(failed.exit, 1); assert.equal(failed.valid, false);
  assert.equal(failed.result.code, 'outbox_lock_io');
  assert.deepEqual(failed.result.lock, {kind: 'queue', phase: 'create', system_code: 'EPERM'});
});
