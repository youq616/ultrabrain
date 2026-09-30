/** Real Node/OS worker lifecycles, deliberately independent of queue filesystems. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {captureWorkerBatch} from './helpers/capture-worker-batch.mjs';
import {controlWorkerReport} from './helpers/capture-control-report.mjs';
const path = fileURLToPath(new URL('./fixtures/capture-supervised-worker.mjs', import.meta.url));
function setup(t, mode, options = {}) {
  const children = [];
  const batch = captureWorkerBatch({count: 8, staged: mode === 'control', parseReport: controlWorkerReport,
    spawnWorker: () => { const child = spawn(process.execPath, [path, mode], {stdio: ['ignore', 'pipe', 'pipe', 'ipc']}); children.push(child); return child; }, ...options});
  t.after(() => batch.shutdown()); return {batch, children};
}
for (const mode of ['writers', 'control']) test('worker native: all eight children complete the exact protocol: ' + mode, async t => {
  const {batch, children} = setup(t, mode);
  await batch.ready(); batch.start(worker => ({worker}));
  if (mode === 'control') { await batch.staged(); batch.resume(() => ({resume: true})); }
  const outcomes = await batch.outcomes(); assert.equal(outcomes.length, 8);
  assert.ok(outcomes.every(r => r.valid && r.lifecycle.closed && r.lifecycle.ready));
  const result = await batch.shutdown(); assert.equal(result.all_closed, true); assert.equal(result.timed_out, false);
  assert.ok(children.every(c => c.exitCode === 0 && c.signalCode === null));
});
for (const mode of ['exit-before-ready', 'disconnect-before-ready', 'bad-ready'])
  test('worker native: failed startup is reaped and never accepted: ' + mode, async t => {
    const {batch, children} = setup(t, mode); await assert.rejects(batch.ready());
    const r = await batch.shutdown(); assert.equal(r.all_closed, true); assert.equal(r.timed_out, false);
    assert.equal(r.outcomes.length, 8); assert.ok(r.outcomes.every(o => !o.valid));
    assert.ok(children.every(c => c.exitCode !== null || c.signalCode !== null));
    assert.ok(!JSON.stringify(r).includes('PRIVATE'));
  });
for (const mode of ['overflow', 'stderr', 'hang-after-start'])
  test('worker native: post-dispatch failure never becomes a completed batch: ' + mode, async t => {
    const {batch, children} = setup(t, mode, mode === 'hang-after-start' ? {timeoutMs: 3000} : {});
    await batch.ready(); batch.start(worker => ({worker})); await assert.rejects(batch.outcomes());
    const r = await batch.shutdown(); assert.equal(r.all_closed, true); assert.ok(r.outcomes.every(o => !o.valid));
    assert.equal(r.timed_out, mode === 'hang-after-start');
    assert.ok(children.every(c => c.exitCode !== null || c.signalCode !== null));
    assert.ok(!JSON.stringify(r).includes('PRIVATE'));
  });
