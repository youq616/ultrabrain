# Capture-contention boundary checklist

This is an implementation boundary checklist, not an independent review verdict.
Independent exact-source review and public-parent binding are publication gates.

- Production capture/lock/journal/retirement files are unchanged
- Existing capture workflows and the worker supervisor are unchanged
- Eight writers, acquisition/retry/deadline limits and integrity assertions remain
- New observations use fixed projections and never control retries or ownership
- Original short-circuit decisions precede diagnostic recording
- Successful real-test results require eight valid diagnostic-bearing outcomes
- Missing normally completed reports differ from explicitly shutdown-killed siblings
- Supervisor timeouts and infrastructure failures remain inconclusive with any report count
- Complete TAP, named-test status, suite counters and command exit must agree
- Mixed contention and unrelated test failures cannot imply suite-load sensitivity
- Original failed TAP is byte-identical; no failure is reclassified as passing
- The Windows experiment is one pinned, finite grouped/serialized pair
- Both exit codes and TAP outputs survive a grouped failure
- A failed arm keeps the workflow red; missing evidence is inconclusive
- Public comparison metadata checks actual checkout/tree, sole prior-attempt parent,
  and the prior attempt's exact tree and sole original-baseline parent
- No automatic retry, new production probe, public PR, merge or deployment is added

Local Linux Node 24.19.0 validation passed 114 focused tests, including the actual
eight-writer contention case and existing supervisor unit contracts. The evidence
gate qualified all eight diagnostic reports. The tested maximum-size reports were
1,877 bytes including newline, with a 599-byte diagnostic, below the unchanged
4,096-byte report and new 2,048-byte diagnostic limits. Workflow YAML, Bash snippets
and summary JavaScript passed syntax checks. Exact commands and source hashes are
in `evidence.json`.

Pure negative-case coverage includes partial-worker supervisor timeout,
deadline-crossing close, mixed/unrelated failures, cancellation, bailout,
truncation, mismatched test/round status and contradictory command exit metadata.
These are deterministic report-classification tests, not new process-failure
injections or another Windows experiment.

At the initial source checkpoint, the paired Windows experiment had not run.
Those local checks did not resolve the retained Windows failure or qualify
repository-wide CI.


## Retained first diagnostic attempt and source portability correction

The first diagnostic attempt at `d1c4da2e932a36ce2d019c09ac9004fc80246aa6`
([run 37011687612](https://github.com/youq616/ultrabrain/actions/runs/37011687612))
failed its pure preflight: 57 tests, 56 passed, one failed. The exact suite-line
assertion required an LF suffix. Both grouped and serialized arms were skipped;
the saved result is failed and inconclusive. CRLF checkout is consistent with
this newline-sensitive failure, but the runner's raw YAML bytes were not saved.
The artifact identity and original failure remain preserved in `evidence.json`.
This does not replace or resolve the older contention failure in
[run 36957869555](https://github.com/youq616/ultrabrain/actions/runs/36957869555).

The correction normalizes CRLF pairs only in the two in-memory workflow source
strings and then runs all existing exact contract assertions. It neither rewrites
workflow files nor normalizes whitespace, command arguments or lone CR. The same
function checks the actual files and all four LF/CRLF source combinations.
Sixteen rejecting controls cover omitted, added and reordered suite files,
grouped/serialized command changes, Node pin, indentation and command whitespace
under LF and CRLF; two more reject lone CR. Pure Linux Node 24.19.0 validation
passed 79/79 tests. Syntax and whitespace checks passed. No new contention workload
or Windows pair ran for this correction.

## Fixed forward ancestry

The comparison workflow now requires an ordinary direct child of actual
`d1c4da2e932a36ce2d019c09ac9004fc80246aa6`. Checkout depth 2 exposes the immediate
parent; a literal `git cat-file -p` read checks that parent's exact tree
`5a9441e7041fad00de6bcec423fa7960f2eeb614` and sole original parent
`c379604af7c12a7154ce02b902933e81c2b5a816`. It does not traverse or fetch the
grandparent. Missing or malformed identity remains inconclusive. The bounded
`prior_attempt` projection reports observed hashes or unavailable values; the
candidate's actual tree is still reported separately. Node/platform, attempt-one,
checkout/head equality and all existing workflow command/permission checks remain.

Combined pure Linux Node 24.19.0 validation passed 102/102 tests, including one
positive and 22 negative identity controls executing the actual extracted summary
JavaScript. Its Git, filesystem and environment ports are synthetic and restricted;
the existing pure evidence classifiers remain real. These controls are neither a
Windows checkout result nor a new contention workload. YAML, all four Bash run
snippets, extracted JavaScript, test syntax and whitespace checks passed.

The trigger and finite pair are unchanged. Exact-source review, fresh public
tree/parent binding and a separate one-child activation decision remain required.
No corrected Windows comparison has run. Earlier failed attempts are never
overwritten, rerun or treated as passing.
