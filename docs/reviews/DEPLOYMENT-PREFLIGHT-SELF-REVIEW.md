# Deployment preflight: implementation self-review

Base: `76fa32b7aa866490b7cdcbf5fc9d2e1f17b2ec86`, source tree `aeb4e947cc460dbc22fc584262a95d0002db7d9c`.

This records the implementation assistant's separate review phase. It is **not** a separate reviewer agent, a third-party security audit, or permission to merge. The AGENTS.md independent-agent and exact-candidate CI gates remain required. At preparation time this execution session has read-only GitHub tools; remote commit/PR/CI and independent-agent scheduling are pending. No result from the preceding ranking phase is reused to approve this change.

## Scope

New offline preflight; CLI/package/CI wiring; private-path and descriptor handling; credential-safe reports; fixed dependency command invocation; source/runtime/configuration checks; missing-installation handling; test isolation. Existing database tables, role/source authorization, migrations, upstream pins, provider configuration and user services are unchanged.

## Second-pass findings, reproduced before correction

Five failing assertions reproduced three categories of implementation defects:

- An unwritable parent of a planned home could produce an otherwise OK install report. Corrected using effective-account access checking relative to the already-open ancestor; no write probe and no permission changes. Access success remains an advisory observation, not authorization for later writes.
- Ordinary files named `node_modules`, a directory named `cli.ts`, or a linked source directory could pass existence-only checks. Corrected with fixed-path no-follow descriptor traversal and explicit type requirements. Checks still do not certify all installed dependency integrity.
- The dependency wrapper sent a group kill after reaping a successful child. The regression proves the unnecessary signal call, not an actual unrelated-process kill. Correction signals only an unreaped child group on failure/timeout, then waits and closes streams. Output remains bounded and a child retaining a pipe is terminated on timeout.

The first adversarial test module imported another TestCase directly, causing duplicate discovery of 35 existing tests. Corrected test-module imports before recording the canonical failure evidence: six second-pass tests, five failures. Final suite counts do not count those imported cases twice. An additional review replaced the trusted-lock read with a bounded no-follow descriptor read; source file paths and parser errors are not reflected in output.

## Evidence and limits

Baseline was reconstructed from the actual GitHub source snapshot. Staged original gitlinks reproduce the base tree exactly. Baseline local runs: 478 Node tests and 119 Python tests pass. All new inputs are synthetic. The final artifact manifest records exact final run counts and hashes, not intended test totals.

The new unit tests exercise real private filesystem operations and bounded subprocesses; dependency availability/version responses in the higher-level synthetic installation fixture are deliberately controlled. Actual Node and Python CLI entrypoints were invoked without an initialized home and verified not to create it.

A separate synthetic PostgreSQL installation was really initialized using the existing manager, then stopped. The runtime cache came from a previously supplied project CI diagnostic artifact with matching locked PostgreSQL/pgvector revisions; it is the accepted legacy directory variant, not a fresh portable build. Bun was actually 1.3.13. Nine real CLI/installed-state checks passed, including configuration fingerprint preservation, safe permission refusal and reading installation state while the DB remains stopped. The test restored its prior running state; the harness then explicitly stopped it. This does not stand in for a new GitHub bootstrap from pinned sources or a user deployment.

PATH dependencies are assumed trusted. There is no OS sandbox or guarantee that a malicious replacement executable honors an offline/version-only command. The checker does not establish live DB/MCP availability, provider credentials, extension/schema completeness, all dependency integrity, backup correctness, throughput or total filesystem-call deadlines. Reports do not contain credential values or memory contents. Resource thresholds are hints, including the explicitly limited host-memory estimate. Do not change these non-claims to PASS labels merely to complete this phase.

## Acceptance state

Local implementation and self-review can be complete independently of publication. The final candidate still needs its own successful remote workflows and a real separate reviewer. Preserve first failures, retain this distinction, and do not merge to main from self-review alone. No Windows/local-agent redevelopment or credentials are requested by this self-review.

## Receiver continuation, 2026-09-16

The saved checkpoint was restored byte-for-byte: base tree aeb4e947cc460dbc22fc584262a95d0002db7d9c, initial candidate a3ccf82bfa07608b8a53a221d5c694592a678b88. Before changing it, this receiver actually reran 483 JavaScript and 166 Python tests plus the nine initialized-installation checks successfully. The runtime was reused from the supplied historical CI artifact, with matching PostgreSQL/pgvector pins, not freshly compiled; remote CI must still build/bootstrap independently.

A further implementation-assistant self-review reproduced two failures when PATH contains a relative dependency directory: shutil.which returns a relative executable, but the bounded child wrapper changes cwd to /. This could falsely reject a valid Bun or pkg-config installation (or select a different root-relative path). dependency_path now binds the selected location to an absolute path before changing cwd. Two real synthetic-executable regressions fail on the checkpoint and pass after the fix. This does not attempt to make a malicious PATH executable safe. The first-failure log is retained privately; no host credentials or user data were used.

This continuation can publish through the currently available connector; the earlier read-only limitation describes the checkpoint session, not current repository authorization. Current-candidate CI, separate review and merge outcomes belong in the PR acceptance record and must not be inferred from this self-review.
