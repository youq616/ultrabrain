import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {createContentionDiagnostics, projectContentionDiagnostics, contentionRoundEvidence,
  contentionTapEvidence, contentionComparisonEvidence, CONTENTION_ROUND_FORMAT, CONTENTION_TEST_NAME} from './helpers/capture-contention-diagnostics.mjs';
import {contentionWorkerReport} from './helpers/capture-contention-report.mjs';

const clone = value => structuredClone(value);
function sample({terminal = 'complete', retries = 0, replay = true} = {}) {
  const attempts = [];
  let busy = 0, completed = 0;
  const events = terminal === 'setup_error' ? 0 : terminal === 'complete' || terminal === 'retry_limit' ? 3 : 1;
  for (let event = 0; event < events; event++) {
    const final = event === events - 1 && terminal !== 'complete';
    const count = final && terminal === 'retry_limit' ? 7 : retries;
    for (let attempt = 1; attempt <= count; attempt++) { attempts.push([event, attempt, 1, 'busy']); busy++; }
    const result = final ? terminal === 'non_busy_error' ? 'error' : 'busy' : event === 1 && replay ? 'replayed' : 'accepted';
    attempts.push([event, count + 1, 1, result]);
    if (!final) completed++;
  }
  const diagnostics = {version: 1, event_index: attempts.at(-1)?.[0] ?? null,
    completed_events: completed, elapsed_ms: terminal === 'deadline' ? 10000 : attempts.length + 1, timing_saturated: false, terminal, attempts};
  return terminal === 'complete' ? {ok: true, busy_retries: busy, replays: Number(replay), diagnostics} :
    {ok: false, busy_retries: busy, code: ['deadline', 'retry_limit'].includes(terminal) ? 'outbox_busy' : 'outbox_lock_io', diagnostics};
}
function round() {
  return {diagnostic_format: CONTENTION_ROUND_FORMAT, passed: true, stage: 'integrity', writers: 8,
    requests: 24, records: 17, identical_replays: 7, busy_retries: 0,
    outcomes: Array.from({length: 8}, (_, worker) => ({worker, exit: 0, signal: null, valid: true,
      result: sample({replay: worker !== 0}), lifecycle: {closed: true, issue: null, termination_requested: false, termination_unconfirmed: false}}))};
}
function failedRound() {
  const value = round(); value.passed = false; value.stage = 'writers'; value.timed_out = false;
  value.outcomes[0] = {...value.outcomes[0], valid: false, exit: 1, result: sample({terminal: 'retry_limit'}),
    lifecycle: {...value.outcomes[0].lifecycle, issue: 'worker_exit_failed'}};
  value.outcomes[7] = {...value.outcomes[7], valid: false, exit: null, signal: 'SIGKILL',
    result: {ok: false, code: 'invalid_worker_report'},
    lifecycle: {closed: true, issue: 'stopped', termination_requested: true, termination_unconfirmed: false}};
  return value;
}
function tap(value, {otherFailure = false, cancelled = 0, skipped = 0, testPassed = value.passed} = {}) {
  const fails = Number(!testPassed) + Number(otherFailure);
  return ['TAP version 13', `${testPassed ? 'ok' : 'not ok'} 1 - ${CONTENTION_TEST_NAME}`,
    '# ' + JSON.stringify(value), `${otherFailure ? 'not ok' : 'ok'} 2 - other capture contract`,
    '1..2', '# tests 2', '# suites 0', '# pass ' + (2 - fails), '# fail ' + fails,
    '# cancelled ' + cancelled, '# skipped ' + skipped, '# todo 0', '# duration_ms 100'].join('\n') + '\n';
}
function pair(grouped, serialized) {
  return [grouped, serialized].map((evidence, index) => ({name: ['grouped', 'serialized'][index], order: index + 1,
    evidence, exit: evidence.expected_exit ?? 1, outcome: evidence.expected_exit === 0 ? 'success' : 'failure', command_complete: true}));
}
const compare = arms => contentionComparisonEvidence(arms, {identityValid: true, preflightOutcome: 'success', expectedTests: 2});

for (const terminal of ['complete', 'retry_limit', 'deadline', 'non_busy_error', 'setup_error']) {
  test('contention diagnostics: project valid ' + terminal, () => {
    const value = sample({terminal});
    assert.deepEqual(projectContentionDiagnostics(value.diagnostics, value), value.diagnostics);
    assert.deepEqual(contentionWorkerReport(JSON.stringify(value)).diagnostics, value.diagnostics);
  });
}
test('contention diagnostics: pure recorder preserves finite ordered observations', () => {
  let time = 0;
  const recorder = createContentionDiagnostics(() => time);
  recorder.begin(0, 1); time = 2.9; recorder.finish('busy');
  time = 28; recorder.begin(0, 2); time = 30.9; recorder.finish('accepted');
  recorder.begin(1, 1); time = 33; recorder.finish('replayed');
  recorder.begin(2, 1); time = 35; recorder.finish('accepted');
  const observed = recorder.end('complete');
  assert.deepEqual(observed.attempts, [[0, 1, 2, 'busy'], [0, 2, 2, 'accepted'], [1, 1, 2, 'replayed'], [2, 1, 2, 'accepted']]);
  assert.equal(observed.elapsed_ms, 35);
  assert.ok(projectContentionDiagnostics(observed, {ok: true, busy_retries: 1, replays: 1}));
  observed.attempts[0][2] = 999;
  assert.equal(recorder.end('complete').attempts[0][2], 2);
});
test('contention diagnostics: saturation is explicit and never a control budget', () => {
  let time = 0;
  const recorder = createContentionDiagnostics(() => time);
  recorder.begin(0, 1); time = 60001; recorder.finish('accepted');
  recorder.begin(1, 1); time++; recorder.finish('accepted');
  recorder.begin(2, 1); time++; recorder.finish('accepted');
  const observed = recorder.end('complete');
  assert.equal(observed.elapsed_ms, 60000); assert.equal(observed.attempts[0][2], 60000);
  assert.equal(observed.timing_saturated, true);
  assert.ok(projectContentionDiagnostics(observed, {ok: true, busy_retries: 0, replays: 0}));
});
test('contention diagnostics: recorder rejects overlapping or out-of-range attempts', () => {
  const recorder = createContentionDiagnostics(() => 0);
  assert.throws(() => recorder.begin(3, 1));
  assert.throws(() => recorder.begin(0, 9));
  recorder.begin(0, 1);
  assert.throws(() => recorder.begin(0, 2));
  assert.throws(() => recorder.end('complete'));
  assert.throws(() => recorder.finish('PRIVATE'));
});

const invalidMutations = {
  unknown_key: r => { r.diagnostics.path = 'PRIVATE_PATH'; },
  missing_key: r => { delete r.diagnostics.terminal; },
  null_diagnostic: r => { r.diagnostics = null; },
  unknown_version: r => { r.diagnostics.version = 2; },
  negative_time: r => { r.diagnostics.elapsed_ms = -1; },
  fractional_time: r => { r.diagnostics.elapsed_ms = 1.5; },
  excessive_time: r => { r.diagnostics.elapsed_ms = 60001; },
  false_saturation: r => { r.diagnostics.timing_saturated = true; },
  impossible_total_time: r => { r.diagnostics.elapsed_ms = 0; },
  wrong_completed: r => { r.diagnostics.completed_events = 2; },
  wrong_event_index: r => { r.diagnostics.event_index = 0; },
  wrong_event_order: r => { r.diagnostics.attempts[0][0] = 1; },
  wrong_attempt_order: r => { r.diagnostics.attempts[0][1] = 2; },
  extra_tuple_field: r => { r.diagnostics.attempts[0].push('PRIVATE'); },
  malformed_tuple: r => { r.diagnostics.attempts[0] = {}; },
  unknown_outcome: r => { r.diagnostics.attempts[0][3] = 'PRIVATE'; },
  replay_wrong_event: r => { r.diagnostics.attempts[0][3] = 'replayed'; },
  excessive_tuple_time: r => { r.diagnostics.attempts[0][2] = 60001; },
  success_after_error: r => { r.diagnostics.attempts[0][3] = 'error'; },
  too_many_attempts: r => { r.diagnostics.attempts = Array(25).fill([0, 1, 0, 'busy']); },
  wrong_retries: r => { r.busy_retries = 1; },
  wrong_replays: r => { r.replays = 0; },
  contradictory_success: r => { r.ok = false; },
  unknown_terminal: r => { r.diagnostics.terminal = 'PRIVATE'; }
};
for (const [name, mutate] of Object.entries(invalidMutations)) {
  test('contention diagnostics: reject ' + name, () => {
    const value = sample(); mutate(value);
    assert.deepEqual(contentionWorkerReport(JSON.stringify(value)), {ok: false, code: 'invalid_worker_report'});
  });
}
test('contention diagnostics: failure reason and retry counters must agree', () => {
  for (const [terminal, mutate] of [
    ['retry_limit', r => { r.diagnostics.terminal = 'deadline'; }],
    ['deadline', r => { r.diagnostics.terminal = 'retry_limit'; }],
    ['deadline', r => { r.busy_retries++; }],
    ['deadline', r => { r.diagnostics.elapsed_ms = 9999; }],
    ['deadline', r => { r.code = 'outbox_lock_io'; }],
    ['non_busy_error', r => { r.code = 'outbox_busy'; }],
    ['setup_error', r => { r.busy_retries = 1; }]
  ]) {
    const value = sample({terminal}); mutate(value);
    assert.equal(projectContentionDiagnostics(value.diagnostics, value), null);
  }
});
test('contention diagnostics: maximum valid reports fit unchanged stdout cap including newline', t => {
  const read = {kind: 'profile', phase: 'handle-before', reason: 'permissions', system_code: 'ENAMETOOLONG', close_failed: true};
  const lock = {kind: 'delivery', phase: 'directory-sync', system_code: 'ENAMETOOLONG', file_read: read,
    retirement: {namespace_state: 'not_released', close_failed: true}};
  const journal = {target: 'binding', operation: 'replace', phase: 'temporary-unlink', system_code: 'ENAMETOOLONG',
    publication: 'not_attempted', directory_sync: 'not_attempted',
    secondary: Array.from({length: 2}, () => ({phase: 'temporary-unlink', system_code: 'ENAMETOOLONG'})),
    lock_release: [lock, lock]};
  let maxBytes = 0, maxDiagnostic = 0;
  for (const terminal of ['complete', 'retry_limit', 'non_busy_error']) {
    const value = sample({terminal: terminal === 'non_busy_error' ? 'retry_limit' : terminal, retries: 7});
    if (terminal === 'non_busy_error') {
      value.diagnostics.terminal = terminal;
      value.diagnostics.attempts.at(-1)[3] = 'error';
      value.code = 'outbox_journal_io';
    }
    value.diagnostics.elapsed_ms = 60000; value.diagnostics.timing_saturated = true;
    value.diagnostics.attempts.forEach(row => { row[2] = 60000; });
    if (!value.ok) Object.assign(value, {lock, journal, native_code: 'ENAMETOOLONG', syscall: 'realpath', target: 'queue-lock'});
    const bytes = Buffer.byteLength(JSON.stringify(value) + '\n');
    maxBytes = Math.max(maxBytes, bytes);
    maxDiagnostic = Math.max(maxDiagnostic, Buffer.byteLength(JSON.stringify(value.diagnostics)));
    assert.equal(value.diagnostics.attempts.length, 24);
    assert.ok(Buffer.byteLength(JSON.stringify(value.diagnostics)) <= 2048);
    assert.ok(bytes <= 4096, String(bytes));
    assert.ok(contentionWorkerReport(JSON.stringify(value) + '\n').diagnostics);
  }
  t.diagnostic(JSON.stringify({max_tested_stdout_bytes_including_newline: maxBytes, max_tested_diagnostic_bytes: maxDiagnostic}));
});
test('contention diagnostics: legacy reports remain projected and arbitrary fields stay private', () => {
  assert.deepEqual(contentionWorkerReport('{"ok":true,"busy_retries":21,"replays":1,"path":"PRIVATE"}'),
    {ok: true, busy_retries: 21, replays: 1});
  const value = {...sample({terminal: 'deadline'}), path: 'PRIVATE_PATH', message: 'PRIVATE_TOKEN'};
  const parsed = contentionWorkerReport(JSON.stringify(value));
  assert.ok(parsed.diagnostics); assert.ok(!JSON.stringify(parsed).includes('PRIVATE'));
  assert.deepEqual(contentionWorkerReport(' '.repeat(4096) + JSON.stringify(value)), {ok: false, code: 'invalid_worker_report'});
  assert.deepEqual(contentionWorkerReport(JSON.stringify(value), {overflow: true}), {ok: false, code: 'invalid_worker_report'});
});

test('contention evidence: success requires all eight valid diagnostic reports and exact counters', () => {
  assert.deepEqual(contentionRoundEvidence(round()), {complete: true, passed: true, reported_workers: 8,
    shutdown_unavailable_workers: 0, reason: null});
  for (const mutate of [
    r => { delete r.outcomes[0].result.diagnostics; }, r => { r.outcomes[0].valid = false; },
    r => { r.outcomes[0].exit = 1; }, r => { r.outcomes[0].worker = 1; },
    r => { r.outcomes.pop(); }, r => { r.outcomes[0].lifecycle.closed = false; },
    r => { r.records = 16; }, r => { r.busy_retries = 1; },
    r => { r.outcomes[1].result = sample({replay: false}); }, r => { delete r.diagnostic_format; }
  ]) {
    const value = round(); mutate(value);
    assert.equal(contentionRoundEvidence(value).complete, false);
    assert.equal(contentionRoundEvidence(value).passed, false);
  }
});
test('contention evidence: genuine failure diagnostics remain distinct from killed-sibling unavailability', () => {
  const value = failedRound();
  assert.deepEqual(contentionRoundEvidence(value), {complete: true, passed: false, reported_workers: 7,
    shutdown_unavailable_workers: 1, reason: null});
  const absent = clone(value); delete absent.outcomes[0].result.diagnostics;
  assert.equal(contentionRoundEvidence(absent).complete, false);
  const unconfirmed = clone(value); unconfirmed.outcomes[7].lifecycle.termination_unconfirmed = true;
  assert.equal(contentionRoundEvidence(unconfirmed).complete, false);
  value.passed = true;
  assert.equal(contentionRoundEvidence(value).passed, false);
});
test('contention evidence: TAP requires exactly one identified round and bounded input', () => {
  const line = '# ' + JSON.stringify(round());
  assert.equal(contentionTapEvidence(tap(round()).replaceAll('\n', '\r\n')).passed, true);
  for (const text of [null, '', '# no round', line + '\n' + line,
    '# {"diagnostic_format":"' + CONTENTION_ROUND_FORMAT + '"', 'x'.repeat(1048577)]) {
    assert.equal(contentionTapEvidence(text).complete, false);
    assert.equal(contentionTapEvidence(text).passed, false);
  }
});
for (const variant of ['partial_workers_timeout', 'last_close_timeout', 'unconfirmed_shutdown', 'infrastructure_failure', 'cleanup_failure']) {
  test('contention evidence: ' + variant + ' remains inconclusive', () => {
    let value = failedRound();
    if (variant === 'partial_workers_timeout') value.timed_out = true;
    if (variant === 'last_close_timeout') {
      value = round(); value.passed = false; value.stage = 'writers';
      value.outcomes[7].valid = false; value.outcomes[7].lifecycle.issue = 'timed_out';
    }
    if (variant === 'unconfirmed_shutdown') value.cleanup_skipped = true;
    if (variant === 'infrastructure_failure') value.outcomes[7].lifecycle.issue = 'ipc_send_failed';
    if (variant === 'cleanup_failure') value.cleanup = {code: 'writer_failed'};
    assert.equal(contentionRoundEvidence(value).complete, false);
    const evidence = contentionTapEvidence(tap(value));
    assert.equal(evidence.complete, false);
    for (const arms of [pair(evidence, contentionTapEvidence(tap(round()))), pair(contentionTapEvidence(tap(round())), evidence)])
      assert.deepEqual(compare(arms), {complete: false, passed: false, interpretation: 'inconclusive'});
  });
}
for (const [name, mutate] of [
  ['cancelled', text => text.replace('# cancelled 0', '# cancelled 1')],
  ['bailout', text => text + 'Bail out! stopped\n'],
  ['truncated', text => text.slice(0, text.indexOf('1..2'))],
  ['missing_duration', text => text.replace('# duration_ms 100\n', '')],
  ['duplicate_summary', text => text + '# tests 2\n'],
  ['wrong_plan', text => text.replace('1..2', '1..3')],
  ['wrong_totals', text => text.replace('# pass 2', '# pass 1')],
  ['missing_named_test', text => text.replace(CONTENTION_TEST_NAME, 'different test')],
  ['skipped', text => text.replace('# skipped 0', '# skipped 1')]
]) {
  test('contention TAP: reject ' + name, () => {
    const evidence = contentionTapEvidence(mutate(tap(round())));
    assert.equal(evidence.complete, false);
    assert.equal(compare(pair(evidence, contentionTapEvidence(tap(round())))).interpretation, 'inconclusive');
  });
}
test('contention TAP: round and named-test status must agree', () => {
  assert.equal(contentionTapEvidence(tap(round(), {testPassed: false})).complete, false);
  assert.equal(contentionTapEvidence(tap(failedRound(), {testPassed: true})).complete, false);
});
test('contention comparison: success, pure contention failure, and mixed/unrelated failure are distinct', () => {
  const success = contentionTapEvidence(tap(round()));
  const failed = contentionTapEvidence(tap(failedRound()));
  const mixed = contentionTapEvidence(tap(failedRound(), {otherFailure: true}));
  const unrelated = contentionTapEvidence(tap(round(), {otherFailure: true}));
  assert.equal(mixed.other_failures, 1); assert.equal(unrelated.other_failures, 1);
  assert.deepEqual(compare(pair(success, success)), {complete: true, passed: true, interpretation: 'historical_failure_unexplained'});
  assert.deepEqual(compare(pair(failed, success)), {complete: true, passed: false, interpretation: 'consistent_with_suite_load_sensitivity'});
  assert.deepEqual(compare(pair(success, failed)), {complete: true, passed: false, interpretation: 'serialized_contention_failure_stop'});
  for (const value of [mixed, unrelated]) for (const arms of [pair(value, success), pair(success, value), pair(value, failed)])
    assert.deepEqual(compare(arms), {complete: false, passed: false, interpretation: 'other_test_failure_inconclusive'});
});
test('contention comparison: command status, TAP exit, test count, preflight and identity must agree', () => {
  const success = contentionTapEvidence(tap(round()));
  for (const mutate of [
    arms => { arms[0].exit = 1; arms[0].outcome = 'failure'; },
    arms => { arms[0].outcome = 'failure'; }, arms => { arms[0].command_complete = false; },
    arms => { arms[0].evidence.test_count = 198; }, arms => { arms[0].order = 2; },
    arms => { arms[0].evidence.suite_passed = false; }
  ]) {
    const arms = clone(pair(success, success)); mutate(arms);
    assert.equal(compare(arms).interpretation, 'inconclusive');
  }
  for (const options of [{identityValid: false, preflightOutcome: 'success'}, {identityValid: true, preflightOutcome: 'failure'}])
    assert.equal(contentionComparisonEvidence(pair(success, success), {...options, expectedTests: 2}).interpretation, 'inconclusive');
  assert.equal(contentionComparisonEvidence(pair(success, success), {identityValid: true, preflightOutcome: 'success'}).interpretation, 'inconclusive');
});
test('contention source: retry decision precedes new observation and retains original short circuits', () => {
  const source = readFileSync(new URL('./fixtures/capture-contention-worker.mjs', import.meta.url), 'utf8');
  const decision = "const reason=error?.code!=='outbox_busy'?'non_busy_error':retries>=7?'retry_limit':performance.now()>=deadline?'deadline':null;";
  assert.ok(source.includes(decision));
  assert.ok(source.indexOf(decision) < source.indexOf("diagnostics.finish(error?.code==='outbox_busy'"));
  assert.ok(source.includes('deadline=performance.now()+10000'));
  assert.ok(source.includes('const backoff=25+((worker*37+event*17+retries*29)%96);'));
  assert.ok(source.includes('await delay(backoff);'));
  assert.ok(!source.includes('await delay(25)'));
});
function assertContentionWorkflow(originalText, candidateText) {
  const original = originalText.replaceAll('\r\n', '\n');
  const candidate = candidateText.replaceAll('\r\n', '\n');
  assert.ok(!original.includes('\r'));
  assert.ok(!candidate.includes('\r'));
  const files = original.match(/run: node --test (.*?) > /)[1];
  assert.equal(files.split(' ').length, 16);
  assert.ok(candidate.includes('        ' + files + '\n'));
  assert.equal((candidate.match(/node --test \$\{CAPTURE_TEST_FILES\}/g) ?? []).length, 1);
  assert.equal((candidate.match(/node --test --test-concurrency=1 \$\{CAPTURE_TEST_FILES\}/g) ?? []).length, 1);
  assert.ok(candidate.includes('if: github.run_attempt == 1'));
  assert.ok(candidate.includes('branches: [dev/capture-contention-diagnostics-20261002]'));
  assert.ok(candidate.includes("node-version: '22.23.3'"));
  assert.ok(candidate.includes('timeout-minutes: 8'));
  assert.ok(candidate.includes('contents: read')); assert.ok(candidate.includes('persist-credentials: false'));
  assert.ok(candidate.includes('fetch-depth: 2'));
  assert.ok(candidate.includes("parents.length===1&&parents[0]==='d1c4da2e932a36ce2d019c09ac9004fc80246aa6'"));
  assert.ok(candidate.includes("execFileSync('git',['cat-file','-p','d1c4da2e932a36ce2d019c09ac9004fc80246aa6']"));
  assert.ok(candidate.includes("prior_attempt.tree==='5a9441e7041fad00de6bcec423fa7960f2eeb614'"));
  assert.ok(candidate.includes("prior_attempt.parents.length===1&&prior_attempt.parents[0]==='c379604af7c12a7154ce02b902933e81c2b5a816'"));
  assert.ok(candidate.includes("if: always() && !cancelled() && steps.preflight.outcome == 'success'"));
  assert.ok(candidate.includes('if(!passed)process.exitCode=1;'));
  assert.ok(!candidate.includes('continue-on-error:')); assert.ok(!candidate.includes('workflow_dispatch:'));
  assert.ok(!candidate.includes('pull_request:')); assert.ok(!candidate.includes('schedule:'));
}
const retainedWorkflow = readFileSync(new URL('../.github/workflows/capture-locks.yml', import.meta.url), 'utf8');
const comparisonWorkflow = readFileSync(new URL('../.github/workflows/capture-contention-comparison.yml', import.meta.url), 'utf8');
test('contention workflow: exact retained suite, one pinned pair, minimal permissions, no retries', () => {
  assertContentionWorkflow(retainedWorkflow, comparisonWorkflow);
});
const withLineEndings = (text, ending) => text.replaceAll('\r\n', '\n').replaceAll('\n', ending);
for (const [originalName, originalEnding] of [['LF', '\n'], ['CRLF', '\r\n']]) {
  for (const [candidateName, candidateEnding] of [['LF', '\n'], ['CRLF', '\r\n']]) {
    test(`contention workflow: exact contract accepts ${originalName}/${candidateName}`, () => {
      assertContentionWorkflow(withLineEndings(retainedWorkflow, originalEnding), withLineEndings(comparisonWorkflow, candidateEnding));
    });
  }
}
const retainedFiles = retainedWorkflow.match(/run: node --test (.*?) > /)[1];
const suiteFiles = retainedFiles.split(' ');
const changedWorkflows = {
  omitted_file: text => text.replace(retainedFiles, suiteFiles.slice(1).join(' ')),
  added_file: text => text.replace(retainedFiles, retainedFiles + ' test/extra-contract.test.mjs'),
  reordered_files: text => text.replace(retainedFiles, [suiteFiles[1], suiteFiles[0], ...suiteFiles.slice(2)].join(' ')),
  grouped_command: text => text.replace('node --test ${CAPTURE_TEST_FILES}', 'node --test --test-concurrency=2 ${CAPTURE_TEST_FILES}'),
  serialized_command: text => text.replace('node --test --test-concurrency=1 ${CAPTURE_TEST_FILES}', 'node --test --test-concurrency=2 ${CAPTURE_TEST_FILES}'),
  node_pin: text => text.replace("node-version: '22.23.3'", "node-version: '22.16.0'"),
  suite_indentation: text => text.replace('        ' + retainedFiles, '       ' + retainedFiles),
  command_whitespace: text => text.replace('node --test ${CAPTURE_TEST_FILES}', 'node  --test ${CAPTURE_TEST_FILES}')
};
for (const [name, mutate] of Object.entries(changedWorkflows)) {
  for (const [endingName, ending] of [['LF', '\n'], ['CRLF', '\r\n']]) {
    test(`contention workflow: reject ${name} with ${endingName}`, () => {
      const changed = mutate(comparisonWorkflow);
      assert.notEqual(changed, comparisonWorkflow);
      assert.throws(() => assertContentionWorkflow(withLineEndings(retainedWorkflow, ending), withLineEndings(changed, ending)));
    });
  }
}
for (const source of ['retained', 'comparison']) {
  test(`contention workflow: reject lone CR in ${source} source`, () => {
    assert.throws(() => assertContentionWorkflow(
      withLineEndings(retainedWorkflow, source === 'retained' ? '\r' : '\n'),
      withLineEndings(comparisonWorkflow, source === 'comparison' ? '\r' : '\n')));
  });
}

function runComparisonSummary(overrides = {}) {
  const source = comparisonWorkflow.replaceAll('\r\n', '\n');
  const blocks = [...source.matchAll(/          node --input-type=module <<'NODE'\n([\s\S]*?)          NODE\n/g)];
  assert.equal(blocks.length, 1);
  const lines = blocks[0][1].trimEnd().split('\n');
  assert.ok(lines.every(line => line.startsWith('          ')));
  const script = lines.map(line => line.slice(10)).join('\n');
  assert.ok(script.length < 10000);
  const imports = [
    "import {readFileSync,statSync,writeFileSync} from 'node:fs';",
    "import {join} from 'node:path';",
    "import {availableParallelism} from 'node:os';",
    "import {execFileSync} from 'node:child_process';",
    "import {contentionTapEvidence,contentionComparisonEvidence} from './test/helpers/capture-contention-diagnostics.mjs';"
  ];
  assert.equal(script.split('\n').slice(0, imports.length).join('\n'), imports.join('\n'));
  const body = script.split('\n').slice(imports.length).join('\n');
  assert.ok(!body.includes('import '));
  const head = 'a'.repeat(40), tree = 'b'.repeat(40);
  const prior = 'd1c4da2e932a36ce2d019c09ac9004fc80246aa6';
  const priorTree = '5a9441e7041fad00de6bcec423fa7960f2eeb614';
  const baseline = 'c379604af7c12a7154ce02b902933e81c2b5a816';
  const fixture = {head, headHeader: `tree ${tree}\nparent ${prior}\n\nsynthetic child`,
    priorHeader: `tree ${priorTree}\nparent ${baseline}\n\nsynthetic prior`, ...overrides};
  const resultTap = ['TAP version 13', 'ok 1 - ' + CONTENTION_TEST_NAME, '# ' + JSON.stringify(round()),
    ...Array.from({length: 197}, (_, index) => `ok ${index + 2} - other capture contract ${index + 2}`),
    '1..198', '# tests 198', '# suites 0', '# pass 198', '# fail 0', '# cancelled 0', '# skipped 0', '# todo 0', '# duration_ms 100', ''].join('\n');
  const files = new Map(['grouped', 'serialized'].flatMap(name => [
    ['/synthetic/contention-' + name + '.tap', resultTap], ['/synthetic/contention-' + name + '.exit', '0\n']
  ]));
  const processStub = {version: 'v22.23.3', platform: 'win32', arch: 'x64',
    ...fixture.process, env: {RUNNER_TEMP: '/synthetic', CAPTURE_TEST_FILES: retainedFiles,
      PREFLIGHT_OUTCOME: 'success', GROUPED_OUTCOME: 'success', SERIALIZED_OUTCOME: 'success',
      GITHUB_SHA: head, GITHUB_RUN_ATTEMPT: '1', GITHUB_RUN_ID: 'synthetic', ...fixture.env}};
  const requests = [], writes = [], logs = [];
  const allowedRequests = ['rev-parse HEAD', 'cat-file -p HEAD', 'cat-file -p ' + prior];
  const get = path => { assert.ok(files.has(path)); return files.get(path); };
  runInNewContext(body, {
    process: processStub, console: {log: value => logs.push(value)},
    readFileSync: (path, encoding) => { assert.equal(encoding, 'utf8'); return get(path); },
    statSync: path => ({size: Buffer.byteLength(get(path))}),
    writeFileSync: (path, text) => { assert.equal(path, '/synthetic/contention-comparison.json'); assert.ok(Buffer.byteLength(text) < 16384); writes.push(text); },
    join: (directory, name) => { assert.equal(directory, '/synthetic'); assert.ok(!name.includes('/')); return directory + '/' + name; },
    availableParallelism: () => 8,
    execFileSync: (command, args, options) => {
      assert.equal(command, 'git'); assert.equal(options.encoding, 'utf8');
      const request = args.join(' '); requests.push(request); assert.ok(allowedRequests.includes(request));
      if (request === allowedRequests[0]) return fixture.head;
      if (request === allowedRequests[1]) { if (fixture.headReadFails) throw Error('synthetic unavailable'); return fixture.headHeader; }
      if (fixture.priorReadFails) throw Error('synthetic unavailable');
      return fixture.priorHeader;
    },
    contentionTapEvidence, contentionComparisonEvidence
  }, {timeout: 1000});
  assert.deepEqual(requests, allowedRequests);
  assert.equal(writes.length, 1); assert.equal(logs.length, 1);
  const report = JSON.parse(writes[0]); assert.deepEqual(JSON.parse(logs[0]), report);
  assert.deepEqual(Object.keys(report.prior_attempt), ['head', 'tree', 'parents']);
  assert.ok(report.prior_attempt.parents.length <= 2);
  assert.ok([report.prior_attempt.head, report.prior_attempt.tree, ...report.prior_attempt.parents]
    .every(value => value === null || /^[a-f0-9]{40}$/.test(value)));
  return {report, exitCode: processStub.exitCode};
}
test('contention ancestry: actual summary accepts the exact fixed forward chain', () => {
  const {report, exitCode} = runComparisonSummary();
  assert.equal(report.identity_valid, true); assert.equal(report.complete, true); assert.equal(report.passed, true);
  assert.equal(report.interpretation, 'historical_failure_unexplained'); assert.equal(exitCode, undefined);
  assert.deepEqual(report.prior_attempt, {head: 'd1c4da2e932a36ce2d019c09ac9004fc80246aa6',
    tree: '5a9441e7041fad00de6bcec423fa7960f2eeb614', parents: ['c379604af7c12a7154ce02b902933e81c2b5a816']});
});
const childTreeLine = 'tree ' + 'b'.repeat(40);
const childParentLine = 'parent d1c4da2e932a36ce2d019c09ac9004fc80246aa6';
const priorTreeLine = 'tree 5a9441e7041fad00de6bcec423fa7960f2eeb614';
const priorParentLine = 'parent c379604af7c12a7154ce02b902933e81c2b5a816';
const extraParentLine = 'parent ' + 'c'.repeat(40);
for (const [name, overrides] of Object.entries({
  wrong_child_parent: {headHeader: childTreeLine + '\n' + extraParentLine},
  missing_child_parent: {headHeader: childTreeLine},
  extra_child_parent: {headHeader: childTreeLine + '\n' + childParentLine + '\n' + extraParentLine},
  missing_child_tree: {headHeader: childParentLine},
  malformed_child_tree: {headHeader: 'tree malformed\n' + childParentLine},
  child_read_failure: {headReadFails: true},
  wrong_prior_tree: {priorHeader: childTreeLine + '\n' + priorParentLine},
  missing_prior_tree: {priorHeader: priorParentLine},
  malformed_prior_tree: {priorHeader: 'tree malformed\n' + priorParentLine},
  duplicate_prior_tree: {priorHeader: priorTreeLine + '\n' + priorTreeLine + '\n' + priorParentLine},
  wrong_prior_parent: {priorHeader: priorTreeLine + '\n' + extraParentLine},
  missing_prior_parent: {priorHeader: priorTreeLine},
  malformed_prior_parent: {priorHeader: priorTreeLine + '\nparent malformed'},
  extra_prior_parent: {priorHeader: priorTreeLine + '\n' + priorParentLine + '\n' + extraParentLine},
  many_prior_parents: {priorHeader: priorTreeLine + '\n' + priorParentLine + '\n' + extraParentLine + '\n' + extraParentLine},
  prior_read_failure: {priorReadFails: true},
  wrong_checkout: {head: 'c'.repeat(40)},
  malformed_checkout: {head: 'malformed'},
  wrong_node: {process: {version: 'v22.16.0'}},
  wrong_platform: {process: {platform: 'linux'}},
  second_attempt: {env: {GITHUB_RUN_ATTEMPT: '2'}},
  wrong_github_sha: {env: {GITHUB_SHA: 'c'.repeat(40)}}
})) {
  test('contention ancestry: actual summary rejects ' + name, () => {
    const {report, exitCode} = runComparisonSummary(overrides);
    assert.equal(report.identity_valid, false); assert.equal(report.complete, false); assert.equal(report.passed, false);
    assert.equal(report.interpretation, 'inconclusive'); assert.equal(exitCode, 1);
    if (name === 'prior_read_failure') assert.deepEqual(report.prior_attempt, {head: null, tree: null, parents: []});
  });
}
